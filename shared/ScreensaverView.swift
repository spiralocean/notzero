import Foundation

enum ScreensaverView: String, CaseIterable {
    case matrixRain = "matrix_rain"
    case winnerContrast = "winner_contrast"
    case matrixWinner = "matrix_winner"

    var label: String {
        switch self {
        case .matrixRain: return "Matrix rain"
        case .winnerContrast: return "Winner contrast"
        case .matrixWinner: return "Matrix + winner"
        }
    }

    var help: String {
        switch self {
        case .matrixRain:
            return "Falling hex from your real ticket hashes."
        case .winnerContrast:
            return "Live network winner vs your ticket — fetched from mempool.space each block."
        case .matrixWinner:
            return "Matrix rain plus a winner-vs-you comparison panel."
        }
    }

    var showsMatrixRain: Bool { self != .winnerContrast }
    var showsWinnerPanel: Bool { self != .matrixRain }
    var largeWinnerPanel: Bool { self == .winnerContrast }

    static func from(raw: String?) -> ScreensaverView {
        guard let raw, let view = ScreensaverView(rawValue: raw) else { return .matrixRain }
        return view
    }
}