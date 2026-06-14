import AppKit

// Background gradient, matrix hash-rain, and winner-vs-you comparison panel,
// split out of LotteryCanvasView.
extension LotteryCanvasView {
    // MARK: - Background & hash

    func drawBackground(
        in rect: NSRect,
        context: CGContext,
        ceremony: Bool,
        state: SaverLotteryState?,
        view: ScreensaverView
    ) {
        let colors = [
            CGColor(red: ceremony ? 0.1 : 0.02, green: ceremony ? 0.04 : 0.025, blue: 0.06, alpha: 1),
            CGColor(red: 0.05, green: ceremony ? 0.06 : 0.03, blue: 0.02, alpha: 1),
        ] as CFArray
        let space = CGColorSpaceCreateDeviceRGB()
        if let gradient = CGGradient(colorsSpace: space, colors: colors, locations: [0, 1]) {
            context.drawLinearGradient(gradient, start: CGPoint(x: rect.midX, y: rect.minY), end: CGPoint(x: rect.midX, y: rect.maxY), options: [])
        }

        if view.showsMatrixRain {
            ensureRainColumns(for: rect)
            updateRainFromRealHashes(Self.realHashPool(from: state))
            updateRainColumns(in: rect, ceremony: ceremony)
            drawHashRain(in: rect, ceremony: ceremony)
        }

        if view.showsMatrixRain {
            let scrimColors = [
                CGColor(red: 0.02, green: 0.02, blue: 0.04, alpha: 0),
                CGColor(red: 0.02, green: 0.02, blue: 0.05, alpha: ceremony ? 0.42 : 0.5),
                CGColor(red: 0.02, green: 0.02, blue: 0.04, alpha: 0),
            ] as CFArray
            if let scrim = CGGradient(colorsSpace: space, colors: scrimColors, locations: [0, 0.5, 1]) {
                let bandTop = rect.midY - rect.height * 0.28
                let bandBottom = rect.midY + rect.height * 0.28
                context.drawLinearGradient(scrim, start: CGPoint(x: rect.midX, y: bandTop), end: CGPoint(x: rect.midX, y: bandBottom), options: [])
            }
        }
    }

