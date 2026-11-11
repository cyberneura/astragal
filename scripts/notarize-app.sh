#!/bin/bash
# Notarize an already signed app using credentials stored by notarytool in Keychain.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: bash scripts/notarize-app.sh <app-path> <keychain-profile>" >&2
  exit 2
fi

APP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
PROFILE=$2
[ -d "$APP/Contents" ] || { echo "App bundle not found: $APP" >&2; exit 1; }
codesign --verify --strict "$APP"
SIGNATURE=$(codesign -dv --verbose=4 "$APP" 2>&1)
if ! [[ "$SIGNATURE" == *'Authority=Developer ID Application: Cyberneura K.K. (2YN5TLNQ9J)'* &&
        "$SIGNATURE" == *'TeamIdentifier=2YN5TLNQ9J'* && "$SIGNATURE" == *'(runtime)'* ]]; then
  echo "Cyberneura Developer ID signature with hardened runtime is required." >&2
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mnb-notarize.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
ditto -c -k --keepParent "$APP" "$WORK/app.zip"
SUBMIT_STATUS=0
xcrun notarytool submit "$WORK/app.zip" --keychain-profile "$PROFILE" \
  --wait --output-format json > "$WORK/result.json" || SUBMIT_STATUS=$?
cat "$WORK/result.json"
if [ "$SUBMIT_STATUS" -ne 0 ] || ! python3 -c \
  'import json,sys; sys.exit(json.load(open(sys.argv[1])).get("status") != "Accepted")' \
  "$WORK/result.json"; then
  echo "Notarization did not complete successfully; the app was not stapled." >&2
  exit 1
fi
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"
