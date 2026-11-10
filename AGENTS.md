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
| `src/terminal.ts` | xterm の生成とテーマ適用、インライン画像 (imgcat / SIXEL) の addon |
| `src/links.ts` | URL の検出と Cmd+クリックでの起動 |
| `src-tauri/src/cli.rs` | コマンドライン引数 (`-e` / `--working-directory`)、ターミナルからの起動し直し、`/usr/local/bin` への導入 |
| `src/tabs.ts` | タブ管理、Cmd 系キーバインド、Ctrl+Tab のタブ巡回、Cmd+Shift+[ / ] のタブ移動、Cmd+K のクリア |
| `src/ai.ts` / `src-tauri/src/ai.rs` | Cmd+I の Ask AI (依頼からシェルコマンドを 1 行作り、プロンプトに貼り付ける。既定は無効) |
| `src/tab-summary.ts` / `src-tauri/src/tab_summary.rs` | タブ名と要約の自動生成 (いつ送るか・表示 / provider の起動と応答の整形。既定は無効) |
| `src/remote-drop.ts` / `src-tauri/src/remote_drop.rs` | ssh 中のタブへファイルをドロップして scp で送る (ドロップゾーンと確認ダイアログ / ssh の argv の解釈と scp の引数) |
| `src/search.ts` | Cmd+F の検索バー (xterm-addon-search)。ウインドウに 1 つで、アクティブなタブを検索する |
| `src/main.ts` / `src/small.ts` | メインウインドウ / 吹き出しの入口 |
| `src/about.ts` | トレイメニューの About から開くウインドウ。バージョンの下にビルド日時 (UTC) を出す (`app_info` の `build_date`) |
| `src/licenses.ts` | トレイメニューの Third-Party Licenses から開くウインドウ (`THIRD-PARTY-NOTICES.txt` を表示) |
| `src-tauri/src/objc_exception.rs` / `src-tauri/src/macos/exception_guard.m` | macOS: AppKit がイベント処理中に投げた Objective-C 例外で落ちないように NSApplication の `-sendEvent:` を包む |
| `resources/app-icons/` | アイコンのマスター素材と `generate.py` / `inspect_icns.py` |

常駐ウインドウは 2 つある。`main` (タブ付き) と `small` (メニューバーアイコン直下に出る
吹き出し)。挙動が違うので、片方だけ直して済ませないこと。`about` と `licenses` は開くたびに作り、
閉じると破棄される。

## ビルド日時の表示 (src-tauri/build.rs)

About ウインドウのバージョンの下の行にビルド日時 (UTC) を出す
(CYBERNEURA-DEV-1214。beckwell の CYBERNEURA-DEV-1143 と同じ作り)。`build.rs` が `ASTRAGAL_BUILD_DATE`
(`YYYY-MM-DD HH:MM UTC`、`SOURCE_DATE_EPOCH` があればそれ) を埋め込み、`lib.rs` の `BUILD_DATE` が読む。
tauri-build は設定ファイルにしか `rerun-if-changed` を出さないので、存在しないパスの `rerun-if-changed` で
build.rs を毎回走らせている (ソースだけを変えたビルドで古い日時が残らないように)。
macOS のアプリメニューの About も標準パネルではなく、トレイと同じ About ウインドウを開く (`APP_MENU_ABOUT_ID`)。
標準パネルのバージョン行は "Version <ApplicationVersion> (<Version>)" の 1 行で、muda の `AboutMetadata` は
`version` を括弧の外 (ApplicationVersion)、`short_version` を括弧の中 (Version) に渡す。
「バージョンの下の行にビルド日時」を指定する項目が無いので、標準パネルには戻さない。

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

## インライン画像 (CYBERNEURA-DEV-976)

`xterm-addon-image` (0.5.0、legacy の `xterm` 5.x 向けの最終版) で iTerm2 の Inline Image
Protocol (OSC 1337、imgcat が出す) と SIXEL を描く。このリポジトリは scoped でない
`xterm` / `xterm-addon-*` で揃えているので、`@xterm/addon-image` は使えない (別パッケージの
`Terminal` を要求する)。`@xterm/*` へ一括で移行する時に一緒に載せ替える。

