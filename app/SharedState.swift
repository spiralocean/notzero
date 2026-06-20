import Foundation

struct LotteryConfig: Codable {
    var mode: String
    var payoutAddress: String
    var rpcURL: String
    var rpcUser: String
    var rpcPass: String
    var machineSeed: String
    var pricePollIntervalMin: Int
    var menuBarDisplay: String
    var notificationsEnabled: Bool
    var notifyClosenessAboveZero: Bool
    var notifyBlockWon: Bool
    var notifyNodeSynced: Bool
    var notifyNodeOutOfSync: Bool
    var screensaverView: String
    var showWalletBalance: Bool

    enum CodingKeys: String, CodingKey {
        case mode
        case payoutAddress = "payout_address"
        case rpcURL = "rpc_url"
        case rpcUser = "rpc_user"
        case rpcPass = "rpc_pass"
        case machineSeed = "machine_seed"
        case pricePollIntervalMin = "price_poll_interval_min"
        case menuBarDisplay = "menu_bar_display"
        case screensaverView = "screensaver_view"
        case notificationsEnabled = "notifications_enabled"
        case notifyClosenessAboveZero = "notify_closeness_above_zero"
        case notifyBlockWon = "notify_block_won"
        case notifyNodeSynced = "notify_node_synced"
        case notifyNodeOutOfSync = "notify_node_out_of_sync"
        case showWalletBalance = "show_wallet_balance"
    }

    static let appSupport = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/BitcoinLottery")

    static var configURL: URL { appSupport.appendingPathComponent("config.json") }
    static var stateURL: URL { appSupport.appendingPathComponent("state.json") }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = try c.decode(String.self, forKey: .mode)
        payoutAddress = try c.decodeIfPresent(String.self, forKey: .payoutAddress) ?? ""
        rpcURL = try c.decodeIfPresent(String.self, forKey: .rpcURL) ?? "http://127.0.0.1:8332"
        rpcUser = try c.decodeIfPresent(String.self, forKey: .rpcUser) ?? ""
        rpcPass = try c.decodeIfPresent(String.self, forKey: .rpcPass) ?? ""
        machineSeed = try c.decodeIfPresent(String.self, forKey: .machineSeed) ?? ""
        if let minutes = try c.decodeIfPresent(Int.self, forKey: .pricePollIntervalMin) {
            pricePollIntervalMin = minutes
        } else if let text = try c.decodeIfPresent(String.self, forKey: .pricePollIntervalMin),
                  let minutes = Int(text) {
            pricePollIntervalMin = minutes
        } else {
            pricePollIntervalMin = 15
        }
        menuBarDisplay = try c.decodeIfPresent(String.self, forKey: .menuBarDisplay) ?? "block"
        screensaverView = try c.decodeIfPresent(String.self, forKey: .screensaverView) ?? "matrix_rain"
        notificationsEnabled = try c.decodeIfPresent(Bool.self, forKey: .notificationsEnabled) ?? true
        notifyClosenessAboveZero = try c.decodeIfPresent(Bool.self, forKey: .notifyClosenessAboveZero) ?? true
        notifyBlockWon = try c.decodeIfPresent(Bool.self, forKey: .notifyBlockWon) ?? true
        notifyNodeSynced = try c.decodeIfPresent(Bool.self, forKey: .notifyNodeSynced) ?? true
        notifyNodeOutOfSync = try c.decodeIfPresent(Bool.self, forKey: .notifyNodeOutOfSync) ?? true
        showWalletBalance = try c.decodeIfPresent(Bool.self, forKey: .showWalletBalance) ?? false
    }

    static func load() -> LotteryConfig? {
        guard let data = try? Data(contentsOf: configURL) else { return nil }
        return try? JSONDecoder().decode(LotteryConfig.self, from: data)
    }

    func save() throws {
        var existing: [String: Any] = [:]
        if let data = try? Data(contentsOf: Self.configURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            existing = json
        }
        let payload: [String: Any] = [
            "version": 1,
            "mode": mode,
            "payout_address": payoutAddress,
            "rpc_url": rpcURL,
            "rpc_user": rpcUser,
            "rpc_pass": rpcPass.isEmpty ? (existing["rpc_pass"] as? String ?? "") : rpcPass,
            "machine_seed": machineSeed,
            "price_poll_interval_min": pricePollIntervalMin,
            "menu_bar_display": menuBarDisplay,
            "screensaver_view": screensaverView,
            "notifications_enabled": notificationsEnabled,
            "notify_closeness_above_zero": notifyClosenessAboveZero,
            "notify_block_won": notifyBlockWon,
            "notify_node_synced": notifyNodeSynced,
            "notify_node_out_of_sync": notifyNodeOutOfSync,
            "show_wallet_balance": showWalletBalance,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try FileManager.default.createDirectory(at: Self.appSupport, withIntermediateDirectories: true)
        try data.write(to: Self.configURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Self.configURL.path) // holds rpc_pass — owner-only
    }
}

struct LotteryState: Codable {
    let lastAttempt: Attempt?
    let stats: Stats
    let mode: String?
    let machineSeed: String?
    let payoutAddress: String?
    let currentTipHeight: Int?
    let node: NodeStatus?
    let display: DisplayStats?
    let price: PriceStats?
    let walletBalance: WalletBalance?

    enum CodingKeys: String, CodingKey {
        case lastAttempt = "last_attempt"
        case stats, mode, display, price
        case walletBalance = "wallet_balance"
        case payoutAddress = "payout_address"
        case currentTipHeight = "current_tip_height"
        case machineSeed = "machine_seed"
        case node
    }

