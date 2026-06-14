import AppKit

/// Anchor for proportional text drawn by `VizPainter`.
enum TextAnchor {
    case center, topCenter, topLeft, topRight
}

/// Anchor for monospaced text drawn by `VizPainter`.
enum MonospaceAnchor {
    case topLeft, topCenter, topRight
}

/// Shared low-level drawing, measurement, and formatting primitives used by every
/// viz module. Holds no animation state — clock-dependent effects take an explicit
/// `clock` value so the caller controls the timeline.
///
/// All drawing methods render into the current `NSGraphicsContext` (set up by the
/// hosting view's `draw(_:)`), matching the original `LotteryCanvasView` behavior.
struct VizPainter {
    // Typographic scale (mirrors the hosting view's constants).
    let fontTiny: CGFloat = 16
    let fontMicro: CGFloat = 18
    let fontCaption: CGFloat = 20
    let fontSmall: CGFloat = 22
    let fontSubtitle: CGFloat = 24

    static let hexAlphabet: [Character] = Array("0123456789abcdef")
    static let cyberAlphabet: [Character] = Array("0123456789ABCDEFアイウエオカキクケコサシスセソタチツテトハヒフヘホマミムメモヤユヨラリルレロワヲン░▒▓█╳╬╣╠┼┤┴┬│─@#$%&*<>")

    // MARK: - Fonts

    static func resolveFont(monospaced: Bool, size: CGFloat, weight: NSFont.Weight) -> NSFont {
        let pointSize = max(8, size)
        if monospaced {
            let font = NSFont.monospacedSystemFont(ofSize: pointSize, weight: weight)
            if font.pointSize > 0 { return font }
            return NSFont.userFixedPitchFont(ofSize: pointSize) ?? NSFont.systemFont(ofSize: pointSize, weight: .regular)
        }
        return NSFont.systemFont(ofSize: pointSize, weight: weight)
    }

    // MARK: - Text

    func drawText(
        _ text: String,
        at point: CGPoint,
        anchor: TextAnchor = .center,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor
    ) {
        guard !text.isEmpty else { return }
        let font = Self.resolveFont(monospaced: false, size: size, weight: weight)
        let str = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        let strSize = str.size()
        let origin: CGPoint
        switch anchor {
        case .center:
            origin = CGPoint(x: point.x - strSize.width / 2, y: point.y - strSize.height / 2)
        case .topCenter:
            origin = CGPoint(x: point.x - strSize.width / 2, y: point.y)
        case .topLeft:
            origin = CGPoint(x: point.x, y: point.y)
        case .topRight:
            origin = CGPoint(x: point.x - strSize.width, y: point.y)
        }
        str.draw(at: origin)
    }

