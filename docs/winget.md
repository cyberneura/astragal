# Publishing Astragal on winget

Astragal is **not on winget yet**. This page covers what it takes to get it there and to
keep it updated.

Unlike the Homebrew tap (`cyberneura/homebrew-tap`, which we own), winget packages live
in [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs). Adding or updating
a package means opening a pull request there, which Microsoft's bots validate
(installer download, SHA-256, a Defender scan, a silent install in a sandbox) before a
moderator merges it. Nothing in this repository can publish to winget on its own.

## What the Release already provides

Starting with 0.6.0, every release carries an NSIS installer built by `release.yml`:

```
https://github.com/cyberneura/astragal/releases/download/v<version>/Astragal_<version>_x64-setup.exe
```

It installs per user (`%LOCALAPPDATA%`), needs no administrator rights, and supports the
silent switch `/S`, which is what winget runs. It is **not code-signed**; winget accepts
unsigned installers, but SmartScreen reputation and the Defender scan are more likely
to cause trouble than with a signed one.

## First submission (manual, needs a human with a Windows machine)

1. Install [wingetcreate](https://github.com/microsoft/winget-create)
   (`winget install wingetcreate`).
2. Generate the manifests from the release asset:

   ```powershell
   wingetcreate new https://github.com/cyberneura/astragal/releases/download/v0.6.0/Astragal_0.6.0_x64-setup.exe
   ```

   Suggested values when prompted:

   | Field | Value |
   |---|---|
   | PackageIdentifier | `Cyberneura.Astragal` |
   | Publisher | `Cyberneura` |
   | PackageName | `Astragal` |
   | License | the repository has no license file yet; one is needed before submitting (winget requires the field) |
   | ShortDescription | `A compact terminal for macOS and Windows` |
   | InstallerType | `nullsoft` |
   | Scope | `user` |
   | Architecture | `x64` |

3. Test locally before submitting:

   ```powershell
   winget validate --manifest <dir>
   winget install --manifest <dir>
   ```

4. Submit (`wingetcreate submit <dir>`, or `wingetcreate new ... --submit`). This forks
   `microsoft/winget-pkgs` under the signed-in GitHub account and opens the PR.

## Automating later versions (optional)

Once the first version is merged into winget-pkgs, new releases can be submitted
automatically with [winget-releaser](https://github.com/vedantmgoyal9/winget-releaser)
(it only updates packages that already exist there). It needs:

- a fork of `microsoft/winget-pkgs` under the account that submits
  (`fork-user`), and
- a **classic** personal access token of that account with `public_repo` (and
  `workflow`, to keep the fork in sync), saved as the repository secret
  `WINGET_TOKEN`.

Then add a workflow such as the one below. It is intentionally **not** included in
`.github/workflows/` yet: without the secret and the first manual submission it could
only fail. Pin the action to a commit SHA rather than `@main` when adding it, like the
other actions in `release.yml`.

```yaml
name: Publish to winget
on:
  release:
    types: [released]
permissions: {}
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: vedantmgoyal9/winget-releaser@<commit-sha> # main
        with:
          identifier: Cyberneura.Astragal
          installers-regex: '_x64-setup\.exe$'
          token: ${{ secrets.WINGET_TOKEN }}
          fork-user: <account-that-owns-the-fork>
```

`release.yml` publishes the Release with the default `GITHUB_TOKEN`, and events created
by `GITHUB_TOKEN` do not trigger other workflows. So `on: release` alone will not fire
for Releases published by `release.yml`. Either run the step as a final job inside
`release.yml` (after `publish`), or trigger this workflow with `workflow_dispatch` /
`workflow_run` on `Release`.
