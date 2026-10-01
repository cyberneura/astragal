#!/bin/sh
# 1Password 等のダイアログが icns のどのエントリを使うかを調べる検証用アプリを作る (macOS 専用)。
#
#     sh resources/app-icons/probe/build.sh [out-dir]
#
# out-dir (既定はこのディレクトリの build/) に 3 つの .app を作る。中身は同じで、
# icns のエントリの並び順と 16px の有無だけが違う:
#
#     IconProbe-asc.app   小さい順 (tauri icon / iconutil と同じ)
#     IconProbe-desc.app  大きい順 (build_icns.py と同じ)
#     IconProbe-no16.app  大きい順から 16px (icp4) を抜いたもの
#
# 要るのは python3 と swiftc (Xcode Command Line Tools)。起動の仕方と結果の読み方は
# AGENTS.md の「アイコン」の節 (CYBERNEURA-DEV-897)。
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/build"}
mkdir -p "$out"

python3 "$here/make_probe_icns.py" "$out"
swiftc -O -o "$out/IconProbe" "$here/IconProbe.swift"

for order in asc desc no16; do
  app="$out/IconProbe-$order.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$out/IconProbe" "$app/Contents/MacOS/IconProbe"
  cp "$out/probe-$order.icns" "$app/Contents/Resources/IconProbe.icns"
  # バンドル ID を変種ごとに分ける。同じ ID だと、1Password や LaunchServices が
  # 先に見た方のアイコンを覚えていて、もう片方を正しく比べられない恐れがある
  cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>IconProbe</string>
  <key>CFBundleIconFile</key><string>IconProbe</string>
  <key>CFBundleIdentifier</key><string>com.cyberneura.iconprobe.$order</string>
  <key>CFBundleName</key><string>IconProbe-$order</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
  codesign --force --sign - "$app"
done
rm -f "$out/IconProbe"

echo
echo "built: $out/IconProbe-asc.app $out/IconProbe-desc.app $out/IconProbe-no16.app"
echo "run each with:  open -n \"$out/IconProbe-asc.app\" --args <user@host>"
