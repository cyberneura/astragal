// Adapted from Beckwell (Cyberneura), commit d9c5c3456cd1bf3fdedb7f050a28e6cc33560983.
// チャットタブのバックエンド。エージェント (Claude Code の stream-json、Codex の app-server) を子プロセスとして起動し、
// stdin / stdout の JSON 行をフロントと中継する。JSON の中身は解釈しない
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::Command;
use std::process::{Child, ChildStdin, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
}
use tauri::{AppHandle, Emitter, Manager};

// 終了を促してから強制終了に切り替えるまでの猶予
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

struct AgentProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Default)]
struct Processes {
    map: HashMap<u32, AgentProcess>,
    // これまでに受け付けた最大の ID。ページを再読み込みしても ID を再利用しないよう、フロントはこの次から採番する
    // (再利用すると、前のプロセスの残りイベントが新しいセッションに混ざる)
    highest_id: u32,
    // 全終了 (stop_all) のたびに進める。フロントは agent_reset で受け取った世代を agent_start に添える。
    // 再読み込み前のページが送った、処理待ちの agent_start を拒否するため
    generation: u64,
    // 終了待ちのスレッド。アプリの終了時に join して、SIGKILL へのフォールバックまで済ませる
    reaping: Vec<JoinHandle<()>>,
}

#[derive(Default)]
pub struct AgentState {
    processes: Mutex<Processes>,
}

#[derive(Clone, Serialize)]
struct AgentLine {
    id: u32,
    line: String,
}

#[derive(Clone, Serialize)]
struct AgentExit {
    id: u32,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
pub struct AgentStarted {
    // 起動したディレクトリ。リモートで指定が無い時は None (相手に接続した時のディレクトリで、手元からは分からない)
    cwd: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReset {
    highest_id: u32,
    generation: u64,
}

fn send_sigterm(child: &Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child;
}

fn wait_exit(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => return None,
        }
    }
}

// SIGTERM を送った後の子プロセスを回収する。猶予内に終わらなければ SIGKILL する。
// SIGKILL だと claude は実行中のツールのコマンドを止められず、そのコマンドが孤児として残る。
// SIGTERM なら claude が自分で止めてから終了するので、先にその機会を与える。
// アプリの終了がこの関数を待つので、どの待ちにも上限を付ける
fn reap(mut child: Child) {
    if wait_exit(&mut child, EXIT_TIMEOUT).is_some() {
        return;
    }
    let _ = child.kill();
    if wait_exit(&mut child, EXIT_TIMEOUT).is_some() {
        return;
    }
    // SIGKILL しても終わらないプロセスに、これ以上できることは無い。呼び出し元は待たせず、回収だけ続ける
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

// 一覧から取り除いたプロセスを終了させる。SIGTERM はこの場で送り、終了待ちは呼び出し元を待たせないよう別スレッドで行う
fn terminate(processes: &mut Processes, process: AgentProcess) {
    send_sigterm(&process.child);
    processes.reaping.retain(|handle| !handle.is_finished());
    processes
        .reaping
        .push(std::thread::spawn(move || reap(process.child)));
}

// 残っているプロセスを全て終了させ、世代を進める
fn stop_all(processes: &mut Processes) {
    processes.generation += 1;
    let drained: Vec<AgentProcess> = processes.map.drain().map(|(_, p)| p).collect();
    for process in drained {
        terminate(processes, process);
    }
}

// アプリの終了時に呼ぶ。終了待ちのスレッドが残ったままアプリが終了すると SIGKILL へのフォールバックが効かないので、終了を待つ
pub fn stop_all_and_wait(app_handle: &AppHandle) {
    let state = app_handle.state::<AgentState>();
    let handles = {
        let mut processes = state.processes.lock().unwrap();
        stop_all(&mut processes);
        std::mem::take(&mut processes.reaping)
    };
    for handle in handles {
        let _ = handle.join();
    }
}

// フロントの初期化時に呼ぶ。ページの再読み込みで、前のページが起動したプロセスが残っていれば終了させる。フロントは highest_id の次から採番し、以後の agent_start に世代を添える
#[tauri::command]
pub async fn agent_reset(
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<AgentReset, String> {
    require_main(&window)?;
    let state = app_handle.state::<AgentState>();
    let mut processes = state.processes.lock().unwrap();
    stop_all(&mut processes);
    Ok(AgentReset {
        highest_id: processes.highest_id,
        generation: processes.generation,
    })
}

// stdout / stderr を行ごとに読む。不正な UTF-8 が 1 行混ざっただけで中継を止めないよう、行ごとに置換する
fn for_each_line(reader: impl std::io::Read, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end_matches(['\n', '\r']);
        if !line.trim().is_empty() {
            on_line(line.to_string());
        }
    }
}

#[tauri::command]
pub async fn agent_start(
    id: u32,
    generation: u64,
    agent: Agent,
    cwd: String,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<AgentStarted, String> {
    require_main(&window)?;
    if !app_handle
        .state::<super::AppState>()
        .config
        .config
        .agent_chat
        .enabled
    {
        return Err("Agent chat is disabled in the configuration".into());
    }
    if !std::path::Path::new(&cwd).is_absolute() || !std::path::Path::new(&cwd).is_dir() {
        return Err("Choose an existing absolute working directory".into());
    }
    let argv = agent_argv(agent);
    let state = app_handle.state::<AgentState>();
    // 世代の検査から登録までロックを握り続ける。起動してから登録するまでの間に stop_all
    // (ページの初期化・アプリの終了) が走ると、一覧に無いそのプロセスを止められない
    let (stdout, stderr) = {
        let mut processes = state.processes.lock().unwrap();
        if generation != processes.generation {
            return Err("The chat tabs were reset".into());
        }
        if processes.map.contains_key(&id) {
            return Err(format!("Agent process {} already exists", id));
        }
        processes.highest_id = processes.highest_id.max(id);

        // リモートの接続先では、子プロセスは ssh / kubectl になる。それを止めると相手のエージェントは
        // stdin の EOF を受け取り、実行中のツールを止めてから自分で終了する (永続セッションでは中継だけが終わる)
        let mut child = pipe_command(&app_handle, &cwd, &argv)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start the agent: {}", e))?;

        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            send_sigterm(&child);
            reap(child);
            return Err("Failed to open the pipes of the agent".into());
        };
        processes.map.insert(
            id,
            AgentProcess {
                child,
                stdin: Arc::new(Mutex::new(stdin)),
            },
        );
        (stdout, stderr)
    };

    let app_for_stderr = app_handle.clone();
    std::thread::spawn(move || {
        for_each_line(stderr, |line| {
            let _ = app_for_stderr.emit_to("main", "agent_stderr", AgentLine { id, line });
        });
    });

    let app_for_stdout = app_handle.clone();
    std::thread::spawn(move || {
        for_each_line(stdout, |line| {
            let _ = app_for_stdout.emit_to("main", "agent_event", AgentLine { id, line });
        });

        // stdout が閉じても (読み取りエラーでも) プロセスが生きていることがある。終了を確認できるまでは
        // 一覧に残して agent_stop / stop_all から止められるようにし、猶予を過ぎたらここから終了させる
        let state = app_for_stdout.state::<AgentState>();
        let deadline = Instant::now() + EXIT_TIMEOUT;
        let code = loop {
            let mut processes = state.processes.lock().unwrap();
            // 一覧に無ければ agent_stop / stop_all が取り除き済みで、終了処理はそちらが行う (agent_exit も送らない)
            let Some(process) = processes.map.get_mut(&id) else {
                return;
            };
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    processes.map.remove(&id);
                    break status.code();
                }
                Ok(None) if Instant::now() < deadline => {}
                _ => {
                    if let Some(process) = processes.map.remove(&id) {
                        terminate(&mut processes, process);
                    }
                    break None;
                }
            }
            drop(processes);
            std::thread::sleep(Duration::from_millis(50));
        };
        let _ = app_for_stdout.emit_to("main", "agent_exit", AgentExit { id, code });
    });

    Ok(AgentStarted { cwd: Some(cwd) })
}

