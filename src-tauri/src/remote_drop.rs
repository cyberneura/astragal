//! ファイルのドロップで、タブが ssh で繋いでいるホストへ scp で送る (CYBERNEURA-DEV-1177)。
//!
//! タブの pty の前面のプロセスグループのリーダーが `ssh` の時だけ対象にする。その argv を
//! ssh と同じ規則で読み、接続に効くオプションを scp のオプションに組み替えて、同じ接続先へ
//! 送る。シェルの中で ssh を打ち直したり、ssh の設定を推測したりはしない
//! (`~/.ssh/config` は scp もそのまま読む)。
//!
//! - scp は `BatchMode=yes` で起動する。GUI から起動した scp には端末が無く、パスワードや
//!   パスフレーズを尋ねられると答えようがないため。鍵 (エージェント) か、ssh の
//!   ControlMaster で繋いでいる接続先だけで送れる
//! - エージェントのソケットは ssh のプロセスの環境変数 (`SSH_AUTH_SOCK`) を引き継ぐ。
//!   シェルの rc で 1Password などのエージェントに向けていると、アプリの環境とは違うため
//! - 送り先のディレクトリは確認ダイアログで利用者が決める (既定はホームディレクトリ)。
//!   リモートのシェルが今いるディレクトリは手元からは分からない
//! - Windows は前面のプロセスを取れない (ConPTY) ので対象外

use serde::Serialize;

/// ssh の getopt の optstring (OpenSSH 9.x の ssh.c)。`:` の付いた文字は値を取る
const SSH_OPTSTRING: &str = "1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy";

/// 対話の接続ではない (設定の表示、制御コマンド、標準入出力の転送など) ことを示すオプション
const NON_INTERACTIVE_FLAGS: &[char] = &['G', 'V', 'Q', 'O', 'W', 'f'];

/// scp が自分で付けるか、scp では意味を持たない (付けると失敗する) `-o` の項目
const DROPPED_CONFIG_KEYS: &[&str] = &[
    "remotecommand",
    "requesttty",
    "localcommand",
    "permitlocalcommand",
    "sessiontype",
    "stdinnull",
    "forkafterauthentication",
];

/// ssh の値を取るオプションのうち、後から出た値が勝つもの (ssh.c が無条件に上書きする) と、
/// それに当たる設定の項目。`-o` は先に出た値が勝つので、最後の値だけを先頭に置いて写す
const LAST_WINS_OPTIONS: &[(char, &str)] = &[
    ('b', "BindAddress"),
    ('B', "BindInterface"),
    ('m', "MACs"),
    ('S', "ControlPath"),
    ('I', "PKCS11Provider"),
    ('P', "Tag"),
];

/// ドロップで送れる接続先
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    /// 確認ダイアログに出す接続先 (`user@host` や `host`、ポートの指定があれば `:port` も)
    pub label: String,
    /// scp に渡すオプション (送り元と送り先より前)
    pub options: Vec<String>,
    /// scp の送り先の `ホスト:` の部分 (IPv6 は `[::1]`)。user と port は `options` の `-o` で渡す
    pub host: String,
}

impl SshTarget {
    /// 確認した接続と送る時の接続が同じかを比べるための値。表示用の `label` は `-o HostName` や
    /// `-F` の違いを含まないので使えない。PID も含め、ssh を起動し直しただけでも別の接続として扱う
    pub fn identity(&self, pid: i32) -> String {
        format!("{pid}\u{0}{}\u{0}{}", self.options.join("\u{0}"), self.host)
    }
}

/// フロントに返す接続先。`key` はそのまま送る時に返してもらう
#[derive(Debug, Clone, Serialize)]
pub struct DropTarget {
    pub label: String,
    pub key: String,
}

/// argv を ssh.c の getopt と同じ規則で読んだ 1 つ分
enum SshArg {
    Flag(char),
    Value(char, String),
    Destination(String),
}

/// `-o` の値 (`Key=value` か `Key value`) を、小文字の項目名と値に分ける
fn config_entry(value: &str) -> (String, String) {
    let value = value.trim_start();
    let end = value
        .find(|c: char| c == '=' || c.is_whitespace())
        .unwrap_or(value.len());
    let rest = value[end..].trim_start_matches(|c: char| c == '=' || c.is_whitespace());
    (
        value[..end].to_ascii_lowercase(),
        rest.trim_end().to_string(),
    )
}

