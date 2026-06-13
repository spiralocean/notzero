import Foundation

struct SaverLotteryState: Decodable {
    let lastAttempt: SaverAttempt?
    let history: [SaverAttempt]?
    let stats: SaverStats
    let mode: String?
    let machineSeed: String?
    let payoutAddress: String?
    let screensaverView: String?
    let display: SaverDisplay?
    let price: SaverPrice?
    let node: SaverNodeStatus?
    let walletBalance: SaverWalletBalance?

    enum CodingKeys: String, CodingKey {
        case lastAttempt = "last_attempt"
        case history, stats, mode, display, price, node
        case walletBalance = "wallet_balance"
        case payoutAddress = "payout_address"
        case screensaverView = "screensaver_view"
        case machineSeed = "machine_seed"
    }

    var viewMode: ScreensaverView { ScreensaverView.from(raw: screensaverView) }
}

struct SaverNodeStatus: Decodable {
    let ready: Bool?
    let reachable: Bool?
    let initialblockdownload: Bool?
    let verificationprogress: Double?
    let blocks: Int?
    let headers: Int?
    let pruned: Bool?
    let status: String?
}

struct SaverAttempt: Decodable {
    let height: Int
    let nonce: Int
    let hashHex: String
    let targetHex: String
    let won: Bool
    let merkleRootHex: String?
    let txCount: Int?

    enum CodingKeys: String, CodingKey {
        case height, nonce, won
        case hashHex = "hash_hex"
        case targetHex = "target_hex"
        case merkleRootHex = "merkle_root_hex"
        case txCount = "tx_count"
    }
}

struct SaverStats: Decodable {
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

struct SaverDisplay: Decodable {
    let blockCountdownSec: Int?
    let blockElapsedSec: Int?
    let avgBlockSec: Int?
    let hashProximity: SaverProximity?
    let ceremonyUntil: String?
    let networkHashrateEh: Double?
    let networkHashrateHistory: [SaverHashratePoint]?
    let difficulty: Double?
    let networkWinner: SaverNetworkWinner?
    let blockSubsidyBtc: Double?
    let nextHalvingHeight: Int?
    let blocksUntilHalving: Int?
    let halvingCountdownSec: Int?
    let halvingEpochProgress: Double?
    let halvingEra: Int?

    enum CodingKeys: String, CodingKey {
        case blockCountdownSec = "block_countdown_sec"
        case blockElapsedSec = "block_elapsed_sec"
        case avgBlockSec = "avg_block_sec"
        case hashProximity = "hash_proximity"
        case ceremonyUntil = "ceremony_until"
        case networkHashrateEh = "network_hashrate_eh"
        case networkHashrateHistory = "network_hashrate_history"
        case difficulty
        case networkWinner = "network_winner"
        case blockSubsidyBtc = "block_subsidy_btc"
        case nextHalvingHeight = "next_halving_height"
        case blocksUntilHalving = "blocks_until_halving"
        case halvingCountdownSec = "halving_countdown_sec"
        case halvingEpochProgress = "halving_epoch_progress"
        case halvingEra = "halving_era"
    }

    var ceremonyActive: Bool {
        guard let ceremonyUntil else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: ceremonyUntil) { return Date() < date }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: ceremonyUntil) else { return false }
        return Date() < date
    }
}

struct SaverProximity: Decodable {
    let won: Bool
    let percent: Double
    let leadingZeroBits: Int
    let label: String

    enum CodingKeys: String, CodingKey {
        case won, percent, label
        case leadingZeroBits = "leading_zero_bits"
    }
}

struct SaverWalletBalance: Decodable {
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

struct SaverPrice: Decodable {
    let usd: Double
    let updatedAt: String?
    let history: [SaverPricePoint]
    let pollIntervalMin: Int?

    enum CodingKeys: String, CodingKey {
        case usd, history
        case updatedAt = "updated_at"
        case pollIntervalMin = "poll_interval_min"
    }
}

struct SaverPricePoint: Decodable {
    let t: String
    let usd: Double
}

struct SaverHashratePoint: Decodable {
    let t: String
    let eh: Double
}

struct SaverNetworkWinner: Decodable {
    let height: Int?
    let hashHex: String?
    let prefixMatchChars: Int?
    let fetchedAt: String?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case height, error
        case hashHex = "hash_hex"
        case prefixMatchChars = "prefix_match_chars"
        case fetchedAt = "fetched_at"
    }
}

enum LotteryStateLoader {
    static var candidateURLs: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [
            home.appendingPathComponent("Library/Screen Savers/bitcoin-lottery-state.json"),
            home.appendingPathComponent("Library/Application Support/BitcoinLottery/state.json"),
        ]
    }

    static var stateURL: URL { candidateURLs[0] }

    static func load() -> (state: SaverLotteryState?, error: String?) {
        var lastError = "state.json not found"
        for url in candidateURLs {
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            do {
                let data = try Data(contentsOf: url)
                let state = try JSONDecoder().decode(SaverLotteryState.self, from: data)
                return (state, nil)
            } catch {
                lastError = "decode error (\(url.lastPathComponent)): \(error.localizedDescription)"
            }
        }
        return (nil, lastError)
    }
}