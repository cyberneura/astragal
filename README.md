# Astragal

A lightweight terminal app for macOS and Windows (Tauri 2.x + xterm.js).

- A main window with tabs. Hiding a window with no tabs left and showing it again
  opens a fresh tab, in both the main window and the popover
- A small popover terminal that drops down from the menu bar (tray) icon
  (left click the icon to open it, right click for the menu, which also has an About
  entry with the version and links)
- Global hotkeys to show and hide the windows
- Ctrl+Tab cycles tabs in most-recently-used order, so pressing it repeatedly flips
  between the last two tabs. Hold Ctrl and press Tab twice for the second most recent
  tab, three times for the third, and add Shift to walk the other way
- Cmd+Shift+[ and Cmd+Shift+] step to the previous and next tab in tab bar order,
  wrapping around at the ends (the same shortcuts iTerm2 uses)
- Cmd+F searches the terminal output (scrollback included) of the active tab, in both
  the main window and the popover. Enter / Shift+Enter (or Cmd+G / Cmd+Shift+G) jump to
  the next / previous match, and Esc closes the search bar. Text selected in the terminal
  becomes the search term when the bar opens
- Cmd+click a URL to open it in the default browser. Holding Cmd underlines the URL
  under the pointer, and a URL that soft-wraps across lines opens in full
- Configuration through `~/.config/astragal/config.yaml`

## Install

### macOS

```shell
brew install --cask cyberneura/tap/astragal
```

Releases are universal `.dmg` files (Intel / Apple Silicon), signed with a Developer ID
and notarized.

### Windows

Get the latest `Astragal_x.y.z_x64-setup.exe` from the
[Releases](https://github.com/cyberneura/astragal/releases) page and run it. The
installer is not code-signed, so SmartScreen warns on first run ("Windows protected
your PC" → More info → Run anyway). It installs for the current user and needs no
administrator rights.

Astragal is not on winget yet. See [docs/winget.md](docs/winget.md) for what publishing
it there takes.

### Windows differences

The shell runs in a ConPTY (Windows 10 1809 or later). Everything above works on Windows
too, with these differences:

- The default shell is Windows PowerShell (`powershell.exe`) with no arguments.
  `$SHELL` is ignored. Set `shell.command` to `pwsh.exe`, `cmd.exe`, `wsl.exe`, etc.
  to use another one.
- Shortcuts follow Windows Terminal, since Ctrl alone belongs to the shell:

  | macOS | Windows |
  |---|---|
  | Cmd+T / Cmd+N (new tab) | Ctrl+Shift+T / Ctrl+Shift+N |
  | Cmd+W (close tab) | Ctrl+Shift+W |
  | Cmd+1 … Cmd+9 (go to tab) | Ctrl+Shift+1 … Ctrl+Shift+9 |
  | Cmd+F (search) | Ctrl+Shift+F |
  | Cmd+G / Cmd+Shift+G (next / previous match) | F3 / Shift+F3 (while the search bar is open) |
  | Cmd+= / Cmd+- / Cmd+0 (font size) | Ctrl+= / Ctrl+- / Ctrl+0 |
  | Cmd+C / Cmd+V | Ctrl+Shift+C / Ctrl+Shift+V. Ctrl+C copies when text is selected (otherwise it interrupts), Ctrl+V pastes |
  | Cmd+click a URL | Ctrl+click a URL |
  | Cmd+Shift+[ / ] (previous / next tab) | Not available; use Ctrl+Tab / Ctrl+Shift+Tab |

- The popover opens from the notification area icon. With the taskbar at the bottom of
  the screen it opens above the icon.
- In `hotkeys`, `Command` / `Super` means the Windows key. The defaults
  (`Control+Option+Command+A` = Ctrl+Alt+Win+A) are kept as they are.
- The config file lives at `%USERPROFILE%\.config\astragal\config.yaml`.
- `config_override_command` is split like a POSIX shell command line, so a backslash
  escapes the next character. Write Windows paths with forward slashes
  (`C:/tools/op.exe`) or in single quotes. No directories are appended to `PATH`.

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
  command: /bin/zsh # defaults to $SHELL, then /bin/zsh (powershell.exe on Windows)
  args: ["-l"] # login shell by default ([] on Windows)
  env:
    LANG: ja_JP.UTF-8

terminal:
  # Close the tab when its shell process exits. Set to false to keep the tab
  # open, so the output stays on screen and can be copied.
  # A shell that exits before you type anything in that tab keeps its tab either
  # way, so a shell that fails to start stays readable.
  close_on_exit: true

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
  path (on macOS, `/opt/homebrew/bin` and `/usr/local/bin` are appended to `PATH`).
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

The build produces `src-tauri/target/release/bundle/macos/Astragal.app` on macOS
(`./astragal` is a CLI wrapper that launches that bundle) and the NSIS installer under
`src-tauri/target/release/bundle/nsis/` on Windows (`pnpm tauri build --bundles nsis`).

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
runs on macOS and Windows runners in parallel. The macOS job goes through Developer ID
signing and notarization and uploads the universal `.dmg`; the Windows job uploads the
unsigned NSIS installer (`*_x64-setup.exe`). Both go into one draft Release for the
`v<version>` tag, which is published only after both succeed. Pull requests run the
tests on both macOS and Windows. The signing secrets
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

pnpm tauri icon "$PWD/resources/app-icons/astragal-favicon.png"
rm -rf src-tauri/icons/android src-tauri/icons/ios
python3 resources/app-icons/build_icns.py \
  resources/app-icons/astragal-mac-icon.png src-tauri/icons/icon.icns

cp resources/app-icons/tray-mac.png resources/app-icons/tray-win.png src-tauri/icons/
```

To see which resolutions the generated `.icns` actually holds — useful when an icon
looks soft somewhere and you need to tell whether the bundle is at fault — run:

```shell
python3 resources/app-icons/inspect_icns.py
```

It needs nothing but the standard library, and exits non-zero if any of the sizes
macOS asks for (16 through 512) is missing. 1024 is reported when it is absent but
does not fail the check: an app whose master artwork is 512px cannot produce one,
and an upscaled entry is not resolution — macOS falls back to 512 either way.

To rebuild an `.icns` from a single master PNG (16 through 512, plus 1024 when the
master is that large):

```shell
python3 resources/app-icons/build_icns.py <master.png> <out.icns>
```

It writes the entries largest first. Some programs read only the first image of an
`.icns` and scale it to fit; with `iconutil` or `tauri icon` output that first image is
the 16px one, which is how the icon came out blurry in 1Password's SSH key prompt.
That is also why `icon.icns` is built with this script rather than `tauri icon`.

Also standard library only, so it works where `iconutil` and `sips` do not — which
is why the icons of the other macOS apps here are rebuilt with this one rather than
with a copy of it kept in each repository.