    func drawWrappedText(
        _ text: String,
        in rect: CGRect,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor,
        alignment: NSTextAlignment
    ) {
        guard !text.isEmpty, rect.width > 0, rect.height > 0 else { return }
        let font = Self.resolveFont(monospaced: false, size: size, weight: weight)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = .byWordWrapping
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ]
        let str = NSAttributedString(string: text, attributes: attrs)
        str.draw(with: rect, options: [.usesLineFragmentOrigin, .usesFontLeading])
    }

    // MARK: - Monospace

    func drawMonospaceText(
        _ text: String,
        at point: CGPoint,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor,
        anchor: MonospaceAnchor = .topCenter
    ) {
        guard !text.isEmpty else { return }
        let font = Self.resolveFont(monospaced: true, size: size, weight: weight)
        let str = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        let strSize = str.size()
        let origin: CGPoint
        switch anchor {
        case .topLeft:
            origin = CGPoint(x: point.x, y: point.y)
        case .topCenter:
            origin = CGPoint(x: point.x - strSize.width / 2, y: point.y - strSize.height / 2)
        case .topRight:
            origin = CGPoint(x: point.x - strSize.width, y: point.y)
        }
        str.draw(at: origin)
    }

    func drawMonospaceTextCentered(
        _ text: String,
        at center: CGPoint,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor
    ) {
        drawMonospaceText(text, at: center, size: size, weight: weight, color: color, anchor: .topCenter)
    }

    func drawFittedMonospace(
        _ text: String,
        in rect: CGRect,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor
    ) {
        guard !text.isEmpty else { return }
        var fontSize = size
        var strSize = monospaceTextSize(text, size: fontSize, weight: weight)
        while fontSize > 9, strSize.width > rect.width {
            fontSize -= 1
            strSize = monospaceTextSize(text, size: fontSize, weight: weight)
        }
        drawMonospaceTextCentered(
            text, at: CGPoint(x: rect.midX, y: rect.midY), size: fontSize, weight: weight, color: color
        )
    }

    func monospaceTextSize(_ text: String, size: CGFloat, weight: NSFont.Weight) -> CGSize {
        let font = Self.resolveFont(monospaced: true, size: size, weight: weight)
        return NSAttributedString(string: text, attributes: [.font: font]).size()
    }

    func truncateMonospace(_ text: String, maxWidth: CGFloat, size: CGFloat) -> String {
        guard monospaceTextSize(text, size: size, weight: .medium).width > maxWidth else { return text }
        var clipped = text
        while clipped.count > 1, monospaceTextSize(clipped + "…", size: size, weight: .medium).width > maxWidth {
            clipped.removeLast()
        }
        return clipped + "…"
    }

    func monospaceCharHeight(size: CGFloat, weight: NSFont.Weight) -> CGFloat {
        let font = Self.resolveFont(monospaced: true, size: size, weight: weight)
        return NSAttributedString(string: "8", attributes: [.font: font]).size().height
    }

    // MARK: - Crypt / matrix effects (clock-driven)

    func cryptStreamChar(clock: CGFloat, seed: Int, depth: Int = 0) -> Character {
        let alphabet = Self.cyberAlphabet
        let idx = Int(floor(clock * 14 + CGFloat(seed) * 0.63 + CGFloat(depth) * 0.55)) % alphabet.count
        return alphabet[max(0, idx)]
    }

    func drawMatrixCryptBackdrop(clock: CGFloat, in frame: CGRect, intensity: CGFloat = 0.32, seed: Int = 0) {
        let colSpacing: CGFloat = 20
        let cols = max(1, Int(frame.width / colSpacing))
        for c in 0..<cols {
            let x = frame.minX + CGFloat(c) * colSpacing + 6
            let streamLen = 3 + (c % 4)
            let phaseOffset = CGFloat(c) * 0.55 + clock * 4
            let travel = max(16, frame.height - CGFloat(streamLen) * 14)
            for d in 0..<streamLen {
                let y = frame.minY + 4 + (phaseOffset * 18 + CGFloat(d) * 14).truncatingRemainder(dividingBy: travel)
                let ch = cryptStreamChar(clock: clock, seed: seed + c * 13 + d * 5, depth: d)
                let alpha = intensity * (d == 0 ? 0.55 : max(0.06, 0.3 - CGFloat(d) * 0.09))
                let color: NSColor = d == 0
                    ? NSColor(calibratedRed: 1, green: 0.65, blue: 0.12, alpha: alpha)
                    : NSColor(calibratedRed: 0.1, green: 0.36, blue: 0.32, alpha: alpha * 0.85)
                drawMonospaceText(String(ch), at: CGPoint(x: x, y: y), size: fontTiny - 2, weight: .regular, color: color)
            }
        }
    }

    func drawCryptHexRow(
        clock: CGFloat,
        in frame: CGRect,
        text: String,
        revealCount: Int,
        size: CGFloat,
        yours: Bool = true,
        seed: Int = 0
    ) {
        let chars = Array(text)
        guard !chars.isEmpty else { return }
        let tailReserve = min(6, chars.count)
        let visible = min(chars.count, max(revealCount + tailReserve, 1))
        let spacing = frame.width / CGFloat(visible)
        let centerY = frame.midY
        let rowHeight = max(14, frame.height - 4)
        for i in 0..<visible {
            let ch = chars[i]
            let x = frame.minX + spacing * (CGFloat(i) + 0.5)
            if i < revealCount {
                drawMonospaceTextCentered(
                    String(ch), at: CGPoint(x: x, y: centerY), size: size, weight: .bold,
                    color: yours
                        ? NSColor(calibratedRed: 1, green: 0.72, blue: 0.2, alpha: 1)
                        : NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 1)
                )
            } else {
                drawEncryptedCharSlot(
                    clock: clock, at: x, centerY: centerY, slotIndex: seed + i, realChar: ch,
                    cellWidth: spacing, rowHeight: rowHeight, size: max(12, size - 2),
                    yours: yours, snapped: false, flashStrength: 0
                )
            }
        }
    }

    func drawLockFlashCell(at x: CGFloat, centerY: CGFloat, cellWidth: CGFloat, rowHeight: CGFloat) {
        let inset: CGFloat = 2
        let rect = CGRect(
            x: x - cellWidth / 2 + inset,
            y: centerY - rowHeight / 2 + inset,
            width: max(4, cellWidth - inset * 2),
            height: max(4, rowHeight - inset * 2)
        )
        NSColor(calibratedRed: 1, green: 0.45, blue: 0.02, alpha: 0.82).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2).fill()
    }

    func drawEncryptedCharSlot(
        clock: CGFloat,
        at x: CGFloat,
        centerY: CGFloat,
        slotIndex: Int,
        realChar: Character,
        cellWidth: CGFloat,
        rowHeight: CGFloat,
        size: CGFloat,
        yours: Bool,
        snapped: Bool,
        flashStrength: CGFloat
    ) {
        let charHeight = monospaceCharHeight(size: size, weight: .bold)
        if snapped {
            if flashStrength > 0 {
                drawLockFlashCell(at: x, centerY: centerY, cellWidth: cellWidth, rowHeight: rowHeight)
                drawMonospaceTextCentered(
                    String(realChar), at: CGPoint(x: x, y: centerY), size: size, weight: .bold,
                    color: NSColor(calibratedWhite: 0.08, alpha: 1)
                )
                return
            }
            let color = yours
                ? NSColor(calibratedRed: 0.84, green: 0.84, blue: 0.84, alpha: 1)
                : NSColor(calibratedRed: 0.32, green: 0.9, blue: 0.52, alpha: 1)
            drawMonospaceTextCentered(
                String(realChar), at: CGPoint(x: x, y: centerY), size: size, weight: .bold, color: color
            )
            return
        }

        let streamLen = 3
        let phase = clock * 14 + CGFloat(slotIndex) * 0.63
        for d in 0..<streamLen {
            let alphabet = Self.cyberAlphabet
            let charIndex = Int(floor(phase + CGFloat(d) * 0.55)) % alphabet.count
            let ch = alphabet[charIndex]
            let alpha: CGFloat = d == 0 ? 1.0 : max(0.12, 0.72 - CGFloat(d) * 0.24)
            let trailY = centerY - charHeight * (0.15 + CGFloat(d) * 0.72)
            let color: NSColor
            if d == 0 {
                color = yours
                    ? NSColor(calibratedRed: 1, green: 0.72, blue: 0.18, alpha: alpha)
                    : NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: alpha)
            } else {
                let fade = 1 - CGFloat(d) / CGFloat(streamLen)
                color = NSColor(
                    calibratedRed: 0.12 + 0.08 * fade,
                    green: 0.38 + 0.2 * fade,
                    blue: 0.34 + 0.12 * fade,
                    alpha: alpha * 0.85
                )
            }
            drawMonospaceTextCentered(
                String(ch), at: CGPoint(x: x, y: trailY), size: size, weight: .bold, color: color
            )
        }
    }

    func drawHashVisualization(clock: CGFloat, hash: String, in frame: CGRect) {
        let chars = Array(hash.prefix(32))
        guard !chars.isEmpty else { return }
        let spacing = frame.width / CGFloat(chars.count)
        for (i, ch) in chars.enumerated() {
            let brightness = 0.35 + 0.65 * abs(sin(clock * 2 + CGFloat(i) * 0.4))
            let color = NSColor(calibratedRed: 1, green: CGFloat(brightness) * 0.7, blue: 0.15, alpha: 1)
            drawText(String(ch), at: CGPoint(x: frame.minX + spacing * (CGFloat(i) + 0.5), y: frame.midY),
                     size: 16, weight: .bold, color: color)
        }
    }

    // MARK: - Formatting

    static func nodeStatusPresentation(mode: String?, node: SaverNodeStatus?) -> (text: String, color: NSColor) {
        guard let node else {
            return ("bitcoind: checking…", NSColor(white: 0.5, alpha: 1))
        }
        if node.reachable == false {
            if node.status == "rpc_not_configured" {
                return ("bitcoind: not configured", NSColor(white: 0.45, alpha: 1))
            }
            return ("bitcoind: not running", NSColor(calibratedRed: 1, green: 0.45, blue: 0.4, alpha: 1))
        }
        let pct = (node.verificationprogress ?? 0) * 100
        if node.ready == true {
            let modeLabel = mode == "live" ? "Live" : "Practice"
            return (
                String(format: "bitcoind: Ready  •  %@ mode", modeLabel),
                NSColor(calibratedRed: 0.3, green: 0.9, blue: 0.5, alpha: 1)
            )
        }
        if node.initialblockdownload == true {
            return (
                String(format: "bitcoind: Syncing %.1f%%", pct),
                NSColor(calibratedRed: 1, green: 0.65, blue: 0.2, alpha: 1)
            )
        }
        return (
            String(format: "bitcoind: Verifying %.1f%%", pct),
            NSColor(white: 0.55, alpha: 1)
        )
    }

    static func formatGrouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.groupingSeparator = ","
        formatter.usesGroupingSeparator = true
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    static func formatUSD(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.groupingSeparator = ","
        formatter.usesGroupingSeparator = true
        formatter.maximumFractionDigits = 0
        formatter.minimumFractionDigits = 0
        if let grouped = formatter.string(from: NSNumber(value: value)) {
            return "$\(grouped)"
        }
        return "$\(Int(value))"
    }

    static func isHexHash(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 8 else { return false }
        return trimmed.allSatisfy { $0.isHexDigit }
    }

    static func leadingZeroHexChars(in hash: String) -> Int {
        var count = 0
        for ch in hash.lowercased() {
            if ch == "0" {
                count += 1
            } else {
                break
            }
        }
        return count
    }
}
