# Astragal

macOS 用の軽量ターミナルアプリ。Tauri 2 (Rust) + xterm.js。

ユーザー向けの説明と設定リファレンスは `README.md` にある。ここには
エージェントが作業する上で必要な、コードから読み取りにくい事項だけを書く。

## 表示言語

public リポジトリなので、**README・UI 文字列・エラーメッセージ・警告はすべて英語**で書く
(CYBERNEURA-DEV-656 での指示)。**この AGENTS.md (= `CLAUDE.md`) だけは日本語**。
エージェント向けの開発メモで、他リポジトリでも「ユーザー向け表示は英語、開発者向け
ドキュメントは日本語」で揃えているため。

コードコメントは現時点で日本語のままになっている。cyberneura の他の public リポジトリ
(runandlog / jj-menu) はコメントも英語で揃えているので、いずれ寄せる余地はある。

## 構成

| パス | 役割 |
|---|---|
| `src-tauri/src/lib.rs` | pty セッション、ウインドウ配置、トレイ、ホットキー |
| `src-tauri/src/config.rs` | `~/.config/astragal/config.yaml` の読み込みとマージ |
| `src/terminal.ts` | xterm の生成とテーマ適用 |
| `src/tabs.ts` | タブ管理と Cmd 系キーバインド |
| `src/main.ts` / `src/small.ts` | メインウインドウ / 吹き出しの入口 |
| `resources/app-icons/` | アイコンのマスター素材と `generate.py` |

ウインドウは 2 つある。`main` (タブ付き) と `small` (メニューバーアイコン直下に出る
吹き出し)。挙動が違うので、片方だけ直して済ませないこと。

## コマンド

```shell
pnpm install
pnpm tauri dev
pnpm tauri build      # src-tauri/target/release/bundle/macos/Astragal.app

cd src-tauri && cargo test
cd src-tauri && cargo clippy --all-targets
pnpm exec tsc --noEmit
```

## macOS 固有の注意

### 座標の単位系

**モニタを跨ぐ計算では、必ずグローバル論理ポイントに揃えてから比較する。**
物理値は API ごとに掛かっている scale が違い、スケール混在時 (Retina + 外部 FHD 等) に
矩形が重なって別のディスプレイを引く。

| 値 | 換算に使われている scale |
|---|---|
| `cursor_position()` | **primary** の scale |
| `Monitor::position()` / `size()` | **そのモニタ自身**の scale |
| `TrayIconEvent` の `rect` / `position` | **トレイが載っているディスプレイ**の scale |

トレイイベントの物理値だけからは scale を確定できない。イベント発生時はカーソルが
アイコン上にあることを利用し、カーソルの載っているモニタから引いている
(`tray_anchor`)。この推定には潰しきれない重なりがあり、`cursor_is_stable` の doc に
限界を書いてある。

### Dock に出さない

`ActivationPolicy::Accessory` と `src-tauri/Info.plist` の `LSUIElement` の両方を使う。
前者は dev 実行 (バンドルされない素のバイナリ)、後者はバンドル版の起動直後の
ちらつき防止。**アプリメニューは描画されなくなるが Cmd+C / Cmd+V は効く**
(`NSApp` の main menu オブジェクトは残り `performKeyEquivalent:` が辿るため)。

### アイコン

用途ごとに余白と色の扱いが違う。手順は `README.md` の「アイコン」を参照。
`pnpm tauri icon` は `src-tauri/icons/` を毎回まるごと上書きするので、単発で流すと
mac 用の余白が黙って消える。

## 依存ライブラリの挙動を調べる時

Tauri / tao / tray-icon は、ドキュメントに書かれていない単位系や前提で動いている
箇所がある。推測せず `~/.cargo/registry/src/*/<crate>-<version>/` のソースを読む。
今回の座標系の問題は全てそこで確定した。

Tauri の API は context7 MCP でも確認できる。