    static func load() -> LotteryState? {
        guard let data = try? Data(contentsOf: LotteryConfig.stateURL) else { return nil }
        return try? JSONDecoder().decode(LotteryState.self, from: data)
    }
}

struct Attempt: Codable {
    let height: Int
    let nonce: Int
    let hashHex: String
    let won: Bool
    let attemptedAt: String?

    enum CodingKeys: String, CodingKey {
        case height, nonce, won
        case hashHex = "hash_hex"
        case attemptedAt = "attempted_at"
    }
}

struct Stats: Codable {
    let totalAttempts: Int
    let wins: Int
    let liveAttempts: Int?
    let liveWins: Int?

    enum CodingKeys: String, CodingKey {
        case totalAttempts = "total_attempts"
        case wins
        case liveAttempts = "live_attempts"
        case liveWins = "live_wins"
    }
}

struct WalletBalance: Codable {
    let btc: Double?
    let confirmedBtc: Double?
    let txCount: Int?
    let updatedAt: String?
    let lastError: String?

    enum CodingKeys: String, CodingKey {
        case btc
        case confirmedBtc = "confirmed_btc"
        case txCount = "tx_count"
        case updatedAt = "updated_at"
        case lastError = "last_error"
    }
}

struct DisplayStats: Codable {
    let blockCountdownSec: Int?
    let hashProximity: HashProximity?
    let blockSubsidyBtc: Double?
    let nextHalvingHeight: Int?
    let blocksUntilHalving: Int?
    let halvingCountdownSec: Int?
    let halvingEpochProgress: Double?
    let halvingEra: Int?

    enum CodingKeys: String, CodingKey {
        case blockCountdownSec = "block_countdown_sec"
        case hashProximity = "hash_proximity"
        case blockSubsidyBtc = "block_subsidy_btc"
        case nextHalvingHeight = "next_halving_height"
        case blocksUntilHalving = "blocks_until_halving"
        case halvingCountdownSec = "halving_countdown_sec"
        case halvingEpochProgress = "halving_epoch_progress"
        case halvingEra = "halving_era"
    }
}

struct HashProximity: Codable {
    let won: Bool?
    let percent: Double?
    let label: String
    let leadingZeroBits: Int

    enum CodingKeys: String, CodingKey {
        case won, percent, label
        case leadingZeroBits = "leading_zero_bits"
    }
}

struct PriceStats: Codable {
    let usd: Double
    let updatedAt: String?
    let pollIntervalMin: Int?

    enum CodingKeys: String, CodingKey {
        case usd
        case updatedAt = "updated_at"
        case pollIntervalMin = "poll_interval_min"
    }
}

struct NodeStatus: Codable {
    let ready: Bool
    let reachable: Bool?
    let initialblockdownload: Bool?
    let verificationprogress: Double?
    let blocks: Int?
    let headers: Int?
    let pruned: Bool?
    let status: String?

    var syncPercent: Double {
        (verificationprogress ?? 0) * 100
    }

    var menuSummary: String {
        if reachable == false {
            return status == "rpc_not_configured" ? "bitcoind: not configured" : "bitcoind: not running"
        }
        if ready {
            return "bitcoind: Ready"
        }
        if initialblockdownload == true {
            let blocks = blocks.map { Formatters.grouped($0) } ?? "?"
            let headers = headers.map { Formatters.grouped($0) } ?? "?"
            return String(format: "bitcoind: Syncing %.1f%%  •  %@ / %@", syncPercent, blocks, headers)
        }
        return String(format: "bitcoind: Verifying %.1f%%", syncPercent)
    }

    /// When the node is not ready, overrides the normal menu bar display.
    var menuBarSyncTitle: String? {
        if reachable == false {
            if status == "rpc_not_configured" { return nil }
            return "₿ Node offline"
        }
        if ready { return nil }
        if initialblockdownload == true {
            return String(format: "₿ Sync %.1f%%", syncPercent)
        }
        return String(format: "₿ Sync %.1f%%", syncPercent)
    }
}

enum BitcoinRPC {
    static func fetchNodeStatus(config: LotteryConfig) -> NodeStatus? {
        guard !config.rpcUser.isEmpty, !config.rpcPass.isEmpty,
              let url = URL(string: config.rpcURL) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let auth = "\(config.rpcUser):\(config.rpcPass)"
        if let encoded = auth.data(using: .utf8)?.base64EncodedString() {
            request.setValue("Basic \(encoded)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = ["jsonrpc": "1.0", "id": "ui", "method": "getblockchaininfo", "params": []]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let sem = DispatchSemaphore(value: 0)
        var result: NodeStatus?

        URLSession.shared.dataTask(with: request) { data, _, _ in
            defer { sem.signal() }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let res = json["result"] as? [String: Any] else { return }

            let progress = res["verificationprogress"] as? Double ?? 0
            let syncing = res["initialblockdownload"] as? Bool ?? true
            let blocks = res["blocks"] as? Int ?? 0
            let ready = !syncing && progress >= 0.99999 && blocks > 0

            result = NodeStatus(
                ready: ready,
                reachable: true,
                initialblockdownload: syncing,
                verificationprogress: progress,
                blocks: blocks,
                headers: res["headers"] as? Int,
                pruned: res["pruned"] as? Bool,
                status: nil
            )
        }.resume()

        _ = sem.wait(timeout: .now() + 5)
        return result
    }
}

func maskAddress(_ address: String) -> String {
    let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > 12 else { return trimmed.isEmpty ? "Not set" : trimmed }
    return "\(trimmed.prefix(8))…\(trimmed.suffix(8))"
}