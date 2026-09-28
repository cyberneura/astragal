# Publishing Astragal on winget

winget packages live in [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs),
not in a repository we own (unlike the Homebrew tap). Each version is a pull request
there, which Microsoft's bots validate (installer download, SHA-256, a Defender scan,
a silent install in a sandbox) before a moderator merges it. The package identifier is
`Cyberneura.Astragal`.

```
winget install Cyberneura.Astragal
```

## What is set up

| Piece | Where |
|---|---|
| Fork of `microsoft/winget-pkgs` | `cyberneura/winget-pkgs` |
| Classic PAT (`public_repo`) of an account that can push to that fork | repository secret `WINGET_TOKEN` |
| Submission workflow | `.github/workflows/winget.yml` |
| Hook that runs it after each release | the `winget` job at the end of `release.yml` |

`winget.yml` downloads a pinned [Komac](https://github.com/russellbanks/Komac) binary
(version and SHA-256 are in the workflow's `env`), syncs the fork, and runs
`komac update Cyberneura.Astragal --version <v> --urls <installer> --submit`. Komac
downloads the NSIS installer, fills in the SHA-256 and the installer metadata, pushes a
branch to the fork and opens the pull request. Every release therefore ends with a
winget-pkgs pull request opened by the owner of `WINGET_TOKEN`.

Before submitting, the workflow checks that the package already exists in winget-pkgs,
that the version is not there yet, and that no pull request for it is open. In each of
those cases it stops with a notice instead of failing, so a release run stays green while
the first submission is waiting for a moderator.

## Submitting a version by hand

Run the `winget` workflow from the Actions tab (or `gh workflow run winget.yml -f
version=0.7.1`). The version's Release must already be published. This is the way to
catch up on versions released while the package was not in winget-pkgs yet, or to retry
after a validation failure that was fixed on the winget-pkgs side.

## The first submission

Komac's `update` only works for packages that are already in winget-pkgs, and
`komac new` asks interactive questions (install modes, upgrade behavior, commands, ...)
that have no command line flags, so it cannot run in CI. The first version was submitted
by writing the three manifests by hand and opening the pull request from a local
checkout of the fork. If the package ever has to be created again (a new identifier,
for example), the same steps apply:

1. Write `Cyberneura.Astragal.yaml`, `Cyberneura.Astragal.installer.yaml` and
   `Cyberneura.Astragal.locale.en-US.yaml` for the version. `komac analyse
   <installer.exe>` prints the installer part (type, product code, Apps & Features
   entries). Set `Architecture: x64` yourself: the NSIS stub is a 32-bit program, so the
   PE header says `x86`, while Komac's `update` takes the architecture from the `x64` in
   the download URL.
2. Put them under `manifests/c/Cyberneura/Astragal/<version>/` on a branch of
   `cyberneura/winget-pkgs` and open a pull request to `microsoft/winget-pkgs` titled
   `New package: Cyberneura.Astragal version <version>`.
3. Answer the validation bot if it asks for changes. Once the pull request is merged,
   `winget.yml` handles every later version.

Things the manifests depend on:

- The installer is the NSIS `*_x64-setup.exe` that `release.yml` uploads. It installs
  per user into `%LocalAppData%\Astragal`, needs no administrator rights, and supports
  the silent switch `/S` that winget uses. It is not code-signed.
- The Apps & Features `Publisher` comes from `bundle.publisher` in
  `src-tauri/tauri.conf.json` (`Cyberneura`). Installers before 0.7.1 registered it as
  `cyberneura`, the default Tauri derives from the bundle identifier.
- The `License` field is `MIT`, matching the `LICENSE` file in this repository.