/// ssh の argv (argv[0] を含む) を読む。対話の ssh でなければ `None`
pub fn parse_ssh_argv(argv: &[String]) -> Option<SshTarget> {
    let program = argv.first()?;
    let name = program.rsplit('/').next().unwrap_or(program);
    if name != "ssh" {
        return None;
    }

    let mut args: Vec<SshArg> = Vec::new();
    let mut has_destination = false;
    let mut index = 1;
    // ssh.c と同じく、接続先の後ろにオプションが続いていれば読み直す
    // (`ssh host -p 2222` が通る)。`--` の後と、接続先の次の非オプションからはコマンド
    'again: loop {
        while index < argv.len() {
            let arg = &argv[index];
            if arg == "--" {
                index += 1;
                if !has_destination && index < argv.len() {
                    args.push(SshArg::Destination(argv[index].clone()));
                }
                break 'again;
            }
            if !arg.starts_with('-') || arg == "-" {
                break;
            }
            let chars: Vec<char> = arg.chars().skip(1).collect();
            let mut position = 0;
            while position < chars.len() {
                let option = chars[position];
                let spec = SSH_OPTSTRING.find(option)?;
                let takes_value = SSH_OPTSTRING[spec + option.len_utf8()..].starts_with(':');
                if takes_value {
                    let rest: String = chars[position + 1..].iter().collect();
                    let value = if !rest.is_empty() {
                        rest
                    } else {
                        index += 1;
                        argv.get(index)?.clone()
                    };
                    args.push(SshArg::Value(option, value));
                    break;
                }
                args.push(SshArg::Flag(option));
                position += 1;
            }
            index += 1;
        }
        if !has_destination && index < argv.len() {
            args.push(SshArg::Destination(argv[index].clone()));
            has_destination = true;
            index += 1;
            continue 'again;
        }
        break;
    }

    // ssh は user / port を「まだ決まっていなければ」で埋める (-l / -p / -o User / -o Port /
    // 接続先の中の値のどれも、先に出たものが勝つ)。scp には全部 -o にして同じ順に渡し、
    // 内側の ssh に同じ規則で選ばせる。表示用の値も同じ規則で選ぶ
    let mut options: Vec<String> = Vec::new();
    let mut last_wins: Vec<(char, String)> = Vec::new();
    let mut host: Option<String> = None;
    let mut user: Option<String> = None;
    let mut port: Option<String> = None;
    fn push_config(options: &mut Vec<String>, key: &str, value: &str) {
        options.push("-o".into());
        options.push(format!("{key}={value}"));
    }
    for arg in args {
        match arg {
            SshArg::Flag(flag) if NON_INTERACTIVE_FLAGS.contains(&flag) => return None,
            SshArg::Value(option, _) if NON_INTERACTIVE_FLAGS.contains(&option) => return None,
            SshArg::Flag(flag) => {
                if matches!(flag, '4' | '6' | 'C') {
                    options.push(format!("-{flag}"));
                }
            }
            SshArg::Destination(destination) => {
                let (dest_user, dest_host, dest_port) = parse_destination(&destination)?;
                if let Some(value) = dest_user {
                    user.get_or_insert(value.clone());
                    push_config(&mut options, "User", &value);
                }
                if let Some(value) = dest_port {
                    port.get_or_insert(value.clone());
                    push_config(&mut options, "Port", &value);
                }
                host = Some(dest_host);
            }
            SshArg::Value(option, value) => match option {
                // 相対パスの設定ファイルは ssh の作業ディレクトリで読まれる。scp からは別の
                // ファイルを読んで別のホストへ繋ぎうるので、対象にしない
                'F' if !value.starts_with('/') && !value.starts_with('~') => return None,
                'c' | 'F' | 'i' | 'J' => {
                    options.push(format!("-{option}"));
                    options.push(value);
                }
                'o' => {
                    let (key, entry) = config_entry(&value);
                    if DROPPED_CONFIG_KEYS.contains(&key.as_str()) {
                        continue;
                    }
                    if key == "user" {
                        user.get_or_insert(entry);
                    } else if key == "port" {
                        port.get_or_insert(entry);
                    }
                    options.push("-o".into());
                    options.push(value);
                }
                'l' => {
                    user.get_or_insert(value.clone());
                    push_config(&mut options, "User", &value);
                }
                'p' => {
                    port.get_or_insert(value.clone());
                    push_config(&mut options, "Port", &value);
                }
                _ => {
                    if LAST_WINS_OPTIONS.iter().any(|(o, _)| *o == option) {
                        last_wins.retain(|(o, _)| *o != option);
                        last_wins.push((option, value));
                    }
                    // 転送 (-D / -L / -R / -w)、ログ (-E)、エスケープ文字 (-e) は送るのに関係しない
                }
            },
        }
    }
    let host = host?;
    let mut front: Vec<String> = Vec::new();
    for (option, value) in last_wins {
        let (_, key) = LAST_WINS_OPTIONS.iter().find(|(o, _)| *o == option)?;
        push_config(&mut front, key, &value);
    }
    front.extend(options);

    let bracketed = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let user_prefix = user
        .as_ref()
        .map(|user| format!("{user}@"))
        .unwrap_or_default();
    let label = match &port {
        Some(port) => format!("{user_prefix}{bracketed}:{port}"),
        None => format!("{user_prefix}{host}"),
    };
    Some(SshTarget {
        label,
        options: front,
        host: bracketed,
    })
}