    func drawWinnerPanel(
        in rect: NSRect,
        layout: Layout,
        state: SaverLotteryState?,
        ceremony: Bool,
        large: Bool
    ) {
        let panelY: CGFloat = 168
        let panelH: CGFloat = large ? 278 : 134
        let panel = CGRect(x: layout.pad, y: panelY, width: rect.width - layout.pad * 2, height: panelH)
        let pulse = ceremony ? 0.75 + 0.25 * sin(animationPhase * 6) : 1.0
        let titleColor = NSColor(calibratedRed: 0.25, green: 0.95, blue: 0.45, alpha: 1)
        let labelColor = NSColor(white: 0.55, alpha: 1)
        let innerPad: CGFloat = 14

        NSColor(white: 0.05, alpha: large ? 0.92 : 0.84).setFill()
        NSBezierPath(roundedRect: panel, xRadius: 12, yRadius: 12).fill()
        NSColor(calibratedRed: 1, green: 0.55 * pulse, blue: 0.12, alpha: large ? 0.55 : 0.35).setStroke()
        let border = NSBezierPath(roundedRect: panel, xRadius: 12, yRadius: 12)
        border.lineWidth = large ? 2 : 1.5
        border.stroke()

        guard let attempt = state?.lastAttempt else {
            drawText("Waiting for next block draw…", at: CGPoint(x: panel.midX, y: panel.midY - 8), anchor: .topCenter,
                     size: fontSmall, weight: .medium, color: NSColor(white: 0.55, alpha: 1))
            return
        }

        let winner = state?.display?.networkWinner
        let titleSize: CGFloat = large ? fontSmall : fontCaption
        let blockSize: CGFloat = large ? fontCaption : fontMicro
        var contentY = panel.minY + 8

        drawText(BitcoinBrand.format("LIVE NETWORK WINNER"), at: CGPoint(x: panel.minX + innerPad, y: contentY),
                 anchor: .topLeft, size: titleSize, weight: .bold, color: titleColor)
        contentY += large ? 26 : 20
        drawText("Block \(winner?.height ?? attempt.height)", at: CGPoint(x: panel.minX + innerPad, y: contentY),
                 anchor: .topLeft, size: blockSize, weight: .semibold, color: NSColor(white: 0.72, alpha: 1))
        contentY += large ? 22 : 16

        let machineSeed = NonceTicket.resolvedMachineSeed(stored: state?.machineSeed)

        if large {
            let diagramH: CGFloat = 22
            let diagramFrame = CGRect(
                x: panel.minX + innerPad,
                y: contentY,
                width: panel.width - innerPad * 2,
                height: diagramH
            )
            let headerPulse = 0.5 + 0.5 * sin(animationPhase * 5)
            drawBlockHeaderDiagram(in: diagramFrame, nonce: attempt.nonce, pulse: headerPulse)
            contentY += diagramH + 14
        }

        if let error = winner?.error {
            drawWrappedText(
                "Could not fetch winner: \(error)",
                in: CGRect(x: panel.minX + innerPad, y: contentY, width: panel.width - innerPad * 2, height: panel.maxY - contentY - 10),
                size: fontCaption, weight: .regular, color: NSColor(white: 0.5, alpha: 1), alignment: .left
            )
            return
        }

        let yourHash = attempt.hashHex
        let hashSize: CGFloat = large ? 15 : 12
        let hashRowH: CGFloat = large ? 34 : 22
        let hashGap: CGFloat = large ? 20 : 12
        let ticketChipH: CGFloat = large ? 20 : 16
        let detailH: CGFloat = large ? 44 : 30
        let hashAreaBottom = panel.maxY - detailH - ticketChipH - 10
        let yoursFrame = CGRect(
            x: panel.minX + 12,
            y: hashAreaBottom - hashRowH,
            width: panel.width - 24,
            height: hashRowH
        )
        let winnerFrame = CGRect(
            x: panel.minX + 12,
            y: yoursFrame.minY - hashGap - hashRowH,
            width: panel.width - 24,
            height: hashRowH
        )

        drawText("Winner hash", at: CGPoint(x: panel.minX + innerPad, y: winnerFrame.minY - 2), anchor: .topLeft,
                 size: fontMicro, weight: .semibold, color: labelColor)
        if let winnerHash = winner?.hashHex, Self.isHexHash(winnerHash) {
            let maskCount = Self.leadingZeroHexChars(in: winnerHash)
            drawComparedHash(winnerHash, compareWith: yourHash, yours: false, in: winnerFrame, size: hashSize, maskCharCount: maskCount)
            drawText("Your ticket", at: CGPoint(x: panel.minX + innerPad, y: yoursFrame.minY - 2), anchor: .topLeft,
                     size: fontMicro, weight: .semibold, color: labelColor)
            drawComparedHash(yourHash, compareWith: winnerHash, yours: true, in: yoursFrame, size: hashSize, maskCharCount: maskCount)
            drawHashMatchBridges(winnerFrame: winnerFrame, yoursFrame: yoursFrame, matchCount: maskCount, charCount: Self.hashPreviewLength)
        } else {
            let fetchFrame = CGRect(x: panel.minX + innerPad, y: winnerFrame.minY, width: panel.width - innerPad * 2, height: hashRowH)
            drawWrappedText(
                "Fetching winner from mempool.space…",
                in: fetchFrame,
                size: fontCaption, weight: .regular, color: NSColor(white: 0.5, alpha: 1), alignment: .left
            )
            drawText("Your ticket", at: CGPoint(x: panel.minX + innerPad, y: yoursFrame.minY - 2), anchor: .topLeft,
                     size: fontMicro, weight: .semibold, color: labelColor)
            drawComparedHash(yourHash, compareWith: "", yours: true, in: yoursFrame, size: hashSize)
        }

        let ticketChipFrame = CGRect(
            x: panel.minX + innerPad,
            y: panel.maxY - detailH - ticketChipH - 6,
            width: panel.width - innerPad * 2,
            height: ticketChipH
        )
        drawNonceTicketChip(
            in: ticketChipFrame,
            machineSeed: machineSeed,
            blockHeight: attempt.height,
            nonce: attempt.nonce,
            size: large ? fontMicro : 10
        )

        let detail: String
        if attempt.won {
            detail = "JACKPOT — your hash matched the network target"
        } else if let winnerHash = winner?.hashHex, Self.leadingZeroHexChars(in: winnerHash) > 0 {
            detail = "★ Winner shows leading 0s; your ticket keeps the mask encrypted until the end. Suffix snaps with an orange flash, holds 15s, then your mask reveals for 15s."
        } else {
            detail = "Different hashes — theirs hit the target, yours didn't"
        }
        drawWrappedText(
            detail,
            in: CGRect(x: panel.minX + innerPad, y: panel.maxY - detailH - 6, width: panel.width - innerPad * 2, height: detailH),
            size: large ? fontCaption : fontMicro,
            weight: .medium,
            color: NSColor(white: 0.62, alpha: 1),
            alignment: .center
        )
    }

