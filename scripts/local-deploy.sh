#!/bin/sh
# Build and sign a local app, then replace the installed copy.
set -eu

cd "$(dirname "$0")/.."

if [ "$(uname -s)" != Darwin ]; then
  echo "Error: local deployment is only supported on macOS." >&2
  exit 1
fi

# Reusing the signing identity preserves macOS folder access permissions.
SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application: Cyberneura K.K. (2YN5TLNQ9J)}"
DEST_DIR="${DEST_DIR:-/Applications}"
DEST_DIR="$(cd "$DEST_DIR" && pwd -P)"
bundle_dir="$PWD/src-tauri/target/release/bundle/macos"
mkdir -p "$bundle_dir"
bundle="$(cd "$bundle_dir" && pwd -P)/Astragal.app"
dest="$DEST_DIR/Astragal.app"

if [ "$bundle" = "$dest" ]; then
  echo "Error: the installation directory must differ from the build directory." >&2
  exit 1
fi

rm -rf "$bundle"
CARGO_TARGET_DIR="$PWD/src-tauri/target" pnpm tauri build --bundles app

# Local builds do not need notarization or an online timestamp service.
codesign --force --deep --timestamp=none --sign "$SIGN_IDENTITY" "$bundle"
codesign --verify --deep --strict "$bundle"

# Copy onto the destination volume before replacing the existing installation.
staging="$(mktemp -d "$DEST_DIR/.astragal-deploy.XXXXXX")"
cleanup() {
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    if [ -e "$staging/previous.app" ] || [ -L "$staging/previous.app" ]; then
      if ! mv "$staging/previous.app" "$dest"; then
        echo "Error: restore the previous app from $staging/previous.app." >&2
        return
      fi
    fi
  fi
  rm -rf "$staging"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
ditto "$bundle" "$staging/Astragal.app"
codesign --verify --deep --strict "$staging/Astragal.app"

if [ -e "$dest" ] || [ -L "$dest" ]; then
  mv "$dest" "$staging/previous.app"
fi
mv "$staging/Astragal.app" "$dest"
rm -rf "$bundle"

echo "Deployed: $dest"
echo "Restart Astragal to use the new build. Running terminal sessions are not closed."