- 画像は addon が `.xterm-screen` に重ねる自前のキャンバスに描くので、レンダラーは既定の
  DOM のままでよい (canvas / webgl addon は要らない)
- **`size=` は実際のバイト数と一致していないと無言で捨てられる** (addon の base64 デコーダが
  宣言サイズで判定する)。imgcat は `wc -c` の値を送るので合う。手で試す時は注意
- pty からは 4096 バイトずつ届く (`lib.rs` の reader thread) が、OSC は xterm のパーサーが
  跨いで組み立てるので分割は問題にならない
- `storageLimit` はタブ 1 つあたり。addon は画像を RGBA で保持するので、既定の 128 MB を
  64 MB に下げている (`createImageAddon`)
- 実機は無いが、`Terminal` + `ImageAddon` だけの harness をリモート Chrome に読ませれば
  描画まで実測できる (2026-10-08 に PNG の IIP と SIXEL を確認。size をずらすと落ちることも
  同じ方法で確認した)

## ドロップして scp で送る (CYBERNEURA-DEV-1177)

アクティブなタブの pty の前面のプロセスグループのリーダーが `ssh` の時だけ、ドロップした
ファイルを scp でそのホストへ送る。設計上の前提:

- **ssh かどうかと接続先は Rust だけが決める。** `MasterPty::process_group_leader` (tcgetpgrp) の
  PID の argv を、macOS は `sysctl(KERN_PROCARGS2)`、Linux は `/proc/<pid>/cmdline` で読み、
  `remote_drop::parse_ssh_argv` が ssh.c と同じ getopt の規則で解釈する (接続先の後ろのオプションも
  読み直す。`ssh host -p 2222` が通る)。フロントはタブ id と、確認ダイアログを出した時の `key`
  (`SshTarget::identity` = PID + scp に渡すオプション + ホスト) しか渡さない。送る直前に読み直して比べ、確認の間に
  ssh を抜けた・繋ぎ直した時は断る。表示用の `label` では比べない (`-o HostName` や `-F` の違いが出ないため)
- 接続に効くオプションだけを scp に写す。**ssh の優先順位を崩さないこと。** ssh は user / port を
  「まだ決まっていなければ」で埋める (`-l` / `-p` / `-o User` / `-o Port` / 接続先の中の値は先に出たものが勝つ) ので、
  全部 `-o User=` / `-o Port=` にして argv の順のまま渡し、内側の ssh に選ばせる (scp の `-P` は使わない)。
  `-S/-b/-B/-m/-I/-P` は ssh が後から上書きする (後勝ち) ので、最後の値だけを `-o` にして先頭に置く。
  `-c/-F/-i/-J/-o` はそのまま。相対パスの `-F` は ssh の作業ディレクトリで読まれるので、対象外にする。転送 (`-L/-R/-D/-w`) は捨てる。`-o RemoteCommand` / `RequestTTY` 等は
  scp と両立しないので捨てる。`-G/-V/-Q/-O/-W/-f` を含む起動 (対話の接続ではない) と、知らない
  オプションを含む起動は対象外。tmux / mosh / autossh 越しの ssh は前面のプロセスが ssh ではないので出ない
- scp は `-o BatchMode=yes` で、標準入力も閉じて起動する。GUI から起動した scp には端末が無く、
  パスワードを尋ねられると答えようがない (止まったままになる)。鍵・エージェント・ssh の
  ControlMaster で繋いでいる接続先だけで送れる。エージェントのソケットは ssh のプロセスの環境変数の
  `SSH_AUTH_SOCK` を引き継ぐ (シェルの rc で 1Password 等に向けているとアプリの環境と違うため)
- 送り先は確認ダイアログで決める (既定は `~` = ホーム)。ディレクトリ名の末尾に `/` を付けるので、
  無いディレクトリを指定するとその名前のファイルを作らずに失敗する。ディレクトリを含むと `-r`。
  送り元は `--` の後ろに置く (ドロップされるパスは絶対パスなので、`:` を含んでもリモート扱いにならない)