/// ssh の接続先 (`[user@]host` か `ssh://[user@]host[:port]`) を user / host / port に分ける
fn parse_destination(destination: &str) -> Option<(Option<String>, String, Option<String>)> {
    if destination.is_empty() || destination.starts_with('-') {
        return None;
    }
    if let Some(rest) = destination.strip_prefix("ssh://") {
        let authority = rest.split('/').next().unwrap_or(rest);
        let (user, hostport) = match authority.rsplit_once('@') {
            // URI の user は URL エンコードできる (OpenSSH の parse_uri が urldecode する)
            Some((user, hostport)) => (Some(percent_decode(user)?), hostport),
            None => (None, authority),
        };
        let (host, port) = if let Some(inner) = hostport.strip_prefix('[') {
            let (host, after) = inner.split_once(']')?;
            (
                host.to_string(),
                after.strip_prefix(':').map(str::to_string),
            )
        } else {
            match hostport.split_once(':') {
                Some((host, port)) => (host.to_string(), Some(port.to_string())),
                None => (hostport.to_string(), None),
            }
        };
        if host.is_empty() {
            return None;
        }
        return Some((user, host, port.filter(|port| !port.is_empty())));
    }
    // `user@host` の user には @ が入りうる (ssh も最後の @ で分ける)
    let (user, host) = match destination.rsplit_once('@') {
        Some((user, host)) => (Some(user.to_string()), host.to_string()),
        None => (None, destination.to_string()),
    };
    if host.is_empty() {
        return None;
    }
    Some((user, host, None))
}

/// `%XX` を戻す。不正な並びと NUL は OpenSSH の urldecode と同じく失敗にする
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            let byte = u8::from_str_radix(hex, 16).ok()?;
            if byte == 0 {
                return None;
            }
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// scp の引数 (プログラム名を除く) を組み立てる
pub fn scp_args(
    target: &SshTarget,
    sources: &[String],
    remote_dir: &str,
    recursive: bool,
) -> Vec<String> {
    let mut args = vec!["-o".to_string(), "BatchMode=yes".to_string()];
    if recursive {
        args.push("-r".into());
    }
    args.extend(target.options.iter().cloned());
    // ssh の -o は先に出た値が勝つので、ssh 側の指定より後ろに置いて既定値として効かせる。
    // 繋がらない接続先で scp (と確認ダイアログ) を待たせ続けないため
    args.extend(["-o".into(), "ConnectTimeout=15".into()]);
    args.push("--".into());
    args.extend(sources.iter().cloned());
    args.push(format!("{}:{}", target.host, remote_path(remote_dir)));
    args
}

/// 送り先のディレクトリを scp の送り先のパスにする。空と `~` はホームディレクトリ。
/// 末尾に `/` を付けて、ディレクトリが無い時にその名前のファイルを作らせない
fn remote_path(remote_dir: &str) -> String {
    let dir = remote_dir.trim();
    if dir.is_empty() || dir == "~" || dir == "~/" {
        return String::new();
    }
    if dir.ends_with('/') {
        dir.to_string()
    } else {
        format!("{dir}/")
    }
}

