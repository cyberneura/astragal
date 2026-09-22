#!/usr/bin/env python3
"""PNG から `.icns` を組み立てる (標準ライブラリだけ)。

    python3 resources/app-icons/build_icns.py <master.png> <out.icns>
    python3 resources/app-icons/build_icns.py <masters-dir> <out.icns>

**なぜ自前で書くか**: macOS の `iconutil` / `sips` は macOS でしか動かず、
Pillow も ImageMagick も入っていない環境がある。アイコンの解像度不足は
「1Password の権限ダイアログでアイコンがボケる」のような形で表に出るので
(CYBERNEURA-DEV-686)、直す手段が特定の OS でしか使えないのは困る。
縮小は 2 の冪の整数倍だけを扱うので、区画の平均がそのまま正しい答えになる
(補間の仕方を選ぶ余地が無い)。色はアルファを乗せてから平均する — 理由は
`downsample` のコメント。

マスターは 512x512 の 8bit RGBA (色型 6)、非インターレースを想定する。
それ以外は落とすのではなく、はっきり失敗させる — 黙って歪んだアイコンを
出す方が困るため。

入れるスロットは `iconutil` が `.iconset` から作るものと同じ:

    icp4 16   ic11 32(=16@2x)   icp5 32   ic12 64(=32@2x)
    ic07 128  ic13 256(=128@2x) ic08 256  ic14 512(=256@2x)  ic09 512

**エントリは大きいサイズから順に並べる** (`iconutil` とは逆順)。icns の中から
「最初の 1 枚」だけを取る実装があり、その場合は先頭の 16px が拡大されて表示される。
1Password の SSH キー許可ダイアログで Astragal のアイコンがボケていた件の対策で
(CYBERNEURA-DEV-686)、きれいに出ていた iTerm2 の icns は先頭が 256px、ボケていた
Astragal / quickllm / clipboard-palette は先頭が 16px だった。サイズを選んで引く
macOS の通常の経路 (Finder / Dock / NSImage) は並び順に依存しないので、逆順にして
失うものは無い。

**入れるのはマスター以下のサイズだけ。** 512 のマスターから 1024 を作っても
拡大であって解像度ではないので、無い方が正直で、Finder も無ければ 512 を使う。
逆にマスターが 1024 あれば `ic10` も入る (このリポジトリのマスターがそれ)。

**サイズごとに描き分けたマスターを渡せる。** 第 1 引数にディレクトリを渡すと、
その中の `*<size>*.png` (例 `icon-16.png`) を各スロットへそのまま入れる。
太さ 3% の線は 512 から 16 へ縮小すると 0.5px になって消えるので、小さい
サイズだけ線を太く描いた絵を使いたいことがある (quickllm の
`resources/app-icons/generate.py` がそれ。CYBERNEURA-DEV-823)。
ちょうどのサイズが無いスロットは、それより大きい最小のマスターから縮小する。
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# スロットとその一辺 (px)。`iconutil` の .iconset からの対応と同じ。
SLOTS: list[tuple[bytes, int]] = [
    (b"icp4", 16),
    (b"ic11", 32),
    (b"icp5", 32),
    (b"ic12", 64),
    (b"ic07", 128),
    (b"ic13", 256),
    (b"ic08", 256),
    (b"ic14", 512),
    (b"ic09", 512),
    (b"ic10", 1024),
]


class Image:
    """8bit RGBA の画素。`rows[y]` が 1 行分の bytes (幅 * 4)。"""

    def __init__(self, width: int, height: int, rows: list[bytearray]):
        self.width = width
        self.height = height
        self.rows = rows


def _chunks(data: bytes):
    """PNG のチャンクを順に返す。長さも CRC も検証する。

    壊れた入力は `struct.error` や `IndexError` ではなく `ValueError` で落とす
    ——「黙って歪んだアイコンを出さない」がこのスクリプトの約束なので、
    受け取れない入力はその場で名前を付けて断る。
    """
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("not a PNG")
    offset = len(PNG_SIGNATURE)
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("truncated PNG (chunk header)")
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        end = offset + 12 + length
        if end > len(data):
            raise ValueError("truncated PNG (chunk body)")
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        (declared,) = struct.unpack(">I", data[end - 4 : end])
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != declared:
            raise ValueError(f"corrupt PNG ({kind.decode('ascii', 'replace')} chunk CRC)")
        yield kind, payload
        offset = end


def _unfilter(raw: bytes, width: int, height: int) -> list[bytearray]:
    """PNG の行フィルタを戻す (仕様どおり 5 種類とも)。"""
    stride = width * 4
    rows: list[bytearray] = []
    previous = bytearray(stride)
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        line = bytearray(raw[offset + 1 : offset + 1 + stride])
        offset += 1 + stride
        for index in range(stride):
            left = line[index - 4] if index >= 4 else 0
            up = previous[index]
            up_left = previous[index - 4] if index >= 4 else 0
            value = line[index]
            if filter_type == 0:
                pass
            elif filter_type == 1:
                value += left
            elif filter_type == 2:
                value += up
            elif filter_type == 3:
                value += (left + up) // 2
            elif filter_type == 4:
                # Paeth
                estimate = left + up - up_left
                da, db, dc = abs(estimate - left), abs(estimate - up), abs(estimate - up_left)
                if da <= db and da <= dc:
                    value += left
                elif db <= dc:
                    value += up
                else:
                    value += up_left
            else:
                raise ValueError(f"unknown PNG filter {filter_type}")
            line[index] = value & 0xFF
        rows.append(line)
        previous = line
    return rows


def read_png(path: Path) -> Image:
    data = path.read_bytes()
    header = None
    idat = bytearray()
    for kind, payload in _chunks(data):
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            idat += payload
        elif kind == b"IEND":
            break
    if header is None:
        raise ValueError("PNG without IHDR")
    width, height, depth, colour, compression, filter_method, interlace = header
    if (depth, colour, compression, filter_method, interlace) != (8, 6, 0, 0, 0):
        raise ValueError(
            "expected an 8-bit RGBA, non-interlaced PNG "
            f"(got depth={depth} colour={colour} interlace={interlace})"
        )
    return Image(width, height, _unfilter(zlib.decompress(bytes(idat)), width, height))


def downsample(image: Image, size: int) -> Image:
    """整数倍で縮小する。倍率が整数でなければ失敗させる。"""
    if image.width != image.height:
        raise ValueError("expected a square master")
    if size == image.width:
        return image
    if image.width % size:
        raise ValueError(f"{image.width} is not an integer multiple of {size}")
    factor = image.width // size
    area = factor * factor
    rows: list[bytearray] = []
    for y in range(size):
        line = bytearray(size * 4)
        sources = image.rows[y * factor : (y + 1) * factor]
        for x in range(size):
            start = x * factor * 4
            # **色はアルファを乗せてから平均する。** 素の RGB を平均すると、
            # 透明な画素に残っている色 (書き出し側が 0 を入れていることが多い)
            # が縁に混ざり、合成した時に黒い輪郭が出る。最後に割り戻して
            # 元の (非乗算の) 形へ戻す。
            red = green = blue = alpha = 0
            for source in sources:
                for step in range(factor):
                    base = start + step * 4
                    a = source[base + 3]
                    red += source[base] * a
                    green += source[base + 1] * a
                    blue += source[base + 2] * a
                    alpha += a
            out = x * 4
            if alpha == 0:
                # 完全に透明な区画。色は意味を持たないので 0 で埋める。
                line[out : out + 4] = b"\x00\x00\x00\x00"
                continue
            # 丸めは四捨五入 (切り捨てると縮小のたびに暗くなる)。
            line[out] = (red + alpha // 2) // alpha
            line[out + 1] = (green + alpha // 2) // alpha
            line[out + 2] = (blue + alpha // 2) // alpha
            line[out + 3] = (alpha + area // 2) // area
        rows.append(line)
    return Image(size, size, rows)


def write_png(image: Image) -> bytes:
    raw = bytearray()
    for row in image.rows:
        raw.append(0)  # フィルタなし。ここは大きさより読みやすさを取る
        raw += row
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )
    header = struct.pack(">IIBBBBB", image.width, image.height, 8, 6, 0, 0, 0)
    return (
        PNG_SIGNATURE
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def build_icns(masters: dict[int, Image]) -> bytes:
    """`{一辺: 画像}` から icns を組み立てる。

    スロットにちょうどのマスターがあればそれを使い、無ければそれより大きい
    最小のマスターから縮小する。
    """
    if not masters:
        raise ValueError("no masters given")
    largest = max(masters)
    # マスターより大きいスロットは飛ばす。埋めれば「あることになる」が、中身は
    # 引き伸ばした絵でしかなく、macOS が自前で拡大するのと変わらない
    # (かえって「1024 がある」と読める分たちが悪い)。
    usable = [(slot, size) for slot, size in SLOTS if size <= largest]
    if not usable:
        raise ValueError(f"masters are smaller than the smallest slot ({SLOTS[0][1]}px)")
    rendered: dict[int, bytes] = {}
    entries = bytearray()
    # 大きい順に書く (先頭の 1 枚だけを読む実装向け。モジュールの docstring 参照)
    for slot, size in sorted(usable, key=lambda entry: entry[1], reverse=True):
        if size not in rendered:
            if size in masters:
                image = masters[size]
            else:
                source = min(s for s in masters if s >= size)
                image = downsample(masters[source], size)
            rendered[size] = write_png(image)
        payload = rendered[size]
        entries += slot + struct.pack(">I", len(payload) + 8) + payload
    return b"icns" + struct.pack(">I", len(entries) + 8) + bytes(entries)


def read_masters(source: Path) -> dict[int, Image]:
    """PNG 1 枚、またはサイズ別 PNG の入ったディレクトリを読む。

    正方形の確認はここで行う。ちょうどのサイズのマスターは `downsample` を
    通らずにそのままスロットへ入るので、あちらの検査に任せると
    16x8 のような画像が黙って icns に入ってしまう。
    """
    def load(path: Path) -> Image:
        image = read_png(path)
        if image.width != image.height:
            raise ValueError(
                f"{path} is {image.width}x{image.height}; masters must be square"
            )
        return image

    if source.is_file():
        image = load(source)
        return {image.width: image}
    paths = sorted(source.glob("*.png"))
    if not paths:
        raise ValueError(f"{source} has no *.png")
    masters: dict[int, Image] = {}
    for path in paths:
        image = load(path)
        if image.width in masters:
            raise ValueError(f"two masters claim {image.width}px (second: {path})")
        masters[image.width] = image
    return masters


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    masters = read_masters(Path(argv[1]))
    Path(argv[2]).write_bytes(build_icns(masters))
    largest = max(masters)
    written = sorted({size for _, size in SLOTS if size <= largest})
    # どのサイズをそのまま使い、どれを縮小で作ったかを出す。
    # 「サイズ別に描いたつもりがファイル名を間違えていて縮小されていた」を
    # 気付けるようにするため。
    detail = ", ".join(
        f"{size}{'' if size in masters else '*'}" for size in written
    )
    legend = "  (* = downsampled, no master at that size)" if "*" in detail else ""
    print(f"{argv[2]}: {detail}{legend}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
