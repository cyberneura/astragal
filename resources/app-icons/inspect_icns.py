#!/usr/bin/env python3
"""`.icns` に入っている解像度を一覧し、抜けがあれば失敗する。

アプリアイコンが「低解像度に見える」時、原因がこちらの資産なのか受け取り側なのかを
先に切り分けるための道具。標準ライブラリだけで動く。

    python3 resources/app-icons/inspect_icns.py [path/to/icon.icns]

macOS が引く解像度をすべて持っていれば 0、足りなければ 1 を返す。
"""

import struct
import sys
from pathlib import Path

DEFAULT = Path(__file__).resolve().parents[2] / "src-tauri" / "icons" / "icon.icns"

# OSType -> (このスロットが表す実ピクセル数, 説明)。
SLOTS = {
    "is32": (16, "16x16 legacy RGB"),
    "il32": (32, "32x32 legacy RGB"),
    "ih32": (48, "48x48 legacy RGB"),
    "it32": (128, "128x128 legacy RGB"),
    "ic04": (16, "16x16 ARGB"),
    "ic05": (32, "32x32 ARGB"),
    "icp4": (16, "16x16"),
    "icp5": (32, "32x32"),
    "icp6": (64, "64x64"),
    "ic07": (128, "128x128"),
    "ic08": (256, "256x256"),
    "ic09": (512, "512x512"),
    "ic10": (1024, "512x512@2x"),
    "ic11": (32, "16x16@2x"),
    "ic12": (64, "32x32@2x"),
    "ic13": (256, "128x128@2x"),
    "ic14": (512, "256x256@2x"),
}
# 圧縮された RGB / ARGB で入る型。寸法をヘッダに持たないので、中身からは確かめられず
# 型が名乗るサイズを信じるしかない。これ以外の型で PNG が読めなければ壊れている。
HEADERLESS = {"is32", "il32", "ih32", "it32", "ic04", "ic05"}
# 画像ではない補助チャンクなので、解像度の集計からは外す。
NON_IMAGE = {"s8mk", "l8mk", "h8mk", "t8mk", "TOC ", "icnV", "info", "name", "sbtp", "slct"}

# macOS が実際に引くサイズ。1024 が無いと Finder の最大表示や Dock の拡大で拡大される。
REQUIRED = (16, 32, 64, 128, 256, 512, 1024)


def read_entries(data, path):
    """(OSType, 中身) を先頭から順に返す。壊れていれば SystemExit で止まる。"""
    if data[:4] != b"icns":
        raise SystemExit(f"{path}: not an icns file")
    declared = struct.unpack(">I", data[4:8])[0]
    # ヘッダの宣言長がファイル長と食い違うファイルは、どこまでが本物か決められない。
    if declared != len(data):
        raise SystemExit(
            f"{path}: header says {declared} bytes but the file is {len(data)}"
        )
    offset = 8
    while offset < declared:
        # 端数が残るのは切り詰められている時。黙って読み飛ばすと抜けを見逃す。
        if offset + 8 > declared:
            raise SystemExit(f"{path}: {declared - offset} trailing bytes at {offset}")
        ostype = data[offset : offset + 4].decode("latin1")
        length = struct.unpack(">I", data[offset + 4 : offset + 8])[0]
        if length < 8 or offset + length > declared:
            raise SystemExit(f"{path}: broken entry {ostype!r} at offset {offset}")
        yield ostype, data[offset + 8 : offset + length]
        offset += length


def png_size(body):
    # IHDR の幅・高さは 16..24 バイト目。マジックだけ見て切り詰められたファイルを
    # unpack に渡すと例外になるので、長さも確かめてから読む。
    if len(body) < 24 or body[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", body[16:24])


def describe(ostype, body):
    """(表示用の文字列, このエントリが供給するピクセル数 or None) を返す。"""
    slot = SLOTS.get(ostype)
    actual = png_size(body)
    if slot is None:
        return (f"{actual[0]}x{actual[1]} png" if actual else "unknown type"), None
    expected, label = slot
    if actual is None:
        # PNG で入るはずの型が PNG として読めないなら、そのサイズは当てにできない。
        if ostype in HEADERLESS:
            return f"{label:<20} headerless", expected
        return f"{label:<20} NOT A PNG", None
    if actual != (expected, expected):
        return f"{label:<20} {actual[0]}x{actual[1]} png MISMATCH", None
    return f"{label:<20} {actual[0]}x{actual[1]} png", expected


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise SystemExit(f"{path}: {exc.strerror}")

    covered = set()
    print(f"{path} ({len(data)} bytes)")
    for ostype, body in read_entries(data, path):
        if ostype in NON_IMAGE:
            print(f"  {ostype}  {len(body):>7} bytes  (not an image)")
            continue
        shape, size = describe(ostype, body)
        print(f"  {ostype}  {len(body):>7} bytes  {shape}")
        if size is not None:
            covered.add(size)

    missing = [size for size in REQUIRED if size not in covered]
    print(f"\ncovered: {', '.join(str(s) for s in sorted(covered))}")
    if missing:
        print(f"missing: {', '.join(str(s) for s in missing)}")
        return 1
    print("all sizes present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
