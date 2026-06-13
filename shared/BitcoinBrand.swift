import Foundation

enum BitcoinBrand {
    static let symbol = "₿"
    static let word = "₿itcoin"

    /// Replaces the word Bitcoin with ₿itcoin in user-facing copy.
    /// Skips filesystem paths (`/Bitcoin/`), `BitcoinLottery`, and `Bitcoin-Qt`.
    static func format(_ text: String) -> String {
        let result = text.replacingOccurrences(of: "BITCOIN", with: "\(symbol)ITCOIN")
        guard let regex = try? NSRegularExpression(pattern: "(?<![/.-])Bitcoin(?![-]|Lottery|lottery)") else {
            return result.replacingOccurrences(of: "Bitcoin", with: word)
        }
        let range = NSRange(result.startIndex..., in: result)
        return regex.stringByReplacingMatches(in: result, range: range, withTemplate: word)
    }
}