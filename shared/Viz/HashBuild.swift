import AppKit

// Hash-build ceremony (nonce → merkle → header → SHA-256 → reveal) + jackpot ceremony,
// split out of LotteryCanvasView. Methods stay on the view via this extension.
extension LotteryCanvasView {
    // MARK: - Ceremony

    func drawCeremony(
        in rect: NSRect,
        attempt: SaverAttempt,
        machineSeed: String,
        build: HashBuildCycle?
    ) {
        let pulse = 0.7 + 0.3 * sin(animationPhase * 8)
        let color = NSColor(calibratedRed: 1, green: 0.5 * pulse, blue: 0.1, alpha: 1)
        drawText("NEW BLOCK DRAWN", at: CGPoint(x: rect.midX, y: rect.midY - 32), anchor: .topCenter,
                 size: 22, weight: .heavy, color: color)
        drawText("#\(attempt.height)", at: CGPoint(x: rect.midX, y: rect.midY - 6), anchor: .topCenter,
                 size: 48, weight: .heavy, color: .white)

        for i in 0..<20 {
            let angle = animationPhase * 4 + CGFloat(i) * 0.5
            let x = rect.midX + cos(angle) * (80 + sin(animationPhase * 3) * 20)
            let y = rect.midY + sin(angle) * 40
            let s: CGFloat = 4 + sin(animationPhase * 5 + CGFloat(i)) * 2
            NSColor(calibratedRed: 1, green: 0.7, blue: 0.2, alpha: 0.7).setFill()
            NSBezierPath(ovalIn: CGRect(x: x, y: y, width: s, height: s)).fill()
        }

        if let build {
            let phaseLabel: String
            switch build.phase {
            case .nonceAssemble, .nonceDigest, .nonceSnap: phaseLabel = "Picking your nonce…"
            case .merkleBuild: phaseLabel = "Building Merkle root…"
            case .headerPack: phaseLabel = "Packing block header…"
            case .sha256First: phaseLabel = "SHA-256 round 1…"
            case .sha256Second: phaseLabel = "SHA-256 round 2…"
            case .hashReveal: phaseLabel = "Your hash emerges…"
            case .hold: phaseLabel = "Ticket ready"
            }
            drawText(phaseLabel, at: CGPoint(x: rect.midX, y: rect.midY + 44), anchor: .topCenter,
                     size: fontMicro, weight: .semibold, color: NSColor(white: 0.72, alpha: 1))
            let mini = CGRect(x: rect.midX - 230, y: rect.midY + 58, width: 460, height: 34)
            drawHashBuildNonceStep(in: mini, build: build, attemptNonce: attempt.nonce, compact: true)
        } else {
            let summary = NonceTicket.ticketSummary(
                machineSeed: machineSeed, blockHeight: attempt.height, nonce: attempt.nonce
            )
            drawText(summary, at: CGPoint(x: rect.midX, y: rect.midY + 58), anchor: .topCenter,
                     size: fontMicro, weight: .medium, color: NSColor(white: 0.78, alpha: 1))
        }
    }

    func beginHashBuildSectionHold(_ cycle: inout HashBuildCycle, next: HashBuildCycle.Phase) {
        guard cycle.pendingPhase == nil, cycle.sectionHold <= 0 else { return }
        cycle.pendingPhase = next
        cycle.sectionHold = Self.hashBuildSectionHoldSeconds
    }

    func advanceHashBuild(_ cycle: inout HashBuildCycle, dt: CGFloat) {
        if cycle.flash > 0 {
            cycle.flash = max(0, cycle.flash - dt)
        }
        tickFlashTimers(&cycle.hashFlashUntil, dt: dt)
        tickHeaderFlashTimers(&cycle.headerFlashUntil, dt: dt)

        if cycle.phase == .hashReveal {
            cycle.nextHashRevealIn -= dt
            while cycle.nextHashRevealIn <= 0, !cycle.hashRevealOrder.isEmpty {
                let slot = cycle.hashRevealOrder.removeFirst()
                cycle.hashResolved.insert(slot)
                cycle.hashFlashUntil[slot] = Self.hashSnapFlashSeconds
                cycle.nextHashRevealIn += Self.hashRevealSnapInterval * CGFloat.random(in: 0.7...1.25)
            }
        }

        if cycle.sectionHold > 0 {
            cycle.sectionHold = max(0, cycle.sectionHold - dt)
            if cycle.sectionHold == 0, let next = cycle.pendingPhase {
                cycle.pendingPhase = nil
                if next != cycle.phase {
                    cycle.phase = next
                    cycle.elapsed = 0
                }
            }
            return
        }

        cycle.elapsed += dt
        switch cycle.phase {
        case .nonceAssemble:
            if cycle.elapsed >= Self.nonceAssembleSeconds {
                cycle.elapsed = Self.nonceAssembleSeconds
                beginHashBuildSectionHold(&cycle, next: .nonceDigest)
            }
        case .nonceDigest:
            if cycle.elapsed >= Self.nonceDigestSeconds {
                cycle.elapsed = Self.nonceDigestSeconds
                cycle.flash = Self.nonceSnapFlashSeconds
                beginHashBuildSectionHold(&cycle, next: .nonceSnap)
            }
        case .nonceSnap:
            if cycle.elapsed >= Self.nonceSnapSeconds {
                cycle.elapsed = Self.nonceSnapSeconds
                cycle.headerFlashUntil[.nonce] = Self.headerFieldFlashSeconds
                beginHashBuildSectionHold(&cycle, next: .merkleBuild)
            }
        case .merkleBuild:
            if cycle.elapsed >= Self.merkleBuildSeconds {
                cycle.elapsed = Self.merkleBuildSeconds
                cycle.headerFlashUntil[.merkle] = Self.headerFieldFlashSeconds
                cycle.lastPackFieldIndex = -1
                beginHashBuildSectionHold(&cycle, next: .headerPack)
            }
        case .headerPack:
            let fieldCount = Self.headerPackFields.count
            let packIdx = min(
                fieldCount - 1,
                Int(floor(cycle.elapsed / Self.headerPackSeconds * CGFloat(fieldCount)))
            )
            if packIdx > cycle.lastPackFieldIndex {
                if cycle.lastPackFieldIndex >= 0, cycle.pendingPhase == nil, cycle.sectionHold <= 0 {
                    cycle.headerFlashUntil[Self.headerPackFields[cycle.lastPackFieldIndex]] = Self.headerFieldFlashSeconds
                    cycle.elapsed = Self.headerPackSeconds * CGFloat(cycle.lastPackFieldIndex + 1) / CGFloat(fieldCount)
                    cycle.pendingPhase = .headerPack
                    cycle.sectionHold = Self.hashBuildPackFieldHoldSeconds
                }
                cycle.lastPackFieldIndex = packIdx
            }
            if cycle.elapsed >= Self.headerPackSeconds {
                cycle.elapsed = Self.headerPackSeconds
                cycle.headerFlashUntil[.bits] = Self.headerFieldFlashSeconds
                beginHashBuildSectionHold(&cycle, next: .sha256First)
            }
        case .sha256First:
            if cycle.elapsed >= Self.sha256RoundSeconds {
                cycle.elapsed = Self.sha256RoundSeconds
                beginHashBuildSectionHold(&cycle, next: .sha256Second)
            }
        case .sha256Second:
            if cycle.elapsed >= Self.sha256RoundSeconds {
                cycle.elapsed = Self.sha256RoundSeconds
                beginHashBuildSectionHold(&cycle, next: .hashReveal)
            }
        case .hashReveal:
            let total = cycle.hashChars.count
            if total == 0 || cycle.hashResolved.count >= total {
                beginHashBuildSectionHold(&cycle, next: .hold)
            }
        case .hold:
            break
        }
    }

