//! Settings ウインドウ (CYBERNEURA-DEV-1297) が使う設定ファイルの読み書き。
//!
//! 方針 (Flashcap の Preferences と同じ):
//! - GUI が読み書きするのはローカルの設定ファイルだけ。`config_override_command` が出す値
//!   (1Password 等から引いた秘密) はマージ前のローカルの値と混ぜず、ファイルへ書き戻さない。
//!   上書きされているキーは保存時に「ファイルにあった値」をそのまま残す
//! - 読めないファイル (YAML の誤り・未知のキー) は書き換えない。テキスト編集で直してもらう
//! - 書き込みは直列化し、同じディレクトリの一時ファイルから rename で置き換える。
//!   symlink はリンク先を書き換える (dotfiles 管理のリンクを実ファイルで潰さない)
//! - 構造から書き直すのでコメントは消える。初回の上書き前に `<name>.bak` を残す
//! - API キーの値は webview に渡さない。「設定されているか」だけを返す

use crate::config::{self, Config, CONFIG_OVERRIDE_COMMAND_KEY};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;

/// 書き込みを直列化する (保存ボタンの連打やテキスト保存との競合で中途半端な内容を書かない)。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 秘密として扱うキー。値は webview に渡さず、保存時は明示的な変更が無ければファイルの値を残す
const AI_API_KEY: &str = "ai.api_key";
const TAB_SUMMARY_API_KEY: &str = "tab_summary.api_key";

/// GUI で保存したファイルの先頭に付ける行。コメント検出 (`has_hand_written_comments`) では
/// テンプレートの行と同じく「手書きではない」とみなす
const SAVED_HEADER: &str = "# Astragal config file (saved from Settings…).\n\
# Every option is described in https://github.com/cyberneura/astragal#configuration\n";

/// コンテキストに含めるターン数の上限 (README の agent_chat の説明と同じ)
const MAX_CONTEXT_TURNS: usize = 20;

