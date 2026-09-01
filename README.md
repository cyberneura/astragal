# Astragal

macOS 用の軽量ターミナルアプリ (Tauri 2.x + xterm.js)。

- タブ付きのメインウインドウ
- メニューバー (トレイ) から、カーソル位置に出る小さいターミナル
- `~/.config/astragal/config.yaml` による設定

## 設定

設定ファイルは `~/.config/astragal/config.yaml` (無ければ `config.yml`)。
初回起動時に、全項目をコメントアウトしたテンプレートが自動生成される。
書いた項目だけが既定値を上書きする。

```yaml
font:
  # xterm に渡す CSS の font-family 指定。
  # Nerd Font に CJK グリフは無いので、CJK フォントを後ろに置くこと。
  family: "'RobotoMono Nerd Font', Menlo, 'Hiragino Sans', monospace"
  size: 13

shell:
  command: /bin/zsh # 省略時は $SHELL、それも無ければ /bin/zsh
  args: ["-l"] # 既定はログインシェル
  env:
    LANG: ja_JP.UTF-8

window:
  main:
    width: 900
    height: 580
    hide_on_blur: false
  small:
    width: 480
    height: 320
    hide_on_blur: true

theme: # xterm のテーマ。書いたキーだけ上書きされる
  background: "#1e1e2e"
  foreground: "#cdd6f4"
```

`ASTRAGAL_CONFIG` 環境変数に設定ファイルのパスを渡すと、その内容で起動する。

### config_override_command

標準出力に YAML を吐くコマンドを実行して、その結果を設定ファイルの上に
再帰マージする。1Password 等から設定を引くための口。

```yaml
config_override_command: op read "op://development/astragal/config-yaml"
```

- mapping 同士は再帰的にマージされ、スカラーとリストは丸ごと置き換わる。
- **シェルを介さずに実行する**。コマンドは PATH 上にあるか絶対パスで書く
  (PATH には `/opt/homebrew/bin` と `/usr/local/bin` が補われる)。
- 60 秒でタイムアウトする。取得に失敗した場合はローカルの設定のまま起動し、
  理由をターミナルに警告として表示する。

## 開発

```shell
pnpm install
pnpm tauri dev
```

## ビルド

```shell
pnpm tauri build
```

ビルドすると `src-tauri/target/release/bundle/macos/Astragal.app` ができる。
`./astragal` はこのバンドルを起動する CLI ラッパー。

## テスト

```shell
cd src-tauri && cargo test
pnpm exec tsc --noEmit
```
