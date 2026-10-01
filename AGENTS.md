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
(runandlog / j-menu) はコメントも英語で揃えているので、いずれ寄せる余地はある。

## 構成

| パス | 役割 |
|---|---|
| `src-tauri/src/lib.rs` | pty セッション、ウインドウ配置、トレイ、ホットキー |
| `src-tauri/src/config.rs` | `~/.config/astragal/config.yaml` の読み込みとマージ |
| `src/terminal.ts` | xterm の生成とテーマ適用 |
| `src/links.ts` | URL の検出と Cmd+クリックでの起動 |
| `src/tabs.ts` | タブ管理、Cmd 系キーバインド、Ctrl+Tab のタブ巡回、Cmd+Shift+[ / ] のタブ移動、Cmd+K のクリア |
| `src/search.ts` | Cmd+F の検索バー (xterm-addon-search)。ウインドウに 1 つで、アクティブなタブを検索する |
| `src/main.ts` / `src/small.ts` | メインウインドウ / 吹き出しの入口 |
| `src/about.ts` | トレイメニューの About から開くウインドウ |
| `src/licenses.ts` | トレイメニューの Third-Party Licenses から開くウインドウ (`THIRD-PARTY-NOTICES.txt` を表示) |
| `resources/app-icons/` | アイコンのマスター素材と `generate.py` / `inspect_icns.py` |

常駐ウインドウは 2 つある。`main` (タブ付き) と `small` (メニューバーアイコン直下に出る
吹き出し)。挙動が違うので、片方だけ直して済ませないこと。`about` と `licenses` は開くたびに作り、
閉じると破棄される。

## 依存ライブラリのライセンス表示

`THIRD-PARTY-NOTICES.txt` は `scripts/generate-third-party-notices.sh` (`pnpm notices`) の生成物で、
`lib.rs` が `include_str!` で埋め込み、トレイメニューの Third-Party Licenses (`licenses` ウインドウ)
に出す。**依存を足す・上げる時は流し直してコミットする** (直接依存が載っていないと `cargo test` が
落ちる)。Rust 側は cargo-about で、`src-tauri/about.toml` の `targets` で配布ターゲット
(mac / Windows) だけに絞っている。cargo-about は `--features cli` を付けないとバイナリが入らない。
npm 側は `package.json` の `dependencies` だけ (devDependencies は配布物に入らない)。

## キーバインド

Cmd 系は `document` のバブリングで拾っている。xterm は Cmd 付きのキーを pty へ
流さないので、これで足りる。

**Ctrl 系はそうはいかない。** xterm は Ctrl の有無に関わらず Tab をタブ文字として
pty へ送る (`xterm/src/common/input/Keyboard.ts` の keyCode 9) ため、Ctrl+Tab を
バブリングで待つとシェルの補完が先に動く。xterm のリスナーは textarea に張られて
いるので、`document` の **capture** で拾って `stopPropagation()` まで行う
(`handleCycleKeydown`)。他の Ctrl 系を足す時も同じ扱いが要る。

Ctrl+Tab は最近使った順 (MRU) の巡回で、Ctrl を押している間は順序を固定したまま
表示だけ動かし、Ctrl の keyup で確定する。ウインドウが背面へ回ると keyup が届かない
ので `blur` でも確定する (吹き出しは blur で隠れるため必須)。

Cmd+Shift+[ / ] は iTerm2 と同じ「表示順で隣のタブへ」。MRU ではなくタブバーの
並び順で動き、端では反対の端へ回り込む。判定は `key` (配列に従った文字) を先に見て、
`code` (US 配列基準の物理位置) は保険にしている。JIS 配列では刻印 "[" のキーが
`code: "BracketRight"` で来るため、`code` を優先すると左右が逆になる。macOS は Cmd を
押している間 Shift を文字へ適用しないことがあるので、"[" と "{" の両方を受ける。
`code` を見るのは `key` が文字を特定できなかった時 (`"Dead"` / `"Unidentified"` 等、
1 文字にならない値) だけ。文字が取れているのに `code` へ落ちると、その位置に別の文字が
載っている配列 (ドイツ語の `BracketRight` は "+") でタブ移動が誤爆する。
Option (`altKey`) を弾くのも `code` で判定する側だけ。北欧系の配列は "[" / "]" の入力に
Option が要る (Option+8 / Option+9) ので、`key` が文字として取れている側で弾くと
そこから届かなくなる。