#[derive(Debug, Clone, Serialize)]
pub struct SecretState {
    /// ローカルの設定ファイルに値が書かれているか
    pub in_file: bool,
    /// config_override_command が値を出しているか
    pub overridden: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowDefaults {
    pub main: config::ResolvedWindow,
    pub small: config::ResolvedWindow,
}

/// Settings ウインドウを開いた時に渡す内容。
#[derive(Debug, Clone, Serialize)]
pub struct SettingsSnapshot {
    pub path: String,
    /// ファイルを読めない理由。Some の時は GUI で編集させない (テキスト編集へ誘導する)
    pub error: Option<String>,
    /// ローカルの設定ファイルの値 (override 前)。API キーは空にしてある
    pub config: Option<Config>,
    pub defaults: Config,
    pub window_defaults: WindowDefaults,
    pub override_command: String,
    /// config_override_command が上書きしているキー (起動時に読んだ結果)
    pub overridden: Vec<String>,
    pub ai_api_key: SecretState,
    pub tab_summary_api_key: SecretState,
    /// 手で書いたコメントがあるか。保存前に一度確認する
    pub has_comments: bool,
    pub min_interval_seconds: u64,
    pub max_context_turns: usize,
}

/// API キーの欄の変更。`Keep` はファイルにある値をそのまま残す。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "action", content = "value", rename_all = "lowercase")]
pub enum SecretChange {
    Keep,
    Set(String),
    Clear,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveRequest {
    pub config: Config,
    pub override_command: String,
    pub ai_api_key: SecretChange,
    pub tab_summary_api_key: SecretChange,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FieldError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveOutcome {
    /// 今回の保存で初めて作ったバックアップのパス
    pub backup: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SaveError {
    /// 入力の誤り。どの欄かを返して、その場に出してもらう
    Invalid { errors: Vec<FieldError> },
    /// ファイルの読み書きの失敗
    Failed { message: String },
}

impl From<String> for SaveError {
    fn from(message: String) -> Self {
        SaveError::Failed { message }
    }
}

// ── 読み込み ─────────────────────────────────────────────────────────────────

pub fn snapshot(path: &Path, overridden: &[String]) -> SettingsSnapshot {
    let defaults = Config::default();
    let secret = |key: &str, local: Option<&Mapping>| SecretState {
        in_file: local
            .and_then(|doc| get_path(doc, key))
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty()),
        overridden: overridden.iter().any(|path| path == key),
    };
    let base = SettingsSnapshot {
        path: path.display().to_string(),
        error: None,
        config: None,
        defaults,
        window_defaults: WindowDefaults {
            main: config::MAIN_WINDOW_DEFAULT,
            small: config::SMALL_WINDOW_DEFAULT,
        },
        override_command: String::new(),
        overridden: overridden.to_vec(),
        ai_api_key: secret(AI_API_KEY, None),
        tab_summary_api_key: secret(TAB_SUMMARY_API_KEY, None),
        has_comments: false,
        min_interval_seconds: config::MIN_TAB_SUMMARY_INTERVAL_SECS,
        max_context_turns: MAX_CONTEXT_TURNS,
    };
    match read_local(path) {
        Ok((text, doc, mut local)) => {
            local.ai.api_key.clear();
            local.tab_summary.api_key.clear();
            SettingsSnapshot {
                config: Some(local),
                override_command: doc
                    .get(CONFIG_OVERRIDE_COMMAND_KEY)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                ai_api_key: secret(AI_API_KEY, Some(&doc)),
                tab_summary_api_key: secret(TAB_SUMMARY_API_KEY, Some(&doc)),
                has_comments: has_hand_written_comments(&text),
                ..base
            }
        }
        Err(error) => SettingsSnapshot {
            error: Some(error),
            ..base
        },
    }
}

/// ローカルの設定ファイルを読む (override は実行しない)。無いファイルは空として扱う。
fn read_local(path: &Path) -> Result<(String, Mapping, Config), String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Failed to read {}: {e}", path.display())),
    };
    let doc = config::parse_mapping(&text, &path.display().to_string())?;
    config::override_command(&doc)?;
    let local = config::parse_config(doc.clone(), path)?;
    Ok((text, doc, local))
}

/// テンプレートと GUI の見出し以外のコメントがあるか。
///
/// 行頭のコメントに加えて、値の後ろの ` #` も数える (引用符の中の `#` を誤検出しうるが、
/// 確認ダイアログが 1 回余計に出るだけなので安全側)。
fn has_hand_written_comments(text: &str) -> bool {
    let known: std::collections::HashSet<&str> = config::CONFIG_TEMPLATE
        .lines()
        .chain(SAVED_HEADER.lines())
        .map(str::trim)
        .collect();
    text.lines().map(str::trim).any(|line| {
        if line.starts_with('#') {
            return !known.contains(line);
        }
        line.contains(" #") || line.contains("\t#")
    })
}

// ── 検査 ─────────────────────────────────────────────────────────────────────

/// 保存できない値を欄ごとに返す。起動時の `sanitize` は黙って既定値に戻すが、
/// GUI では保存せずにその場で直してもらう。
pub fn validate(config: &Config, override_command: &str) -> Vec<FieldError> {
    let mut errors = Vec::new();
    let mut push = |path: &str, message: String| {
        errors.push(FieldError {
            path: path.to_string(),
            message,
        })
    };

    if config.font.family.trim().is_empty() {
        push("font.family", "Enter at least one font name.".into());
    }
    if !(config.font.size.is_finite() && config.font.size > 0.0) {
        push("font.size", "Must be a number greater than 0.".into());
    }
    for (name, spec) in [
        ("main", &config.window.main),
        ("small", &config.window.small),
    ] {
        for (field, value) in [("width", spec.width), ("height", spec.height)] {
            if let Some(size) = value {
                if !(size.is_finite() && size > 0.0) {
                    push(
                        &format!("window.{name}.{field}"),
                        "Must be a number greater than 0, or empty for the default.".into(),
                    );
                }
            }
        }
    }
    for (path, value) in [
        ("hotkeys.window", &config.hotkeys.window),
        ("hotkeys.small_window", &config.hotkeys.small_window),
    ] {
        let Some(shortcut) = value.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if let Err(e) = tauri_plugin_global_shortcut::Shortcut::from_str(shortcut) {
            push(path, format!("Not a valid shortcut: {e}"));
        }
    }
    for key in config.shell.env.keys() {
        if key.trim().is_empty() || key.contains('=') || key.contains('\0') {
            push(
                "shell.env",
                format!("{key:?} is not a valid environment variable name."),
            );
        }
    }
    for (key, value) in &config.theme {
        if key.trim().is_empty() || value.trim().is_empty() {
            push(
                "theme",
                "Every theme entry needs a name and a value.".into(),
            );
            break;
        }
    }
    if config.ai.model.trim().is_empty() {
        push("ai.model", "Enter a model name.".into());
    }
    if config.tab_summary.interval_seconds < config::MIN_TAB_SUMMARY_INTERVAL_SECS {
        push(
            "tab_summary.interval_seconds",
            format!(
                "Must be at least {} seconds.",
                config::MIN_TAB_SUMMARY_INTERVAL_SECS
            ),
        );
    }
    if config.agent_chat.context_turns > MAX_CONTEXT_TURNS {
        push(
            "agent_chat.context_turns",
            format!("Must be between 0 and {MAX_CONTEXT_TURNS}."),
        );
    }
    let command = override_command.trim();
    if !command.is_empty() && shlex::split(command).is_none_or(|argv| argv.is_empty()) {
        push(
            CONFIG_OVERRIDE_COMMAND_KEY,
            "Could not split the command line (unbalanced quotes?).".into(),
        );
    }
    errors
}

// ── 書き込み ─────────────────────────────────────────────────────────────────

/// `path` そのもの・親・子のどれかが override されているか (フロントの `isOverridden` と同じ判定)。
fn is_overridden(path: &str, overridden: &[String]) -> bool {
    overridden.iter().any(|key| {
        key == path || key.starts_with(&format!("{path}.")) || path.starts_with(&format!("{key}."))
    })
}

/// GUI の内容でファイルを書き直す。
pub fn save(
    path: &Path,
    request: &SaveRequest,
    overridden: &[String],
) -> Result<SaveOutcome, SaveError> {
    let mut errors = validate(&request.config, &request.override_command);
    // override されているキーはファイルの値を残すだけなので検査しない。ファイルの値が不正でも
    // 起動時は override の値で動いており、GUI では読み取り専用で直せないため
    errors.retain(|error| !is_overridden(&error.path, overridden));
    if !errors.is_empty() {
        return Err(SaveError::Invalid { errors });
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = write_target(path)?;
    // 読めないファイルは書き換えない (直すのは利用者で、GUI が中身を推測で捨てない)
    let (_, old_doc, _) = read_local(&target).map_err(|e| {
        format!("{e}\nAstragal does not overwrite a file it cannot read. Fix it with Edit as Text.")
    })?;
    let doc = build_document(request, &old_doc, overridden)?;
    // 書く前に、起動時と同じ読み方で読めることを確かめる
    config::parse_config(doc.clone(), &target)?;
    let yaml = serde_yaml::to_string(&Value::Mapping(doc))
        .map_err(|e| format!("Failed to write the settings as YAML: {e}"))?;
    let text = if yaml.trim() == "{}" {
        SAVED_HEADER.to_string()
    } else {
        format!("{SAVED_HEADER}{yaml}")
    };
    let backup = write_with_backup(&target, &text)?;
    Ok(SaveOutcome { backup })
}

/// テキスト編集の内容で書き直す。起動時と同じ読み方 (override は除く) で読めないものは書かない。
pub fn save_text(path: &Path, text: &str) -> Result<SaveOutcome, SaveError> {
    let source = path.display().to_string();
    let doc = config::parse_mapping(text, &source)?;
    config::override_command(&doc)?;
    config::parse_config(doc, path)?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = write_target(path)?;
    let backup = write_with_backup(&target, text)?;
    Ok(SaveOutcome { backup })
}

/// テキスト編集に出すファイルの中身。無ければ空。
pub fn read_text(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Failed to read {}: {e}", path.display())),
    }
}

/// 保存する YAML の木を作る。既定値と同じ値は書かない (「書いたキーだけが既定値を上書きする」
/// というファイルの約束を保つ)。上書きされているキーと、変更の無い API キーはファイルの値を残す。
fn build_document(
    request: &SaveRequest,
    old_doc: &Mapping,
    overridden: &[String],
) -> Result<Mapping, String> {
    let mut config = request.config.clone();
    // null は「ホットキーを使わない」の意味だが、既定値と比べて落とす処理で消えると
    // 既定のホットキーが戻ってしまう。空文字 (同じく無効) で書く
    for hotkey in [&mut config.hotkeys.window, &mut config.hotkeys.small_window] {
        if hotkey.is_none() {
            *hotkey = Some(String::new());
        }
    }
    config.ai.api_key.clear();
    config.tab_summary.api_key.clear();

    let mut doc = to_mapping(&config)?;
    let defaults = to_mapping(&Config::default())?;
    prune_defaults(&mut doc, &defaults);

    for (key, change) in [
        (AI_API_KEY, &request.ai_api_key),
        (TAB_SUMMARY_API_KEY, &request.tab_summary_api_key),
    ] {
        match change {
            SecretChange::Keep => copy_path(&mut doc, old_doc, key),
            SecretChange::Set(value) if !value.trim().is_empty() => {
                set_path(&mut doc, key, Value::String(value.trim().to_string()))
            }
            SecretChange::Set(_) | SecretChange::Clear => remove_path(&mut doc, key),
        }
    }
    // override されているキーは GUI の値ではなくファイルにあった値を残す。GUI は読み取り専用に
    // しているが、マージ後の値が紛れ込んでもローカルへ書き戻さないためにここでも揃える
    for key in overridden {
        copy_path(&mut doc, old_doc, key);
    }

    let command = request.override_command.trim();
    if !command.is_empty() {
        doc.insert(
            Value::String(CONFIG_OVERRIDE_COMMAND_KEY.to_string()),
            Value::String(command.to_string()),
        );
    }
    Ok(doc)
}

fn to_mapping(config: &Config) -> Result<Mapping, String> {
    match serde_yaml::to_value(config) {
        Ok(Value::Mapping(map)) => Ok(map),
        Ok(_) => Err("The settings did not serialize to a mapping".to_string()),
        Err(e) => Err(format!("Failed to serialize the settings: {e}")),
    }
}

/// 既定値と同じ値・null・空になった mapping を落とす。
fn prune_defaults(doc: &mut Mapping, defaults: &Mapping) {
    let keys: Vec<Value> = doc.keys().cloned().collect();
    for key in keys {
        let default = defaults.get(&key);
        let remove = match doc.get_mut(&key) {
            Some(Value::Null) => true,
            Some(Value::Mapping(child)) => {
                match default {
                    Some(Value::Mapping(default_child)) => prune_defaults(child, default_child),
                    _ => prune_defaults(child, &Mapping::new()),
                }
                child.is_empty()
            }
            Some(value) => default == Some(value),
            None => false,
        };
        if remove {
            doc.remove(&key);
        }
    }
}

fn split_path(path: &str) -> Vec<Value> {
    path.split('.')
        .map(|part| Value::String(part.to_string()))
        .collect()
}

fn get_path<'a>(doc: &'a Mapping, path: &str) -> Option<&'a Value> {
    let parts = split_path(path);
    let (last, parents) = parts.split_last()?;
    let mut map = doc;
    for part in parents {
        map = map.get(part)?.as_mapping()?;
    }
    map.get(last)
}

