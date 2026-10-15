use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

#[derive(Serialize, Clone)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct PtyExitPayload {
    pub id: String,
    pub exit_code: i32,
}

#[derive(Deserialize)]
pub struct SpawnPtyOptions {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
}

#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    state: State<'_, AppState>,
    options: SpawnPtyOptions,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let size = PtySize {
        rows: options.rows.unwrap_or(24),
        cols: options.cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(&options.command);
    for arg in &options.args {
        cmd.arg(arg);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".to_string());
    let mut current_path = std::env::var("PATH").unwrap_or_default();
    let extra_paths = format!(
        "{}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:{}/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        home, home
    );
    if !current_path.contains("/opt/homebrew/bin") && !current_path.contains("/.local/bin") {
        current_path = format!("{}:{}", extra_paths, current_path);
    }
    cmd.env("PATH", &current_path);

    if let Some(cwd) = &options.cwd {
        if !cwd.is_empty() {
            cmd.cwd(cwd);
        } else {
            cmd.cwd(&home);
        }
    } else {
        cmd.cwd(&home);
    }

    if let Some(env) = &options.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Close slave in parent process
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let session_id = options.id.clone();
    let read_session_id = session_id.clone();
    let app_handle = app.clone();

    // Spawn reader thread
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app_handle.emit(
                        "pty:exit",
                        PtyExitPayload {
                            id: read_session_id.clone(),
                            exit_code: 0,
                        },
                    );
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit(
                        "pty:data",
                        PtyDataPayload {
                            id: read_session_id.clone(),
                            data: text,
                        },
                    );
                }
                Err(_) => {
                    let _ = app_handle.emit(
                        "pty:exit",
                        PtyExitPayload {
                            id: read_session_id.clone(),
                            exit_code: 1,
                        },
                    );
                    break;
                }
            }
        }
    });

    let mut sessions = state.sessions.lock().unwrap();
    sessions.insert(
        session_id.clone(),
        PtySession {
            writer,
            master: pair.master,
            child,
        },
    );

    Ok(session_id)
}

#[tauri::command]
fn write_pty(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;
        Ok(())
    } else {
        Err(format!("PTY session {} not found", id))
    }
}

#[tauri::command]
fn resize_pty(
    state: State<'_, AppState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {}", e))?;
        Ok(())
    } else {
        Err(format!("PTY session {} not found", id))
    }
}

#[tauri::command]
fn kill_pty(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
        let _ = app.emit("pty:exit", PtyExitPayload { id: id.clone(), exit_code: 130 });
        Ok(())
    } else {
        Err(format!("PTY session {} not found", id))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