/// macOS の `KERN_PROCARGS2` の中身から argv と環境変数を取り出す。
/// 先頭に argc (int)、実行ファイルのパス、詰め物の NUL が続き、その後に argv と環境変数が
/// NUL 区切りで並ぶ
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_procargs2(buffer: &[u8]) -> Option<(Vec<String>, Vec<String>)> {
    let argc = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?);
    if argc <= 0 {
        return None;
    }
    let mut rest = &buffer[4..];
    let exec_end = rest.iter().position(|&b| b == 0)?;
    rest = &rest[exec_end..];
    let start = rest.iter().position(|&b| b != 0)?;
    rest = &rest[start..];
    let mut strings = rest
        .split(|&b| b == 0)
        .map(|s| String::from_utf8_lossy(s).into_owned());
    let argv: Vec<String> = strings.by_ref().take(argc as usize).collect();
    if argv.len() != argc as usize {
        return None;
    }
    let env = strings.take_while(|s| !s.is_empty()).collect();
    Some((argv, env))
}

/// 環境変数の一覧 (`KEY=value`) から 1 つ引く
pub fn env_value(env: &[String], key: &str) -> Option<String> {
    env.iter().find_map(|entry| {
        entry
            .strip_prefix(key)?
            .strip_prefix('=')
            .map(str::to_string)
    })
}

/// プロセスの argv と環境変数
#[cfg(target_os = "macos")]
pub fn process_args(pid: i32) -> Option<(Vec<String>, Vec<String>)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    // SAFETY: 大きさを問い合わせるだけ (oldp が null)
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    // SAFETY: buffer は size バイトあり、sysctl は size を書いた長さに更新する
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    buffer.truncate(size);
    parse_procargs2(&buffer)
}