    func drawHashMatchBridges(winnerFrame: CGRect, yoursFrame: CGRect, matchCount: Int, charCount: Int) {
        guard matchCount > 0 else { return }
        let spacing = winnerFrame.width / CGFloat(charCount)
        let matchWidth = spacing * CGFloat(matchCount)
        let highlight = CGRect(x: winnerFrame.minX, y: winnerFrame.minY - 2, width: matchWidth, height: yoursFrame.maxY - winnerFrame.minY + 4)
        NSColor(calibratedRed: 1, green: 0.82, blue: 0.15, alpha: 0.12).setFill()
        NSBezierPath(roundedRect: highlight, xRadius: 6, yRadius: 6).fill()
        NSColor(calibratedRed: 1, green: 0.72, blue: 0.1, alpha: 0.55).setStroke()
        let outline = NSBezierPath(roundedRect: highlight, xRadius: 6, yRadius: 6)
        outline.lineWidth = 1.5
        outline.stroke()

        if matchCount < charCount {
            let splitX = winnerFrame.minX + matchWidth
            NSColor(calibratedRed: 1, green: 0.35, blue: 0.25, alpha: 0.85).setStroke()
            let diverge = NSBezierPath()
            diverge.move(to: CGPoint(x: splitX, y: winnerFrame.minY - 4))
            diverge.line(to: CGPoint(x: splitX, y: yoursFrame.maxY + 4))
            diverge.lineWidth = 2
            diverge.setLineDash([4, 3], count: 2, phase: animationPhase * 8)
            diverge.stroke()
        }

        for i in 0..<matchCount {
            let x = winnerFrame.minX + spacing * (CGFloat(i) + 0.5)
            NSColor(calibratedRed: 1, green: 0.78, blue: 0.2, alpha: 0.35).setStroke()
            let link = NSBezierPath()
            link.move(to: CGPoint(x: x, y: winnerFrame.maxY + 1))
            link.line(to: CGPoint(x: x, y: yoursFrame.minY - 1))
            link.lineWidth = 1.5
            link.stroke()
        }
    }