    /// Create-on-new-block + advance the hash-build cycle, returning the current frame.
    /// Shared by the screensaver and dashboard render paths. Cycle holds at `.hold`
    /// until a new block height arrives (play-once-then-hold).
    func currentHashBuild(for attempt: SaverAttempt, machineSeed: String) -> HashBuildCycle? {
        if hashBuildHeight != attempt.height {
            hashBuild = HashBuildCycle(
                blockHeight: attempt.height,
                machineSeed: machineSeed,
                hashHex: attempt.hashHex,
                merkleRootHex: attempt.merkleRootHex ?? "",
                txCount: attempt.txCount ?? 1,
                previewLength: Self.hashBuildPreviewLength
            )
            hashBuildHeight = attempt.height
        }
        if var build = hashBuild {
            advanceHashBuild(&build, dt: Self.scrambleFrameDt)
            hashBuild = build
        }
        return hashBuild
    }

    func drawHashBuild(buildFrame: CGRect, hashFrame: CGRect, build: HashBuildCycle, attemptNonce: Int) {
        var panel = buildFrame
        if showsHashBuildReplayButton {
            panel.size.height -= Self.hashBuildReplayButtonH + 6
        }
        drawHashBuildVertical(in: panel, build: build, attemptNonce: attemptNonce)
        if build.phase == .hold, !hashFrame.isEmpty {
            drawHashVisualization(hash: build.hashHex, in: hashFrame)
        }
        if showsHashBuildReplayButton {
            let btnW: CGFloat = 156
            replayButtonFrame = CGRect(
                x: buildFrame.midX - btnW / 2,
                y: buildFrame.maxY - Self.hashBuildReplayButtonH - 6,
                width: btnW,
                height: Self.hashBuildReplayButtonH
            )
            drawReplayButton(in: replayButtonFrame, hovered: replayButtonHovered)
        } else {
            replayButtonFrame = .zero
        }
    }

    func hashBuildPhaseOrder(_ phase: HashBuildCycle.Phase) -> Int {
        switch phase {
        case .nonceAssemble: return 0
        case .nonceDigest: return 1
        case .nonceSnap: return 2
        case .merkleBuild: return 3
        case .headerPack: return 4
        case .sha256First: return 5
        case .sha256Second: return 6
        case .hashReveal: return 7
        case .hold: return 8
        }
    }

    func hashBuildSectionCompleted(_ section: HashBuildSection, build: HashBuildCycle) -> Bool {
        func past(_ phase: HashBuildCycle.Phase) -> Bool {
            hashBuildPhaseOrder(build.phase) > hashBuildPhaseOrder(phase)
        }
        func holdingAfter(_ phase: HashBuildCycle.Phase, next: HashBuildCycle.Phase) -> Bool {
            build.phase == phase && build.sectionHold > 0 && build.pendingPhase == next
        }
        switch section {
        case .nonce:
            return past(.nonceSnap) || holdingAfter(.nonceSnap, next: .merkleBuild)
        case .merkle:
            return past(.merkleBuild) || holdingAfter(.merkleBuild, next: .headerPack)
        case .header:
            return past(.headerPack) || holdingAfter(.headerPack, next: .sha256First)
        case .sha256:
            return past(.sha256Second) || holdingAfter(.sha256Second, next: .hashReveal)
        case .hash:
            return build.phase == .hold || holdingAfter(.hashReveal, next: .hold)
        }
    }

    func resolvedMerkleRootHex(for build: HashBuildCycle) -> String {
        if !build.merkleRootHex.isEmpty { return build.merkleRootHex }
        return String(format: "%08x", build.blockHeight) + String(repeating: "0", count: 56)
    }

    func hashBuildCompletedSections(for build: HashBuildCycle) -> [HashBuildSection] {
        HashBuildSection.allCases.filter { hashBuildSectionCompleted($0, build: build) }
    }

    func hashBuildSectionValue(
        _ section: HashBuildSection,
        build: HashBuildCycle,
        attemptNonce: Int
    ) -> String {
        switch section {
        case .nonce:
            return "#\(NonceTicket.formattedNonce(attemptNonce))"
        case .merkle:
            let root = resolvedMerkleRootHex(for: build)
            return String(root.prefix(12)) + "…"
        case .header:
            return "80 bytes · 6 fields"
        case .sha256:
            return "double SHA-256 complete"
        case .hash:
            return String(build.hashHex.prefix(18)) + "…"
        }
    }

