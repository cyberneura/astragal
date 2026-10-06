//! コマンドラインからの起動 (`astragal -e 'cmd'`) と、`/usr/local/bin` へのコマンドの導入。

use base64::Engine;
use std::path::{Path, PathBuf};

/// ログイン時の自動起動で付ける引数。付いていたら main を出さずメニューバーだけに常駐する
pub const MINIMIZED_ARG: &str = "--minimized";
const WORKING_DIRECTORY_ARG: &str = "--working-directory";
/// `-e` のコマンドを base64 (URL safe) で包んで渡す内部用の引数。Windows の
/// single-instance は argv を `|` で連結・分割して本体へ送るので、パイプを含む
/// コマンドが割れる (`forward_without_pipes`)
const EXEC_BASE64_ARG: &str = "--exec-base64=";

pub const USAGE: &str = "\
Usage: astragal [--working-directory DIR] [-e COMMAND [ARGS...]]

Open a new Astragal tab, or bring Astragal to the front if no option is given.

Options:
  -e, --exec COMMAND [ARGS...]  Run COMMAND in a new tab with your shell (-c).
                                Every argument after it belongs to the command.
                                A single argument is passed to the shell as is,
                                so it can hold pipes: -e 'free -m | grep Mem'
                                On Windows, give COMMAND as one argument.
  --working-directory DIR       Start the new tab in DIR (default: the current
                                directory when -e is given)
  -h, --help                    Show this help
";

/// コマンドラインの解釈結果
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CliArgs {
    pub exec: Option<String>,
    pub working_directory: Option<PathBuf>,
    pub minimized: bool,
    pub help: bool,
}

impl CliArgs {
    /// 新しいタブを開く要求か (オプション無しなら既存のウインドウを出すだけ)
    pub fn opens_tab(&self) -> bool {
        self.exec.is_some() || self.working_directory.is_some()
    }
}

/// argv (先頭はプログラム名) を解釈する。
///
/// `-e` は xterm / Alacritty / Ghostty と同じく残りの引数をすべてコマンドとして取る。
/// 引数が 1 つならシェルへそのまま渡し (パイプを書ける)、複数なら 1 つずつ引用して
/// 繋ぐ (`-e ls "my dir"` で空白入りの引数が割れないように)。Windows では複数を
/// エラーにする (`quote_arg`)。
pub fn parse<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> Result<CliArgs, String> {
    let args: Vec<String> = args
        .into_iter()
        .skip(1)
        .map(|arg| arg.as_ref().to_string())
        .collect();
    let mut parsed = CliArgs::default();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "-e" | "--exec" => {
                let rest = &args[i + 1..];
                if rest.is_empty() {
                    return Err(format!("{arg} needs a command"));
                }
                parsed.exec = Some(join_command(rest)?);
                break;
            }
            "-h" | "--help" | "help" => parsed.help = true,
            MINIMIZED_ARG => parsed.minimized = true,
            WORKING_DIRECTORY_ARG => {
                let Some(dir) = args.get(i + 1) else {
                    return Err(format!("{WORKING_DIRECTORY_ARG} needs a directory"));
                };
                parsed.working_directory = Some(PathBuf::from(dir));
                i += 1;
            }
            _ => {
                if let Some(command) = arg.strip_prefix("--exec=") {
                    if i + 1 < args.len() {
                        return Err("--exec=COMMAND takes no further arguments".to_string());
                    }
                    if command.is_empty() {
                        return Err("--exec needs a command".to_string());
                    }
                    parsed.exec = Some(command.to_string());
                    break;
                }
                if let Some(encoded) = arg.strip_prefix(EXEC_BASE64_ARG) {
                    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .decode(encoded)
                        .map_err(|e| format!("invalid {EXEC_BASE64_ARG}: {e}"))?;
                    let command = String::from_utf8(bytes)
                        .map_err(|e| format!("invalid {EXEC_BASE64_ARG}: {e}"))?;
                    parsed.exec = Some(command);
                } else if let Some(dir) = arg.strip_prefix("--working-directory=") {
                    parsed.working_directory = Some(PathBuf::from(dir));
                } else if arg.starts_with("-psn_") {
                    // 古い macOS の LaunchServices が付けるプロセス番号。意味は無い
                } else {
                    return Err(format!("unknown argument: {arg}"));
                }
            }
        }
        i += 1;
    }
    Ok(parsed)
}

