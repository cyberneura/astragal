# Astragal

macOS 用の軽量ターミナルアプリ (Tauri 2.x + xterm.js)。

- タブ付きのメインウインドウ
- メニューバー (トレイ) のアイコン直下に出る、吹き出し型の小さいターミナル
  (アイコンを左クリック、右クリックでメニュー)
- ウインドウの表示・非表示のグローバルホットキー
- `~/.config/astragal/config.yaml` による設定

## インストール

```shell
brew install --cask cyberneura/tap/astragal
```

配布物は Developer ID で署名し公証済みの universal dmg (Intel / Apple Silicon)。

## 設定

設定ファイルは `~/.config/astragal/config.yaml` (無ければ `config.yml`)。
初回起動時に、全項目をコメントアウトしたテンプレートが自動生成される。
書いた項目だけが既定値を上書きする。

```yaml
font:
  # CSS font-family list passed to xterm.
  # Nerd Fonts have no CJK glyphs, so keep a CJK font in the fallbacks.
  family: "'RobotoMono Nerd Font', Menlo, 'Hiragino Sans', monospace"
  size: 13

shell:
  command: /bin/zsh # defaults to $SHELL, then /bin/zsh
  args: ["-l"] # login shell by default
  env:
    LANG: ja_JP.UTF-8

# Global hotkeys. Set an empty string to disable one.
hotkeys:
  window: "Control+Option+Command+A"
  small_window: "Control+Shift+Option+Command+A"

window:
  main:
    width: 900
    height: 580
    hide_on_blur: false
  # The popover that drops down from the menu bar icon.
  small:
    width: 800
    height: 600
    hide_on_blur: true

theme: # xterm theme; only the keys you write are overridden
  background: "#181825"
  foreground: "#cdd6f4"
```

ホットキーの修飾子は `Control` / `Option` (`Alt`) / `Shift` / `Command` (`Cmd`, `Super`)。
登録に失敗した場合は理由がターミナルに警告として出る。ただし macOS の
`RegisterEventHotKey` はプロセス単位の登録なので、他のアプリやシステムが同じ
組み合わせを握っている場合は**登録自体は成功し、キーが届かないだけで警告も出ない**。
効かない時は組み合わせを変えること。

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

## リリース

リリースは `src-tauri/tauri.conf.json` の version で決まる。version を変えて main に
載せれば `.github/workflows/release.yml` がビルドして GitHub Release を作り、変えなければ
何度 push しても何も起きない (実行可否を決めるのは diff ではなく「その version が
リリース済みか」)。

```shell
pnpm release            # patch を採番して main に push し、ビルドを watch する
pnpm release minor
pnpm release major
```

`scripts/release.sh` は main がクリーンで origin/main と一致している時だけ動く。
ビルドは macOS ランナーで走り、Developer ID 署名と公証を経て `v<version>` タグの
Release に universal dmg を上げる。署名用の Secret (`APPLE_CERTIFICATE` /
`APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` /
`APPLE_PASSWORD` / `APPLE_TEAM_ID`) はリポジトリに登録済みで、1 つでも欠けると
ビルドの手前で失敗する (欠けたまま進むと公証なしの dmg が黙って公開されるため)。

Homebrew の cask (cyberneura/homebrew-tap) は最新リリースを毎時見て自分を更新する
ので、`brew` に出るまで最大 1 時間遅れる。

## テスト

```shell
cd src-tauri && cargo test
pnpm exec tsc --noEmit
```

## アイコン

マスターは `resources/app-icons/` にあり、`generate.py` (要 `rsvg-convert`) で
SVG から起こす。用途ごとに余白と色の扱いが違うので 4 枚に分かれている。

| ファイル | 用途 |
|---|---|
| `astragal-mac-icon.png` | macOS アプリアイコン。背景に 10% の余白 |
| `astragal-favicon.png` | Windows / Web。余白なし |
| `tray-mac.png` | メニューバー。単色 + 透過 (template 画像) |
| `tray-win.png` | Windows トレイ。カラー |

`src-tauri/icons/` への反映は下記の順で行う。`pnpm tauri icon` は
`src-tauri/icons/` を毎回まるごと上書きするので、単発で流すと mac の余白が黙って消える。

```shell
python3 resources/app-icons/generate.py

TMP=$(mktemp -d)
pnpm tauri icon "$PWD/resources/app-icons/astragal-mac-icon.png"
cp src-tauri/icons/icon.icns "$TMP/"
pnpm tauri icon "$PWD/resources/app-icons/astragal-favicon.png"
cp "$TMP/icon.icns" src-tauri/icons/
rm -rf "$TMP" src-tauri/icons/android src-tauri/icons/ios

cp resources/app-icons/tray-mac.png resources/app-icons/tray-win.png src-tauri/icons/
```