- ssh の cwd は見ていない。`-i` に相対パスを渡した ssh だと scp が鍵を見つけられないことがある (送り先は変わらない)
- Windows は対象外 (ConPTY の前面のプロセスを取れない。`remote_drop_target` が常に `None`)
- macOS の `process_args` (sysctl) はこのリポジトリの Linux 環境では検査できない。`parse_procargs2` は
  純粋な関数にしてテストしてある。ドラッグの見た目はリモート Chrome に Tauri API をモックした
  harness で確認した (2026-10-30)。実機での確認は未実施

## コマンドライン (`astragal -e`)

`/usr/local/bin/astragal` は .app の中のバイナリへのシンボリックリンク (トレイメニューの
Install 'astragal' Command in PATH で作る)。設計上の前提:

- **ターミナルから直接起動されたら `open -n -a` で起動し直す** (`relaunch_from_terminal`)。
  未起動の時にそのまま本体になると、ターミナルの子として残り、タブを閉じた時の SIGHUP で
  落ちる。判定は「親が launchd (pid 1) でない」かつ「.app の中で動いている」。dev 実行
  (`pnpm tauri dev`) はバンドルの外なので起動し直さない
- 起動し直したプロセスの cwd は `/` なので、`-e` の開始位置は `--working-directory=` で
  明示して渡す。起動済みなら、起動し直したプロセスが single-instance の Unix ソケットで
  本体へ argv を送って終わる (cwd も送られるが `/` なので使えない)
- 本体はタブを開く要求を `AppState.launch_requests` に積み、main の front が id で
  `create_terminal` に渡して取り出す。front が起動前でも取りこぼさないように、イベント
  (`launch-requested`) と `pending_launches` の両方から拾い、front 側で重複を除く。
  イベントは `present_window` の前に送る (後だと `window-shown` の補充で空のタブが増える)
- `-e` は xterm / Ghostty と同じく残りの引数をすべて取る。iTerm2 に相当する CLI は無い
- **Windows の single-instance は argv を `|` で連結・分割して送る** (plugin 2.4.3 の
  `platform_impl/windows.rs`)。パイプ入りの `-e` が割れるので、引数に `|` があれば
  `--exec-base64=` に包んで自分を起動し直してから送る (`forward_without_pipes`)。
  包むのはコマンドだけなので、作業ディレクトリに `|` が残る時は起動し直さずにそのまま
  続ける (起動し直した先でも `|` が見つかり、起動し直しが終わらなくなる)。
  Windows で `-e` の後ろに複数の引数を取らないのは、cmd と PowerShell で引用の規則が違うため
- `--minimized` / `--help` の判定も `cli::parse` を通す。argv 全体を探すと `-e` の
  コマンドの引数に反応する
- **Windows のリリース版は GUI サブシステム** (`main.rs` の `windows_subsystem`) なので
  stderr / stdout はどこにも出ない。利用者に見せる CLI の出力 (`--help`・引数の誤り) は
  起動してからダイアログで出す (`report_cli_help` / `report_cli_error`)
- 実機で試す時は、インストール済みの Astragal を終了しておく。single-instance のソケット
  (`/tmp/com_cyberneura_astragal_si.sock`) は identifier だけで決まり、ビルド版の引数が
  インストール版へ送られてしまう

## Ask AI (CYBERNEURA-DEV-898)

Warp の自然言語コマンド入力に相当する機能。設計上の不変条件:

- **既定は無効** (`ai.enabled: false`)。外部へテキストを送る機能なので、依頼者の指示で
  スイッチにしている。無効ならバーも作らず Cmd+I は何もしない
- **実行しない。** 応答はまずバーに表示し、もう一度 Enter で `terminal.paste()` するだけ。
  pty に Enter は送らない。表示を挟むのは、貼り付け先がシェルのプロンプトか確かめる手段が
  無いため (代替バッファかどうかしか分からない)。
  改行・制御文字を含む応答は `ai.rs` の `parse_reply` で弾く (改行は pty では Enter と同じ)。
  代替バッファ (vim 等) の表示中も打ち込まない
