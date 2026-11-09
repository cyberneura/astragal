//! OSC 133 boundaries for interactive zsh, without modifying the user's dotfiles.
use portable_pty::CommandBuilder;
use std::path::PathBuf;

pub struct Integration(PathBuf);
impl Drop for Integration {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn install(
    cmd: &mut CommandBuilder,
    shell: &crate::config::ShellConfig,
) -> Result<Option<Integration>, String> {
    if shell.resolve_command().file_name().and_then(|s| s.to_str()) != Some("zsh") {
        return Ok(None);
    }
    let dir = std::env::temp_dir().join(format!(
        "astragal-zsh-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let integration = Integration(dir);
    let original = shell
        .env
        .get("ZDOTDIR")
        .cloned()
        .or_else(|| std::env::var("ZDOTDIR").ok());
    cmd.env(
        "ASTRAGAL_ORIGINAL_ZDOTDIR",
        original.as_deref().unwrap_or(""),
    );
    cmd.env(
        "ASTRAGAL_ZDOTDIR_SET",
        if original.is_some() { "1" } else { "0" },
    );
    cmd.env("ZDOTDIR", &integration.0);
    std::fs::write(integration.0.join(".zshenv"), r#"
_astragal_integration_dir=$ZDOTDIR
if [[ $ASTRAGAL_ZDOTDIR_SET == 1 ]]; then export ZDOTDIR=$ASTRAGAL_ORIGINAL_ZDOTDIR; else unset ZDOTDIR; fi
[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && source "${ZDOTDIR:-$HOME}/.zshenv"
_astragal_user_zdotdir=${ZDOTDIR:-$HOME}
_astragal_user_zdotdir_set=${+ZDOTDIR}
export ZDOTDIR=$_astragal_integration_dir
"#).map_err(|e| e.to_string())?;
    std::fs::write(integration.0.join(".zprofile"), r#"
if [[ $_astragal_user_zdotdir_set == 1 ]]; then export ZDOTDIR=$_astragal_user_zdotdir; else unset ZDOTDIR; fi
[[ -r ${ZDOTDIR:-$HOME}/.zprofile ]] && source "${ZDOTDIR:-$HOME}/.zprofile"
_astragal_user_zdotdir=${ZDOTDIR:-$HOME}
_astragal_user_zdotdir_set=${+ZDOTDIR}
export ZDOTDIR=$_astragal_integration_dir
"#).map_err(|e| e.to_string())?;
    std::fs::write(integration.0.join(".zshrc"), r#"
if [[ $_astragal_user_zdotdir_set == 1 ]]; then export ZDOTDIR=$_astragal_user_zdotdir; else unset ZDOTDIR; fi
[[ -r ${ZDOTDIR:-$HOME}/.zshrc ]] && source "${ZDOTDIR:-$HOME}/.zshrc"
unset ASTRAGAL_ORIGINAL_ZDOTDIR ASTRAGAL_ZDOTDIR_SET _astragal_integration_dir _astragal_user_zdotdir _astragal_user_zdotdir_set
_astragal_command_running=0
_astragal_preexec() { _astragal_command_running=1; printf '\033]133;C\007'; }
_astragal_precmd() {
  local result=$?
  if (( _astragal_command_running )); then printf '\033]133;D;%s\007' "$result"; fi
  _astragal_command_running=0
  local directory=${PWD//\%/\%25}
  directory=${directory//\#/\%23}
  directory=${directory//\?/\%3F}
  directory=${directory//$'\007'/\%07}
  directory=${directory//$'\033'/\%1B}
  printf '\033]7;file://%s\007' "$directory"
  printf '\033]133;A\007'
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _astragal_preexec
add-zsh-hook precmd _astragal_precmd
"#).map_err(|e| e.to_string())?;
    Ok(Some(integration))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, PtySize};
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn zsh_preserves_dotfiles_and_reports_completed_commands() {
        if !std::path::Path::new("/bin/zsh").exists() {
            return;
        }
        let root = std::env::temp_dir().join(format!("astragal-zsh-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let cleanup = Integration(root.clone());
        for file in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            std::fs::write(root.join(file), format!("print -r -- loaded:{file}\n")).unwrap();
        }
        let mut shell = crate::config::ShellConfig {
            command: Some("/bin/zsh".into()),
            ..Default::default()
        };
        shell
            .env
            .insert("ZDOTDIR".into(), root.to_string_lossy().into_owned());
        let mut command = CommandBuilder::new("/bin/zsh");
        command.arg("-l");
        command.env("HOME", &root);
        command.env("TERM", "dumb");
        let integration = install(&mut command, &shell).unwrap().unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut buf = [0; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut output = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !output.contains("\x1b]133;A\x07") && std::time::Instant::now() < deadline {
            if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(100)) {
                output.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        writer.write_all(b"printf 'turn-output\\n'\r").unwrap();
        while !output.contains("\x1b]133;D;0\x07") && std::time::Instant::now() < deadline {
            if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(100)) {
                output.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        child.kill().unwrap();
        let _ = child.wait();
        drop(writer);
        drop(pair.master);
        drop(rx);
        let _ = thread.join();
        for file in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            assert_eq!(
                output.matches(&format!("loaded:{file}")).count(),
                1,
                "{output:?}"
            );
        }
        assert!(output.contains("\x1b]133;C\x07"), "{output:?}");
        assert!(output.contains("\x1b]133;D;0\x07"), "{output:?}");
        assert!(output.contains("turn-output"), "{output:?}");
        drop(integration);
        drop(cleanup);
    }
}