    func drawComparedHash(
        _ hash: String,
        compareWith: String,
        yours: Bool,
        in frame: CGRect,
        size: CGFloat,
        maskCharCount: Int? = nil
    ) {
        let rowFrame = frame
        let chars = Array(hash.prefix(Self.hashPreviewLength))
        guard !chars.isEmpty else { return }
        let other = Array(compareWith.lowercased())
        let hasComparison = !compareWith.isEmpty && Self.isHexHash(compareWith)
        let spacing = rowFrame.width / CGFloat(max(chars.count, 1))
        let mismatchIndex: Int
        if hasComparison, let maskCharCount {
            mismatchIndex = min(max(maskCharCount, 0), chars.count)
        } else if hasComparison {
            var computed = chars.count
            for (i, ch) in chars.enumerated() {
                if i >= other.count || String(ch).lowercased() != String(other[i]) {
                    computed = i
                    break
                }
            }
            mismatchIndex = computed
        } else {
            mismatchIndex = chars.count
        }

        let suffixCount = chars.count - mismatchIndex
        var scrambleCycle: HashScrambleCycle?
        if hasComparison {
            let cycleKey = "\(yours ? "y" : "w")-\(hash)-\(mismatchIndex)"
            scrambleCycle = advanceHashScramble(
                key: cycleKey,
                suffixCount: suffixCount,
                maskCharCount: mismatchIndex,
                isYours: yours,
                dt: Self.scrambleFrameDt
            )
        }

        if hasComparison, mismatchIndex > 0, !yours || scrambleCycle?.phase == .completeHold {
            let matchBg = CGRect(x: rowFrame.minX, y: rowFrame.minY + 2, width: spacing * CGFloat(mismatchIndex), height: rowFrame.height - 4)
            let bgColor = yours
                ? NSColor(calibratedRed: 1, green: 0.72, blue: 0.1, alpha: 0.22)
                : NSColor(calibratedRed: 0.2, green: 0.9, blue: 0.45, alpha: 0.18)
            bgColor.setFill()
            NSBezierPath(roundedRect: matchBg, xRadius: 4, yRadius: 4).fill()
        }

        if hasComparison, mismatchIndex < chars.count {
            let scrambleBg = CGRect(
                x: rowFrame.minX + spacing * CGFloat(mismatchIndex),
                y: rowFrame.minY + 1,
                width: spacing * CGFloat(chars.count - mismatchIndex),
                height: rowFrame.height - 2
            )
            NSColor(calibratedRed: 0.04, green: 0.12, blue: 0.1, alpha: yours ? 0.55 : 0.45).setFill()
            NSBezierPath(roundedRect: scrambleBg, xRadius: 4, yRadius: 4).fill()
            NSColor(calibratedRed: 0.15, green: 0.55, blue: 0.42, alpha: 0.35).setStroke()
            let scrambleBorder = NSBezierPath(roundedRect: scrambleBg, xRadius: 4, yRadius: 4)
            scrambleBorder.lineWidth = 1
            scrambleBorder.stroke()
        }

        let centerY = rowFrame.midY
        let rowHeight = rowFrame.height
        let cycle = scrambleCycle
        let showYourPrefix = yours && cycle?.phase == .completeHold

        for (i, ch) in chars.enumerated() {
            let x = rowFrame.minX + spacing * (CGFloat(i) + 0.5)

            if !hasComparison {
                drawMonospaceTextCentered(
                    String(ch), at: CGPoint(x: x, y: centerY), size: size, weight: .bold,
                    color: NSColor(white: 0.8, alpha: 1)
                )
                continue
            }

            if i < mismatchIndex {
                if yours && !showYourPrefix {
                    drawEncryptedCharSlot(
                        at: x, centerY: centerY, slotIndex: i, realChar: ch,
                        cellWidth: spacing, rowHeight: rowHeight, size: size, yours: true, snapped: false, flashStrength: 0
                    )
                    continue
                }
                let flash = cycle?.flashUntil[-(i + 1)] ?? 0
                let charSize: CGFloat = size + 2
                let color: NSColor = yours
                    ? NSColor(calibratedRed: 1, green: 0.88, blue: 0.25, alpha: 1)
                    : NSColor(calibratedRed: 0.55, green: 1, blue: 0.65, alpha: 1)
                if flash > 0 {
                    drawLockFlashCell(at: x, centerY: centerY, cellWidth: spacing, rowHeight: rowHeight)
                    drawMonospaceTextCentered(
                        String(ch), at: CGPoint(x: x, y: centerY), size: charSize, weight: .bold,
                        color: NSColor(calibratedWhite: 0.08, alpha: 1)
                    )
                } else {
                    drawMonospaceTextCentered(
                        String(ch), at: CGPoint(x: x, y: centerY), size: charSize, weight: .bold, color: color
                    )
                }
                continue
            }

            let suffixIdx = i - mismatchIndex
            let snapped = cycle?.resolved.contains(suffixIdx) == true
            let flash = cycle?.flashUntil[suffixIdx] ?? 0
            drawEncryptedCharSlot(
                at: x, centerY: centerY, slotIndex: suffixIdx, realChar: ch,
                cellWidth: spacing, rowHeight: rowHeight, size: size, yours: yours, snapped: snapped, flashStrength: flash
            )
        }

        if hasComparison, mismatchIndex > 0, mismatchIndex < chars.count {
            let x = rowFrame.minX + spacing * CGFloat(mismatchIndex)
            drawText("≠", at: CGPoint(x: x, y: rowFrame.minY - 10), anchor: .topCenter,
                     size: fontMicro, weight: .bold, color: NSColor(calibratedRed: 1, green: 0.4, blue: 0.3, alpha: 1))
        }
    }