- **送るのは依頼文・OS 名・シェル名・バーを開いた時の選択テキストだけ。** スクロールバックを
  黙って送らない。選択を送る時はバーに表示する
- 対象タブと選択はバーを開いた時に固定し、タブが切り替わったら閉じる (`syncAiWithActiveTab`)。
  別タブの選択を送る・見えていないタブへ貼り付ける、を防ぐため
- API キーは Rust 側だけに置き、`FrontendConfig` には `ai_enabled` しか渡さない。
  `AiConfig` の Debug はキーを伏せている
- HTTP は reqwest (tauri が既に引いている 0.13) を `native-tls` で使う。既定の rustls は
  aws-lc-rs を引き、Windows のビルドに cmake / nasm が要るため避けた
- 既定モデルは `claude-opus-5` + `effort: low`。モデルを変える時、Haiku 4.5 のように
  effort を受け付けないモデルは `effort: ""` が要る (送ると 400)

## Agent chat (main の右ペイン)

`src/chat/pane.ts` が UI とタブごとの会話を持ち、`src/chat/beckwell/` は Beckwell の
stream-json / app-server の共通エンジンと Markdown 描画のコピー。移植元の revision と
差分は `docs/beckwell-chat.md`。Rust の `agent_process.rs` は子プロセスと JSON 行の中継、
`chat_window.rs` は幅の拡張と復元。small には作らない。

- `#workspace` の左 `#terminal-pane` にタブバー・サマリー・ターミナルを収め、右のチャットは
  ウインドウ上端から使う。チャットのヘッダーは provider / path / context のコンパクトな 3 行
- Follow はタブごとに既定 OFF。Codex の `turn/start.cwd` で次の送信時にローカル OSC 7 の cwd を
  渡し、thread は維持する。実行中は変更しない。OFF では表示中の cwd を固定する。
  remote の OSC 7 は cwd を不明に戻し、追従中に不明なら送信を止める。
  Claude は実行中の cwd 変更をサポートしていないためスイッチを無効にする

- `agent_chat` の既定は有効だが、開いただけではターミナル出力を送らない。送信のたびに
  `TerminalContext.snapshot` で最後の完了済み N ターンを選び、その後にブラックリストで
  ターン全体を除外する。除外分を古いターンで補充しない。設定の blacklist は追加分だけ
- `shell_integration.rs` は main の対話 zsh に一時 ZDOTDIR を渡し、ユーザーの dotfile を
  読んでから OSC 133 の A/C/D と OSC 7 の cwd を出す。元の dotfile は編集しない。
  境界が分からないシェルでは履歴を推測して送らない。`-e` は対象外
- 生出力を分割 UTF-8 / OSC の境界を跨いで読む。未完了ターンと 131,072 UTF-16 code units を超えるターンを
  送らない。保持は最大 20 ターン。これは Astragal の添付範囲の制限であり、エージェントの
  独立したファイルアクセスのサンドボックスではない
- 書き戻しは最終応答の `astragal-terminal` コードブロック 1 個、単一行だけ。
  `result.finalText` だけを使う。Claude は result の本文、Codex は最後の完了済み回答
  (commentary / partial_answer を除外し、後続の tool / reasoning で無効化) から取る。
  Enter は送らない。送信時のタブ・入力 revision・通常バッファ・空のプロンプト・表示中の
  ペインを全て確かめる。中断した応答からは書き戻さない
- 手動入力は完了済み回答のコードブロックごとのアイコンから行う。自動書き戻しと違い
  入力 revision・空プロンプトは要求しない。表示中の同じタブの通常バッファへ貼り付け、
  Enter は追加しない。改行・タブを含むブロックは bracketed paste が有効な時だけ許可する
- CLI の承認方針を緩めない。承認と質問は Beckwell のプロトコルで UI に出す。会話を
  作り直すと process ID を変え、古いプロセスの非同期 callback でも状態を書き換えない
  (await 後にも世代を確認する)。承認・質問の decision は送信前に UI 側で設定する。
  プロトコルは送信失敗時に pending へ戻すだけなので、UI 側での二重送信防止が必要
