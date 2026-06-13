import Foundation

enum MenuBarDisplay: String, CaseIterable {
    case block
    case price
    case closeness

    var segmentLabel: String {
        switch self {
        case .block: return "Block"
        case .price: return "Price"
        case .closeness: return "Closeness"
        }
    }

    var menuLabel: String {
        switch self {
        case .block: return "Show block height"
        case .price: return "Show BTC price"
        case .closeness: return "Show hash closeness"
        }
    }

    static func from(config: LotteryConfig?) -> MenuBarDisplay {
        MenuBarDisplay(rawValue: config?.menuBarDisplay ?? "") ?? .block
    }

    static func statusBarTitle(state: LotteryState?, config: LotteryConfig?) -> String {
        if let syncTitle = state?.node?.menuBarSyncTitle {
            return syncTitle
        }
        return from(config: config).formatTitle(state: state)
    }

    func formatTitle(state: LotteryState?) -> String {
        switch self {
        case .block:
            if let height = state?.lastAttempt?.height {
                return "₿ \(height)"
            }
            return "₿ …"
        case .price:
            if let usd = state?.price?.usd {
                return "₿ \(Formatters.usdCompact(usd))"
            }
            return "₿ …"
        case .closeness:
            guard let prox = state?.display?.hashProximity else { return "₿ …" }
            if prox.won == true { return "₿ JACKPOT!" }
            let pct = prox.percent ?? 0
            return String(format: "₿ %.4f%%", pct)
        }
    }
}

enum Formatters {
    private static let usd: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 0
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    static func usd(_ value: Double) -> String {
        usd.string(from: NSNumber(value: value)) ?? String(format: "$%.0f", value)
    }

    static func usdCompact(_ value: Double) -> String {
        usd.string(from: NSNumber(value: value)) ?? String(format: "$%.0f", value)
    }

    static func closeness(_ percent: Double) -> String {
        String(format: "%.4f%%", percent)
    }

    static func btc(_ value: Double) -> String {
        if value == 0 { return "0 BTC" }
        if abs(value) < 0.00000001 { return String(format: "%.8f BTC", value) }
        if abs(value) < 0.001 { return String(format: "%.8f BTC", value) }
        return String(format: "%.8f BTC", value)
    }

    static func durationShort(_ seconds: Int) -> String {
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        if days > 0 {
            return "~\(days)d \(hours)h"
        }
        if hours > 0 {
            return "~\(hours)h"
        }
        let minutes = max(1, seconds / 60)
        return "~\(minutes)m"
    }

    static func grouped(_ value: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US_POSIX")
        f.groupingSeparator = ","
        f.usesGroupingSeparator = true
        return f.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}

func resolvedPayoutAddress(config: LotteryConfig?, state: LotteryState?) -> String {
    let fromConfig = config?.payoutAddress.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !fromConfig.isEmpty { return fromConfig }
    return state?.payoutAddress?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}