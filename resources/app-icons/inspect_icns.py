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
# 型が名乗るサイズを信じるしかない。これ以外の型は PNG か JPEG 2000 で入る。
HEADERLESS = {"is32", "il32", "ih32", "it32", "ic04", "ic05"}
# 画像ではない補助チャンクなので、解像度の集計からは外す。
NON_IMAGE = {"s8mk", "l8mk", "h8mk", "t8mk", "TOC ", "icnV", "info", "name", "sbtp", "slct"}

# macOS が実際に引くサイズ。ここに抜けがあるとその大きさで表示された時に
# 拡大されてボケる (1Password の権限ダイアログの 16px がその例)。
REQUIRED = (16, 32, 64, 128, 256, 512)

# あると良いが、無くても落とさないサイズ。Finder の最大表示と Dock の拡大が
# 引く大きさだが、**512 のマスターしか無いアプリでは作りようがない** ——
# 拡大して埋めても解像度は増えず、512 を使う macOS の既定の方が正直なため
# (2026-09-07、CYBERNEURA-DEV-686 の指示)。
OPTIONAL = (1024,)


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


def _jp2_boxes(data):
    """JP2 のボックス列を (型, 中身) で返す。長さ 0 / 1 は末尾までの意味。"""
    offset = 0
    while offset + 8 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        boxtype = data[offset + 4 : offset + 8]
        if length == 0:
            length = len(data) - offset
        elif length == 1:
            # 64bit 長。アイコン程度の大きさでは出てこないので追わない。
            return
        if length < 8 or offset + length > len(data):
            return
        yield boxtype, data[offset + 8 : offset + length]
        offset += length


def jp2_size(body):
    """JPEG 2000 の寸法。icns の現代的なスロットは PNG か JPEG 2000 で入る。"""
    if body[:12] == b"\x00\x00\x00\x0cjP  \r\n\x87\n":
        for boxtype, content in _jp2_boxes(body):
            if boxtype != b"jp2h":
                continue
            for subtype, subcontent in _jp2_boxes(content):
                # ihdr は高さが先。PNG と順番が逆なので入れ替えて返す。
                if subtype == b"ihdr" and len(subcontent) >= 8:
                    height, width = struct.unpack(">II", subcontent[:8])
                    return width, height
        return None
    # 生のコードストリーム (SOC + SIZ)。Xsiz/Ysiz から原点を引いた分が寸法。
    if body[:4] == b"\xff\x4f\xff\x51" and len(body) >= 24:
        xsiz, ysiz, xosiz, yosiz = struct.unpack(">IIII", body[8:24])
        return xsiz - xosiz, ysiz - yosiz
    return None


def image_size(body):
    size = png_size(body)
    # (0, 0) を返す壊れた PNG を JPEG 2000 として読み直さないよう、明示的に判定する。
    return size if size is not None else jp2_size(body)


def describe(ostype, body):
    """(表示用の文字列, このエントリが供給するピクセル数 or None) を返す。"""
    slot = SLOTS.get(ostype)
    actual = image_size(body)
    if slot is None:
        return (f"{actual[0]}x{actual[1]}" if actual else "unknown type"), None
    expected, label = slot
    if actual is None:
        # 寸法を持つはずの型が読めないなら、そのサイズは当てにできない。
        if ostype in HEADERLESS:
            return f"{label:<20} headerless", expected
        return f"{label:<20} UNREADABLE", None
    if actual != (expected, expected):
        return f"{label:<20} {actual[0]}x{actual[1]} MISMATCH", None
    return f"{label:<20} {actual[0]}x{actual[1]}", expected


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
    absent_optional = [size for size in OPTIONAL if size not in covered]
    print(f"\ncovered: {', '.join(str(s) for s in sorted(covered))}")
    if absent_optional:
        print(f"absent (optional): {', '.join(str(s) for s in absent_optional)}")
    if missing:
        print(f"missing: {', '.join(str(s) for s in missing)}")
        return 1
    print("every required size is present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