fn join_command(parts: &[String]) -> Result<String, String> {
    if let [only] = parts {
        return Ok(only.clone());
    }
    let quoted: Result<Vec<String>, String> = parts.iter().map(|part| quote_arg(part)).collect();
    Ok(quoted?.join(" "))
}

#[cfg(not(windows))]
fn quote_arg(arg: &str) -> Result<String, String> {
    shlex::try_quote(arg)
        .map(|quoted| quoted.into_owned())
        .map_err(|_| "the command contains a NUL character".to_string())
}

/// cmd と PowerShell では引用の規則が違い、cmd の `&` `|` `^` は引用しても安全に
/// 包み切れない。1 つの文字列で渡してもらう
#[cfg(windows)]
fn quote_arg(_arg: &str) -> Result<String, String> {
    Err("on Windows, pass the command as one argument: -e \"COMMAND ARGS\"".to_string())
}

/// シェルにコマンド文字列を実行させる引数。cmd と PowerShell は `-c` を受け付けない。
/// wsl.exe はシェルではなく起動口なので、distro の中の sh に `-c` で渡す
pub fn shell_exec_args(shell: &Path) -> &'static [&'static str] {
    let name = shell
        .file_stem()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match name.as_str() {
        "cmd" => &["/C"],
        "powershell" | "pwsh" => &["-Command"],
        "wsl" => &["-e", "sh", "-c"],
        _ => &["-c"],
    }
}

/// タブで実行する内容。`create_terminal` が `id` で取り出して使う
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchRequest {
    pub id: u32,
    pub exec: Option<String>,
    pub cwd: Option<PathBuf>,
}

/// タブを開く要求に変換する。`fallback_cwd` は呼び出し元プロセスの cwd で、
/// `--working-directory` が無い時に `-e` のタブの開始位置に使う。
pub fn launch_request(
    id: u32,
    args: &CliArgs,
    fallback_cwd: Option<&Path>,
) -> Option<LaunchRequest> {
    // `--help -e cmd` でコマンドを実行しない
    if args.help || !args.opens_tab() {
        return None;
    }
    let cwd = match &args.working_directory {
        Some(dir) if dir.is_absolute() => Some(dir.clone()),
        Some(dir) => fallback_cwd.map(|base| base.join(dir)),
        None => fallback_cwd.map(Path::to_path_buf),
    };
    Some(LaunchRequest {
        id,
        exec: args.exec.clone(),
        cwd,
    })
}

// ── Relaunch from a terminal (macOS) ─────────────────────────────────────────

/// ターミナルから .app の中のバイナリが直接起動された時、LaunchServices 経由で
/// 起動し直す。このプロセスが本体になると、ターミナルの子として残り、タブを閉じた
/// 時の SIGHUP で落ちる。
///
/// 起動し直したプロセスの cwd は `/` になるので、`-e` の開始位置は
/// `--working-directory` で明示して渡す。起動済みなら、起動し直したプロセスが
/// single-instance の仕組みで本体へ引数を送って終わる。
///
/// 戻り値は終了コード。`None` ならこのプロセスがそのまま本体として動く。
#[cfg(target_os = "macos")]
pub fn relaunch_from_terminal() -> Option<i32> {
    // LaunchServices (open / Finder / Dock / LaunchAgent) から起動されたプロセスの親は launchd
    if std::os::unix::process::parent_id() == 1 {
        return None;
    }
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let bundle = app_bundle(&exe)?;

    let argv: Vec<String> = std::env::args().collect();
    let parsed = match parse(&argv) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("astragal: {e}\n\n{USAGE}");
            return Some(2);
        }
    };
    if parsed.help {
        print!("{USAGE}");
        return Some(0);
    }

    let cwd = std::env::current_dir().ok();
    let forwarded = match launch_request(0, &parsed, cwd.as_deref())
        .map(|request| forwarded_args(request, false))
    {
        Some(Ok(forwarded)) => forwarded,
        Some(Err(e)) => {
            eprintln!("astragal: {e}");
            return Some(2);
        }
        None => Vec::new(),
    };

    let status = std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg("-a")
        .arg(&bundle)
        .arg("--args")
        .args(&forwarded)
        .status();
    match status {
        Ok(status) => Some(status.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("astragal: failed to launch {}: {e}", bundle.display());
            Some(1)
        }
    }
}