fn set_path(doc: &mut Mapping, path: &str, value: Value) {
    let parts = split_path(path);
    let Some((last, parents)) = parts.split_last() else {
        return;
    };
    let mut map = doc;
    for part in parents {
        let entry = map
            .entry(part.clone())
            .or_insert_with(|| Value::Mapping(Mapping::new()));
        if !entry.is_mapping() {
            *entry = Value::Mapping(Mapping::new());
        }
        map = entry.as_mapping_mut().expect("just made a mapping");
    }
    map.insert(last.clone(), value);
}

/// キーを消し、空になった親の mapping も消す。
fn remove_path(doc: &mut Mapping, path: &str) {
    fn walk(map: &mut Mapping, parts: &[Value]) {
        let Some((first, rest)) = parts.split_first() else {
            return;
        };
        if rest.is_empty() {
            map.remove(first);
            return;
        }
        let empty = match map.get_mut(first).and_then(Value::as_mapping_mut) {
            Some(child) => {
                walk(child, rest);
                child.is_empty()
            }
            None => false,
        };
        if empty {
            map.remove(first);
        }
    }
    walk(doc, &split_path(path));
}

/// `from` にある値を `to` へ写す。`from` に無ければ `to` からも消す。
fn copy_path(to: &mut Mapping, from: &Mapping, path: &str) {
    match get_path(from, path) {
        Some(value) => set_path(to, path, value.clone()),
        None => remove_path(to, path),
    }
}

