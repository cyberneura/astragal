//! `~/.config/astragal/config.yaml` の読み込み。
//!
//! `config_override_command:` が書かれていれば、その行を argv に分解して実行し、
//! 標準出力の YAML を設定ツリーへ再帰マージする (queryfolio と同じ機構)。
//! 1Password 等から設定を引くための口で、シェルを介さずに実行する。

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const CONFIG_OVERRIDE_COMMAND_KEY: &str = "config_override_command";

/// config_override_command の実行タイムアウト。
/// 1Password の認証待ちで無限ハングするとアプリが永久に起動しないため必須。
const OVERRIDE_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// 設定ファイルの場所を差し替える環境変数 (開発・検証用)。
const CONFIG_PATH_ENV: &str = "ASTRAGAL_CONFIG";

/// Nerd Font には CJK グリフが無いため、フォールバックに CJK フォントを置く。
const DEFAULT_FONT_FAMILY: &str =
    "'RobotoMono Nerd Font', 'Roboto Mono', Menlo, 'Hiragino Sans', monospace";

const MAIN_WINDOW_DEFAULT: ResolvedWindow = ResolvedWindow {
    width: 900.0,
    height: 580.0,
    hide_on_blur: false,
};

const SMALL_WINDOW_DEFAULT: ResolvedWindow = ResolvedWindow {
    width: 800.0,
    height: 600.0,
    hide_on_blur: true,
};

const CONFIG_TEMPLATE: &str = r##"# Astragal config file
# https://github.com/cyberneura/astragal
#
# Only the keys you write here override the defaults.

# font:
#   # CSS font-family list passed to xterm, tried from left to right.
#   # Nerd Fonts have no CJK glyphs, so keep a CJK font in the fallbacks.
#   family: "'RobotoMono Nerd Font', Menlo, 'Hiragino Sans', monospace"
#   size: 13

# shell:
#   # Defaults to $SHELL, then /bin/zsh.
#   command: /bin/zsh
#   # Defaults to ["-l"] (login shell). An app launched from the GUI does not
#   # read .zprofile otherwise, so PATH stays minimal. Use [] to run a
#   # non-shell command.
#   args: ["-l"]
#   # Extra environment for the pty. TERM and LANG can be overridden here too.
#   env:
#     LANG: ja_JP.UTF-8

# Global hotkeys. Set an empty string to disable one.
# Modifiers: Control / Option (Alt) / Shift / Command (Cmd, Super).
# hotkeys:
#   window: "Control+Option+Command+A"
#   small_window: "Control+Shift+Option+Command+A"

# window:
#   main:
#     width: 900
#     height: 580
#     # Set to true to hide the main window when it loses focus.
#     hide_on_blur: false
#   # The popover that drops down from the menu bar icon.
#   small:
#     width: 800
#     height: 600
#     hide_on_blur: true

# xterm theme. Only the keys you write here override the default theme.
# theme:
#   background: "#181825"
#   foreground: "#cdd6f4"
#   cursor: "#f5e0dc"

# config_override_command runs a command whose stdout must be YAML, and merges
# that YAML over this file. Mappings are merged recursively; scalars and lists
# are replaced wholesale.
# It runs without a shell, so the command must be on PATH or an absolute path.
#
# config_override_command: op read "op://development/astragal/config-yaml"
"##;

// ── 設定ツリー ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub font: FontConfig,
    pub shell: ShellConfig,
    pub window: WindowsConfig,
    pub hotkeys: HotkeyConfig,
    /// xterm の theme にそのまま渡す。既定テーマの上にキー単位で被せる。
    pub theme: BTreeMap<String, String>,
}

/// グローバルホットキー。空文字・null にすると登録しない。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HotkeyConfig {
    pub window: Option<String>,
    pub small_window: Option<String>,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            window: Some("Control+Option+Command+A".to_string()),
            small_window: Some("Control+Shift+Option+Command+A".to_string()),
        }
    }
}

impl HotkeyConfig {
    pub fn window(&self) -> Option<&str> {
        shortcut(&self.window)
    }

