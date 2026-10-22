// Chorus desktop (Phase 5): a native window over `chorus serve`. It holds no logic: it starts the local API, shows its page,
// and stops it when the app quits. The chats, agents and data all live in `chorus serve` (docs/architecture.md §2, D3).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, Url};

struct Serve(Mutex<Option<Child>>);

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn log_file() -> PathBuf {
    let dir = std::env::var_os("CHORUS_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".chorus"));
    let _ = fs::create_dir_all(&dir);
    dir.join("desktop.log")
}

/// `chorus serve` through the user's login shell, so it finds `chorus`, `node` and the agents on the PATH their terminal has
/// (an app opened from the Finder gets a bare PATH). CHORUS_SERVE_CMD replaces `chorus` (development: `node …/src/cli/index.ts`).
fn serve_command() -> Command {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let cli = std::env::var("CHORUS_SERVE_CMD").unwrap_or_else(|_| "chorus".into());
    let mut c = Command::new(shell);
    // --exit-with-stdin: serve stops when this app's end of the pipe closes, even when the app is killed
    c.arg("-l").arg("-c").arg(format!("exec {cli} serve --port 0 --exit-with-stdin"));
    c.current_dir(home());
    // a parent Claude Code session leaks its session id into children (CLAUDE.md rule 5)
    for k in ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID"] {
        c.env_remove(k);
    }
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c
}

fn show_error(app: &AppHandle, msg: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.showError && window.showError({})", serde_json_string(msg));
        let _ = w.eval(&js);
    }
}

/// A JS string literal (no serde dependency for one call).
fn serde_json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn start_serve(app: &AppHandle) {
    let mut child = match serve_command().spawn() {
        Ok(c) => c,
        Err(e) => return show_error(app, &format!("Could not start your shell: {e}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    app.state::<Serve>().0.lock().unwrap().replace(child);
    let log = log_file();
    let mut lines = vec![];
    if let Some(err) = stderr {
        let log = log.clone();
        thread::spawn(move || {
            let mut f = OpenOptions::new().create(true).append(true).open(&log).ok();
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if let Some(f) = f.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
            }
        });
    }
    let Some(out) = stdout else { return };
    let app = app.clone();
    thread::spawn(move || {
        let mut f = OpenOptions::new().create(true).append(true).open(&log).ok();
        let mut found = false;
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(f) = f.as_mut() {
                let _ = writeln!(f, "{line}");
            }
            if !found {
                lines.push(line.clone());
            }
            // the first line of `chorus serve` is "chorus serve: <url with the token>"
            if let Some(url) = line.strip_prefix("chorus serve: ") {
                found = true;
                if let (Some(w), Ok(u)) = (app.get_webview_window("main"), Url::parse(url.trim())) {
                    let _ = w.navigate(u);
                }
            }
        }
        if !found {
            let tail = lines.iter().rev().take(6).rev().cloned().collect::<Vec<_>>().join("\n");
            show_error(
                &app,
                &format!("`chorus serve` stopped before it started.\n\n{tail}\n\nInstall the CLI with: npm install -g chorus-cli (Node 22 or newer). Log: {}", log.display()),
            );
        }
    });
}

/// SIGTERM first, so `chorus serve` stops its agents and closes the database; a hard kill only if it does not exit in time.
fn stop_serve(app: &AppHandle) {
    let Some(mut child) = app.state::<Serve>().0.lock().unwrap().take() else { return };
    #[cfg(unix)]
    let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

fn main() {
    tauri::Builder::default()
        .manage(Serve(Mutex::new(None)))
        .setup(|app| {
            start_serve(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Chorus window")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_serve(app);
            }
        });
}
