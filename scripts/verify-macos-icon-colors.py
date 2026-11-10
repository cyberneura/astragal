#!/usr/bin/env python3
"""Validate PNG color metadata and Astragal's original opaque plate color.

AppKit can ignore PNG gamma metadata, so native-to-native image comparisons
alone missed a gAMA=2.2 export that gamma-aware decoders displayed too brightly.
This reads PNG chunks and raw samples without AppKit or color conversion.
"""

import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources/app-icons"))
from build_icns import _chunks, read_png  # noqa: E402


def validate(path: Path) -> None:
    chunks = dict(_chunks(path.read_bytes()))
    if chunks.get(b"sRGB") != b"\x00":
        raise ValueError(f"{path}: expected explicit sRGB rendering intent 0")
    gamma = chunks.get(b"gAMA")
    if gamma is not None and gamma != struct.pack(">I", 45455):
        raise ValueError(f"{path}: conflicting PNG gamma")
    if b"iCCP" in chunks:
        raise ValueError(f"{path}: conflicting ICC profile alongside sRGB")
    image = read_png(path)
    # Stay inside the plate but outside the mark, even in the full-bleed 16px
    # image where interpolation blends pixels closer to the mark.
    small = path.name in {"icon_16x16.png", "icon_32x32.png"}
    x, y = (1 if small else int(image.width * 0.2)), image.height // 2
    rgba = tuple(image.rows[y][x * 4 : x * 4 + 4])
    if rgba != (30, 30, 46, 255):
        raise ValueError(f"{path}: expected opaque #1e1e2e plate, got {rgba}")
    print(f"PASS {path.name}: sRGB, opaque #1e1e2e plate")


if __name__ == "__main__":
    iconset = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "resources/app-icons/AppIcon.iconset"
    images = sorted(iconset.glob("*.png"))
    if len(images) != 10:
        raise ValueError(f"Expected 10 PNG representations in {iconset}, got {len(images)}")
    for image_path in images:
        validate(image_path)
