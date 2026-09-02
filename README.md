# Astragal

A lightweight terminal app for macOS (Tauri 2.x + xterm.js).

- A main window with tabs
- A small popover terminal that drops down from the menu bar (tray) icon
  (left click the icon to open it, right click for the menu)
- Global hotkeys to show and hide the windows
- Configuration through `~/.config/astragal/config.yaml`

## Install

```shell
brew install --cask cyberneura/tap/astragal
```

Releases are universal `.dmg` files (Intel / Apple Silicon), signed with a Developer ID
and notarized.

## Configuration

The config file is `~/.config/astragal/config.yaml` (or `config.yml` if that is the one
present). On first launch a template is generated with every entry commented out.
Only the entries you write override the defaults.

```yaml
font:
  # CSS font-family list passed to xterm.
  # Nerd Fonts have no CJK glyphs, so keep a CJK font in the fallbacks.
  family: "'RobotoMono Nerd Font', Menlo, 'Hiragino Sans', monospace"
  size: 13

shell:
  command: /bin/zsh # defaults to $SHELL, then /bin/zsh
  args: ["-l"] # login shell by default
  env:
    LANG: ja_JP.UTF-8

# Global hotkeys. Set an empty string to disable one.
hotkeys:
  window: "Control+Option+Command+A"
  small_window: "Control+Shift+Option+Command+A"

window:
  main:
    width: 900
    height: 580
    hide_on_blur: false
  # The popover that drops down from the menu bar icon.
  small:
    width: 800
    height: 600
    hide_on_blur: true

theme: # xterm theme; only the keys you write are overridden
  background: "#111111"
  foreground: "#e6e6e6"
```

Hotkey modifiers are `Control` / `Option` (`Alt`) / `Shift` / `Command` (`Cmd`, `Super`).
If registration fails, the reason is printed in the terminal as a warning. Note that
macOS `RegisterEventHotKey` registers per process, so when another app or the system
already holds the same combination, **registration still succeeds — the key simply never
arrives, and no warning is printed**. If a hotkey does nothing, try a different
combination.

Set the `ASTRAGAL_CONFIG` environment variable to a config file path to start using that
file instead.

### config_override_command

Runs a command that writes YAML to stdout and recursively merges the result on top of
the config file. This is the hook for pulling settings out of 1Password and the like.

```yaml
config_override_command: op read "op://development/astragal/config-yaml"
```

- Mappings are merged recursively; scalars and lists are replaced wholesale.
- **The command runs without a shell.** It has to be on `PATH` or written as an absolute
  path (`/opt/homebrew/bin` and `/usr/local/bin` are appended to `PATH`).
- It times out after 60 seconds. If the command fails, Astragal starts with the local
  config and prints the reason in the terminal as a warning.

## Development

```shell
pnpm install
pnpm tauri dev
```

## Build

```shell
pnpm tauri build
```

The build produces `src-tauri/target/release/bundle/macos/Astragal.app`.
`./astragal` is a CLI wrapper that launches that bundle.

## Release

A release is triggered by the version in `src-tauri/tauri.conf.json`. Change the version
and land it on `main`, and `.github/workflows/release.yml` builds it and creates a
GitHub Release; leave the version alone and nothing happens no matter how many times you
push (what decides whether it runs is not the diff but whether that version has already
been released).

```shell
pnpm release            # bump the patch version, push to main, and watch the build
pnpm release minor
pnpm release major
```

`scripts/release.sh` only runs when `main` is clean and matches `origin/main`. The build
runs on a macOS runner, goes through Developer ID signing and notarization, and uploads
the universal `.dmg` to the Release for the `v<version>` tag. The signing secrets
(`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` /
`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`) are already registered on the
repository, and the build fails up front if any one of them is missing (if it went ahead
without them, an unnotarized `.dmg` would be published silently).

The Homebrew cask (cyberneura/homebrew-tap) updates itself hourly from the latest
release, so it can take up to an hour for a new version to show up in `brew`.

## Tests

```shell
cd src-tauri && cargo test
pnpm exec tsc --noEmit
```

## Icons

The masters live in `resources/app-icons/` and are rendered from SVG by `generate.py`
(which needs `rsvg-convert`). There are four of them because padding and color are
handled differently per use.

| File | Use |
|---|---|
| `astragal-mac-icon.png` | macOS app icon. 10% padding around the artwork |
| `astragal-favicon.png` | Windows / web. No padding |
| `tray-mac.png` | Menu bar. Monochrome + transparency (a template image) |
| `tray-win.png` | Windows tray. Full color |

Apply them to `src-tauri/icons/` in the order below. `pnpm tauri icon` overwrites the
whole of `src-tauri/icons/` every time, so running it once on its own silently drops the
padding on the macOS icon.

```shell
python3 resources/app-icons/generate.py

TMP=$(mktemp -d)
pnpm tauri icon "$PWD/resources/app-icons/astragal-mac-icon.png"
cp src-tauri/icons/icon.icns "$TMP/"
pnpm tauri icon "$PWD/resources/app-icons/astragal-favicon.png"
cp "$TMP/icon.icns" src-tauri/icons/
rm -rf "$TMP" src-tauri/icons/android src-tauri/icons/ios

cp resources/app-icons/tray-mac.png resources/app-icons/tray-win.png src-tauri/icons/
```