    func advanceHashScramble(
        key: String,
        suffixCount: Int,
        maskCharCount: Int,
        isYours: Bool,
        dt: CGFloat
    ) -> HashScrambleCycle {
        var cycle = hashScrambles[key] ?? HashScrambleCycle(
            suffixCount: suffixCount, maskCharCount: maskCharCount, isYours: isYours
        )
        if cycle.suffixCount != suffixCount || cycle.maskCharCount != maskCharCount || cycle.isYours != isYours {
            cycle = HashScrambleCycle(suffixCount: suffixCount, maskCharCount: maskCharCount, isYours: isYours)
        }

        tickFlashTimers(&cycle, dt: dt)

        switch cycle.phase {
        case .encrypted:
            cycle.encryptedElapsed += dt
            if cycle.encryptedElapsed >= Self.scrambleEncryptedLeadIn {
                cycle.phase = .locking
            }
        case .locking:
            if suffixCount > 0 {
                cycle.nextRevealIn -= dt
                while cycle.nextRevealIn <= 0, !cycle.revealOrder.isEmpty {
                    let slot = cycle.revealOrder.removeFirst()
                    cycle.resolved.insert(slot)
                    cycle.flashUntil[slot] = Self.scrambleLockFlashSeconds
                    cycle.nextRevealIn += Self.scrambleSnapInterval * CGFloat.random(in: 0.65...1.35)
                }
            }
            if suffixCount == 0 || cycle.resolved.count == suffixCount {
                cycle.phase = .lockedHold
                cycle.lockedHoldElapsed = 0
            }
        case .lockedHold:
            cycle.lockedHoldElapsed += dt
            if cycle.lockedHoldElapsed >= Self.scrambleLockedHoldSeconds {
                if isYours {
                    for i in 0..<maskCharCount {
                        cycle.flashUntil[-(i + 1)] = Self.scrambleLockFlashSeconds
                    }
                } else if suffixCount > 0 {
                    for slot in 0..<suffixCount where !cycle.resolved.contains(slot) {
                        cycle.resolved.insert(slot)
                        cycle.flashUntil[slot] = Self.scrambleLockFlashSeconds
                    }
                }
                cycle.phase = .completeHold
                cycle.completeHoldElapsed = 0
            }
        case .completeHold:
            cycle.completeHoldElapsed += dt
            if cycle.completeHoldElapsed >= Self.scrambleCompleteHoldSeconds {
                cycle = HashScrambleCycle(suffixCount: suffixCount, maskCharCount: maskCharCount, isYours: isYours)
            }
        }

        hashScrambles[key] = cycle
        return cycle
    }

    func tickFlashTimers(_ timers: inout [Int: CGFloat], dt: CGFloat) {
        guard !timers.isEmpty else { return }
        for slot in Array(timers.keys) {
            timers[slot, default: 0] -= dt
            if timers[slot, default: 0] <= 0 {
                timers.removeValue(forKey: slot)
            }
        }
    }

    func tickHeaderFlashTimers(_ timers: inout [BlockHeaderField: CGFloat], dt: CGFloat) {
        guard !timers.isEmpty else { return }
        for field in Array(timers.keys) {
            timers[field, default: 0] -= dt
            if timers[field, default: 0] <= 0 {
                timers.removeValue(forKey: field)
            }
        }
    }

    func tickFlashTimers(_ cycle: inout HashScrambleCycle, dt: CGFloat) {
        tickFlashTimers(&cycle.flashUntil, dt: dt)
    }

