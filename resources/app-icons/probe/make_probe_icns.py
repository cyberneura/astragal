#!/usr/bin/env python3
"""アイコンを表示する側が icns のどのエントリを使っているかを調べるための icns を作る。

    python3 resources/app-icons/probe/make_probe_icns.py <out-dir>

`<out-dir>` に 3 つ書く。エントリごとの絵は同じで、並び順と 16px の有無が違う:

    probe-asc.icns    小さい順 (`iconutil` / `tauri icon` と同じ)
    probe-desc.icns   大きい順 (`build_icns.py` と同じ)
    probe-no16.icns   大きい順から 16px (`icp4`) だけを抜いたもの

**エントリごとに色を変えてある** (下の `ENTRIES`)。ダイアログに出た色を見れば、
表示側がどのエントリを拾ったかが分かる。同じ 32px でも `ic11` (16@2x) と
`icp5` (32) は別の色にしてある — 1x / 2x のどちらとして引かれたかも区別したいため。

絵は 2px 角の市松模様で、エントリの色とその暗い色を交互に置く。

- 拾ったエントリの画素がそのまま拡大されていれば、市松のマス目が数えられる
  (16px なら 8x8 マス)。マス目の数がそのエントリの解像度を保ったまま届いたかの目安になる
  (途中で一度縮小してから拡大していれば無地に近づく)
- 大きいエントリを縮小して使っていれば、市松は平均されて無地に見える

CYBERNEURA-DEV-897。1Password の SSH キー許可ダイアログでアイコンがボケる件で、
「先頭のエントリだけを読む」仮説 (DEV-686) と「並び順によらず 16px のエントリを選ぶ」
仮説を切り分け、後者なら 16px を抜くと鮮明になるかまでを macOS 上で 1 回で見るために
作った。使い方は `build.sh` と AGENTS.md。
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_icns import Image, write_png  # noqa: E402

# (スロット, 一辺 px, 色)。並びは小さい順。
ENTRIES: list[tuple[bytes, int, tuple[int, int, int]]] = [
    (b"icp4", 16, (230, 40, 40)),  # 赤
    (b"ic11", 32, (245, 150, 20)),  # 橙 (16@2x)
    (b"icp5", 32, (240, 220, 30)),  # 黄
    (b"ic12", 64, (120, 210, 40)),  # 黄緑 (32@2x)
    (b"ic07", 128, (20, 160, 110)),  # 緑
    (b"ic13", 256, (30, 200, 230)),  # 水色 (128@2x)
    (b"ic08", 256, (40, 90, 230)),  # 青
    (b"ic14", 512, (140, 60, 220)),  # 紫 (256@2x)
    (b"ic09", 512, (230, 60, 200)),  # 桃
    (b"ic10", 1024, (90, 90, 90)),  # 灰 (512@2x)
]

COLOR_NAMES = {
    b"icp4": "red",
    b"ic11": "orange",
    b"icp5": "yellow",
    b"ic12": "yellow-green",
    b"ic07": "green",
    b"ic13": "light blue",
    b"ic08": "blue",
    b"ic14": "purple",
    b"ic09": "pink",
    b"ic10": "gray",
}

CELL = 2  # 市松の 1 マスの一辺 (px)


def checker(size: int, color: tuple[int, int, int]) -> Image:
    light = bytes(color) + b"\xff"
    dark = bytes(c // 2 for c in color) + b"\xff"
    # 1 行は 2 種類しか無いので、先に作って使い回す (1024px でも一瞬で終わる)
    cells = size // CELL
    even = bytearray(b"".join((light if i % 2 == 0 else dark) * CELL for i in range(cells)))
    odd = bytearray(b"".join((dark if i % 2 == 0 else light) * CELL for i in range(cells)))
    rows = [bytearray(even if (y // CELL) % 2 == 0 else odd) for y in range(size)]
    return Image(size, size, rows)


def assemble(entries: list[tuple[bytes, bytes]]) -> bytes:
    body = b"".join(slot + struct.pack(">I", len(png) + 8) + png for slot, png in entries)
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    out = Path(argv[1])
    out.mkdir(parents=True, exist_ok=True)
    rendered = [(slot, write_png(checker(size, color))) for slot, size, color in ENTRIES]
    (out / "probe-asc.icns").write_bytes(assemble(rendered))
    descending = list(reversed(rendered))
    (out / "probe-desc.icns").write_bytes(assemble(descending))
    (out / "probe-no16.icns").write_bytes(
        assemble([entry for entry in descending if entry[0] != b"icp4"])
    )
    print("entry  size  color")
    for slot, size, _ in ENTRIES:
        print(f"{slot.decode()}  {size:>4}  {COLOR_NAMES[slot]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