- pane を閉じてもプロセスは残す。タブを閉じる・New chat・アプリ終了・フロントの
  再初期化で終了させる。SIGTERM の後に期限付き SIGKILL へ進む
- `pnpm test:chat` は共有範囲と書き戻しのテスト。`tests/agent-smoke.mjs` は実 CLI に合成の
  接続確認だけを送る任意テスト。ネットワークと通常の資格情報へのアクセスが必要

## タブ名と要約 (CYBERNEURA-DEV-1197)

出力のあったタブの末尾 120 行を LLM に渡し、タブ名 (全角 10 / 半角 20 文字) と 1〜2 文の要約を
作らせる。設計上の前提:

- **既定は無効** (`tab_summary.enabled: false`)。Ask AI と違って画面の中身そのものを送るので、
  README に送る範囲を書いてある。webview には `enabled` / `display` / `interval_seconds` だけを
  渡し、provider・API キーは Rust 側に置く
- **CLI の provider はツールを全部切って起動する。** ターミナルの出力は任意の文字列で、
  「このファイルを読め」のような注入を書ける。Claude Code は `--tools "" --strict-mcp-config
  --setting-sources ""` (ユーザー設定のフックも動かさない)、Codex は `--disable shell_tool /
  unified_exec / code_mode_host / view_image / image_generation / apps / plugins / remote_plugin /
  browser_use / in_app_browser / computer_use / multi_agent` と `-c web_search=disabled`、
  さらに `--ignore-user-config` (`~/.codex/config.toml` の `mcp_servers` は `--disable` では消えない)。
  read-only の sandbox でもファイルは読めるので、sandbox だけに頼らないこと。
  2026-11-05 に Linux で、ツールを切った codex がシェルを実行できないこと (切らないと実行しに行く) と、
  出力に混ぜた「~/.ssh/id_rsa を出せ」を claude-code が無視することを確かめた。`view_image` (画像のパスを渡すとそのファイルを読む) と
  `code_mode_host` (`functions.exec` の JS) は最初は切り忘れていた (CYBERNEURA-DEV-1198 の Codex レビューで発覚)。
  モデルの「使えるツール」の自己申告は当てにならないので、確かめる時は実際にファイルを読ませる。
  知らない feature 名を渡すと codex は `Unknown feature flag` で起動を断る (要約が失敗するだけで、緩む方には倒れない)
- **Claude Code / Codex の要約は sandbox を必須にする。** Codex は `--sandbox read-only`、
  Claude Code は `--settings` で `sandbox.enabled: true` / `failIfUnavailable: true` /
  `allowUnsandboxedCommands: false` を渡す。利用不可時の続行や sandbox 外への再試行を許さない。
  Claude Code はこれらの設定に対応した版と sandbox 対応環境が必要 (native Windows は対象外)。
  ツールの無効化も維持する。
- テキストは全部標準入力で渡す (引数は `ps` に見える)。作業ディレクトリは生成ごとの空の一時
  ディレクトリ (プロジェクトの CLAUDE.md / AGENTS.md を拾わない)。Codex の応答は `-o` のファイルから読む
- `claude` / `codex` は node 製なので、GUI の最小の PATH では node が見つからない (asdf / nvm)。
  `shell.command` が zsh / bash / ksh ならログインシェル越しに `exec "$@"` で起動する (コマンド名と
  引数はシェルに解釈させない)。fish 等はそのまま起動する
- 名前の幅と重複は Rust (`clean_title` / `make_unique`) で揃える。モデルは指示しても超えてくる。
  幅は unicode-width を足さずに East Asian Wide の主な範囲で近似している (`char_width`)
- いつ送るかはフロント (`tab-summary.ts`): 出力 (`onWriteParsed`) が 5 秒止まったら、タブごとに
  `interval_seconds` (既定 120、下限 15) に 1 回、ウインドウで同時に 1 本 (main と small を跨ぐ
  CLI の起動は Rust の `CLI_LOCK` で 1 本にする)。待ち行列に入った後に出力が再開したら列から外して
  待ち直す。前回と同じテキストは送らない (失敗した時は覚えず、次の出力の後に送り直す)。
  読むのは通常バッファ (vim 等の表示中も、その前にシェルで打った内容を読む)