Cmd+F / Cmd+G / Cmd+K はネイティブメニューのアクセラレータに奪われない (Tauri の既定
メニューに Find 系・Clear 系の項目が無い)。メニューを足す時にこれらを割り当てると、
WebView までキーが届かなくなり検索やクリアが効かなくなる。

Cmd+K (Windows は Ctrl+Shift+K) は `terminal.clear()` で、シェルには何も送らない
(iTerm2 の Clear Buffer と同じ。Ctrl+L と違ってスクロールバックも消える)。代替バッファ
(vim / less) の表示中は何もしない — xterm の `clear()` はアクティブなバッファを消すので、
全画面アプリの描画だけが消えて操作は効く、という状態になるため。クリアは書き込みでも
カーソル移動でもないので検索 addon の行キャッシュと件数が古いまま残る。`syncSearchAfterClear`
が行キャッシュと検索語のキャッシュ (`clearDecorations()`) を捨てて数え直している。検索語の
キャッシュが残っていると、addon は同じ語の再検索で全一致の再計算を省き、件数が古いまま返る。

検索バーの Esc は入力欄にフォーカスがある時だけ効く。ターミナル側の Esc は vim 等の
ためにそのまま pty へ流す。

`xterm-addon-search` 0.13 は行テキストのキャッシュをカーソル移動でしか捨てず、
プロンプトが同じ位置へ戻ると新しい出力が検索に掛からない。`createSearchAddon` が
書き込みのたびに非公開の `_destroyLinesCache` を呼んで回避している。

## コマンド

```shell
pnpm install
pnpm tauri dev
pnpm tauri build      # src-tauri/target/release/bundle/macos/Astragal.app

cd src-tauri && cargo test
cd src-tauri && cargo clippy --all-targets
pnpm exec tsc --noEmit
```

## バージョンとリリース

version の正本は `src-tauri/tauri.conf.json` と `package.json` の 2 ファイルだけ
(`scripts/release.sh` が触るのと同じ)。`Cargo.toml` の version はコードから参照されて
おらず、上げない。version を変えて main に載せると `release.yml` がビルド・署名・公証して
GitHub Release を公開するので、**PR に version bump を含めるとマージがそのままリリースになる**。
手順は `README.md` の「リリース」。

## winget

配布は `.github/workflows/winget.yml` (Komac の `update`) が release.yml の末尾から
呼ばれて microsoft/winget-pkgs へ PR を出す。仕組みと初回登録の手順は `docs/winget.md`。
書き換える時に効く前提:

- `komac new` は CI で動かない (InstallModes / UpgradeBehavior 等の対話をフラグで埋められない)。
  初回登録は manifest 手書き。`update` は既存パッケージ専用
- fork は org 配下 (`cyberneura/winget-pkgs`)。Komac は既定で token の持ち主の fork を探すので
  `KOMAC_FORK_OWNER` が要る。token は `GITHUB_TOKEN` 環境変数で渡すが、winget 側の操作には
  このリポジトリの `github.token` ではなく classic PAT の `WINGET_TOKEN` を入れること
- `on: release` では起動しない (release.yml が `github.token` で公開するイベントは他の
  workflow を起こさない)。`workflow_call` で release.yml から繋いでいる
- Komac は `CI=true` だと既存 PR の確認を飛ばして 2 本目を出す。重複は winget.yml 側の
  guard で止めている
- NSIS の stub は 32bit なので `komac analyse` は x86 と言う。`update` は URL の `x64` を
  優先するので実害は無いが、手書き時は自分で `x64` にする

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

### ログイン時の自動起動

トレイメニューの Launch at Login は `auto-launch` crate で、macOS は
`~/Library/LaunchAgents/Astragal.plist`、Windows は Run レジストリに登録する
(CYBERNEURA-DEV-894)。登録には `--minimized` が付き、これで起動すると main を出さずに
メニューバーだけに常駐する (`launched_minimized`)。

- **macOS は LaunchAgent 方式に固定している。** AppleScript のログイン項目は引数を
  渡せず、`--minimized` が届かない