    func monospaceCharHeight(size: CGFloat, weight: NSFont.Weight) -> CGFloat {
        painter.monospaceCharHeight(size: size, weight: weight)
    }

    func cryptStreamChar(seed: Int, depth: Int = 0) -> Character {
        painter.cryptStreamChar(clock: animationPhase, seed: seed, depth: depth)
    }

    func drawMatrixCryptBackdrop(in frame: CGRect, intensity: CGFloat = 0.32, seed: Int = 0) {
        painter.drawMatrixCryptBackdrop(clock: animationPhase, in: frame, intensity: intensity, seed: seed)
    }

    func drawCryptHexRow(
        in frame: CGRect,
        text: String,
        revealCount: Int,
        size: CGFloat,
        yours: Bool = true,
        seed: Int = 0
    ) {
        painter.drawCryptHexRow(
            clock: animationPhase, in: frame, text: text, revealCount: revealCount,
            size: size, yours: yours, seed: seed
        )
    }

    func drawLockFlashCell(at x: CGFloat, centerY: CGFloat, cellWidth: CGFloat, rowHeight: CGFloat) {
        painter.drawLockFlashCell(at: x, centerY: centerY, cellWidth: cellWidth, rowHeight: rowHeight)
    }

    func drawEncryptedCharSlot(
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
        painter.drawEncryptedCharSlot(
            clock: animationPhase, at: x, centerY: centerY, slotIndex: slotIndex, realChar: realChar,
            cellWidth: cellWidth, rowHeight: rowHeight, size: size, yours: yours,
            snapped: snapped, flashStrength: flashStrength
        )
    }

    func ensureRainColumns(for rect: NSRect) {
        let size = rect.size
        guard size != rainBoundsSize || rainColumns.isEmpty else { return }
        rainBoundsSize = size
        rainHashPoolKey = ""
        let count = max(1, Int(ceil(rect.width / rainColumnSpacing)))
        rainColumns = (0..<count).map { i in
            let len = Int.random(in: 10...24)
            return RainColumn(
                x: CGFloat(i) * rainColumnSpacing + rainColumnSpacing * 0.5,
                offset: CGFloat.random(in: 0...(rect.height + CGFloat(len) * rainCharHeight)),
                speed: CGFloat.random(in: 1.8...5.2),
                chars: Self.randomHexChars(count: len),
                spark: Double.random(in: 0..<1) < 0.12
            )
        }
    }

    static func realHashPool(from state: SaverLotteryState?) -> [String] {
        guard let state else { return [] }
        var hashes: [String] = []
        var seen = Set<String>()
        if let last = state.lastAttempt?.hashHex {
            let normalized = last.lowercased()
            if !normalized.isEmpty {
                hashes.append(normalized)
                seen.insert(normalized)
            }
        }
        for attempt in state.history ?? [] {
            let normalized = attempt.hashHex.lowercased()
            guard !normalized.isEmpty, !seen.contains(normalized) else { continue }
            hashes.append(normalized)
            seen.insert(normalized)
        }
        return hashes
    }

    func updateRainFromRealHashes(_ hashes: [String]) {
        rainHashPool = hashes
        let key = hashes.joined(separator: "|")
        guard key != rainHashPoolKey, !rainColumns.isEmpty else { return }
        rainHashPoolKey = key
        guard !hashes.isEmpty else { return }
        for i in rainColumns.indices {
            rainColumns[i].chars = Self.charsFromHashPool(hashes, column: i, count: rainColumns[i].chars.count)
        }
    }

    static func charsFromHashPool(_ hashes: [String], column: Int, count: Int) -> [Character] {
        let hashChars = Array(hashes[column % hashes.count].filter { hexAlphabet.contains($0) })
        guard !hashChars.isEmpty else { return randomHexChars(count: count) }
        let start = (column * 5) % hashChars.count
        return (0..<count).map { hashChars[(start + $0) % hashChars.count] }
    }