- 要約の行 (`display: bar`) は要約の有無に関わらず常に置く。出し入れするとターミナルの行数が動く
- 失敗したら名前は変えず、要約の場所に理由を出す (CLI が無い・未ログインに気付けるように)
- **実機確認は未実施。** Rust は抜き出したクレートで単体テストと、このホストの claude / codex を
  実際に呼ぶ結合確認をした。fm と API の provider は呼んでいない

## コマンド

```shell
pnpm install
pnpm tauri dev
pnpm tauri build      # src-tauri/target/release/bundle/macos/Astragal.app

cd src-tauri && cargo test
cd src-tauri && cargo clippy --all-targets
pnpm exec tsc --noEmit
```

Windows ターゲットの検査 (`--target x86_64-pc-windows-msvc`) は tauri-winres が `llvm-rc` を
要求するので、無い mac では通らない。PR の CI (`release.yml` の test ジョブ、windows-latest) で見る。

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

### Dock には main の表示中だけ出す (CYBERNEURA-DEV-954)

起動時は `ActivationPolicy::Accessory` と `src-tauri/Info.plist` の `LSUIElement` の両方で
Dock に出さない。前者は dev 実行 (バンドルされない素のバイナリ)、後者はバンドル版の起動直後の
ちらつき防止。**Accessory の間はアプリメニューが描画されないが Cmd+C / Cmd+V は効く**
(`NSApp` の main menu オブジェクトは残り `performKeyEquivalent:` が辿るため)。

main を出している間だけ `Regular` に切り替えて Dock に出し、隠したら `Accessory` に戻す
(`dock_follows`)。吹き出しや About だけを開いても Dock には出さない。

- **main を出し入れする経路は全部 `dock_follows` を通す。** 出す側は `present_window`
  (ホットキー・トレイメニュー・single-instance・Dock の Reopen が全部ここを通る) と setup の
  初回表示。隠す側は `toggle_visibility` / `hide_window` / `hide_on_close` / `hide_on_blur`。
  `win.hide()` を新しく書く時は忘れないこと (Dock にアイコンが残る)
- **アプリメニューの Hide (Cmd+H) は自前の項目** (`app_menu`)。Regular の間はアプリメニューが
  出るが、Tauri 既定の `PredefinedMenuItem::hide` は AppKit の `hide:` を直接呼ぶので、
  `dock_follows` を通らず Dock にアイコンだけが残る。`app_menu` は既定メニューと同じ構成で
  Hide だけを差し替え、`hide_all_windows` (全ウインドウを隠して `dock_follows`) を通す。
  Dock アイコンの右クリックの「隠す」は AppKit が直接処理するので拾えていない
  (Dock に残るだけで、クリックすれば Reopen で main が出る)。
  **アプリメニューに項目を足す時は `app_menu` を直す** (既定メニューはもう使っていない)
- 出す時は Regular に切り替えてから `show` / `set_focus` する
- Dock アイコンのクリックは `RunEvent::Reopen` で受けて main を前に出す
  (`.build()` してから `.run(|app, event| ...)` にしているのはこのため)

### トレイのメニューは右クリックの時だけ付ける (macOS、CYBERNEURA-DEV-954)

macOS では `TrayIconBuilder::menu()` を使わない。NSStatusItem に menu が付いていると
AppKit がクリックでそれを開く。tray-icon 0.24 はボタンに重ねたサブビュー (`TaoTrayTarget`)
でクリックを横取りして `show_menu_on_left_click(false)` を実現しているが、実機では左クリックでも
メニューが出た。横取りがどこで外れるのかは確かめられていない (OS 側の処理順、サブビューの frame が
作成時に一度合わせるだけであること、等が候補)。menu を付けなければ AppKit が開く経路が無くなる。
右クリック (Down) の時だけ `set_menu` → `show_menu` (`performClick:`、閉じるまで戻らない) →
`set_menu(None)` で開く (`popup_tray_menu`)。Windows は従来どおり `menu()` +
`show_menu_on_left_click(false)` (OS のトレイが右クリックで開く)。

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

