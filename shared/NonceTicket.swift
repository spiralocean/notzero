import CryptoKit
import Foundation

enum NonceTicket {
    static func resolvedMachineSeed(stored: String?) -> String {
        let trimmed = stored?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return ProcessInfo.processInfo.hostName
    }

    static func ticketInput(machineSeed: String, blockHeight: Int) -> String {
        "\(machineSeed):\(blockHeight)"
    }

    static func digest(for machineSeed: String, blockHeight: Int) -> Data {
        let input = ticketInput(machineSeed: machineSeed, blockHeight: blockHeight)
        let hash = SHA256.hash(data: Data(input.utf8))
        return Data(hash)
    }

    static func digestHex(for machineSeed: String, blockHeight: Int) -> String {
        digest(for: machineSeed, blockHeight: blockHeight).map { String(format: "%02x", $0) }.joined()
    }

    static func firstFourBytesHex(for machineSeed: String, blockHeight: Int) -> String {
        digest(for: machineSeed, blockHeight: blockHeight).prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    static func pickNonce(machineSeed: String, blockHeight: Int) -> UInt32 {
        let bytes = digest(for: machineSeed, blockHeight: blockHeight)
        guard bytes.count >= 4 else { return 0 }
        return UInt32(bytes[0])
            | (UInt32(bytes[1]) << 8)
            | (UInt32(bytes[2]) << 16)
            | (UInt32(bytes[3]) << 24)
    }

    static func formattedNonce(_ nonce: UInt32) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.groupingSeparator = ","
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: NSNumber(value: nonce)) ?? "\(nonce)"
    }

    static func formattedNonce(_ nonce: Int) -> String {
        formattedNonce(UInt32(truncatingIfNeeded: nonce))
    }

    static func shortSeed(_ seed: String, maxLen: Int = 14) -> String {
        if seed.count <= maxLen { return seed }
        return String(seed.prefix(max(1, maxLen - 1))) + "…"
    }

    static func ticketSummary(machineSeed: String, blockHeight: Int, nonce: Int) -> String {
        let input = ticketInput(machineSeed: machineSeed, blockHeight: blockHeight)
        let bytes = firstFourBytesHex(for: machineSeed, blockHeight: blockHeight)
        return "\(shortSeed(input)) → 0x\(bytes) → #\(formattedNonce(nonce))"
    }
}