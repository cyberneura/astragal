// 検証用アプリの本体。`ssh -T <接続先>` を子プロセスとして走らせて終わるだけ。
//
// 1Password の SSH キー許可ダイアログは「ssh を起動したアプリ」のアイコンを出すので、
// このバイナリを .app に包み、`open` で起動すると、そのバンドルの icns が
// ダイアログに出る (ターミナルから直接実行するとターミナルのアイコンになる)。
// 組み立ては build.sh、背景は make_probe_icns.py の docstring。

import Foundation

let destination = CommandLine.arguments.dropFirst().first ?? "git@github.com"

let ssh = Process()
ssh.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
ssh.arguments = ["-T", "-o", "ConnectTimeout=15", destination]

do {
    try ssh.run()
} catch {
    FileHandle.standardError.write("failed to start ssh: \(error)\n".data(using: .utf8)!)
    exit(1)
}
ssh.waitUntilExit()
exit(ssh.terminationStatus)