### イベント処理中の Objective-C 例外 (CYBERNEURA-DEV-1204)

v0.14.0 が `abort() called` / 「panic in a function that cannot unwind」で落ちたクラッシュレポートの
正体は、**AppKit が `sendEvent:` の中で投げた NSException が tao の `extern "C"` の
`-[TaoApp sendEvent:]` を越えようとして Rust が abort したもの**だった。release は
`panic = "abort"` なので、Rust の panic なら panic した地点で abort し、スタックの最上位に
tao のランディングパッドは来ない。普通の Cocoa アプリなら `-[NSApplication run]` が受け止めて
報告するだけの例外で、何が投げたかは分かっていない (クラッシュレポートからは読めない)。

- NSApplication 自身の `-sendEvent:` (tao の `[super sendEvent:]` が着く先) を `exception_guard.m` の
  `@try` 付きの実装に差し替え、受け止めた例外は `NSLog` と
  `~/Library/Logs/Astragal/exceptions.log` に書いて続ける (`-reportException:` は
  `NSApplicationCrashOnExceptions` が有効だとそこで落ちるので使わない)。
  受け止められるのは Rust のフレームを挟まずに届いた例外だけ (途中の objc2 のメソッド等から
  呼んだ AppKit が投げたものは、そのフレームで abort する)。**次に同じ例外が出たら、この
  ログの callStackSymbols で投げた場所が分かる**
- **`objc2::exception::catch` で書き直さないこと。** 閉包を Rust のトランポリン越しに呼ぶので、
  `panic = "abort"` では例外がそのフレームを通った時点で abort する。投げる側と受け止める側の
  間に Rust のフレームを挟まないために Objective-C で書いている
- Cmd+keyUp の時に tao が直接呼ぶ `[keyWindow sendEvent:]` は包んでいない (クラッシュは
  super 呼び出しの側だった)
- `.m` は build.rs が macOS ターゲットの時だけ cc でビルドする。**Linux では検査できない**
  (PR の CI の macOS の test ジョブで初めてコンパイルされる)
- 解析の手順: Release の dmg を展開して arm64 のスライスを取り出し (UUID がレポートの
  `slice_uuid` と一致するか見る)、strip 済みなので LC_FUNCTION_STARTS と `__unwind_info` の
  LSDA からフレームの関数とランディングパッドを引いた。panic 経路の関数は
  `"panic in a function that cannot unwind"` などの文字列参照で分かる

### 非表示ウインドウで requestAnimationFrame を待たない

webview の初期背景は白なので、新しいウインドウは `visible(false)` で作り、front が DOM を
埋めてからコマンドで show している (`about` / `licenses`)。この「show してもらう合図」を
`requestAnimationFrame` の中で送ると永遠に出ない。WebKit は見えていないページの
フレームを止めるため。DOM 更新の直後にそのまま invoke する。

### macOS app icon

Run `bash scripts/generate-macos-icons.sh` with Xcode on macOS. Fixed artwork,
layout measurements, size-specific sources and the verification command are in
`resources/app-icons/README.md`. Small @1x backgrounds reach the canvas edges;
the glyph fits inside the central 80%. Larger backgrounds have 10% outer margins.
Do not replace the generated ICNS with `tauri icon` / `iconutil`: preserve the
ARGB small entries and the matching Assets.car / CFBundleIconName registration.
Native rendering is verified by `.github/workflows/macos-icons.yml`.

Windows and menu-bar assets keep their independent generators.

## 依存ライブラリの挙動を調べる時

Tauri / tao / tray-icon は、ドキュメントに書かれていない単位系や前提で動いている
箇所がある。推測せず `~/.cargo/registry/src/*/<crate>-<version>/` のソースを読む。
今回の座標系の問題は全てそこで確定した。

Tauri の API は context7 MCP でも確認できる。