fn agent_argv(agent: Agent) -> Vec<String> {
    match agent {
        Agent::Claude => [
            "claude",
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool",
            "stdio",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        Agent::Codex => ["codex", "app-server"]
            .into_iter()
            .map(String::from)
            .collect(),
    }
}

// Preserve the JSON pipes while the login shell loads the user's CLI/node PATH.
fn pipe_command(app: &AppHandle, cwd: &str, argv: &[String]) -> Command {
    #[cfg(unix)]
    let shell = app
        .state::<super::AppState>()
        .config
        .config
        .shell
        .resolve_command();
    #[cfg(unix)]
    if matches!(
        shell.file_name().and_then(|s| s.to_str()),
        Some("zsh" | "bash" | "ksh" | "sh")
    ) {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", concat!(
            "exec 3>&1 4>&2 5<&0 1>/dev/null 2>/dev/null </dev/null; ",
            "s=$1; shift; ",
            "if \"$s\" -lic ': >&3' </dev/null; then f=-lic; else f=-lc; fi; ",
            "exec \"$s\" \"$f\" 'cd -- \"$1\" 2>&4 || exit 1; shift; exec \"$@\" 0<&5 1>&3 2>&4 3>&- 4>&- 5<&-' astragal \"$@\""
        ), "astragal"]).arg(shell).arg(cwd).args(argv).current_dir(cwd);
        return command;
    }
    #[cfg(not(unix))]
    let _ = app;
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]).current_dir(cwd);
    command
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Agent chat is only available in the main window".into());
    }
    Ok(())
}

// JSON 1 行を stdin に書く (JSON の組み立てはフロントが行う)
#[tauri::command]
pub async fn agent_write(
    id: u32,
    line: String,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    require_main(&window)?;
    let stdin = {
        let state = app_handle.state::<AgentState>();
        let processes = state.processes.lock().unwrap();
        processes
            .map
            .get(&id)
            .map(|p| Arc::clone(&p.stdin))
            .ok_or(format!("Agent process {} not found", id))?
    };

    let mut stdin = stdin.lock().unwrap();
    stdin
        .write_all(format!("{}\n", line).as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Failed to write to the agent: {}", e))
}

// ここで止めたプロセスには agent_exit を送らないので、止めた側 (フロント) が自分で状態を更新する
#[tauri::command]
pub async fn agent_stop(
    id: u32,
    app_handle: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    require_main(&window)?;
    let state = app_handle.state::<AgentState>();
    let mut processes = state.processes.lock().unwrap();
    if let Some(process) = processes.map.remove(&id) {
        terminate(&mut processes, process);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agents_use_json_protocols_without_bypassing_permissions() {
        let claude = agent_argv(Agent::Claude);
        assert!(claude.contains(&"stream-json".into()));
        assert!(!claude.iter().any(|a| a.contains("dangerously")));
        assert_eq!(agent_argv(Agent::Codex), ["codex", "app-server"]);
    }
}