    pub fn small_window(&self) -> Option<&str> {
        shortcut(&self.small_window)
    }
}

fn shortcut(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FontConfig {
    pub family: String,
    pub size: f32,
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            family: DEFAULT_FONT_FAMILY.to_string(),
            size: 13.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ShellConfig {
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            command: None,
            // GUI から起動したアプリの環境は最小構成で、ログインシェルとして
            // 起動しないと .zprofile 由来の PATH (Homebrew 等) が入らない。
            args: vec!["-l".to_string()],
            env: BTreeMap::new(),
        }
    }
}

impl ShellConfig {
    pub fn resolve_command(&self) -> PathBuf {
        if let Some(command) = self.command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            return expand_tilde(command);
        }
        match std::env::var("SHELL") {
            Ok(shell) if !shell.trim().is_empty() => PathBuf::from(shell),
            _ => PathBuf::from("/bin/zsh"),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WindowsConfig {
    pub main: WindowSpec,
    pub small: WindowSpec,
}

/// 未指定を既定値と区別するため Option で持つ。既定値はウインドウごとに
/// 異なる (main は隠れない / small は隠れる) ので Default では表現できない。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WindowSpec {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub hide_on_blur: Option<bool>,
}

impl WindowSpec {
    fn resolve(&self, defaults: ResolvedWindow) -> ResolvedWindow {
        ResolvedWindow {
            width: self.width.unwrap_or(defaults.width),
            height: self.height.unwrap_or(defaults.height),
            hide_on_blur: self.hide_on_blur.unwrap_or(defaults.hide_on_blur),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ResolvedWindow {
    pub width: f64,
    pub height: f64,
    pub hide_on_blur: bool,
}

impl Config {
    pub fn main_window(&self) -> ResolvedWindow {
        self.window.main.resolve(MAIN_WINDOW_DEFAULT)
    }

    pub fn small_window(&self) -> ResolvedWindow {
        self.window.small.resolve(SMALL_WINDOW_DEFAULT)
    }
}

// ── 読み込み ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub config: Config,
    pub path: PathBuf,
    /// 設定を読めなかった理由。起動は止めず、フロントで警告として表示する。
    pub warning: Option<String>,
}

/// 設定を読み込む。失敗しても既定値で起動を続け、理由を warning に載せる
/// (設定ミスでターミナルが一切開けなくなる方が困る)。
pub fn load() -> LoadedConfig {
    let path = config_path();
    match load_from(&path) {
        Ok((config, warning)) => LoadedConfig {
            config,
            path,
            warning,
        },
        Err(warning) => LoadedConfig {
            config: Config::default(),
            path,
            warning: Some(warning),
        },
    }
}

fn load_from(path: &Path) -> Result<(Config, Option<String>), String> {
    let mut warning = ensure_config_file(path).err();

    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut doc = parse_mapping(&text, &path.display().to_string())?;

    match override_command(&doc) {
        Ok(Some(command)) => match fetch_override(&command) {
            Ok(overrides) => merge_mapping(&mut doc, &overrides),
            // 取得できなくてもローカルの設定で起動する。黙って落とすと
            // 「上書きが効いていない」ことに気付けないので warning に残す。
            Err(e) => warning = Some(e),
        },
        Ok(None) => {}
        Err(e) => warning = Some(e),
    }
    // 適用済みなので落とす (取得 YAML 側が持っていても再帰取得はしない)。
    doc.remove(CONFIG_OVERRIDE_COMMAND_KEY);

    let config = serde_yaml::from_value::<Config>(Value::Mapping(doc))
        .map_err(|e| format!("Invalid config in {}: {e}", path.display()))?;
    Ok((config, warning))
}

fn fetch_override(command: &str) -> Result<Mapping, String> {
    let yaml = run_override_command(command, OVERRIDE_COMMAND_TIMEOUT)?;
    parse_mapping(&yaml, &format!("{CONFIG_OVERRIDE_COMMAND_KEY}: {command}"))
}

pub fn config_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".config").join("astragal")
}

/// 読み込む設定ファイルのパス。config.yaml を優先し、無ければ config.yml、
/// どちらも無ければ (これから作る) config.yaml を返す。
pub fn config_path() -> PathBuf {
    if let Some(path) = std::env::var_os(CONFIG_PATH_ENV) {
        let path = PathBuf::from(path);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    let dir = config_dir();
    let yaml = dir.join("config.yaml");
    if yaml.exists() {
        return yaml;
    }
    let yml = dir.join("config.yml");
    if yml.exists() {
        return yml;
    }
    yaml
}

/// 設定ファイルが無ければテンプレートを置く。中身は全てコメントなので、
/// 読み直しても既定値のままになる。
fn ensure_config_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    }
    std::fs::write(path, CONFIG_TEMPLATE)
        .map_err(|e| format!("Failed to create {}: {e}", path.display()))
}