/// `Foo.app/Contents/MacOS/foo` から `Foo.app` を返す。バンドルの外 (dev 実行) なら `None`
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    let contents = macos_dir.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos_dir.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then(|| bundle.to_path_buf())
}

/// 本体へ渡す引数。cwd は呼び出し元で解決して明示する (受け取る側の cwd は当てにならない)。
///
/// 引数は String で受け渡すので、UTF-8 でないパスは表せない。`display()` で置換文字に
/// 化けたパスを渡すと別の場所でタブが開くので、エラーにする (APFS / HFS+ では起きず、
/// ネットワークボリューム等でだけありうる)
fn forwarded_args(request: LaunchRequest, encode_exec: bool) -> Result<Vec<String>, String> {
    let mut forwarded = Vec::new();
    if let Some(dir) = request.cwd {
        let dir = dir.to_str().ok_or_else(|| {
            format!(
                "the working directory is not valid UTF-8: {}",
                dir.display()
            )
        })?;
        forwarded.push(format!("{WORKING_DIRECTORY_ARG}={dir}"));
    }
    if let Some(command) = request.exec {
        forwarded.push(if encode_exec {
            format!(
                "{EXEC_BASE64_ARG}{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(command)
            )
        } else {
            format!("--exec={command}")
        });
    }
    Ok(forwarded)
}

/// 引数に `|` があれば、`-e` を base64 で包んだ引数で自分を起動し直す (Windows)。
///
/// Windows の single-instance は argv を `|` で連結し、本体側で `|` で分割する。
/// パイプを含むコマンドがそのまま届くと別の引数に割れるので、送る前に `|` を消す。
/// 戻り値は終了コード。`None` ならこのプロセスがそのまま続ける。
#[cfg(windows)]
pub fn forward_without_pipes() -> Option<i32> {
    let argv: Vec<String> = std::env::args().collect();
    // 起動し直した後のプロセスでは繰り返さない
    if argv.iter().any(|arg| arg.starts_with(EXEC_BASE64_ARG))
        || !argv.iter().skip(1).any(|arg| arg.contains('|'))
    {
        return None;
    }
    let parsed = parse(&argv).ok()?;
    let cwd = std::env::current_dir().ok();
    let request = launch_request(0, &parsed, cwd.as_deref())?;
    let forwarded = forwarded_args(request, true).ok()?;
    // 包むのはコマンドだけ。作業ディレクトリに `|` が残る (Windows のパスには使えない
    // 文字なので誤入力) なら起動し直さない。起動し直した先でも `|` が見つかり終わらなく
    // なるため。このまま続ければ、起動済みなら本体が割れた引数の誤りをダイアログで出し、
    // 未起動ならこのプロセスが本体になる
    if forwarded.iter().any(|arg| arg.contains('|')) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    match std::process::Command::new(exe).args(forwarded).spawn() {
        Ok(_) => Some(0),
        Err(e) => {
            eprintln!("astragal: failed to relaunch: {e}");
            Some(1)
        }
    }
}

// ── Install the command (macOS) ──────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub const INSTALL_PATH: &str = "/usr/local/bin/astragal";

/// `/usr/local/bin/astragal` にこのバイナリへのシンボリックリンクを作る。
///
/// 書き込めなければ (Apple Silicon では `/usr/local/bin` が root 所有か存在しない)
/// 管理者権限で作り直す。成功ならリンク先を返す。`Ok(None)` はユーザーが
/// 認証をキャンセルした。
#[cfg(target_os = "macos")]
pub fn install_command() -> Result<Option<PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = install_target(&exe)?;
    let link = Path::new(INSTALL_PATH);

    match std::fs::symlink_metadata(link) {
        Ok(meta) if !meta.file_type().is_symlink() => {
            return Err(format!(
                "{INSTALL_PATH} already exists and is not a symbolic link. Remove it first."
            ));
        }
        _ => {}
    }

    if replace_symlink(&target, link).is_ok() {
        return Ok(Some(target));
    }

    // パスは argv で渡して AppleScript の quoted form で引用させる。文字列に埋め込むと
    // パス中の引用符でスクリプトが壊れる
    let output = std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "do shell script \"mkdir -p \" & quoted form of (item 1 of argv) & \
             \" && ln -sfn \" & quoted form of (item 2 of argv) & \" \" & \
             quoted form of (item 3 of argv) with administrator privileges",
            "-e",
            "end run",
        ])
        .arg(link.parent().unwrap_or(Path::new("/usr/local/bin")))
        .arg(&target)
        .arg(link)
        .output()
        .map_err(|e| format!("Failed to run osascript: {e}"))?;
    if output.status.success() {
        return Ok(Some(target));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // ユーザーが認証ダイアログをキャンセルした (errAEEventNotPermitted ではなく userCanceled)
    if stderr.contains("(-128)") {
        return Ok(None);
    }
    Err(stderr.trim().to_string())
}

