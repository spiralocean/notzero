import Foundation
import Darwin

enum DaemonManager {
    static let label = "com.bitcoinlottery.miner"

    enum Status: Equatable {
        case running
        case stopped
        case notInstalled
    }

    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.bitcoinlottery.miner.plist")
    }

    private static var domain: String { "gui/\(getuid())" }
    private static var target: String { "\(domain)/\(label)" }

    static func status() -> Status {
        guard isInstalled() else { return .notInstalled }
        return isLoadedAndRunning() ? .running : .stopped
    }

    static func isInstalled() -> Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    private static func isLoadedAndRunning() -> Bool {
        let result = runLaunchctl(["print", target])
        guard result.exitCode == 0 else { return false }
        return result.stdout.contains("state = running")
    }

    static func stop() -> String? {
        guard isInstalled() else { return "Mining daemon is not installed." }
        let result = runLaunchctl(["bootout", target])
        if result.exitCode != 0 {
            let message = combinedError(result)
            if message.contains("No such process") || message.contains("Could not find") {
                return nil
            }
            return message.isEmpty ? "Failed to stop mining daemon." : message
        }
        return nil
    }

    static func start() -> String? {
        guard isInstalled() else {
            return "Mining daemon is not installed. Run ./scripts/install.sh first."
        }
        if !isLoadedAndRunning() {
            let bootstrap = runLaunchctl(["bootstrap", domain, plistURL.path])
            if bootstrap.exitCode != 0 {
                let message = combinedError(bootstrap)
                if !message.contains("already") && !message.contains("Input/output error") {
                    return message.isEmpty ? "Failed to load mining daemon." : message
                }
            }
            _ = runLaunchctl(["enable", target])
        }
        let kickstart = runLaunchctl(["kickstart", "-k", target])
        if kickstart.exitCode != 0 {
            let message = combinedError(kickstart)
            return message.isEmpty ? "Failed to start mining daemon." : message
        }
        return nil
    }

    static func uninstall() -> String? {
        _ = stop()
        guard isInstalled() else { return nil }
        do {
            try FileManager.default.removeItem(at: plistURL)
            return nil
        } catch {
            return "Failed to remove mining daemon: \(error.localizedDescription)"
        }
    }

    static var statusLabel: String {
        switch status() {
        case .running:
            return "Running — one ticket per block in the background"
        case .stopped:
            return "Stopped — no new tickets until you start the daemon"
        case .notInstalled:
            return "Not installed — run ./scripts/install.sh to enable background mining"
        }
    }

    private struct CommandResult {
        let exitCode: Int32
        let stdout: String
        let stderr: String
    }

    private static func runLaunchctl(_ arguments: [String]) -> CommandResult {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return CommandResult(exitCode: 1, stdout: "", stderr: error.localizedDescription)
        }
        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return CommandResult(exitCode: process.terminationStatus, stdout: stdout, stderr: stderr)
    }

    private static func combinedError(_ result: CommandResult) -> String {
        [result.stderr, result.stdout]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}