#[cfg(target_os = "linux")]
pub fn process_args(pid: i32) -> Option<(Vec<String>, Vec<String>)> {
    let split = |bytes: Vec<u8>| -> Vec<String> {
        bytes
            .split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect()
    };
    let argv = split(std::fs::read(format!("/proc/{pid}/cmdline")).ok()?);
    let env = std::fs::read(format!("/proc/{pid}/environ"))
        .map(split)
        .unwrap_or_default();
    Some((argv, env))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_args(_pid: i32) -> Option<(Vec<String>, Vec<String>)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_string).collect()
    }

    fn target(line: &str) -> Option<SshTarget> {
        parse_ssh_argv(&argv(line))
    }

    #[test]
    fn plain_host() {
        let t = target("ssh example.com").unwrap();
        assert_eq!(t.label, "example.com");
        assert_eq!(t.host, "example.com");
        assert!(t.options.is_empty());
    }

    #[test]
    fn user_port_and_identity_become_scp_options_in_order() {
        let t = target("ssh -p 2222 -i /k/id -o ControlPath=/tmp/c -A user@host").unwrap();
        assert_eq!(t.label, "user@host:2222");
        assert_eq!(t.host, "host");
        assert_eq!(
            t.options,
            argv("-o Port=2222 -i /k/id -o ControlPath=/tmp/c -o User=user")
        );
    }

    #[test]
    fn combined_flags_and_attached_values() {
        let t = target("/usr/bin/ssh -tt -4p2222 -luser host").unwrap();
        assert_eq!(t.label, "user@host:2222");
        assert_eq!(t.options, argv("-4 -o Port=2222 -o User=user"));
    }

    #[test]
    fn options_after_the_destination_are_read_and_the_command_is_ignored() {
        let t = target("ssh host -p 2200 -t tmux attach -d").unwrap();
        assert_eq!(t.label, "host:2200");
        assert_eq!(t.options, argv("-o Port=2200"));
    }

    // ssh は user / port を先に出た値で決める。-o に揃えて同じ順に渡せば、内側の ssh も同じものを選ぶ
    #[test]
    fn the_first_user_and_port_win_like_ssh() {
        let t = target("ssh -l other me@host").unwrap();
        assert_eq!(t.label, "other@host");
        assert_eq!(t.options, argv("-o User=other -o User=me"));

        let t = target("ssh -p 2222 ssh://host:2022").unwrap();
        assert_eq!(t.label, "host:2222");
        assert_eq!(t.options, argv("-o Port=2222 -o Port=2022"));

        let t = target("ssh -o Port=2200 -p 2222 host").unwrap();
        assert_eq!(t.label, "host:2200");
        assert_eq!(t.options, argv("-o Port=2200 -o Port=2222"));
    }

    // -S などは ssh が後から上書きするので、最後の値を先頭の -o にして必ず勝たせる
    #[test]
    fn last_wins_options_go_first_with_the_last_value() {
        let t = target("ssh -o ControlPath=/o -S /a -S /b host").unwrap();
        assert_eq!(t.options, argv("-o ControlPath=/b -o ControlPath=/o"));
    }

    #[test]
    fn ssh_uri_with_port_and_ipv6() {
        let t = target("ssh ssh://me@[::1]:2022").unwrap();
        assert_eq!(t.label, "me@[::1]:2022");
        assert_eq!(t.host, "[::1]");
        assert_eq!(t.options, argv("-o User=me -o Port=2022"));
        let t = target("ssh ::1").unwrap();
        assert_eq!(t.host, "[::1]");
    }

    #[test]
    fn uri_user_is_percent_decoded() {
        let t = target("ssh ssh://user%40foo@localhost:22").unwrap();
        assert_eq!(t.label, "user@foo@localhost:22");
        assert_eq!(t.options, argv("-o User=user@foo -o Port=22"));
        assert!(target("ssh ssh://bad%4@host").is_none());
        assert!(target("ssh ssh://nul%00@host").is_none());
        // URI でない接続先の user はそのまま (ssh も decode しない)
        assert_eq!(target("ssh a%40b@host").unwrap().label, "a%40b@host");
    }

    #[test]
    fn connection_options_are_kept_and_others_dropped() {
        let t = target(
            "ssh -L 8080:localhost:80 -E /tmp/log -J jump -o RemoteCommand=tmux -o User=x host",
        )
        .unwrap();
        assert_eq!(t.label, "x@host");
        assert_eq!(t.options, argv("-J jump -o User=x"));
    }

    #[test]
    fn non_interactive_or_unknown_invocations_are_rejected() {
        assert!(target("ssh -G host").is_none());
        assert!(target("ssh -W host:22 jump").is_none());
        assert!(target("ssh -O check host").is_none());
        assert!(target("ssh -Z host").is_none());
        assert!(target("ssh -p").is_none());
        assert!(target("ssh").is_none());
        assert!(target("sshd -D").is_none());
        assert!(target("zsh -l").is_none());
    }

    #[test]
    fn relative_config_file_is_rejected() {
        assert!(target("ssh -F ./config alias").is_none());
        assert!(target("ssh -F config alias").is_none());
        assert!(target("ssh -F ~/.ssh/other alias").is_some());
        assert!(target("ssh -F /etc/ssh/cfg alias").is_some());
    }

    #[test]
    fn double_dash_ends_options() {
        let t = target("ssh -p 2 -- host -p 3").unwrap();
        assert_eq!(t.label, "host:2");
    }

    #[test]
    fn identity_changes_with_pid_and_hidden_options() {
        let a = target("ssh -o HostName=server-a alias").unwrap();
        let b = target("ssh -o HostName=server-b alias").unwrap();
        assert_eq!(a.label, b.label);
        assert_ne!(a.identity(10), b.identity(10));
        assert_ne!(a.identity(10), a.identity(11));
        assert_eq!(a.identity(10), a.clone().identity(10));
    }

    #[test]
    fn config_entry_accepts_both_forms() {
        assert_eq!(config_entry("Port=22"), ("port".into(), "22".into()));
        assert_eq!(config_entry("User  me "), ("user".into(), "me".into()));
        assert_eq!(config_entry("user = me"), ("user".into(), "me".into()));
    }

    #[test]
    fn scp_args_put_sources_after_double_dash() {
        let t = target("ssh -p 2222 user@host").unwrap();
        let args = scp_args(&t, &["/a b".into(), "/c".into()], " ~ ", false);
        assert_eq!(
            args,
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "Port=2222",
                "-o",
                "User=user",
                "-o",
                "ConnectTimeout=15",
                "--",
                "/a b",
                "/c",
                "host:"
            ]
        );
        let args = scp_args(&t, &["/d".into()], "/var/tmp", true);
        assert_eq!(args[2], "-r");
        assert_eq!(args.last().unwrap(), "host:/var/tmp/");
    }

    #[test]
    fn procargs2_layout() {
        let mut buffer = 2i32.to_ne_bytes().to_vec();
        buffer.extend(b"/usr/bin/ssh\0\0\0\0ssh\0host\0SSH_AUTH_SOCK=/tmp/agent\0HOME=/h\0\0junk");
        let (argv, env) = parse_procargs2(&buffer).unwrap();
        assert_eq!(argv, vec!["ssh", "host"]);
        assert_eq!(
            env_value(&env, "SSH_AUTH_SOCK").as_deref(),
            Some("/tmp/agent")
        );
        assert_eq!(env_value(&env, "HOME").as_deref(), Some("/h"));
        assert!(parse_procargs2(&0i32.to_ne_bytes()).is_none());
        assert!(parse_procargs2(&[1]).is_none());
    }
}