- **tauri-plugin-autostart は使っていない。** 中身は同じ auto-launch だが、登録する
  パスを加工できない。auto-launch 0.5 はパスをそのまま書くので、Windows は引用符で囲み
  (空白入りのパスが途中で切れる)、macOS は `& < >` を含むパスの登録を断っている
  (plist に XML エスケープせずに埋め込まれ、壊れた plist が「登録成功」になる)。
  `autostart_program` / `check_registrable` を参照。登録を断るのは有効化の時だけで、
  確認・解除には掛けない (登録後にアプリを移すと残った登録を外せなくなる)。auto-launch を上げる時はこの 2 点が直っていないか見る
- 有効かどうかはアプリの設定に持たず、毎回 OS 側 (plist / レジストリの有無) から読む。
  チェックの表示も切り替え後に読み直して合わせる
- 切り替えの失敗はダイアログ (`tauri-plugin-dialog`) で出す。`warn()` はターミナルを開いた時に
  まとめて表示する仕組みなので、トレイからの操作の結果を伝えられない
- 登録するパスは `current_exe()` を canonicalize せずに使う (シンボリックリンク越しの版ごとの
  実体を登録すると、更新で旧版が消えた時に起動しなくなる)
- plist / レジストリにはその時の実行ファイルのパスが書かれる。dev ビルドで有効にすると
  dev のバイナリが登録されるので、確認後は OFF に戻すこと

### 非表示ウインドウで requestAnimationFrame を待たない

webview の初期背景は白なので、新しいウインドウは `visible(false)` で作り、front が DOM を
埋めてからコマンドで show している (`about` / `licenses`)。この「show してもらう合図」を
`requestAnimationFrame` の中で送ると永遠に出ない。WebKit は見えていないページの
フレームを止めるため。DOM 更新の直後にそのまま invoke する。

### アイコン

用途ごとに余白と色の扱いが違う。手順は `README.md` の「Icons」を参照。
`pnpm tauri icon` は `src-tauri/icons/` を毎回まるごと上書きするので、単発で流すと
mac 用の余白と、Windows 用に拡大した図柄が黙って消える。

**Windows のアプリアイコン (`icon.ico`) は専用のマスター `astragal-win-icon` から作る**
(CYBERNEURA-DEV-884)。背景を full-bleed にするだけでは足りず、図柄そのものを背景の 86%
まで拡大している (`generate.py` の `WIN_MARK_FILL_PERCENT`)。暗い背景は Windows のダークな
タスクバーに溶けるので、見た目の大きさは明るい図柄で決まり、macOS と同じ配置 (高さ 68%)
では他のアプリより小さく見えていた。macOS の icns と `32x32.png` 等の素の PNG は変えていない。

`icon.ico` の**先頭のエントリ**がウインドウアイコン (タイトルバー / Alt-Tab) に使われる
(tauri-codegen の `CachedIcon::new_ico` が `entries()[0]` を取る)。`tauri icon` は 32px を
先頭に書く。NSIS のインストーラーは `bundle.windows.nsis.installerIcon` を指定しないと
NSIS 既定のアイコンになる (v0.8.0 までの setup.exe はそうだった)。

`src-tauri/icons/icon.icns` の中身は `resources/app-icons/inspect_icns.py` で一覧できる
(標準ライブラリのみ。16〜512px に抜けがあれば exit 1。1024px は「あると良い」扱いで、
512px のマスターしか無いアプリでは作りようがないため落とさない)。
**アイコンが低解像度に見えるという報告が来たら、まずこれを流して原因がこちら側かを切り分ける。**

抜けていた場合は `resources/app-icons/build_icns.py <master.png> <out.icns>` で作り直せる。
こちらも標準ライブラリのみで、macOS の `iconutil` / `sips` も Pillow も要らない
(縮小は 2 の冪の整数倍だけなので、区画の平均がそのまま答えになる。色はアルファを
乗せてから平均するので、縁に黒が乗らない)。**このリポジトリ以外の
mac アプリ (quickllm / clipboard-palette 等) のアイコンもこれで直している** —
icns を扱う道具はここに置くという約束で、各リポジトリに同じスクリプトを撒かない。

