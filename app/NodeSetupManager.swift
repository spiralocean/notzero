import AppKit
import Foundation
import Security

enum NodeSetupManager {
    enum BitcoinCoreStatus: Equatable {
        case notInstalled
        case installed(command: String)
        case guiApp
    }

    enum PrunedConfigStatus: Equatable {
        case missing
        case configured(path: String)
    }

    struct SetupResult {
        let confPath: String
        let rpcUser: String
        let createdCredentials: Bool
        let appendedToExisting: Bool
    }

    private static let lotteryMarker = "Bitcoin Lottery"
    private static let lotterySection = """
    # --- Added by Bitcoin Lottery ---
    server=1
    rpcbind=127.0.0.1
    rpcallowip=127.0.0.1
    prune=2048
    disablewallet=1
    blocksonly=1
    dbcache=450
    maxconnections=8
    """

    static var bitcoinDataDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Bitcoin")
    }

    static var bitcoinConfURL: URL {
        bitcoinDataDir.appendingPathComponent("bitcoin.conf")
    }

    static func bitcoinCoreStatus() -> BitcoinCoreStatus {
        if FileManager.default.fileExists(atPath: "/Applications/Bitcoin-Qt.app") {
            return .guiApp
        }
        for path in candidateBitcoindPaths() {
            return .installed(command: path)
        }
        return .notInstalled
    }

    static func prunedConfigStatus() -> PrunedConfigStatus {
        guard FileManager.default.fileExists(atPath: bitcoinConfURL.path),
              let content = try? String(contentsOf: bitcoinConfURL, encoding: .utf8),
              content.contains(lotteryMarker) || content.contains("prune=")
        else {
            return .missing
        }
        return .configured(path: bitcoinConfURL.path)
    }

    static func setupPrunedNode() -> String? {
        do {
            _ = try performSetup()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    static func installBitcoinCoreViaHomebrew() -> String? {
        guard let brew = brewExecutable() else {
            return BitcoinBrand.format("Homebrew not found. Install from https://brew.sh or download Bitcoin Core from bitcoin.org.")
        }
        let result = runCommand(executable: brew, arguments: ["install", "bitcoin"], timeout: 3600)
        if result.exitCode != 0 {
            let message = result.combinedOutput
            if message.contains("already installed") { return nil }
            return message.isEmpty ? "Homebrew install failed." : message
        }
        return nil
    }

    static func openBitcoinCoreDownloadPage() {
        if let url = URL(string: "https://bitcoin.org/en/download") {
            NSWorkspace.shared.open(url)
        }
    }

    static func startBitcoinCore() -> String? {
        switch bitcoinCoreStatus() {
        case .guiApp:
            if let url = URL(string: "file:///Applications/Bitcoin-Qt.app") {
                NSWorkspace.shared.open(url)
                return nil
            }
            return "Could not open Bitcoin-Qt."
        case .installed(let command):
            let running = runCommand(executable: command, arguments: ["-daemon"], timeout: 15)
            if running.exitCode == 0 { return nil }
            let message = running.combinedOutput.lowercased()
            if message.contains("already running") || message.contains("lock") {
                return nil
            }
            if let brew = brewExecutable() {
                let service = runCommand(executable: brew, arguments: ["services", "start", "bitcoin"], timeout: 60)
                if service.exitCode == 0 { return nil }
            }
            return running.combinedOutput.isEmpty ? "Failed to start bitcoind." : running.combinedOutput
        case .notInstalled:
            return BitcoinBrand.format("Install Bitcoin Core first.")
        }
    }

    static var setupSummary: String {
        let core = bitcoinCoreStatus()
        let conf = prunedConfigStatus()
        let coreLabel: String
        switch core {
        case .notInstalled: coreLabel = BitcoinBrand.format("Bitcoin Core not installed")
        case .guiApp: coreLabel = "Bitcoin-Qt app installed"
        case .installed(let path): coreLabel = "bitcoind found (\(path))"
        }
        let confLabel: String
        switch conf {
        case .missing: confLabel = "pruned config not set up"
        case .configured: confLabel = "pruned config ready (~15 GB disk)"
        }
        return "\(coreLabel)  •  \(confLabel)"
    }

    // MARK: - Setup

    private static func performSetup() throws -> SetupResult {
        try FileManager.default.createDirectory(at: bitcoinDataDir, withIntermediateDirectories: true)
        let confURL = bitcoinConfURL
        var content = (try? String(contentsOf: confURL, encoding: .utf8)) ?? ""
        var appendedToExisting = false
        var createdCredentials = false

        if content.contains(lotteryMarker) || content.contains("prune=") {
            let (user, pass, generated) = try rpcCredentials(from: content)
            try updateLotteryRPC(user: user, pass: pass)
            return SetupResult(
                confPath: confURL.path,
                rpcUser: user,
                createdCredentials: generated,
                appendedToExisting: false
            )
        } else if !content.isEmpty {
            content += "\n\n" + lotterySection + "\n"
            appendedToExisting = true
        } else if let template = bundledTemplate() {
            content = template + "\n"
        } else {
            content = defaultTemplate() + "\n"
        }

        let (user, pass, generated) = try rpcCredentials(from: content)
        createdCredentials = generated

        if generated || !content.contains("rpcuser=") {
            let stamp = ISO8601DateFormatter().string(from: Date()).prefix(10)
            content += """

            # Bitcoin Lottery credentials (\(stamp))
            rpcuser=\(user)
            rpcpassword=\(pass)
            """
        }

        if !content.contains(lotteryMarker) && !content.contains("# --- Added by Bitcoin Lottery ---") {
            if !content.hasSuffix("\n") { content += "\n" }
            content += "\n" + lotterySection + "\n"
        }

        try content.write(to: confURL, atomically: true, encoding: .utf8)
        try updateLotteryRPC(user: user, pass: pass)
        return SetupResult(
            confPath: confURL.path,
            rpcUser: user,
            createdCredentials: createdCredentials,
            appendedToExisting: appendedToExisting
        )
    }

    private static func rpcCredentials(from content: String) throws -> (user: String, pass: String, generated: Bool) {
        if let user = matchConfValue("rpcuser", in: content),
           let pass = matchConfValue("rpcpassword", in: content) ?? matchConfValue("rpcpass", in: content) {
            return (user, pass, false)
        }
        return ("lottery", try randomPassword(), true)
    }

    private static func matchConfValue(_ key: String, in content: String) -> String? {
        let pattern = "(?m)^\\s*\(key)\\s*=\\s*(.+?)\\s*$"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: content, range: NSRange(content.startIndex..., in: content)),
              let range = Range(match.range(at: 1), in: content)
        else { return nil }
        return String(content[range]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func randomPassword() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw NSError(domain: "NodeSetupManager", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Could not generate RPC password.",
            ])
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static func updateLotteryRPC(user: String, pass: String) throws {
        var payload: [String: Any] = defaultLotteryConfig()
        if let data = try? Data(contentsOf: LotteryConfig.configURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            payload = json
        }
        payload["version"] = payload["version"] ?? 1
        payload["rpc_url"] = "http://127.0.0.1:8332"
        payload["rpc_user"] = user
        payload["rpc_pass"] = pass
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try FileManager.default.createDirectory(at: LotteryConfig.appSupport, withIntermediateDirectories: true)
        try data.write(to: LotteryConfig.configURL, options: .atomic)
    }

    private static func defaultLotteryConfig() -> [String: Any] {
        [
            "version": 1,
            "mode": "symbolic",
            "payout_address": "",
            "rpc_url": "http://127.0.0.1:8332",
            "rpc_user": "",
            "rpc_pass": "",
            "machine_seed": "",
            "price_poll_interval_min": 15,
            "menu_bar_display": "block",
            "screensaver_view": "matrix_rain",
            "notifications_enabled": true,
            "notify_closeness_above_zero": true,
            "notify_block_won": true,
            "notify_node_synced": true,
            "notify_node_out_of_sync": true,
        ]
    }

    private static func bundledTemplate() -> String? {
        guard let url = Bundle.main.url(forResource: "bitcoin.conf", withExtension: "template"),
              let text = try? String(contentsOf: url, encoding: .utf8)
        else { return nil }
        return text
    }

    private static func defaultTemplate() -> String {
        """
        # Bitcoin Lottery — optional Live mode (pruned node ~15 GB disk)
        \(lotterySection)
        """
    }

    // MARK: - Process helpers

    private static func candidateBitcoindPaths() -> [String] {
        [
            "/opt/homebrew/bin/bitcoind",
            "/usr/local/bin/bitcoind",
            "/Applications/Bitcoin-Qt.app/Contents/MacOS/bitcoind",
        ].filter { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func brewExecutable() -> String? {
        ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].first {
            FileManager.default.isExecutableFile(atPath: $0)
        }
    }

    private struct CommandResult {
        let exitCode: Int32
        let stdout: String
        let stderr: String

        var combinedOutput: String {
            [stderr, stdout]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n")
        }
    }

    private static func runCommand(executable: String, arguments: [String], timeout: TimeInterval) -> CommandResult {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return CommandResult(exitCode: 1, stdout: "", stderr: error.localizedDescription)
        }

        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            process.waitUntilExit()
            group.leave()
        }
        _ = group.wait(timeout: .now() + timeout)
        if process.isRunning {
            process.terminate()
            return CommandResult(exitCode: 1, stdout: "", stderr: "Command timed out.")
        }

        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return CommandResult(exitCode: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}