    func drawHashBuildCompletedSections(
        in frame: CGRect,
        build: HashBuildCycle,
        attemptNonce: Int,
        sections: [HashBuildSection]
    ) {
        guard !sections.isEmpty else { return }
        let rowGap: CGFloat = 3
        let rowH = Self.hashBuildCompletedRowH
        for (i, section) in sections.enumerated() {
            let row = CGRect(x: frame.minX, y: frame.minY + CGFloat(i) * (rowH + rowGap), width: frame.width, height: rowH)
            NSColor(white: 0.05, alpha: 0.78).setFill()
            NSBezierPath(roundedRect: row, xRadius: 4, yRadius: 4).fill()
            NSColor(calibratedRed: 0.18, green: 0.72, blue: 0.4, alpha: 0.3).setStroke()
            let border = NSBezierPath(roundedRect: row, xRadius: 4, yRadius: 4)
            border.lineWidth = 0.9
            border.stroke()
            drawText(
                section.label, at: CGPoint(x: row.minX + 8, y: row.midY), anchor: .topLeft,
                size: fontMicro, weight: .semibold, color: NSColor(white: 0.5, alpha: 1)
            )
            drawText(
                "✓", at: CGPoint(x: row.minX + 88, y: row.midY), anchor: .topLeft,
                size: fontMicro, weight: .bold, color: NSColor(calibratedRed: 0.4, green: 1, blue: 0.62, alpha: 0.9)
            )
            let value = hashBuildSectionValue(section, build: build, attemptNonce: attemptNonce)
            drawMonospaceText(
                value, at: CGPoint(x: row.maxX - 8, y: row.midY),
                size: fontMicro, weight: .bold,
                color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 0.88),
                anchor: .topRight
            )
        }
    }

    func blockHeaderBlueprintContext(
        for build: HashBuildCycle
    ) -> (states: [BlockHeaderField: BlockHeaderFieldState], active: BlockHeaderField?, pulseAll: Bool) {
        switch build.phase {
        case .nonceAssemble, .nonceDigest, .nonceSnap:
            var states: [BlockHeaderField: BlockHeaderFieldState] = [:]
            for field in BlockHeaderField.allCases {
                switch field {
                case .nonce: states[field] = .active
                case .merkle: states[field] = .pending
                case .ver, .prev, .time, .bits: states[field] = .settled
                }
            }
            return (states, .nonce, false)
        case .merkleBuild:
            var states: [BlockHeaderField: BlockHeaderFieldState] = [:]
            for field in BlockHeaderField.allCases {
                switch field {
                case .merkle: states[field] = .active
                case .nonce: states[field] = .done
                case .ver, .prev, .time, .bits: states[field] = .settled
                }
            }
            return (states, .merkle, false)
        case .headerPack:
            let packProgress = min(1, build.elapsed / Self.headerPackSeconds)
            let packFields = Self.headerPackFields
            let idx = min(packFields.count - 1, Int(floor(packProgress * CGFloat(packFields.count))))
            var states: [BlockHeaderField: BlockHeaderFieldState] = [:]
            states[.nonce] = .done
            states[.merkle] = .done
            for (i, field) in packFields.enumerated() {
                if i < idx {
                    states[field] = .done
                } else if i == idx {
                    states[field] = .active
                } else {
                    states[field] = .settled
                }
            }
            return (states, packFields[idx], false)
        case .sha256First, .sha256Second:
            let states = Dictionary(uniqueKeysWithValues: BlockHeaderField.allCases.map { ($0, BlockHeaderFieldState.done) })
            return (states, nil, true)
        case .hashReveal, .hold:
            let states = Dictionary(uniqueKeysWithValues: BlockHeaderField.allCases.map { ($0, BlockHeaderFieldState.done) })
            return (states, nil, false)
        }
    }

    func blockHeaderCellText(
        field: BlockHeaderField,
        state: BlockHeaderFieldState,
        build: HashBuildCycle,
        attemptNonce: Int
    ) -> String {
        guard state != .pending else { return "··" }
        switch field {
        case .ver:
            return "v4"
        case .prev:
            return String(build.hashHex.prefix(4)) + "…"
        case .merkle:
            let root = resolvedMerkleRootHex(for: build)
            if state == .done || hashBuildPhaseOrder(build.phase) > hashBuildPhaseOrder(.merkleBuild) {
                return String(root.prefix(4)) + "…"
            }
            if state == .active, build.phase == .merkleBuild {
                let progress = min(1, build.elapsed / Self.merkleBuildSeconds)
                let reveal = min(4, max(0, Int(floor(progress * 4))))
                return String(root.prefix(reveal)) + String(repeating: "·", count: max(0, 4 - reveal))
            }
            return "····"
        case .time:
            return "time"
        case .bits:
            return "bits"
        case .nonce:
            return "#\(NonceTicket.formattedNonce(attemptNonce))"
        }
    }

    func hashBuildStatus(for build: HashBuildCycle, attemptNonce: Int) -> (title: String, detail: String) {
        let nonceText = NonceTicket.formattedNonce(attemptNonce)
        switch build.phase {
        case .nonceAssemble:
            return ("Working on: NONCE", "Assembling ticket input from your machine seed + block height")
        case .nonceDigest:
            return ("Working on: NONCE", "SHA-256 of ticket input → first 4 bytes become your nonce")
        case .nonceSnap:
            return ("Working on: NONCE", "Your lottery number locks in at #\(nonceText)")
        case .merkleBuild:
            let txLabel = build.txCount == 1
                ? "coinbase transaction"
                : "coinbase + \(build.txCount - 1) mempool transactions"
            return ("Distilling transactions → root", "Hashing \(txLabel) into one Merkle root")
        case .headerPack:
            return ("Packing block header", "Placing all 6 fields into the 80-byte header")
        case .sha256First:
            return ("Hashing the full header", "SHA-256 round 1 — mixing all 80 bytes")
        case .sha256Second:
            return ("Hashing the full header", "SHA-256 round 2 — this produces your block hash")
        case .hashReveal:
            return ("Your block hash", "Comparing against the network difficulty target")
        case .hold:
            return ("Block header complete", "Ticket #\(nonceText) — double SHA-256 finished")
        }
    }

    func drawBlockHeaderBlueprint(in frame: CGRect, build: HashBuildCycle, attemptNonce: Int) {
        let ctx = blockHeaderBlueprintContext(for: build)
        NSColor(white: 0.06, alpha: 0.82).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8).fill()

        if ctx.pulseAll {
            let pulse = 0.45 + 0.35 * sin(animationPhase * 7)
            NSColor(calibratedRed: 1, green: 0.55, blue: 0.1, alpha: pulse).setStroke()
            let outline = NSBezierPath(roundedRect: frame.insetBy(dx: 2, dy: 2), xRadius: 7, yRadius: 7)
            outline.lineWidth = 1.6
            outline.stroke()
        }

        let inner = frame.insetBy(dx: 8, dy: 8)
        var x = inner.minX
        let cellH = inner.height
        let gap: CGFloat = 2
        let totalGap = gap * CGFloat(BlockHeaderField.allCases.count - 1)
        let innerW = inner.width - totalGap

        for field in BlockHeaderField.allCases {
            let w = innerW * field.weight
            let cell = CGRect(x: x, y: inner.minY, width: w, height: cellH)
            let state = ctx.states[field] ?? .pending
            let isActive = ctx.active == field
            let pulse = 0.55 + 0.45 * sin(animationPhase * 6 + CGFloat(BlockHeaderField.allCases.firstIndex(of: field) ?? 0))

            let fill: NSColor
            switch state {
            case .pending:
                fill = NSColor(white: 0.1, alpha: 0.55)
            case .settled:
                fill = NSColor(calibratedRed: 0.14, green: 0.42, blue: 0.62, alpha: 0.24)
            case .active:
                fill = field == .nonce
                    ? NSColor(calibratedRed: 1, green: 0.45 + 0.1 * pulse, blue: 0.05, alpha: 0.38)
                    : NSColor(calibratedRed: 1, green: 0.55, blue: 0.1, alpha: 0.28)
            case .done:
                fill = field == .nonce
                    ? NSColor(calibratedRed: 1, green: 0.45, blue: 0.05, alpha: 0.24)
                    : NSColor(calibratedRed: 0.2, green: 0.75, blue: 0.42, alpha: 0.28)
            }
            fill.setFill()
            NSBezierPath(roundedRect: cell, xRadius: 4, yRadius: 4).fill()

            let fieldFlash = build.headerFlashUntil[field] ?? 0
            if fieldFlash > 0 {
                drawLockFlashCell(
                    at: cell.midX, centerY: cell.midY, cellWidth: cell.width - 2, rowHeight: cell.height - 2
                )
            } else if isActive || (state == .active && field == .nonce && build.flash > 0) {
                NSColor(calibratedRed: 1, green: 0.62, blue: 0.12, alpha: 0.85).setStroke()
                let outline = NSBezierPath(roundedRect: cell, xRadius: 4, yRadius: 4)
                outline.lineWidth = 1.4
                outline.stroke()
            }

            let text = blockHeaderCellText(field: field, state: state, build: build, attemptNonce: attemptNonce)
            if state == .pending && fieldFlash <= 0 {
                drawEncryptedCharSlot(
                    at: cell.midX, centerY: cell.midY, slotIndex: field.rawValue, realChar: "0",
                    cellWidth: cell.width - 4, rowHeight: cell.height - 4, size: fontMicro - 1,
                    yours: field == .nonce, snapped: false, flashStrength: 0
                )
            } else {
                let textColor: NSColor
                if fieldFlash > 0 {
                    textColor = NSColor(calibratedWhite: 0.08, alpha: 1)
                } else {
                    switch state {
                    case .pending:
                        textColor = NSColor(white: 0.32, alpha: 1)
                    case .settled:
                        textColor = NSColor(white: 0.58, alpha: 1)
                    case .active:
                        textColor = field == .nonce
                            ? NSColor(calibratedRed: 1, green: 0.82, blue: 0.3, alpha: 1)
                            : NSColor(calibratedRed: 1, green: 0.78, blue: 0.35, alpha: 1)
                    case .done:
                        textColor = field == .nonce
                            ? NSColor(calibratedRed: 1, green: 0.82, blue: 0.3, alpha: 1)
                            : NSColor(white: 0.76, alpha: 1)
                    }
                }
                drawMonospaceTextCentered(
                    text, at: CGPoint(x: cell.midX, y: cell.midY), size: fontMicro,
                    weight: field == .nonce || isActive || fieldFlash > 0 ? .bold : .medium,
                    color: textColor
                )
            }
            x += w + gap
        }
    }

    func drawHashBuildPhaseDetail(in frame: CGRect, build: HashBuildCycle, attemptNonce: Int) {
        NSColor(white: 0.05, alpha: 0.58).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6).fill()
        drawMatrixCryptBackdrop(in: frame.insetBy(dx: 2, dy: 2), intensity: 0.26, seed: build.blockHeight)

        let input = build.ticketInput
        let digest = build.digestHex
        let bytes = build.firstFourHex
        let nonceText = NonceTicket.formattedNonce(attemptNonce)

        switch build.phase {
        case .nonceAssemble:
            let reveal = min(input.count, max(0, Int(floor(build.elapsed * 9))))
            let tailLen = min(8, max(0, input.count - reveal))
            let shown = String(input.prefix(reveal))
            let tail = (0..<tailLen).map { cryptStreamChar(seed: build.blockHeight + reveal + $0) }
            let cursor = reveal < input.count && Int(build.elapsed * 3) % 2 == 0 ? "▌" : ""
            drawFittedMonospace(
                shown + String(tail) + cursor, in: frame.insetBy(dx: 8, dy: 8),
                size: fontCaption, weight: .bold,
                color: NSColor(calibratedRed: 1, green: 0.82, blue: 0.35, alpha: 1)
            )
        case .nonceDigest:
            let reveal = min(digest.count, max(0, Int(floor(build.elapsed / Self.nonceDigestSeconds * CGFloat(digest.count)))))
            let windowStart = max(0, min(reveal - 14, digest.count - 24))
            let window = String(digest.dropFirst(windowStart).prefix(24))
            let windowReveal = max(0, reveal - windowStart)
            drawCryptHexRow(
                in: frame.insetBy(dx: 8, dy: 8), text: window, revealCount: windowReveal,
                size: fontCaption, yours: false, seed: build.blockHeight
            )
            let byteReveal = min(8, max(0, Int(floor(build.elapsed / Self.nonceDigestSeconds * 8))))
            drawCryptHexRow(
                in: CGRect(x: frame.maxX - 108, y: frame.maxY - 22, width: 96, height: 18),
                text: bytes, revealCount: byteReveal, size: fontMicro - 1, yours: true, seed: build.blockHeight + 99
            )
            drawText(
                "→ 0x", at: CGPoint(x: frame.maxX - 112, y: frame.maxY - 8), anchor: .topRight,
                size: fontMicro, weight: .semibold, color: NSColor(white: 0.45, alpha: 1)
            )
        case .nonceSnap:
            let snapProgress = min(1, build.elapsed / Self.nonceSnapSeconds)
            let revealDigits = build.flash > 0
                ? nonceText.count
                : min(nonceText.count, max(0, Int(floor(snapProgress * CGFloat(nonceText.count + 2) - 0.5))))
            if build.flash > 0 {
                drawLockFlashCell(at: frame.midX, centerY: frame.midY, cellWidth: frame.width * 0.55, rowHeight: frame.height - 12)
            }
            drawCryptHexRow(
                in: frame.insetBy(dx: 12, dy: 10), text: nonceText, revealCount: revealDigits,
                size: fontCaption + 1, yours: true, seed: build.blockHeight + 7
            )
            drawText(
                "#", at: CGPoint(x: frame.minX + 14, y: frame.midY), anchor: .topLeft,
                size: fontCaption, weight: .bold, color: NSColor(calibratedRed: 1, green: 0.72, blue: 0.2, alpha: 1)
            )
        case .merkleBuild:
            break
        case .headerPack:
            let packProgress = min(1, build.elapsed / Self.headerPackSeconds)
            let packedMaterial = build.hashHex + build.merkleRootHex + String(format: "%08x", attemptNonce) + "v4timebits"
            let reveal = min(packedMaterial.count, max(0, Int(floor(packProgress * CGFloat(packedMaterial.count)))))
            drawCryptHexRow(
                in: frame.insetBy(dx: 8, dy: 22), text: packedMaterial, revealCount: reveal,
                size: fontMicro, yours: false, seed: build.blockHeight + 31
            )
            let bar = CGRect(x: frame.minX + 12, y: frame.midY - 4, width: frame.width - 24, height: 8)
            NSColor(white: 0.12, alpha: 1).setFill()
            NSBezierPath(roundedRect: bar, xRadius: 3, yRadius: 3).fill()
            let fill = CGRect(x: bar.minX, y: bar.minY, width: bar.width * packProgress, height: bar.height)
            NSColor(calibratedRed: 0.2, green: 0.78, blue: 0.45, alpha: 0.9).setFill()
            NSBezierPath(roundedRect: fill, xRadius: 3, yRadius: 3).fill()
            drawText(
                "\(Int(packProgress * 100))% packed", at: CGPoint(x: frame.midX, y: frame.minY + 10), anchor: .topCenter,
                size: fontMicro, weight: .semibold, color: NSColor(white: 0.55, alpha: 1)
            )
        case .sha256First:
            drawSha256LineProgress(
                in: frame.insetBy(dx: 8, dy: 10),
                progress: min(1, build.elapsed / Self.sha256RoundSeconds),
                hashHex: build.hashHex
            )
        case .sha256Second:
            drawSha256LineProgress(
                in: frame.insetBy(dx: 8, dy: 10),
                progress: min(1, build.elapsed / Self.sha256RoundSeconds),
                hashHex: build.hashHex
            )
        case .hashReveal:
            drawAnimatedHashReveal(in: frame.insetBy(dx: 6, dy: 6), build: build, inset: true)
        case .hold:
            drawHashBuildSummaryChip(in: frame.insetBy(dx: 6, dy: 6), build: build, attemptNonce: attemptNonce, compact: true)
        }
    }

    func hashBuildHeaderColumnHeight(completedCount: Int) -> CGFloat {
        let rowsH = completedCount > 0
            ? CGFloat(completedCount) * (Self.hashBuildCompletedRowH + 3) - 3
            : Self.hashBuildCompletedPlaceholderH
        return 10
            + Self.hashBuildColumnHeaderH + 6
            + Self.hashBuildBlueprintH + 10
            + Self.hashBuildCompletedHeaderH + 4
            + rowsH + 10
    }

    func drawHashBuildHeaderColumn(
        in frame: CGRect,
        build: HashBuildCycle,
        attemptNonce: Int
    ) {
        NSColor(white: 0.035, alpha: 0.92).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8).fill()
        NSColor(calibratedRed: 0.2, green: 0.55, blue: 0.9, alpha: 0.22).setStroke()
        let border = NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8)
        border.lineWidth = 1
        border.stroke()

        let pad: CGFloat = 10
        let innerW = frame.width - pad * 2
        var y = frame.minY + 10

        drawText(
            "BLOCK HEADER", at: CGPoint(x: frame.minX + pad, y: y), anchor: .topLeft,
            size: fontMicro, weight: .bold, color: NSColor(white: 0.58, alpha: 1)
        )
        drawText(
            "80 bytes · 6 fields", at: CGPoint(x: frame.maxX - pad, y: y), anchor: .topRight,
            size: fontMicro, weight: .regular, color: NSColor(white: 0.38, alpha: 1)
        )
        y += Self.hashBuildColumnHeaderH + 6

        let blueprint = CGRect(x: frame.minX + pad, y: y, width: innerW, height: Self.hashBuildBlueprintH)
        drawBlockHeaderBlueprint(in: blueprint, build: build, attemptNonce: attemptNonce)
        y = blueprint.maxY + 10

        drawText(
            "COMPLETED", at: CGPoint(x: frame.minX + pad, y: y), anchor: .topLeft,
            size: fontMicro, weight: .bold, color: NSColor(calibratedRed: 0.35, green: 0.9, blue: 0.55, alpha: 0.75)
        )
        y += Self.hashBuildCompletedHeaderH + 4

        let completed = hashBuildCompletedSections(for: build)
        if completed.isEmpty {
            drawText(
                "— waiting for first field —", at: CGPoint(x: frame.minX + pad, y: y + 2), anchor: .topLeft,
                size: fontMicro, weight: .regular, color: NSColor(white: 0.32, alpha: 1)
            )
        } else {
            let completedH = CGFloat(completed.count) * (Self.hashBuildCompletedRowH + 3) - 3
            drawHashBuildCompletedSections(
                in: CGRect(x: frame.minX + pad, y: y, width: innerW, height: completedH),
                build: build, attemptNonce: attemptNonce, sections: completed
            )
        }
    }

    func drawHashBuildVertical(in frame: CGRect, build: HashBuildCycle, attemptNonce: Int) {
        NSColor(white: 0.04, alpha: 0.88).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 10, yRadius: 10).fill()
        drawMatrixCryptBackdrop(in: frame.insetBy(dx: 6, dy: 6), intensity: 0.12, seed: build.blockHeight + 500)
        NSColor(calibratedRed: 1, green: 0.5, blue: 0.1, alpha: 0.22).setStroke()
        let border = NSBezierPath(roundedRect: frame, xRadius: 10, yRadius: 10)
        border.lineWidth = 1.2
        border.stroke()

        let padX = frame.minX + 10
        let contentW = frame.width - 20
        var y = frame.minY + 10
        let isMerkle = build.phase == .merkleBuild

        drawText(
            "Building the block header", at: CGPoint(x: frame.midX, y: y), anchor: .topCenter,
            size: fontCaption, weight: .bold, color: NSColor(white: 0.72, alpha: 1)
        )
        y += 20

        let completedCount = hashBuildCompletedSections(for: build).count
        let columnH = hashBuildHeaderColumnHeight(completedCount: completedCount)
        let column = CGRect(x: padX, y: y, width: contentW, height: columnH)
        drawHashBuildHeaderColumn(in: column, build: build, attemptNonce: attemptNonce)
        y = column.maxY + 12

        drawText(
            "CURRENT STEP", at: CGPoint(x: padX, y: y), anchor: .topLeft,
            size: fontMicro, weight: .bold, color: NSColor(calibratedRed: 1, green: 0.62, blue: 0.15, alpha: 0.85)
        )
        y += Self.hashBuildCurrentStepHeaderH + 4

        let status = hashBuildStatus(for: build, attemptNonce: attemptNonce)
        drawText(
            status.title, at: CGPoint(x: frame.midX, y: y), anchor: .topCenter,
            size: fontCaption, weight: .bold, color: NSColor(calibratedRed: 1, green: 0.68, blue: 0.22, alpha: 1)
        )
        y += 16
        if isMerkle {
            drawText(
                status.detail, at: CGPoint(x: frame.midX, y: y), anchor: .topCenter,
                size: fontMicro, weight: .regular, color: NSColor(white: 0.52, alpha: 1)
            )
            y += 14
        }

        if isMerkle {
            let merkleH = frame.maxY - y - 10
            let merklePanel = CGRect(x: padX, y: y, width: contentW, height: merkleH)
            NSColor(white: 0.03, alpha: 0.9).setFill()
            NSBezierPath(roundedRect: merklePanel, xRadius: 8, yRadius: 8).fill()
            NSColor(calibratedRed: 0.2, green: 0.78, blue: 0.45, alpha: 0.28).setStroke()
            let merkleBorder = NSBezierPath(roundedRect: merklePanel, xRadius: 8, yRadius: 8)
            merkleBorder.lineWidth = 1.1
            merkleBorder.stroke()
            drawText(
                "Merkle tree", at: CGPoint(x: merklePanel.minX + 10, y: merklePanel.minY + 6), anchor: .topLeft,
                size: fontMicro, weight: .bold, color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.68, alpha: 0.85)
            )
            drawMatrixCryptBackdrop(in: merklePanel.insetBy(dx: 4, dy: 18), intensity: 0.22, seed: build.blockHeight + 900)
            let merkleContent = CGRect(
                x: merklePanel.minX + 4, y: merklePanel.minY + 18,
                width: merklePanel.width - 8, height: merklePanel.height - 22
            )
            drawMerkleBuildAnimation(in: merkleContent, build: build)
        } else {
            let detailH = min(Self.hashBuildCompactDetailH, frame.maxY - y - 10)
            let detail = CGRect(x: padX, y: y, width: contentW, height: detailH)
            drawHashBuildPhaseDetail(in: detail, build: build, attemptNonce: attemptNonce)
        }
    }

    func drawSha256LineProgress(in body: CGRect, progress: CGFloat, hashHex: String) {
        let bar = CGRect(x: body.minX, y: body.minY + 2, width: body.width, height: 7)
        NSColor(white: 0.12, alpha: 1).setFill()
        NSBezierPath(roundedRect: bar, xRadius: 3, yRadius: 3).fill()
        let fill = CGRect(x: bar.minX, y: bar.minY, width: bar.width * progress, height: bar.height)
        NSColor(calibratedRed: 1, green: 0.5, blue: 0.12, alpha: 0.9).setFill()
        NSBezierPath(roundedRect: fill, xRadius: 3, yRadius: 3).fill()
        drawText("\(Int(progress * 100))%", at: CGPoint(x: body.maxX, y: body.minY + 1), anchor: .topRight,
                 size: fontMicro, weight: .semibold, color: NSColor(white: 0.45, alpha: 1))
        let reveal = min(hashHex.count, max(0, Int(floor(progress * CGFloat(hashHex.count)))))
        let windowStart = max(0, min(reveal - 12, hashHex.count - 24))
        let window = String(hashHex.dropFirst(windowStart).prefix(24))
        let windowReveal = max(0, reveal - windowStart)
        drawCryptHexRow(
            in: CGRect(x: body.minX, y: body.minY + 12, width: body.width, height: body.height - 12),
            text: window, revealCount: windowReveal, size: fontMicro, yours: false, seed: Int(progress * 1000)
        )
    }

    func drawReplayButton(in frame: CGRect, hovered: Bool, label: String = "↻ Replay animation") {
        let fill = hovered
            ? NSColor(calibratedRed: 1, green: 0.55, blue: 0.12, alpha: 0.32)
            : NSColor(white: 0.1, alpha: 0.82)
        fill.setFill()
        NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6).fill()
        NSColor(calibratedRed: 1, green: 0.55, blue: 0.12, alpha: hovered ? 0.9 : 0.55).setStroke()
        let border = NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6)
        border.lineWidth = 1.2
        border.stroke()
        drawText(label, at: CGPoint(x: frame.midX, y: frame.midY), anchor: .topCenter,
                 size: fontMicro, weight: .semibold,
                 color: hovered
                    ? NSColor(calibratedRed: 1, green: 0.88, blue: 0.35, alpha: 1)
                    : NSColor(white: 0.78, alpha: 1))
    }

    func drawHashBuildNonceStep(
        in frame: CGRect,
        build: HashBuildCycle,
        attemptNonce: Int,
        compact: Bool = false
    ) {
        NSColor(white: 0.06, alpha: compact ? 0.55 : 0.72).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6).fill()
        NSColor(calibratedRed: 1, green: 0.55, blue: 0.12, alpha: 0.28).setStroke()
        let border = NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6)
        border.lineWidth = 1
        border.stroke()

        let pad: CGFloat = compact ? 6 : 8
        let stepW = (frame.width - pad * 2 - (compact ? 24 : 36)) / 3
        let y = frame.midY
        let size: CGFloat = compact ? fontMicro : fontCaption
        let stepCenters: [CGFloat] = (0..<3).map { frame.minX + pad + stepW * (CGFloat($0) + 0.5) }

        func drawArrow(between left: CGFloat, and right: CGFloat) {
            drawText("→", at: CGPoint(x: (left + right) / 2, y: y), anchor: .topCenter,
                     size: size, weight: .bold, color: NSColor(white: 0.45, alpha: 1))
        }

        let input = build.ticketInput
        let digest = build.digestHex
        let bytes = build.firstFourHex
        let nonceText = NonceTicket.formattedNonce(attemptNonce)

        switch build.phase {
        case .nonceAssemble:
            let reveal = min(input.count, max(0, Int(floor(build.elapsed * 14))))
            let shown = String(input.prefix(reveal))
            let cursor = reveal < input.count && Int(build.elapsed * 4) % 2 == 0 ? "▌" : ""
            drawMonospaceTextCentered(
                shown + cursor, at: CGPoint(x: stepCenters[0], y: y), size: size, weight: .bold,
                color: NSColor(calibratedRed: 1, green: 0.82, blue: 0.35, alpha: 1)
            )
            drawText("SHA-256", at: CGPoint(x: stepCenters[1], y: y), anchor: .topCenter,
                     size: size, weight: .semibold, color: NSColor(white: 0.35, alpha: 1))
            drawText("nonce", at: CGPoint(x: stepCenters[2], y: y), anchor: .topCenter,
                     size: size, weight: .semibold, color: NSColor(white: 0.35, alpha: 1))
        case .nonceDigest:
            drawMonospaceTextCentered(
                NonceTicket.shortSeed(input, maxLen: compact ? 10 : 14),
                at: CGPoint(x: stepCenters[0], y: y), size: size, weight: .bold,
                color: NSColor(calibratedRed: 0.55, green: 1, blue: 0.65, alpha: 1)
            )
            let scroll = Int(floor(animationPhase * 18)) % max(1, digest.count - 8)
            let window = String(digest.dropFirst(scroll).prefix(compact ? 10 : 14))
            drawMonospaceTextCentered(
                window, at: CGPoint(x: stepCenters[1], y: y), size: size, weight: .bold,
                color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 1)
            )
            drawMonospaceTextCentered(
                "0x\(bytes)", at: CGPoint(x: stepCenters[2], y: y), size: size, weight: .bold,
                color: NSColor(white: 0.4, alpha: 1)
            )
        case .nonceSnap:
            drawMonospaceTextCentered(
                NonceTicket.shortSeed(input, maxLen: compact ? 10 : 14),
                at: CGPoint(x: stepCenters[0], y: y), size: size, weight: .bold,
                color: NSColor(calibratedRed: 0.55, green: 1, blue: 0.65, alpha: 1)
            )
            drawMonospaceTextCentered(
                "0x\(bytes)", at: CGPoint(x: stepCenters[1], y: y), size: size, weight: .bold,
                color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 1)
            )
            if build.flash > 0 {
                drawLockFlashCell(at: stepCenters[2], centerY: y, cellWidth: stepW - 4, rowHeight: frame.height - 6)
            }
            drawMonospaceTextCentered(
                "#\(nonceText)", at: CGPoint(x: stepCenters[2], y: y), size: size + (compact ? 0 : 1), weight: .bold,
                color: build.flash > 0
                    ? NSColor(calibratedWhite: 0.08, alpha: 1)
                    : NSColor(calibratedRed: 1, green: 0.82, blue: 0.3, alpha: 1)
            )
        default:
            drawHashBuildSummaryChip(in: frame, build: build, attemptNonce: attemptNonce, compact: compact)
            return
        }

        if !compact {
            drawArrow(between: stepCenters[0] + stepW * 0.34, and: stepCenters[1] - stepW * 0.34)
            drawArrow(between: stepCenters[1] + stepW * 0.34, and: stepCenters[2] - stepW * 0.34)
        }
    }

    func drawHashBuildSummaryChip(
        in frame: CGRect,
        build: HashBuildCycle,
        attemptNonce: Int,
        compact: Bool = false
    ) {
        NSColor(white: 0.06, alpha: 0.72).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6).fill()
        let summary = NonceTicket.ticketSummary(
            machineSeed: build.machineSeed, blockHeight: build.blockHeight, nonce: attemptNonce
        )
        drawMonospaceTextCentered(
            summary, at: CGPoint(x: frame.midX, y: frame.midY), size: compact ? fontMicro : fontCaption,
            weight: .semibold, color: NSColor(calibratedRed: 1, green: 0.78, blue: 0.28, alpha: 1)
        )
    }

    func drawHashBuildWaiting(in frame: CGRect, label: String, detail: String) {
        NSColor(white: 0.05, alpha: 0.75).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8).fill()
        NSColor(white: 0.14, alpha: 0.8).setStroke()
        let border = NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8)
        border.lineWidth = 1
        border.stroke()
        drawText(label, at: CGPoint(x: frame.midX, y: frame.midY - 4), anchor: .topCenter,
                 size: fontCaption, weight: .semibold, color: NSColor(white: 0.62, alpha: 1))
        drawText(detail, at: CGPoint(x: frame.midX, y: frame.midY + 14), anchor: .topCenter,
                 size: fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
    }

    func merkleTxHashSeed(blockHeight: Int, index: Int, rootHex: String) -> UInt32 {
        let rootPrefix = String(rootHex.prefix(8))
        let rootChunk = UInt32(rootPrefix, radix: 16) ?? UInt32(truncatingIfNeeded: blockHeight)
        var x = UInt32(truncatingIfNeeded: blockHeight)
        x = x &+ rootChunk
        x = x &+ UInt32(truncatingIfNeeded: index &* 2_654_435_761)
        x ^= x >> 16
        x &*= 0x7feb352d
        x ^= x >> 15
        x &*= 0x846ca68b
        x ^= x >> 16
        return x
    }

    func merkleParticleLabel(blockHeight: Int, index: Int, rootHex: String, mergeLevel: Int) -> String {
        if index == 0 && mergeLevel == 0 { return "cb" }
        let seed = merkleTxHashSeed(blockHeight: blockHeight, index: index, rootHex: rootHex)
        let hex = String(format: "%06x", seed)
        switch mergeLevel {
        case 0: return String(hex.prefix(6))
        case 1: return String(hex.prefix(4))
        case 2: return String(hex.prefix(3))
        default: return String(hex.prefix(2))
        }
    }

    func merkleLeafX(frame: CGRect, index: Int, count: Int) -> CGFloat {
        let slot = count > 1 ? CGFloat(index) / CGFloat(count - 1) : 0.5
        return frame.minX + 8 + slot * (frame.width - 16)
    }

    func drawMerkleTreeNode(
        at center: CGPoint,
        label: String,
        alpha: CGFloat,
        slotIndex: Int,
        accent: Bool = false,
        flash: Bool = false
    ) {
        let w: CGFloat = label.count > 4 ? 40 : 30
        let h: CGFloat = 14
        let cell = CGRect(x: center.x - w / 2, y: center.y - h / 2, width: w, height: h)
        if flash {
            drawLockFlashCell(at: center.x, centerY: center.y, cellWidth: w, rowHeight: h)
        } else {
            let fill = accent
                ? NSColor(calibratedRed: 0.15, green: 0.72, blue: 0.42, alpha: 0.3 * alpha)
                : NSColor(calibratedRed: 0.14, green: 0.42, blue: 0.72, alpha: 0.22 * alpha)
            fill.setFill()
            NSBezierPath(roundedRect: cell, xRadius: 3, yRadius: 3).fill()
        }
        let scramble = alpha < 0.92 && !flash
        if scramble {
            let chars = Array(label)
            let spacing = min(9, (w - 4) / CGFloat(max(chars.count, 1)))
            let startX = center.x - spacing * CGFloat(max(chars.count - 1, 0)) / 2
            for (i, ch) in chars.enumerated() {
                drawEncryptedCharSlot(
                    at: startX + CGFloat(i) * spacing, centerY: center.y,
                    slotIndex: slotIndex + i, realChar: ch,
                    cellWidth: spacing + 2, rowHeight: h, size: fontMicro - 2,
                    yours: false, snapped: alpha > 0.75, flashStrength: 0
                )
            }
            return
        }
        drawMonospaceTextCentered(
            label, at: center, size: fontMicro, weight: .semibold,
            color: flash
                ? NSColor(calibratedWhite: 0.08, alpha: 1)
                : (accent
                    ? NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: alpha)
                    : NSColor(calibratedRed: 0.55, green: 0.92, blue: 1, alpha: alpha))
        )
    }

    func drawMerkleBuildAnimation(in frame: CGRect, build: HashBuildCycle) {
        let progress = min(1, build.elapsed / Self.merkleBuildSeconds)
        let rootHex = build.merkleRootHex.isEmpty
            ? String(format: "%08x", build.blockHeight) + String(repeating: "0", count: 56)
            : build.merkleRootHex
        let txCount = build.txCount
        let leafCount = min(16, max(8, txCount / 80 + 8))
        let treeLevels = Int(ceil(log2(Double(leafCount)))) + 1
        let rowGap = min(50, max(32, (frame.height - 24) / CGFloat(treeLevels + 1)))
        let treeTop = frame.minY + 10
        let rowY: (Int) -> CGFloat = { treeTop + CGFloat($0) * rowGap }

        drawText(
            "\(txCount) transaction hashes", at: CGPoint(x: frame.midX, y: frame.minY + 2), anchor: .topCenter,
            size: fontMicro, weight: .semibold, color: NSColor(white: 0.5, alpha: 1)
        )

        func levelProgress(_ level: Int) -> CGFloat {
            let start = 0.08 + CGFloat(level) * 0.14
            return min(1, max(0, (progress - start) / 0.14))
        }

        // Vertical tree links (draw under nodes)
        for level in 1..<treeLevels {
            let lp = levelProgress(level)
            guard lp > 0 else { continue }
            let childCount = max(1, leafCount >> (level - 1))
            let parentCount = max(1, leafCount >> level)
            for parent in 0..<parentCount {
                let leftChild = parent * 2
                let rightChild = min(leftChild + 1, childCount - 1)
                let px = merkleLeafX(frame: frame, index: parent, count: parentCount)
                let py = rowY(level)
                for child in [leftChild, rightChild] where child < childCount {
                    let cx = merkleLeafX(frame: frame, index: child, count: childCount)
                    let cy = rowY(level - 1)
                    let mix = CGPoint(x: cx + (px - cx) * lp, y: cy + (py - cy) * lp)
                    let path = NSBezierPath()
                    path.move(to: CGPoint(x: cx, y: cy + 7))
                    path.line(to: mix)
                    NSColor(calibratedRed: 0.3, green: 0.82, blue: 0.55, alpha: 0.18 * lp).setStroke()
                    path.lineWidth = 1
                    path.stroke()
                }
            }
        }

        // Level 0 — transaction leaves across the top
        let leafReveal = levelProgress(0)
        for i in 0..<leafCount {
            let stagger = CGFloat(i) * 0.025
            let reveal = min(1, max(0, (leafReveal - stagger) / 0.7))
            guard reveal > 0 else { continue }
            let isOverflow = i == leafCount - 1 && txCount > leafCount
            let label: String
            if i == 0 {
                label = "cb"
            } else if isOverflow {
                label = "+\(txCount - leafCount + 1)"
            } else {
                label = merkleParticleLabel(
                    blockHeight: build.blockHeight, index: i, rootHex: rootHex, mergeLevel: 0
                )
            }
            let wobble = sin(animationPhase * 2.5 + CGFloat(i)) * 2 * (1 - reveal)
            let point = CGPoint(x: merkleLeafX(frame: frame, index: i, count: leafCount) + wobble, y: rowY(0))
            drawMerkleTreeNode(at: point, label: label, alpha: reveal, slotIndex: i)
        }

        // Intermediate merge levels
        for level in 1..<treeLevels {
            let lp = levelProgress(level)
            guard lp > 0 else { continue }
            let nodeCount = max(1, leafCount >> level)
            let flashLevel = lp > 0.88 && lp < 1.0
            for i in 0..<nodeCount {
                let label = merkleParticleLabel(
                    blockHeight: build.blockHeight, index: i + level * 97, rootHex: rootHex,
                    mergeLevel: min(3, level)
                )
                let point = CGPoint(x: merkleLeafX(frame: frame, index: i, count: nodeCount), y: rowY(level))
                drawMerkleTreeNode(
                    at: point, label: label, alpha: lp, slotIndex: i + level * 31, flash: flashLevel
                )
            }
        }

        // Root row at bottom of tree
        let rootLevel = treeLevels
        let rootProgress = min(1, max(0, (progress - 0.72) / 0.28))
        if rootProgress > 0 {
            let rootFlash = rootProgress > 0.92 && progress < 0.99
            let vesselW = min(frame.width - 12, 100 + rootProgress * 100)
            let vessel = CGRect(x: frame.midX - vesselW / 2, y: rowY(rootLevel) - 8, width: vesselW, height: 18)
            if rootFlash {
                drawLockFlashCell(at: vessel.midX, centerY: vessel.midY, cellWidth: vessel.width, rowHeight: vessel.height)
            } else {
                NSColor(calibratedRed: 0.15, green: 0.72, blue: 0.42, alpha: 0.2 + 0.25 * rootProgress).setFill()
                NSBezierPath(roundedRect: vessel, xRadius: 5, yRadius: 5).fill()
            }
            let revealCount = min(rootHex.count, max(8, Int(floor(rootProgress * 22))))
            if rootFlash {
                drawFittedMonospace(
                    String(rootHex.prefix(revealCount)), in: vessel.insetBy(dx: 4, dy: 2),
                    size: fontMicro, weight: .bold, color: NSColor(calibratedWhite: 0.08, alpha: 1)
                )
            } else {
                drawCryptHexRow(
                    in: vessel.insetBy(dx: 4, dy: 2), text: rootHex, revealCount: revealCount,
                    size: fontMicro, yours: false, seed: build.blockHeight + 777
                )
            }
        }

        let caption: String
        if progress < 0.22 {
            caption = "each tx → double SHA-256"
        } else if progress < 0.5 {
            caption = "pair hashes → merge down a level"
        } else if progress < 0.75 {
            caption = "tree narrows row by row"
        } else {
            caption = "\(txCount) → 1 merkle root"
        }
        drawText(
            caption, at: CGPoint(x: frame.midX, y: frame.maxY - 2), anchor: .topCenter,
            size: fontMicro,
            weight: progress >= 0.75 ? .semibold : .regular,
            color: progress >= 0.75
                ? NSColor(calibratedRed: 0.45, green: 1, blue: 0.68, alpha: 0.9)
                : NSColor(white: 0.42, alpha: 1)
        )
    }

    func drawAnimatedBlockHeader(
        in frame: CGRect,
        nonce: Int,
        packProgress: CGFloat,
        hashPrefix: String,
        merklePrefix: String? = nil,
        embedded: Bool = false
    ) {
        if !embedded {
            NSColor(white: 0.06, alpha: 0.72).setFill()
            NSBezierPath(roundedRect: frame, xRadius: 6, yRadius: 6).fill()
        }
        let labels = ["ver", "prev", "merkle", "time", "bits", "NONCE"]
        let weights: [CGFloat] = [0.08, 0.24, 0.24, 0.14, 0.14, 0.16]
        let filled = Int(floor(packProgress * CGFloat(labels.count)))
        var x = frame.minX + 6
        let innerW = frame.width - 12
        let h = frame.height - 10
        let top = frame.minY + 5
        for (index, (label, weight)) in zip(labels.indices, zip(labels, weights)) {
            let w = innerW * weight - 2
            let cell = CGRect(x: x, y: top, width: w, height: h)
            let isNonce = label == "NONCE"
            let lit = index < filled || (isNonce && packProgress >= 0.92)
            let pulse = 0.55 + 0.45 * sin(animationPhase * 6 + CGFloat(index))
            let fill: NSColor
            if lit {
                fill = isNonce
                    ? NSColor(calibratedRed: 1, green: 0.45 + 0.1 * pulse, blue: 0.05, alpha: 0.38)
                    : NSColor(calibratedRed: 0.2, green: 0.75, blue: 0.42, alpha: 0.28)
            } else {
                fill = NSColor(white: 0.1, alpha: 0.55)
            }
            fill.setFill()
            NSBezierPath(roundedRect: cell, xRadius: 3, yRadius: 3).fill()
            if lit && isNonce {
                NSColor(calibratedRed: 1, green: 0.55, blue: 0.1, alpha: 0.75).setStroke()
                let outline = NSBezierPath(roundedRect: cell, xRadius: 3, yRadius: 3)
                outline.lineWidth = 1.2
                outline.stroke()
            }
            let text: String
            if isNonce {
                text = "#\(NonceTicket.formattedNonce(nonce))"
            } else if label == "prev" && lit {
                text = String(hashPrefix.prefix(4)) + "…"
            } else if label == "merkle" && lit {
                text = merklePrefix.map { String($0.prefix(4)) + "…" } ?? label
            } else {
                text = lit ? label : "··"
            }
            drawMonospaceTextCentered(
                text, at: CGPoint(x: cell.midX, y: cell.midY), size: fontMicro,
                weight: isNonce ? .bold : .medium,
                color: lit
                    ? (isNonce
                        ? NSColor(calibratedRed: 1, green: 0.82, blue: 0.3, alpha: 1)
                        : NSColor(white: 0.72, alpha: 1))
                    : NSColor(white: 0.32, alpha: 1)
            )
            x += w + 2
        }
    }

    func drawSha256Round(in frame: CGRect, round: Int, elapsed: CGFloat, hashHex: String) {
        NSColor(white: 0.05, alpha: 0.8).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8).fill()
        let title = round == 1 ? "Step 6: SHA-256 (round 1)" : "Step 7: SHA-256 (round 2)"
        drawText(title, at: CGPoint(x: frame.midX, y: frame.minY + 8), anchor: .topCenter,
                 size: fontCaption, weight: .bold, color: NSColor(calibratedRed: 1, green: 0.62, blue: 0.2, alpha: 1))

        let bar = CGRect(x: frame.minX + 24, y: frame.midY - 6, width: frame.width - 48, height: 12)
        NSColor(white: 0.12, alpha: 1).setFill()
        NSBezierPath(roundedRect: bar, xRadius: 4, yRadius: 4).fill()
        let progress = min(1, elapsed / Self.sha256RoundSeconds)
        let fill = CGRect(x: bar.minX, y: bar.minY, width: bar.width * progress, height: bar.height)
        NSColor(calibratedRed: 1, green: 0.5 + 0.2 * sin(animationPhase * 8), blue: 0.12, alpha: 0.9).setFill()
        NSBezierPath(roundedRect: fill, xRadius: 4, yRadius: 4).fill()

        let scroll = Int(floor(animationPhase * 22 + elapsed * 10)) % max(1, hashHex.count - 10)
        let window = String(hashHex.dropFirst(scroll).prefix(18))
        drawMonospaceTextCentered(
            window, at: CGPoint(x: frame.midX, y: frame.midY + 18), size: fontCaption, weight: .bold,
            color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 0.85)
        )
        if round == 2 {
            drawText("→ your hash", at: CGPoint(x: frame.midX, y: frame.maxY - 8), anchor: .topCenter,
                     size: fontMicro, weight: .semibold, color: NSColor(white: 0.5, alpha: 1))
        }
    }

    func drawAnimatedHashReveal(in frame: CGRect, build: HashBuildCycle, inset: Bool = false) {
        if !inset {
            NSColor(white: 0.05, alpha: 0.8).setFill()
            NSBezierPath(roundedRect: frame, xRadius: 8, yRadius: 8).fill()
            drawText("Step 8: your hash", at: CGPoint(x: frame.midX, y: frame.minY + 6), anchor: .topCenter,
                     size: fontCaption, weight: .bold, color: NSColor(calibratedRed: 1, green: 0.62, blue: 0.2, alpha: 1))
        }

        let chars = build.hashChars
        guard !chars.isEmpty else { return }
        let spacing = frame.width / CGFloat(chars.count)
        let centerY = frame.midY
        let rowHeight = max(14, frame.height - 4)
        for (i, ch) in chars.enumerated() {
            let x = frame.minX + spacing * (CGFloat(i) + 0.5)
            let resolved = build.hashResolved.contains(i)
            let flash = build.hashFlashUntil[i] ?? 0
            if resolved {
                if flash > 0 {
                    drawLockFlashCell(at: x, centerY: centerY, cellWidth: spacing, rowHeight: rowHeight)
                    drawMonospaceTextCentered(
                        String(ch), at: CGPoint(x: x, y: centerY), size: 16, weight: .bold,
                        color: NSColor(calibratedWhite: 0.08, alpha: 1)
                    )
                } else {
                    drawMonospaceTextCentered(
                        String(ch), at: CGPoint(x: x, y: centerY), size: 16, weight: .bold,
                        color: NSColor(calibratedRed: 1, green: 0.72, blue: 0.2, alpha: 1)
                    )
                }
            } else {
                drawEncryptedCharSlot(
                    at: x, centerY: centerY, slotIndex: i, realChar: ch,
                    cellWidth: spacing, rowHeight: rowHeight, size: 15, yours: true, snapped: false, flashStrength: 0
                )
            }
        }
    }

    func drawNonceTicketChip(
        in frame: CGRect,
        machineSeed: String,
        blockHeight: Int,
        nonce: Int,
        size: CGFloat
    ) {
        let summary = NonceTicket.ticketSummary(machineSeed: machineSeed, blockHeight: blockHeight, nonce: nonce)
        NSColor(white: 0.07, alpha: 0.8).setFill()
        NSBezierPath(roundedRect: frame, xRadius: 5, yRadius: 5).fill()
        drawMonospaceTextCentered(
            summary, at: CGPoint(x: frame.midX, y: frame.midY), size: size, weight: .semibold,
            color: NSColor(calibratedRed: 1, green: 0.78, blue: 0.28, alpha: 1)
        )
    }

    func drawBlockHeaderDiagram(in frame: CGRect, nonce: Int, pulse: CGFloat) {
        let labels = ["ver", "prev", "merkle", "time", "bits", "NONCE"]
        let weights: [CGFloat] = [0.08, 0.24, 0.24, 0.14, 0.14, 0.16]
        var x = frame.minX
        let h = frame.height
        for (label, weight) in zip(labels, weights) {
            let w = frame.width * weight - 2
            let cell = CGRect(x: x, y: frame.minY, width: w, height: h)
            let isNonce = label == "NONCE"
            let fill = isNonce
                ? NSColor(calibratedRed: 1, green: 0.45 + 0.12 * pulse, blue: 0.05, alpha: 0.28)
                : NSColor(white: 0.1, alpha: 0.65)
            fill.setFill()
            NSBezierPath(roundedRect: cell, xRadius: 3, yRadius: 3).fill()
            if isNonce {
                NSColor(calibratedRed: 1, green: 0.55, blue: 0.1, alpha: 0.7).setStroke()
                let outline = NSBezierPath(roundedRect: cell, xRadius: 3, yRadius: 3)
                outline.lineWidth = 1.2
                outline.stroke()
            }
            let text = isNonce ? "#\(NonceTicket.formattedNonce(nonce))" : label
            drawMonospaceTextCentered(
                text, at: CGPoint(x: cell.midX, y: cell.midY), size: fontMicro, weight: isNonce ? .bold : .medium,
                color: isNonce
                    ? NSColor(calibratedRed: 1, green: 0.82, blue: 0.3, alpha: 1)
                    : NSColor(white: 0.5, alpha: 1)
            )
            x += w + 2
        }
        drawText("double SHA-256 → your hash", at: CGPoint(x: frame.midX, y: frame.maxY + 4), anchor: .topCenter,
                 size: fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
    }

}