fn parse_mapping(text: &str, source: &str) -> Result<Mapping, String> {
    let value: Value = serde_yaml::from_str(text)
        .map_err(|e| format!("Failed to parse YAML from {source}: {e}"))?;
    match value {
        // 全行コメント / 空ファイルは「何も上書きしない」として扱う。
        Value::Null => Ok(Mapping::new()),
        Value::Mapping(mapping) => Ok(mapping),
        _ => Err(format!("{source} is not a YAML mapping")),
    }
}

fn override_command(doc: &Mapping) -> Result<Option<String>, String> {
    let Some(value) = doc.get(CONFIG_OVERRIDE_COMMAND_KEY) else {
        return Ok(None);
    };
    let command = value
        .as_str()
        .map(str::trim)
        .ok_or_else(|| format!("{CONFIG_OVERRIDE_COMMAND_KEY} must be a string"))?;
    if command.is_empty() {
        return Err(format!("{CONFIG_OVERRIDE_COMMAND_KEY} is empty"));
    }
    Ok(Some(command.to_string()))
}

/// mapping 同士は再帰的に混ぜ、スカラーとリストは丸ごと置き換える
/// (リストの要素単位マージは「同じ項目」を決められないので行わない)。
fn merge_mapping(base: &mut Mapping, overrides: &Mapping) {
    for (key, over_value) in overrides {
        match (base.get_mut(key), over_value) {
            (Some(Value::Mapping(base_map)), Value::Mapping(over_map)) => {
                merge_mapping(base_map, over_map);
            }
            _ => {
                base.insert(key.clone(), over_value.clone());
            }
        }
    }
}

fn run_override_command(command: &str, timeout: Duration) -> Result<String, String> {
    let argv = shlex::split(command).ok_or_else(|| {
        format!("Failed to parse {CONFIG_OVERRIDE_COMMAND_KEY} (unbalanced quotes?): {command}")
    })?;
    let Some((program, args)) = argv.split_first() else {
        return Err(format!("{CONFIG_OVERRIDE_COMMAND_KEY} is empty"));
    };

    let mut child = Command::new(program)
        .args(args)
        // Finder / Dock から起動した GUI の PATH は最小構成で、Homebrew の
        // op 等が見つからないため定番パスを補う。
        .env("PATH", supplemented_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {CONFIG_OVERRIDE_COMMAND_KEY}: {command}: {e}"))?;

    // パイプが埋まって子がブロックしないよう、待つ前から読み出しておく。
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || read_all(&mut stdout_pipe));
    let stderr_reader = std::thread::spawn(move || read_all(&mut stderr_pipe));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    // 認証待ちでハングした子を残すと、再起動のたびに増える。
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{CONFIG_OVERRIDE_COMMAND_KEY} timed out ({}s): {command} \
                         (it may be waiting on a 1Password or other auth prompt)",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("Failed to wait for {command}: {e}")),
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();

    if !status.success() {
        return Err(format!(
            "{CONFIG_OVERRIDE_COMMAND_KEY} exited with an error (code={:?}): {command}\nstderr: {}",
            status.code(),
            stderr.trim()
        ));
    }
    if stdout.trim().is_empty() {
        return Err(format!(
            "{CONFIG_OVERRIDE_COMMAND_KEY} produced no output: {command}"
        ));
    }
    Ok(stdout)
}