/// 書き込む実ファイル。symlink ならリンク先を書く。
fn write_target(path: &Path) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::canonicalize(path).map_err(|e| {
            format!(
                "{} is a symbolic link whose target cannot be resolved: {e}",
                path.display()
            )
        }),
        _ => Ok(path.to_path_buf()),
    }
}

fn backup_path(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "config.yaml".into());
    name.push(".bak");
    target.with_file_name(name)
}

/// 初回だけバックアップを残してから、一時ファイル + rename で置き換える。
fn write_with_backup(target: &Path, text: &str) -> Result<Option<String>, String> {
    let dir = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

    let mut backup = None;
    if target.exists() {
        let bak = backup_path(target);
        // symlink_metadata で見る (壊れた symlink を「無い」とみなしてリンク先へ書かない)
        if std::fs::symlink_metadata(&bak).is_err() {
            std::fs::copy(target, &bak).map_err(|e| {
                format!(
                    "Failed to back up {} to {}: {e}",
                    target.display(),
                    bak.display()
                )
            })?;
            backup = Some(bak.display().to_string());
        }
    }

    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config.yaml".to_string());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{file_name}.{}-{nanos}.tmp", std::process::id()));
    // create_new: 既にあるファイルや symlink を開かない (置かれたリンク経由で別のファイルを壊さない)。
    // API キーを書くこともあるので、作る時点で所有者だけが読める権限にする
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(&tmp)
        .map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        // 既存のファイルがあればその権限を引き継ぐ (無ければ 0600 のまま)
        if let Ok(meta) = std::fs::metadata(target) {
            file.set_permissions(meta.permissions())?;
        }
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, target)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Failed to write {}: {e}", target.display()));
    }
    Ok(backup)
}

