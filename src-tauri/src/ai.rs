//! Ask AI (Cmd+I): 自然言語の依頼から 1 行のシェルコマンドを作ってもらう。
//!
//! Anthropic の Messages API を直接叩く (Rust には公式 SDK が無い)。API キーは Rust 側に
//! だけ置き、webview には渡さない。
//!
//! **返ってきたコマンドは実行しない。** フロントがプロンプトに打ち込むだけで、Enter は
//! ユーザーが押す。そのため改行や制御文字を含む応答は、打ち込んだ瞬間に実行されたり
//! 端末を操作したりしないよう、ここで弾く (`parse_reply`)。

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::config::AiConfig;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
/// 応答は 1 行だが、adaptive thinking の分も max_tokens に数えられるので余裕を持たせる。
const MAX_TOKENS: u32 = 4096;
/// 応答待ちの上限。ネットワークが詰まった時に入力欄が「考え中」のまま残らないように。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
/// 依頼と一緒に送る選択テキストの上限 (文字数)。黙って切り詰めず、超えたら断る。
pub const MAX_SELECTION_CHARS: usize = 20_000;
/// モデルが「コマンドにできない」と答える時の接頭辞。プロンプトで指示している。
const DECLINE_PREFIX: &str = "# ";

/// フロントへ返す結果。
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "text", rename_all = "lowercase")]
pub enum Suggestion {
    /// プロンプトへ打ち込んでよい 1 行のコマンド
    Command(String),
    /// コマンドにできなかった理由。打ち込まずに入力欄へ表示する
    Message(String),
}

fn system_prompt(os: &str, shell: &str) -> String {
    format!(
        "You turn a request into one shell command for the user's terminal.\n\
         OS: {os}\n\
         Shell: {shell}\n\
         \n\
         Reply with the command only, on a single line: no explanation, no Markdown, \
         no code fences. The user reviews the command before running it, so prefer the \
         plain, common form over clever one-liners. If the task needs several steps, \
         chain them on that one line with the operators this shell supports. \
         If the request cannot be done with a shell command, or it is unclear, reply \
         with one line that starts with \"{DECLINE_PREFIX}\" and says why, in the \
         language of the request."
    )
}

fn user_message(request: &str, selection: Option<&str>) -> String {
    match selection.filter(|text| !text.trim().is_empty()) {
        Some(text) => format!(
            "Text the user selected in the terminal, for context:\n\
             <selection>\n{text}\n</selection>\n\nRequest: {request}"
        ),
        None => format!("Request: {request}"),
    }
}

fn request_body(
    config: &AiConfig,
    os: &str,
    shell: &str,
    request: &str,
    selection: Option<&str>,
) -> Value {
    let mut body = json!({
        "model": config.model.trim(),
        "max_tokens": MAX_TOKENS,
        "system": system_prompt(os, shell),
        "messages": [{ "role": "user", "content": user_message(request, selection) }],
    });
    let effort = config.effort.trim();
    if !effort.is_empty() {
        body["output_config"] = json!({ "effort": effort });
    }
    body
}

/// 応答の本文を取り出す。拒否・打ち切りは理由を付けたエラーにする。
fn response_text(response: &Value) -> Result<String, String> {
    match response["stop_reason"].as_str() {
        Some("refusal") => return Err("The model declined this request.".to_string()),
        Some("max_tokens") => {
            return Err("The model ran out of tokens before answering. Try again.".to_string())
        }
        _ => {}
    }
    let text: String = response["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect();
    Ok(text)
}

/// モデルの応答を、打ち込んでよいコマンドか表示するだけのメッセージに振り分ける。
///
/// 改行が残るものは打ち込まない。xterm への入力として pty に流すので、改行は Enter と
/// 同じ意味になり、ユーザーが見る前に実行されてしまう。ESC 等の制御文字も同じ理由で
/// 断る (シェルのキーバインドや端末の操作として解釈されうる)。
pub fn parse_reply(raw: &str) -> Result<Suggestion, String> {
    let text = strip_code_fence(raw.trim()).trim();
    if text.is_empty() {
        return Err("The model returned an empty answer.".to_string());
    }
    if let Some(reason) = text.strip_prefix(DECLINE_PREFIX) {
        return Ok(Suggestion::Message(reason.trim().to_string()));
    }
    if text.contains(['\n', '\r']) {
        return Err(format!(
            "The model returned more than one line, so it was not typed in:\n{text}"
        ));
    }
    let command = text.replace('\t', " ");
    if command.chars().any(char::is_control) {
        return Err("The answer contains control characters, so it was not typed in.".to_string());
    }
    Ok(Suggestion::Command(command))
}

/// 指示しても付いてくることがあるコードフェンスと、全体を囲むバッククォートを外す。
fn strip_code_fence(text: &str) -> &str {
    if let Some(inner) = text.strip_prefix("```").and_then(|t| t.strip_suffix("```")) {
        // 開きフェンスの行の残り (言語名) は捨てる
        return match inner.split_once('\n') {
            Some((_, body)) => body,
            None => inner,
        };
    }
    if text.len() >= 2
        && text.starts_with('`')
        && text.ends_with('`')
        && !text[1..text.len() - 1].contains('`')
    {
        return &text[1..text.len() - 1];
    }
    text
}

/// API のエラー応答を、ユーザーが原因を判断できる 1 行にする。
fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        let error = &value["error"];
        let message = error["message"].as_str()?;
        Some(match error["type"].as_str() {
            Some(kind) => format!("{kind}: {message}"),
            None => message.to_string(),
        })
    });
    match detail {
        Some(detail) => format!("Anthropic API error ({status}): {detail}"),
        None => format!("Anthropic API error ({status})"),
    }
}

