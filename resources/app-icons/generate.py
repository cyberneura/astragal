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


def svg_plate(margin_percent):
    inner = 100 - 2 * margin_percent
    scale = inner / 100
    radius = RADIUS_PERCENT / 100 * inner
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        'width="100" height="100">'
        f'<rect x="{margin_percent}" y="{margin_percent}" '
        f'width="{inner}" height="{inner}" '
        f'rx="{radius}" ry="{radius}" fill="{PLATE}"/>'
        f'<g transform="translate({margin_percent},{margin_percent}) scale({scale})">'
        f'<path d="{MARK}" fill="{LIGHT}" fill-rule="evenodd"/>'
        "</g></svg>"
    )


def svg_tray():
    x0, x1, y0, y1 = MARK_BOX
    w, h = x1 - x0, y1 - y0
    s = TRAY_FILL_PERCENT / max(w, h)
    tx = (100 - w * s) / 2 - x0 * s
    ty = (100 - h * s) / 2 - y0 * s
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        'width="100" height="100">'
        f'<g transform="translate({tx:.3f},{ty:.3f}) scale({s:.4f})">'
        f'<path d="{MARK}" fill="#000000" fill-rule="evenodd"/>'
        "</g></svg>"
    )


TARGETS = {
    # macOS のアプリアイコンだけ背景に余白を空ける。空けないと Dock で他アプリより大きく見える。
    "astragal-mac-icon": (svg_plate(10.0), 1024),
    # Windows / Web は full-bleed。余白を入れるとタスクバーで実効サイズが落ちる。
    "astragal-favicon": (svg_plate(0.0), 1024),
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