    func updateRainColumns(in rect: NSRect, ceremony: Bool) {
        let speedMult: CGFloat = ceremony ? 1.8 : 1.0
        for i in rainColumns.indices {
            rainColumns[i].offset += rainColumns[i].speed * speedMult
            let cycle = rect.height + CGFloat(rainColumns[i].length) * rainCharHeight
            if rainColumns[i].offset > cycle {
                rainColumns[i].offset -= cycle
                if !rainHashPool.isEmpty, Int.random(in: 0..<20) == 0 {
                    let column = i + Int.random(in: 0..<rainHashPool.count)
                    rainColumns[i].chars = Self.charsFromHashPool(rainHashPool, column: column, count: rainColumns[i].chars.count)
                }
            }
        }
    }

    func drawHashRain(in rect: NSRect, ceremony: Bool) {
        for column in rainColumns {
            let headY = column.offset.truncatingRemainder(dividingBy: rect.height + CGFloat(column.length) * rainCharHeight)
            for (i, ch) in column.chars.enumerated() {
                let y = headY - CGFloat(i) * rainCharHeight
                guard y > -rainCharHeight, y < rect.height + rainCharHeight else { continue }
                let color: NSColor
                if i == 0 {
                    color = NSColor(
                        calibratedRed: 1,
                        green: ceremony ? 0.75 : 0.68,
                        blue: 0.12,
                        alpha: ceremony ? 1.0 : 0.88
                    )
                } else {
                    color = rainTrailColor(distance: i, length: column.length, spark: column.spark, ceremony: ceremony)
                }
                guard ch.isASCII, ch.isHexDigit else { continue }
                drawMonospaceText(String(ch), at: CGPoint(x: column.x, y: y), size: fontSmall, weight: .regular, color: color)
            }
        }
    }

    func rainTrailColor(distance: Int, length: Int, spark: Bool, ceremony: Bool) -> NSColor {
        let t = CGFloat(distance) / CGFloat(max(length - 1, 1))
        let alpha = 0.5 * (1.0 - t) + 0.05
        if spark || (ceremony && distance < 4) {
            return NSColor(
                calibratedRed: 1,
                green: 0.45 + 0.25 * (1 - t),
                blue: 0.08,
                alpha: min(1, alpha * (ceremony ? 1.35 : 1.0))
            )
        }
        let fade = 1 - t
        return NSColor(
            calibratedRed: 0.16 + 0.1 * fade,
            green: 0.34 + 0.14 * fade,
            blue: 0.32 + 0.1 * fade,
            alpha: alpha
        )
    }

    static func randomHexChars(count: Int) -> [Character] {
        (0..<count).map { _ in hexAlphabet[Int.random(in: 0..<hexAlphabet.count)] }
    }

    static func leadingZeroHexChars(in hash: String) -> Int {
        VizPainter.leadingZeroHexChars(in: hash)
    }

    static func isHexHash(_ text: String) -> Bool {
        VizPainter.isHexHash(text)
    }

    func drawMonospaceText(
        _ text: String,
        at point: CGPoint,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor,
        anchor: MonospaceAnchor = .topCenter
    ) {
        painter.drawMonospaceText(text, at: point, size: size, weight: weight, color: color, anchor: anchor)
    }

    func drawMonospaceTextCentered(
        _ text: String,
        at center: CGPoint,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor
    ) {
        painter.drawMonospaceTextCentered(text, at: center, size: size, weight: weight, color: color)
    }

    func drawFittedMonospace(
        _ text: String,
        in rect: CGRect,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor
    ) {
        painter.drawFittedMonospace(text, in: rect, size: size, weight: weight, color: color)
    }

    func monospaceTextSize(_ text: String, size: CGFloat, weight: NSFont.Weight) -> CGSize {
        painter.monospaceTextSize(text, size: size, weight: weight)
    }

    func truncateMonospace(_ text: String, maxWidth: CGFloat, size: CGFloat) -> String {
        painter.truncateMonospace(text, maxWidth: maxWidth, size: size)
    }

    func drawHashVisualization(hash: String, in frame: CGRect) {
        painter.drawHashVisualization(clock: animationPhase, hash: hash, in: frame)
    }

}
