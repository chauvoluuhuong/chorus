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
use tauri::{AppHandle, DragDropEvent, Manager, RunEvent, Url, WindowEvent};

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
    let shell = std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }.into());
    // the installer's own copy (~/.chorus/current, with its Node inside) first, so the app needs nothing on the PATH; else `chorus`
    let bundled = home().join(".chorus/current/bin/chorus");
    let cli = std::env::var("CHORUS_SERVE_CMD").unwrap_or_else(|_| if bundled.exists() { format!("'{}'", bundled.display()) } else { "chorus".into() });
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
                if let Ok(u) = Url::parse(url.trim()) {
                    let app = app.clone();
                    thread::spawn(move || open_page(&app, u));
                }
            }
        }
        if !found {
            let tail = lines.iter().rev().take(6).rev().cloned().collect::<Vec<_>>().join("\n");
            show_error(
                &app,
                &format!("`chorus serve` stopped before it started.\n\n{tail}\n\nInstall or repair it with: curl -fsSL https://chorus-cli.web.app/install.sh | bash. Log: {}", log.display()),
            );
        }
    });
}

/// Show the served page. `chorus serve` can print its URL before the splash page has finished loading, and a navigation sent that early
/// is lost when the splash load completes (the window then stays on "Starting chorus serve…"), so repeat it until the window is there.
fn open_page(app: &AppHandle, target: Url) {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(20) {
        if let Some(w) = app.get_webview_window("main") {
            if w.url().map(|u| u.host_str() == target.host_str() && u.port() == target.port()).unwrap_or(false) {
                return;
            }
            let _ = w.navigate(target.clone());
        }
        thread::sleep(Duration::from_millis(400));
    }
    show_error(app, "The Chorus window could not open the page `chorus serve` started. Quit Chorus and open it again.");
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

/// Files dropped on the window: Tauri takes the drop (the page gets no HTML drop with paths), so it is passed to the page with the
/// full paths and the pointer position in CSS pixels; the page decides what the drop does (docs/phase5.md §8.3).
fn forward_drop(app: &AppHandle, label: &str, d: &DragDropEvent) {
    let Some(w) = app.get_webview_window(label) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let (kind, paths, pos) = match d {
        DragDropEvent::Enter { paths, position } => ("enter", paths.clone(), Some(*position)),
        DragDropEvent::Over { position } => ("over", vec![], Some(*position)),
        DragDropEvent::Drop { paths, position } => ("drop", paths.clone(), Some(*position)),
        DragDropEvent::Leave => ("leave", vec![], None),
        #[allow(unreachable_patterns)]
        _ => return,
    };
    let list = paths.iter().map(|p| serde_json_string(&p.to_string_lossy())).collect::<Vec<_>>().join(",");
    let (x, y) = pos.map(|p| (p.x / scale, p.y / scale)).unwrap_or((-1.0, -1.0));
    let _ = w.eval(&format!("window.chorusDrop && window.chorusDrop({{kind:\"{kind}\",paths:[{list}],x:{x},y:{y}}})"));
}

fn main() {
    let builder = tauri::Builder::default();
    // Linux: one window per user. `chorus` run again brings it to the front instead of a second window with a second `chorus serve`
    // (macOS does this itself: `open` focuses the running app).
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    builder
        .manage(Serve(Mutex::new(None)))
        .setup(|app| {
            start_serve(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Chorus window")
        .run(|app, event| match event {
            RunEvent::Exit => stop_serve(app),
            RunEvent::WindowEvent { label, event: WindowEvent::DragDrop(d), .. } => forward_drop(app, &label, &d),
            _ => {}
        });
}