// ── config_override_command のテスト実行 ─────────────────────────────────────

/// override のコマンドを実行し、上書きするキーの数だけを返す (値は返さない)。
///
/// マージ後に使えない値が混ざっていれば失敗にするが、serde のメッセージは値を含みうる
/// (`invalid type: string "sk-…"`) のでキーの名前だけを返す。
pub fn test_override(path: &Path, command: &str) -> Result<usize, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Enter a command first.".to_string());
    }
    // エラーはコマンド全文を含む (`echo` で YAML を出すコマンドなら値そのもの) ので、伏せて返す
    let overrides =
        config::fetch_override(command).map_err(|e| e.replace(command, "<the command>"))?;
    let keys = config::leaf_paths(&overrides);
    let mut doc = match read_local(path) {
        Ok((_, doc, _)) => doc,
        Err(_) => Mapping::new(),
    };
    config::merge_mapping(&mut doc, &overrides);
    if config::parse_config(doc, path).is_err() {
        return Err(format!(
            "The command printed {} key(s), but Astragal cannot use the result (an unknown key \
             or a value of the wrong type). Keys: {}",
            keys.len(),
            keys.join(", ")
        ));
    }
    Ok(keys.len())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("astragal-settings-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("should create temp dir");
        dir
    }

    fn request(config: Config) -> SaveRequest {
        SaveRequest {
            config,
            override_command: String::new(),
            ai_api_key: SecretChange::Keep,
            tab_summary_api_key: SecretChange::Keep,
        }
    }

    fn reload(path: &Path) -> Config {
        read_local(path).expect("saved file should load").2
    }

    #[test]
    fn saved_settings_round_trip() {
        // Arrange
        let path = temp_dir("round-trip").join("config.yaml");
        let mut config = Config::default();
        config.font.size = 17.0;
        config.font.family = "Menlo".into();
        config.shell.command = Some("/bin/bash".into());
        config.shell.env.insert("LANG".into(), "ja_JP.UTF-8".into());
        config.window.small.width = Some(640.0);
        config.window.main.hide_on_blur = Some(true);
        config.theme.insert("background".into(), "#000000".into());
        config.tab_summary.enabled = true;
        config.tab_summary.interval_seconds = 300;
        config.agent_chat.blacklist = vec!["secret".into()];

        // Act
        save(&path, &request(config.clone()), &[]).expect("should save");

        // Assert
        let loaded = reload(&path);
        assert_eq!(
            serde_yaml::to_value(&loaded).unwrap(),
            serde_yaml::to_value(&config).unwrap()
        );
    }

    #[test]
    fn only_values_different_from_the_defaults_are_written() {
        // Arrange
        let path = temp_dir("minimal").join("config.yaml");
        let mut config = Config::default();
        config.font.size = 15.0;

        // Act
        save(&path, &request(config), &[]).expect("should save");

        // Assert
        let text = std::fs::read_to_string(&path).unwrap();
        let doc = config::parse_mapping(&text, "test").unwrap();
        assert_eq!(config::leaf_paths(&doc), vec!["font.size".to_string()]);
    }

    #[test]
    fn disabled_hotkey_stays_disabled() {
        // Arrange
        let path = temp_dir("hotkey").join("config.yaml");
        let mut config = Config::default();
        config.hotkeys.window = None;

        // Act
        save(&path, &request(config), &[]).expect("should save");

        // Assert
        assert!(reload(&path).hotkeys.window().is_none());
        assert!(reload(&path).hotkeys.small_window().is_some());
    }

    #[test]
    fn overridden_keys_keep_the_local_value() {
        // Arrange
        let path = temp_dir("override").join("config.yaml");
        std::fs::write(&path, "font:\n  size: 13.5\n").unwrap();
        let mut config = Config::default();
        // マージ後の値 (override が出した値) が送られてきたとする
        config.font.size = 30.0;
        config.font.family = "Menlo".into();
        let overridden = vec!["font.size".to_string(), "theme.background".to_string()];
        config.theme.insert("background".into(), "#123456".into());

        // Act
        save(&path, &request(config), &overridden).expect("should save");

        // Assert
        let loaded = reload(&path);
        assert_eq!(loaded.font.size, 13.5);
        assert_eq!(loaded.font.family, "Menlo");
        assert!(!loaded.theme.contains_key("background"));
    }

    #[test]
    fn api_keys_are_kept_unless_changed() {
        // Arrange
        let path = temp_dir("secret-keep").join("config.yaml");
        std::fs::write(&path, "ai:\n  api_key: sk-local\n").unwrap();
        let snapshot = snapshot(&path, &[]);
        let config = snapshot.config.clone().expect("should read");

        // Act
        save(&path, &request(config), &[]).expect("should save");

        // Assert
        assert_eq!(
            snapshot.config.unwrap().ai.api_key,
            "",
            "the key must not reach the webview"
        );
        assert!(snapshot.ai_api_key.in_file);
        assert_eq!(reload(&path).ai.api_key, "sk-local");
    }

    #[test]
    fn api_keys_can_be_set_and_cleared() {
        // Arrange
        let path = temp_dir("secret-change").join("config.yaml");
        std::fs::write(&path, "ai:\n  api_key: sk-old\n").unwrap();
        let mut req = request(Config::default());
        req.ai_api_key = SecretChange::Clear;
        req.tab_summary_api_key = SecretChange::Set(" sk-new ".into());

        // Act
        save(&path, &req, &[]).expect("should save");

        // Assert
        let loaded = reload(&path);
        assert_eq!(loaded.ai.api_key, "");
        assert_eq!(loaded.tab_summary.api_key, "sk-new");
    }

    #[test]
    fn overridden_api_key_is_never_written() {
        // Arrange
        let path = temp_dir("secret-override").join("config.yaml");
        std::fs::write(&path, "config_override_command: op read x\n").unwrap();
        let mut req = request(Config::default());
        req.override_command = "op read x".into();
        req.ai_api_key = SecretChange::Set("sk-merged".into());

        // Act
        save(&path, &req, &[AI_API_KEY.to_string()]).expect("should save");

        // Assert
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-merged"), "{text}");
        assert!(
            text.contains("config_override_command: op read x"),
            "{text}"
        );
    }

    #[test]
    fn backup_is_made_before_the_first_overwrite_only() {
        // Arrange
        let path = temp_dir("backup").join("config.yml");
        std::fs::write(&path, "# my notes\nfont:\n  size: 14\n").unwrap();
        let bak = path.with_file_name("config.yml.bak");

        // Act
        let first = save(&path, &request(Config::default()), &[]).expect("should save");
        let second = save(&path, &request(Config::default()), &[]).expect("should save again");

        // Assert
        assert_eq!(
            first.backup.as_deref(),
            Some(bak.display().to_string().as_str())
        );
        assert!(second.backup.is_none());
        assert_eq!(
            std::fs::read_to_string(&bak).unwrap(),
            "# my notes\nfont:\n  size: 14\n"
        );
    }

    #[test]
    fn unreadable_file_is_not_overwritten() {
        // Arrange
        let path = temp_dir("unreadable").join("config.yaml");
        std::fs::write(&path, "fonts:\n  size: 14\n").unwrap();

        // Act
        let result = save(&path, &request(Config::default()), &[]);

        // Assert
        assert!(matches!(result, Err(SaveError::Failed { .. })));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "fonts:\n  size: 14\n"
        );
        assert!(snapshot(&path, &[]).error.is_some());
    }

    #[test]
    fn invalid_values_are_reported_per_field_and_not_saved() {
        // Arrange
        let path = temp_dir("invalid").join("config.yaml");
        let mut config = Config::default();
        config.font.size = 0.0;
        config.tab_summary.interval_seconds = 5;
        config.hotkeys.window = Some("Control+Nope".into());
        config.window.main.width = Some(-1.0);

        // Act
        let result = save(&path, &request(config), &[]);

        // Assert
        let Err(SaveError::Invalid { errors }) = result else {
            panic!("should be invalid: {result:?}");
        };
        let paths: Vec<&str> = errors.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "font.size",
                "window.main.width",
                "hotkeys.window",
                "tab_summary.interval_seconds"
            ]
        );
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_is_written() {
        // Arrange
        let dir = temp_dir("symlink");
        let real = dir.join("real.yaml");
        std::fs::write(&real, "font:\n  size: 14\n").unwrap();
        let link = dir.join("config.yaml");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let mut config = Config::default();
        config.font.size = 18.0;

        // Act
        save(&link, &request(config), &[]).expect("should save");

        // Assert
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(reload(&real).font.size, 18.0);
        assert!(dir.join("real.yaml.bak").exists());
    }

    #[test]
    fn text_save_rejects_unknown_keys() {
        // Arrange
        let path = temp_dir("text").join("config.yaml");
        std::fs::write(&path, "font:\n  size: 14\n").unwrap();

        // Act
        let bad = save_text(&path, "fontz: {}\n");
        let good = save_text(&path, "# hi\nfont:\n  size: 16\n");

        // Assert
        assert!(bad.is_err());
        assert!(good.is_ok());
        assert_eq!(reload(&path).font.size, 16.0);
    }

    #[test]
    fn invalid_overridden_values_do_not_block_saving() {
        // Arrange
        let path = temp_dir("invalid-overridden").join("config.yaml");
        std::fs::write(&path, "font:\n  size: 0\n").unwrap();
        let mut config = read_local(&path).unwrap().2;
        config.ai.enabled = true;

        // Act
        let result = save(&path, &request(config), &["font.size".to_string()]);

        // Assert
        assert!(result.is_ok(), "{result:?}");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("size: 0"), "{text}");
        assert!(reload(&path).ai.enabled);
    }

    #[cfg(unix)]
    #[test]
    fn new_file_is_private_and_existing_permissions_are_kept() {
        use std::os::unix::fs::PermissionsExt;
        // Arrange
        let dir = temp_dir("permissions");
        let fresh = dir.join("fresh.yaml");
        let existing = dir.join("existing.yaml");
        std::fs::write(&existing, "").unwrap();
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o640)).unwrap();

        // Act
        save(&fresh, &request(Config::default()), &[]).expect("should save");
        save(&existing, &request(Config::default()), &[]).expect("should save");

        // Assert
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&fresh), 0o600);
        assert_eq!(mode(&existing), 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn override_test_errors_do_not_echo_the_command() {
        // Arrange
        let path = temp_dir("override-error").join("config.yaml");

        // Act
        let message = test_override(&path, "/bin/echo 'ai: [sk-secret'").expect_err("broken YAML");

        // Assert
        assert!(!message.contains("sk-secret"), "{message}");
    }

    #[test]
    fn secret_changes_parse_from_the_webview_json() {
        let parse = |json: &str| serde_json::from_str::<SecretChange>(json).unwrap();
        assert_eq!(parse(r#"{"action":"keep"}"#), SecretChange::Keep);
        assert_eq!(parse(r#"{"action":"clear"}"#), SecretChange::Clear);
        assert_eq!(
            parse(r#"{"action":"set","value":"sk"}"#),
            SecretChange::Set("sk".into())
        );
    }

    #[test]
    fn comments_from_the_template_and_header_are_not_hand_written() {
        assert!(!has_hand_written_comments(config::CONFIG_TEMPLATE));
        assert!(!has_hand_written_comments(&format!(
            "{SAVED_HEADER}font:\n  size: 14\n"
        )));
        assert!(!has_hand_written_comments(
            "theme:\n  background: \"#111111\"\n"
        ));
        assert!(has_hand_written_comments("# mine\nfont:\n  size: 14\n"));
        assert!(has_hand_written_comments("font:\n  size: 14 # bigger\n"));
    }

    #[cfg(unix)]
    #[test]
    fn override_test_reports_only_the_key_count() {
        // Arrange
        let path = temp_dir("override-test").join("config.yaml");

        // Act
        let ok = test_override(
            &path,
            r#"/bin/echo '{"ai": {"api_key": "sk-secret"}, "font": {"size": 20}}'"#,
        );
        let bad = test_override(&path, r#"/bin/echo '{"ai": {"api_key": 3, "nope": 1}}'"#);

        // Assert
        assert_eq!(ok, Ok(2));
        let message = bad.expect_err("unknown key should fail");
        assert!(message.contains("ai.nope"), "{message}");
        assert!(!message.contains("sk-secret"));
    }
}