fn read_all<R: Read>(pipe: &mut Option<R>) -> String {
    let mut buffer = Vec::new();
    if let Some(pipe) = pipe.as_mut() {
        let _ = pipe.read_to_end(&mut buffer);
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

fn supplemented_path() -> String {
    supplement_path(&std::env::var("PATH").unwrap_or_default())
}

fn supplement_path(base: &str) -> String {
    let mut path = base.to_string();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if base.split(':').any(|entry| entry == extra) {
            continue;
        }
        if !path.is_empty() {
            path.push(':');
        }
        path.push_str(extra);
    }
    path
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(yaml: &str) -> Mapping {
        parse_mapping(yaml, "test").expect("should parse")
    }

    fn child<'a>(map: &'a Mapping, key: &str) -> &'a Mapping {
        map.get(key)
            .and_then(Value::as_mapping)
            .unwrap_or_else(|| panic!("{key} should be a mapping"))
    }

    #[test]
    fn merge_is_recursive_for_mappings() {
        // Arrange
        let mut base = mapping("font:\n  family: Menlo\n  size: 13\nshell:\n  args: ['-l']\n");
        let overrides = mapping("font:\n  size: 20\n");

        // Act
        merge_mapping(&mut base, &overrides);

        // Assert
        let font = child(&base, "font");
        assert_eq!(font.get("family").and_then(Value::as_str), Some("Menlo"));
        assert_eq!(font.get("size").and_then(Value::as_i64), Some(20));
        assert!(base.contains_key("shell"));
    }

    #[test]
    fn merge_replaces_lists_wholesale() {
        // Arrange
        let mut base = mapping("shell:\n  args: ['-l', '-i']\n");
        let overrides = mapping("shell:\n  args: ['-c', 'true']\n");

        // Act
        merge_mapping(&mut base, &overrides);

        // Assert
        let args = child(&base, "shell")
            .get("args")
            .and_then(Value::as_sequence)
            .expect("args should be a list");
        assert_eq!(args.len(), 2);
        assert_eq!(args[0].as_str(), Some("-c"));
    }

    #[test]
    fn empty_document_is_an_empty_mapping() {
        // Arrange
        let text = "# comments only\n";

        // Act
        let parsed = parse_mapping(text, "test").expect("should parse");

        // Assert
        assert!(parsed.is_empty());
    }

    #[test]
    fn non_mapping_document_is_rejected() {
        // Arrange
        let text = "- a\n- b\n";

        // Act
        let parsed = parse_mapping(text, "test");

        // Assert
        assert!(parsed.unwrap_err().contains("not a YAML mapping"));
    }

    #[test]
    fn partial_config_keeps_defaults() {
        // Arrange
        let doc = mapping("font:\n  size: 18\n");

        // Act
        let config: Config = serde_yaml::from_value(Value::Mapping(doc)).expect("should parse");

        // Assert
        assert_eq!(config.font.size, 18.0);
        assert_eq!(config.font.family, DEFAULT_FONT_FAMILY);
        assert_eq!(config.shell.args, vec!["-l".to_string()]);
    }

    #[test]
    fn unknown_key_is_rejected() {
        // Arrange
        let doc = mapping("fnot:\n  size: 18\n");

        // Act
        let parsed = serde_yaml::from_value::<Config>(Value::Mapping(doc));

        // Assert
        assert!(parsed.is_err());
    }

    #[test]
    fn window_defaults_differ_per_window() {
        // Arrange
        let doc = mapping("window:\n  small:\n    width: 600\n");
        let config: Config = serde_yaml::from_value(Value::Mapping(doc)).expect("should parse");

        // Act
        let main = config.main_window();
        let small = config.small_window();

        // Assert
        assert!(!main.hide_on_blur);
        assert!(small.hide_on_blur);
        assert_eq!(small.width, 600.0);
        assert_eq!(small.height, SMALL_WINDOW_DEFAULT.height);
    }

    #[test]
    fn shell_command_falls_back_when_unset() {
        // Arrange
        let config = ShellConfig {
            command: Some("  ".to_string()),
            ..ShellConfig::default()
        };

        // Act
        let resolved = config.resolve_command();

        // Assert
        let expected = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        assert_eq!(resolved, PathBuf::from(expected));
    }

    #[test]
    fn override_command_output_is_merged_over_the_file() {
        // Arrange
        let mut base = mapping("font:\n  family: Menlo\n  size: 13\n");
        let command = r#"/bin/echo {"font": {"size": 20}}"#;

        // Act
        let overrides = fetch_override(command).expect("should fetch");
        merge_mapping(&mut base, &overrides);

        // Assert
        let font = child(&base, "font");
        assert_eq!(font.get("size").and_then(Value::as_i64), Some(20));
        assert_eq!(font.get("family").and_then(Value::as_str), Some("Menlo"));
    }

    #[test]
    fn override_command_with_no_output_is_rejected() {
        // Arrange
        let command = "/usr/bin/true";

        // Act
        let result = run_override_command(command, Duration::from_secs(10));

        // Assert
        assert!(result.unwrap_err().contains("produced no output"));
    }

    #[test]
    fn override_command_times_out() {
        // Arrange
        let command = "/bin/sleep 30";

        // Act
        let result = run_override_command(command, Duration::from_millis(100));

        // Assert
        assert!(result.unwrap_err().contains("timed out"));
    }

    #[test]
    fn override_command_failure_reports_stderr() {
        // Arrange
        let command = "/bin/sh -c 'echo boom >&2; exit 3'";

        // Act
        let result = run_override_command(command, Duration::from_secs(10));

        // Assert
        let error = result.unwrap_err();
        assert!(error.contains("code=Some(3)"));
        assert!(error.contains("boom"));
    }

    #[test]
    fn unbalanced_quotes_are_reported() {
        // Arrange
        let command = "op read \"op://unclosed";

        // Act
        let result = run_override_command(command, Duration::from_secs(10));

        // Assert
        assert!(result.unwrap_err().contains("unbalanced quotes"));
    }

    /// テスト用の一時ディレクトリ (テストごとに別名にする)。
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("astragal-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("should create temp dir");
        dir
    }

    #[test]
    fn missing_config_file_is_created_from_the_template() {
        // Arrange
        let path = temp_dir("template").join("config.yaml");

        // Act
        let (config, warning) = load_from(&path).expect("should load");

        // Assert
        assert!(path.exists());
        assert!(warning.is_none());
        assert_eq!(config.font.family, DEFAULT_FONT_FAMILY);
    }

    #[test]
    fn override_command_result_is_applied_to_the_file() {
        // Arrange
        let path = temp_dir("override").join("config.yaml");
        std::fs::write(
            &path,
            "font:\n  size: 13\n  family: Menlo\n\
             config_override_command: '/bin/echo {\"font\": {\"size\": 22}}'\n",
        )
        .expect("should write config");

        // Act
        let (config, warning) = load_from(&path).expect("should load");

        // Assert
        assert_eq!(config.font.size, 22.0);
        assert_eq!(config.font.family, "Menlo");
        assert!(warning.is_none(), "unexpected warning: {warning:?}");
    }

    #[test]
    fn failing_override_command_keeps_the_local_config() {
        // Arrange
        let path = temp_dir("override-fails").join("config.yaml");
        std::fs::write(
            &path,
            "font:\n  size: 17\nconfig_override_command: /usr/bin/false\n",
        )
        .expect("should write config");

        // Act
        let (config, warning) = load_from(&path).expect("should load");

        // Assert
        assert_eq!(config.font.size, 17.0);
        assert!(warning.expect("should warn").contains("exited with an error"));
    }

    #[test]
    fn path_is_supplemented_without_duplicates() {
        // Arrange
        let base = "/usr/bin:/opt/homebrew/bin";

        // Act
        let supplemented = supplement_path(base);

        // Assert
        assert_eq!(supplemented, "/usr/bin:/opt/homebrew/bin:/usr/local/bin");
    }
}