現在の `icon.icns` は `build_icns.py` で 1024px のマスターから作ったもので、
16 / 32 / 64 / 128 / 256 / 512 / 1024px をすべて持ち、**大きい順に並んでいる**。

**並び順が効く (CYBERNEURA-DEV-686)。** 1Password の SSH キー許可ダイアログで Astragal の
アイコンだけがボケていた。資産は全サイズ揃っていたので、当初は呼び出し側の問題と判断したが、
きれいに出る iTerm2 の icns は先頭が 256px、ボケる Astragal (`tauri icon` 製) と
quickllm / clipboard-palette (当時の `build_icns.py` 製) は先頭が 16px だった。
スクリーンショットのボケ方も 12〜16px の拡大と一致する。icns の最初の 1 枚だけを読んで
拡大する実装があると考え、大きい順に並べ替えた (v0.4.2)。**これで直ったかは macOS 上で
確かめる必要があり、Linux では検証できない。** 直らなければ別の原因。

- `pnpm tauri icon` は小さい順の icns を書くので、**icns はそれで作らない**
  (手順は `README.md` の「アイコン」)
- Finder / Dock / NSImage のようにサイズを選んで引く経路は並び順に依存しない

**並び順の仮説は未確認のまま、ダイアログは 16px を出していると分かった (CYBERNEURA-DEV-897)。**
2026-10-01 に Queryfolio (icns は小さい順、16px は描き分け済み) の同じダイアログの
スクリーンショットをもらい、アイコンを各エントリの拡大と画素で比べたところ、`icp4` (16px)
と平均誤差 7.7、`icp5` (32px) とは 28.1 で、**16px のエントリそのものの拡大**だった
(帯 2 本の 16px 専用の絵がそのまま出ていた)。「Electron は 32px まで取れるので 32px が勝負」
(DEV-825) はこのダイアログには当てはまらない。依頼者は大きい順の Astragal も
「同様にボケる」と言っており、そうなら並び順も効いていない。

残る説明は「並び順によらず 16px のエントリを選んでいる」。その場合、16px のエントリを
抜けば次に小さいエントリが選ばれて鮮明になるのか、それとも 16x16 に縮めて渡されるだけで
変わらないのかがまだ分からない。これを確かめる道具が `resources/app-icons/probe/` にある
(macOS で実行する):

```shell
sh resources/app-icons/probe/build.sh   # build/ に IconProbe-asc / -desc / -no16 の .app
open -n resources/app-icons/probe/build/IconProbe-asc.app --args <user@host>
open -n resources/app-icons/probe/build/IconProbe-desc.app --args <user@host>
open -n resources/app-icons/probe/build/IconProbe-no16.app --args <user@host>
```

`ssh -T <user@host>` を走らせるだけのアプリで、1Password の SSH キーを使う接続先を渡す
(既定は `git@github.com`)。**ターミナルから中のバイナリを直接実行しないこと** — ダイアログに
ターミナルのアイコンが出る。3 つは icns の並び順 (asc = 小さい順 / desc = 大きい順) と
16px の有無 (no16 は desc から `icp4` を抜いたもの) だけが違い、エントリごとに色を変えた
1px 角の市松模様を入れてある (色の対応は `make_probe_icns.py` の `ENTRIES`)。一度でも縮小されると市松は無地になる。

| ダイアログの見え方 | 意味 |
|---|---|
| asc が赤、desc が灰 | 先頭のエントリを読んでいる。各アプリの icns を `build_icns.py` で作り直せば直る |
| asc / desc とも赤 (16x16 マス) | 並び順によらず 16px のエントリを選んでいる。no16 を見る |
| ↑ かつ no16 が橙か黄で、市松が 32x32 マス | 32px のエントリが届いている。16px を抜けば今より鮮明になる |
| ↑ かつ no16 が無地 | 大きいエントリを 16x16 に縮めて渡している。バンドル側では 16px より細かくできない |

## 依存ライブラリの挙動を調べる時

Tauri / tao / tray-icon は、ドキュメントに書かれていない単位系や前提で動いている
箇所がある。推測せず `~/.cargo/registry/src/*/<crate>-<version>/` のソースを読む。
今回の座標系の問題は全てそこで確定した。

Tauri の API は context7 MCP でも確認できる。
