#!/usr/bin/env python3
"""アイコンのマスター素材を生成する。

図柄は「開いた戸口 (上下対称の台形) から漏れる光」で、そこにプロンプト `>` を
抜いてある。`>` を線で描かないのは、メニューバーの 18pt で細線が消えるため。

用途ごとに余白と色の扱いが違うので、1 枚を使い回さず 4 種類を出す。

    python3 resources/app-icons/generate.py

要 rsvg-convert (brew install librsvg)。
"""

import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parent

PLATE = "#1e1e2e"
LIGHT = "#f2d5a0"

# 図柄。左 (手前) が高く右 (奥) が低い台形で透視をつくる。cy=50 で上下対称。
DOOR_NEAR_X, DOOR_FAR_X = 28.0, 74.0
DOOR_NEAR_H, DOOR_FAR_H = 68.0, 42.0
CHEVRON = (41.0, 17.0, 15.0, 11.0)  # x, 幅, 半分の高さ, 太さ

# 背景の角丸。キャンバス全体ではなく余白を除いた背景矩形に対する割合。
RADIUS_PERCENT = 20.0
# トレイ用に図柄が占める割合。メニューバーでは高さが効くので長辺基準。
TRAY_FILL_PERCENT = 88.0
# Windows のアプリアイコンでは図柄を背景いっぱいまで拡大する (CYBERNEURA-DEV-884)。
# 背景だけ full-bleed にしても、図柄が背景の半分しか無いと小さく見える。
# 暗い背景は Windows のダークなタスクバーに溶けるので、目に入るのは図柄の大きさになる。
# 値は背景に対する図柄の長辺 (高さ) の割合。
WIN_MARK_FILL_PERCENT = 86.0


def _doorway(cy=50.0):
    return (
        f"M {DOOR_NEAR_X} {cy - DOOR_NEAR_H / 2} "
        f"L {DOOR_FAR_X} {cy - DOOR_FAR_H / 2} "
        f"L {DOOR_FAR_X} {cy + DOOR_FAR_H / 2} "
        f"L {DOOR_NEAR_X} {cy + DOOR_NEAR_H / 2} Z"
    )


def _chevron(cy=50.0):
    a, w, h, t = CHEVRON
    pts = [
        (a + t / 2, cy - h),
        (a + w + t / 2, cy),
        (a + t / 2, cy + h),
        (a - t / 2, cy + h),
        (a + w - t / 2, cy),
        (a - t / 2, cy - h),
    ]
    return "M " + " L ".join(f"{x:.2f} {y:.2f}" for x, y in pts) + " Z"


# 台形と `>` を 1 つの path にまとめ、evenodd で `>` を穴にする。
# 別 path を背景色で重ねる方式だと、トレイ用の透過素材でアルファに穴が開かない。
MARK = _doorway() + " " + _chevron()

MARK_BOX = (
    DOOR_NEAR_X,
    DOOR_FAR_X,
    50 - DOOR_NEAR_H / 2,
    50 + DOOR_NEAR_H / 2,
)


def _mark_transform(fill_percent):
    """図柄を背景の中央へ、長辺が `fill_percent` になるよう置く transform。"""
    x0, x1, y0, y1 = MARK_BOX
    w, h = x1 - x0, y1 - y0
    s = fill_percent / max(w, h)
    tx = (100 - w * s) / 2 - x0 * s
    ty = (100 - h * s) / 2 - y0 * s
    return f"translate({tx:.3f},{ty:.3f}) scale({s:.4f})"


def svg_plate(margin_percent, mark_fill_percent=None):
    """角丸の背景に図柄を載せる。

    `mark_fill_percent` を渡すと、図柄を元の配置ではなく背景に対するその割合まで
    拡大して中央に置く。省略時は元の配置 (macOS / favicon と同じ見た目) のまま。
    """
    inner = 100 - 2 * margin_percent
    scale = inner / 100
    radius = RADIUS_PERCENT / 100 * inner
    mark_transform = (
        f' transform="{_mark_transform(mark_fill_percent)}"'
        if mark_fill_percent is not None
        else ""
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        'width="100" height="100">'
        f'<rect x="{margin_percent}" y="{margin_percent}" '
        f'width="{inner}" height="{inner}" '
        f'rx="{radius}" ry="{radius}" fill="{PLATE}"/>'
        f'<g transform="translate({margin_percent},{margin_percent}) scale({scale})">'
        f'<path d="{MARK}" fill="{LIGHT}" fill-rule="evenodd"{mark_transform}/>'
        "</g></svg>"
    )


def svg_tray():
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        'width="100" height="100">'
        f'<g transform="{_mark_transform(TRAY_FILL_PERCENT)}">'
        f'<path d="{MARK}" fill="#000000" fill-rule="evenodd"/>'
        "</g></svg>"
    )


TARGETS = {
    # macOS のアプリアイコンだけ背景に余白を空ける。空けないと Dock で他アプリより大きく見える。
    "astragal-mac-icon": (svg_plate(10.0), 1024),
    # Web 向けは full-bleed。図柄の配置は macOS と同じ。
    "astragal-favicon": (svg_plate(0.0), 1024),
    # Windows のアプリアイコン (icon.ico)。背景は full-bleed で、図柄も背景いっぱいまで拡大する。
    "astragal-win-icon": (svg_plate(0.0, WIN_MARK_FILL_PERCENT), 1024),
    # macOS メニューバー用。template 画像はアルファしか使われないので単色 + 透過。
    "tray-mac": (svg_tray(), 256),
    # Windows トレイには template の概念が無いのでカラーのまま。
    "tray-win": (svg_plate(0.0), 256),
}


def main():
    for name, (markup, size) in TARGETS.items():
        svg_path = OUT / f"{name}.svg"
        png_path = OUT / f"{name}.png"
        svg_path.write_text(markup)
        subprocess.run(
            ["rsvg-convert", "-w", str(size), "-h", str(size),
             str(svg_path), "-o", str(png_path)],
            check=True,
        )
        print(f"{png_path.name} ({size}px)")


if __name__ == "__main__":
    main()