pub async fn suggest_command(
    config: &AiConfig,
    os: &str,
    shell: &str,
    request: &str,
    selection: Option<&str>,
) -> Result<Suggestion, String> {
    if !config.enabled {
        return Err("Ask AI is turned off. Set ai.enabled to true in the config file.".to_string());
    }
    let request = request.trim();
    if request.is_empty() {
        return Err("Describe what you want to do.".to_string());
    }
    if selection.is_some_and(|text| text.chars().count() > MAX_SELECTION_CHARS) {
        return Err(format!(
            "The selection is longer than {MAX_SELECTION_CHARS} characters. Select less text."
        ));
    }
    let api_key = config.resolve_api_key().ok_or_else(|| {
        "No API key. Set ai.api_key in the config file or the ANTHROPIC_API_KEY environment variable."
            .to_string()
    })?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not set up the HTTP client: {e}"))?;
    let response = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .json(&request_body(config, os, shell, request, selection))
        .send()
        .await
        .map_err(|e| format!("Could not reach the Anthropic API: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Could not read the Anthropic API response: {e}"))?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|e| format!("The Anthropic API returned invalid JSON: {e}"))?;
    parse_reply(&response_text(&value)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_line_reply_becomes_a_command() {
        // Act
        let result = parse_reply("  ls -la ~/Downloads \n");

        // Assert
        assert_eq!(
            result,
            Ok(Suggestion::Command("ls -la ~/Downloads".to_string()))
        );
    }

    #[test]
    fn code_fences_and_backticks_are_stripped() {
        // Act
        let fenced = parse_reply("```sh\ngit status\n```");
        let quoted = parse_reply("`git status`");

        // Assert
        assert_eq!(fenced, Ok(Suggestion::Command("git status".to_string())));
        assert_eq!(quoted, Ok(Suggestion::Command("git status".to_string())));
    }

    #[test]
    fn multi_line_reply_is_not_typed_in() {
        // 改行は Enter として pty に届き、確認の前に実行されてしまう
        // Act
        let result = parse_reply("cd /tmp\nrm -rf build");

        // Assert
        assert!(result.is_err());
    }

    #[test]
    fn control_characters_are_rejected() {
        // Act
        let result = parse_reply("echo hi\u{1b}[2J");

        // Assert
        assert!(result.is_err());
    }

    #[test]
    fn tabs_become_spaces() {
        // Act
        let result = parse_reply("echo\ta");

        // Assert
        assert_eq!(result, Ok(Suggestion::Command("echo a".to_string())));
    }

    #[test]
    fn decline_prefix_becomes_a_message() {
        // Act
        let result = parse_reply("# That needs a GUI, not a shell command.");

        // Assert
        assert_eq!(
            result,
            Ok(Suggestion::Message(
                "That needs a GUI, not a shell command.".to_string()
            ))
        );
    }

    #[test]
    fn effort_is_sent_only_when_set() {
        // Arrange
        let with_effort = AiConfig::default();
        let without_effort = AiConfig {
            effort: String::new(),
            ..AiConfig::default()
        };

        // Act
        let a = request_body(&with_effort, "macOS", "zsh", "list files", None);
        let b = request_body(&without_effort, "macOS", "zsh", "list files", None);

        // Assert
        assert_eq!(a["output_config"]["effort"], "low");
        assert!(b.get("output_config").is_none());
    }

    #[test]
    fn selection_is_included_only_when_present() {
        // Act
        let with = user_message("fix this", Some("error: not found"));
        let without = user_message("fix this", Some("   "));

        // Assert
        assert!(with.contains("<selection>\nerror: not found\n</selection>"));
        assert_eq!(without, "Request: fix this");
    }

    #[test]
    fn refusal_and_truncation_are_errors() {
        // Act
        let refusal = response_text(&json!({ "stop_reason": "refusal", "content": [] }));
        let truncated = response_text(&json!({ "stop_reason": "max_tokens", "content": [] }));
        let ok = response_text(&json!({
            "stop_reason": "end_turn",
            "content": [{ "type": "thinking", "thinking": "" }, { "type": "text", "text": "pwd" }],
        }));

        // Assert
        assert!(refusal.is_err());
        assert!(truncated.is_err());
        assert_eq!(ok, Ok("pwd".to_string()));
    }

    #[test]
    fn api_error_includes_type_and_message() {
        // Act
        let message = api_error(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
        );

        // Assert
        assert!(message.contains("authentication_error: invalid x-api-key"));
        assert!(message.contains("401"));
    }
}