#[cfg(target_os = "macos")]
fn replace_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(link).is_ok() {
        std::fs::remove_file(link)?;
    }
    std::os::unix::fs::symlink(target, link)
}

/// リンク先にしてよい実行ファイルか。
///
/// canonicalize しない (`autostart_entry` と同じ理由。版ごとの実体を指すと更新で切れる)。
/// Gatekeeper の App Translocation で動いている時は、毎回変わる読み取り専用の場所に
/// いるので、そこを指すリンクは次の起動で切れる。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn install_target(exe: &Path) -> Result<PathBuf, String> {
    if exe.to_string_lossy().contains("/AppTranslocation/") {
        return Err(
            "Astragal is running from a temporary location. Move Astragal.app to the \
             Applications folder, open it from there, and try again."
                .to_string(),
        );
    }
    if app_bundle(exe).is_none() {
        return Err(format!(
            "Astragal is not running from an app bundle ({}).",
            exe.display()
        ));
    }
    Ok(exe.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        std::iter::once("astragal")
            .chain(args.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn exec_with_a_single_argument_keeps_the_pipe() {
        // Arrange
        let args = argv(&["-e", "free -m | grep Mem"]);

        // Act
        let parsed = parse(&args).unwrap();

        // Assert
        assert_eq!(parsed.exec.as_deref(), Some("free -m | grep Mem"));
    }

    #[cfg(not(windows))]
    #[test]
    fn exec_takes_every_following_argument_and_quotes_them() {
        // Arrange
        let args = argv(&["--exec", "ls", "-la", "my dir", "--working-directory"]);

        // Act
        let parsed = parse(&args).unwrap();

        // Assert
        assert_eq!(
            parsed.exec.as_deref(),
            Some("ls -la 'my dir' --working-directory")
        );
        assert_eq!(parsed.working_directory, None);
    }

    #[test]
    fn exec_without_a_command_is_an_error() {
        assert!(parse(argv(&["-e"])).is_err());
        assert!(parse(argv(&["--exec="])).is_err());
    }

    #[test]
    fn exec_equals_form_takes_no_further_arguments() {
        assert_eq!(
            parse(argv(&["--exec=top"])).unwrap().exec.as_deref(),
            Some("top")
        );
        assert!(parse(argv(&["--exec=ls", "extra"])).is_err());
    }

    #[test]
    fn working_directory_accepts_both_forms() {
        assert_eq!(
            parse(argv(&["--working-directory", "/tmp"]))
                .unwrap()
                .working_directory,
            Some(PathBuf::from("/tmp"))
        );
        assert_eq!(
            parse(argv(&["--working-directory=/a b"]))
                .unwrap()
                .working_directory,
            Some(PathBuf::from("/a b"))
        );
        assert!(parse(argv(&["--working-directory"])).is_err());
    }

    #[test]
    fn unknown_option_is_an_error_but_psn_is_ignored() {
        assert!(parse(argv(&["--bogus"])).is_err());
        assert_eq!(parse(argv(&["-psn_0_12345"])).unwrap(), CliArgs::default());
    }

    #[test]
    fn help_with_exec_runs_nothing() {
        // Arrange
        let parsed = parse(argv(&["--help", "-e", "rm -rf build"])).unwrap();

        // Act
        let request = launch_request(0, &parsed, Some(Path::new("/work")));

        // Assert
        assert_eq!(request, None);
    }

    #[test]
    fn minimized_after_exec_belongs_to_the_command() {
        let parsed = parse(argv(&["-e", "--minimized"])).unwrap();
        assert!(!parsed.minimized);
        assert_eq!(parsed.exec.as_deref(), Some("--minimized"));
    }

    #[test]
    fn encoded_exec_round_trips_a_pipe() {
        // Arrange
        let request = LaunchRequest {
            id: 0,
            exec: Some("dir | findstr \"a b\"".to_string()),
            cwd: Some(PathBuf::from("/work")),
        };

        // Act
        let forwarded = forwarded_args(request.clone(), true).unwrap();
        let reparsed =
            parse(std::iter::once("astragal".to_string()).chain(forwarded.clone())).unwrap();

        // Assert
        assert!(forwarded.iter().all(|arg| !arg.contains('|')));
        assert_eq!(reparsed.exec, request.exec);
        assert_eq!(reparsed.working_directory, request.cwd);
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_working_directory_is_not_forwarded() {
        use std::os::unix::ffi::OsStrExt;
        // Arrange
        let request = LaunchRequest {
            id: 0,
            exec: Some("pwd".to_string()),
            cwd: Some(PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/\xff"))),
        };

        // Act
        let forwarded = forwarded_args(request, false);

        // Assert
        assert!(forwarded.is_err());
    }

    #[cfg(windows)]
    #[test]
    fn several_exec_arguments_are_rejected_on_windows() {
        assert!(parse(argv(&["-e", "dir", "C:\\"])).is_err());
    }

    #[test]
    fn help_is_accepted_without_dashes() {
        assert!(parse(argv(&["help"])).unwrap().help);
        assert!(parse(argv(&["--help"])).unwrap().help);
    }

    #[test]
    fn minimized_alone_opens_no_tab() {
        // Arrange
        let parsed = parse(argv(&["--minimized"])).unwrap();

        // Act
        let request = launch_request(1, &parsed, Some(Path::new("/home")));

        // Assert
        assert!(parsed.minimized);
        assert_eq!(request, None);
    }

    #[test]
    fn exec_starts_in_the_caller_directory() {
        // Arrange
        let parsed = parse(argv(&["-e", "pwd"])).unwrap();

        // Act
        let request = launch_request(3, &parsed, Some(Path::new("/work"))).unwrap();

        // Assert
        assert_eq!(request.cwd, Some(PathBuf::from("/work")));
        assert_eq!(request.exec.as_deref(), Some("pwd"));
    }

    #[test]
    fn relative_working_directory_is_resolved_against_the_caller() {
        // Arrange
        let parsed = parse(argv(&["--working-directory", "sub"])).unwrap();

        // Act
        let request = launch_request(0, &parsed, Some(Path::new("/work"))).unwrap();

        // Assert
        assert_eq!(request.cwd, Some(PathBuf::from("/work/sub")));
        assert_eq!(request.exec, None);
    }

    #[test]
    fn shell_exec_args_follow_the_shell() {
        assert_eq!(shell_exec_args(Path::new("/bin/zsh")), ["-c"]);
        assert_eq!(shell_exec_args(Path::new("/opt/homebrew/bin/fish")), ["-c"]);
        assert_eq!(shell_exec_args(Path::new("cmd.exe")), ["/C"]);
        assert_eq!(shell_exec_args(Path::new("pwsh.exe")), ["-Command"]);
        assert_eq!(shell_exec_args(Path::new("PowerShell.EXE")), ["-Command"]);
        assert_eq!(shell_exec_args(Path::new("wsl.exe")), ["-e", "sh", "-c"]);
    }

    #[test]
    fn app_bundle_is_found_only_inside_a_bundle() {
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/Astragal.app/Contents/MacOS/astragal"
            )),
            Some(PathBuf::from("/Applications/Astragal.app"))
        );
        assert_eq!(
            app_bundle(Path::new("/repo/src-tauri/target/debug/astragal")),
            None
        );
    }

    #[test]
    fn translocated_app_is_not_installed() {
        let exe = Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/Astragal.app/Contents/MacOS/astragal",
        );
        assert!(install_target(exe).is_err());
        assert!(install_target(Path::new(
            "/Applications/Astragal.app/Contents/MacOS/astragal"
        ))
        .is_ok());
    }
}
