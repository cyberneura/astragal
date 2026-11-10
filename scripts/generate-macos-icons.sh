#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift scripts/prepare-macos-icons.swift resources/app-icons/layout.json
python3 scripts/verify-macos-icon-colors.py
swift scripts/macos-icon.swift build resources/app-icons/AppIcon.iconset src-tauri/icons Astragal
