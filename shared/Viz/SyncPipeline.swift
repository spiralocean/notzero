import AppKit

// Sync pipeline visualization (live-mode node catch-up), split out of LotteryCanvasView.
extension LotteryCanvasView {
    // MARK: - Sync panel

    private func syncPipelinePresentation(
        mode: String?,
        node: SaverNodeStatus?
    ) -> (step: SyncPipelineStep, stepProgress: CGFloat, overall: CGFloat, detail: String, demo: Bool) {
        guard let node, node.reachable != false else {
            let steps = SyncPipelineStep.allCases
            let idx = Int(floor(animationPhase * 1.4)) % steps.count
            let step = steps[idx]
            let local = (animationPhase * 1.4).truncatingRemainder(dividingBy: 1)
            return (
                step, local,
                CGFloat(idx) / CGFloat(max(steps.count - 1, 1)),
                mode == "live" ? "Waiting for Bitcoin Core…" : "Practice mode — no node required",
                true
            )
        }
        let overall = Self.syncProgress(node: node)
        if node.ready == true {
            return (.ready, 1, 1, node.pruned == true ? "Pruned · ~2 GB kept on disk" : "Fully synced", false)
        }
        let pct = CGFloat(node.verificationprogress ?? 0)
        if node.initialblockdownload == true {
            if pct < 0.1 {
                return (.headers, pct / 0.1, overall, "Downloading headers…", false)
            }
            if pct < 0.82 {
                return (.download, (pct - 0.1) / 0.72, overall, "Initial block download…", false)
            }
            if node.pruned == true {
                return (.prune, (pct - 0.82) / 0.18, overall, "Pruning old block files…", false)
            }
            return (.verify, (pct - 0.82) / 0.18, overall, "Verifying chain…", false)
        }
        if node.pruned == true {
            return (.prune, pct, overall, "Pruning & verifying…", false)
        }
        return (.verify, pct, overall, "Verifying chain state…", false)
    }

    func advanceSyncReplay(_ cycle: inout SyncReplayCycle, dt: CGFloat) {
        if cycle.wireFlash > 0 {
            cycle.wireFlash = max(0, cycle.wireFlash - dt)
        }
        cycle.elapsed += dt
        switch cycle.phase {
        case .wire:
            if cycle.elapsed >= Self.syncReplayWireSeconds * 0.88, cycle.wireFlash <= 0 {
                cycle.wireFlash = 0.45
            }
            if cycle.elapsed >= Self.syncReplayWireSeconds {
                cycle.elapsed = 0
                cycle.phase = .prune
            }
        case .prune:
            if cycle.elapsed >= Self.syncReplayPruneSeconds {
                cycle.elapsed = 0
                cycle.phase = .hold
            }
        case .hold:
            break
        }
    }

    private func syncVizHeight(for step: SyncPipelineStep, replay: SyncReplayCycle?) -> CGFloat {
        if replay != nil { return 172 }
        return step == .download ? 168 : 56
    }

    private func syncEducationCaption(step: SyncPipelineStep, replay: SyncReplayCycle?) -> String? {
        if let replay {
            switch replay.phase {
            case .wire:
                return "Wiring: every block header stores a prev_block hash. Core fetches the full newest block, then checks that hash matches the parent header — a broken link means a rejected block."
            case .prune:
                return "Pruning: Core deletes the oldest blk*.dat files from disk (not the headers). Storage drops toward ~2 GB; the node still tracks the full chain but cannot serve blocks below the prune height."
            case .hold:
                return nil
            }
        }
        switch step {
        case .download:
            return "Wiring: as each block arrives, Core verifies its prev_block field equals the parent's header hash. The matrix fill is raw block data streaming in; the green wire is that hash link locking into place."
        case .prune:
            return "Pruning: old complete block files are removed from disk to save space. Headers and the UTXO database remain — only the heavy historical block payloads are gone."
        default:
            return nil
        }
    }

    private func wireCurvePoint(from start: CGPoint, to end: CGPoint, t: CGFloat) -> CGPoint {
        let midY = (start.y + end.y) / 2 - 6
        let u = max(0, min(1, t))
        let c1 = CGPoint(x: start.x + (end.x - start.x) * 0.35, y: midY)
        let c2 = CGPoint(x: start.x + (end.x - start.x) * 0.65, y: midY)
        let omt = 1 - u
        let x = omt * omt * omt * start.x + 3 * omt * omt * u * c1.x + 3 * omt * u * u * c2.x + u * u * u * end.x
        let y = omt * omt * omt * start.y + 3 * omt * omt * u * c1.y + 3 * omt * u * u * c2.y + u * u * u * end.y
        return CGPoint(x: x, y: y)
    }

    private func drawPhysicalWire(
        from start: CGPoint,
        to end: CGPoint,
        progress: CGFloat,
        hashLabel: String,
        flash: Bool,
        animateDigits: Bool = true,
        showLabels: Bool = true
    ) {
        let path = NSBezierPath()
        let midY = (start.y + end.y) / 2 - 6
        path.move(to: start)
        path.curve(to: end, controlPoint1: CGPoint(x: start.x + (end.x - start.x) * 0.35, y: midY), controlPoint2: CGPoint(x: start.x + (end.x - start.x) * 0.65, y: midY))
        NSColor(white: 0.06, alpha: 0.9).setStroke()
        path.lineWidth = 5
        path.stroke()
        let wireColor: NSColor = flash
            ? NSColor(calibratedRed: 1, green: 0.85, blue: 0.3, alpha: 1)
            : NSColor(calibratedRed: 0.72, green: 0.58, blue: 0.22, alpha: 0.95)
        wireColor.setStroke()
        path.lineWidth = 2.6
        path.stroke()

        for bolt in [start, end] {
            NSColor(white: 0.22, alpha: 1).setFill()
            NSBezierPath(ovalIn: CGRect(x: bolt.x - 4, y: bolt.y - 4, width: 8, height: 8)).fill()
            NSColor(calibratedRed: 0.85, green: 0.7, blue: 0.25, alpha: 0.8).setStroke()
            let ring = NSBezierPath(ovalIn: CGRect(x: bolt.x - 3, y: bolt.y - 3, width: 6, height: 6))
            ring.lineWidth = 1
            ring.stroke()
        }

        let t = max(0, min(1, progress))
        let dot = wireCurvePoint(from: start, to: end, t: t)
        NSColor(calibratedRed: 1, green: 0.78, blue: 0.25, alpha: 1).setFill()
        NSBezierPath(ovalIn: CGRect(x: dot.x - 4, y: dot.y - 4, width: 8, height: 8)).fill()

        if animateDigits {
            let hashChars = Array(hashLabel)
            for packet in 0..<4 {
                let packetT = max(0, min(1, progress - CGFloat(packet) * 0.14 + sin(animationPhase * 6 + CGFloat(packet)) * 0.03))
                guard packetT > 0.02 else { continue }
                let pos = wireCurvePoint(from: start, to: end, t: packetT)
                let idx = Int(floor(animationPhase * 16 + CGFloat(packet) * 2.7)) % max(hashChars.count, 1)
                let ch = hashChars.isEmpty ? "?" : String(hashChars[idx])
                drawMonospaceTextCentered(
                    ch, at: pos, size: fontMicro - 3, weight: .bold,
                    color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: flash ? 1 : 0.85)
                )
            }
        }

        if showLabels {
            let reveal = animateDigits
                ? min(hashLabel.count, max(2, Int(floor(progress * CGFloat(hashLabel.count + 3)))))
                : hashLabel.count
            let revealed = String(hashLabel.prefix(reveal))
            drawMonospaceTextCentered(
                revealed, at: CGPoint(x: (start.x + end.x) / 2, y: midY - 11),
                size: fontMicro - 2, weight: .bold,
                color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: flash ? 1 : 0.8)
            )
            drawText(
                "prev hash", at: CGPoint(x: (start.x + end.x) / 2, y: midY + 2), anchor: .topCenter,
                size: fontMicro - 3, weight: .semibold, color: NSColor(white: 0.5, alpha: 1)
            )
        }
    }

    private func syncBlockHashHex(height: Int, length: Int = 8) -> String {
        var s = ""
        for i in 0..<length {
            let seed = UInt32(truncatingIfNeeded: height &* 2_654_435_761 &+ i &* 1_597_334_677)
            s += String(format: "%x", Int((seed >> 12) & 0xf))
        }
        return s
    }

    private func drawSyncFetchingMatrix(in body: CGRect, fillProgress: CGFloat, blockHeight: Int) {
        guard fillProgress > 0.03 else { return }
        let fillH = body.height * fillProgress
        let fillRect = CGRect(x: body.minX, y: body.maxY - fillH, width: body.width, height: fillH)
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: fillRect).addClip()
        drawMatrixCryptBackdrop(in: body, intensity: 0.5, seed: blockHeight)
        let hash = syncBlockHashHex(height: blockHeight, length: 8)
        let reveal = min(hash.count, max(1, Int(floor(fillProgress * CGFloat(hash.count + 2)))))
        drawCryptHexRow(
            in: CGRect(x: body.minX + 2, y: body.minY + 2, width: body.width - 4, height: body.height - 4),
            text: hash, revealCount: reveal, size: fontMicro - 4, yours: false, seed: blockHeight
        )
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawPhysicalSyncBlock(
        in frame: CGRect,
        height: Int,
        bodyFill: CGFloat,
        wired: Bool,
        dissolve: CGFloat,
        fetching: Bool,
        pruneMB: Int? = nil
    ) {
        let alpha = max(0, 1 - dissolve * 0.92)
        guard alpha > 0.05 else { return }

        let shadow = frame.offsetBy(dx: 3, dy: 4)
        NSColor(white: 0, alpha: 0.28 * alpha).setFill()
        NSBezierPath(roundedRect: shadow, xRadius: 4, yRadius: 4).fill()

        let shell = frame.insetBy(dx: 0, dy: 0)
        NSColor(calibratedWhite: 0.14, alpha: 0.85 * alpha).setFill()
        NSBezierPath(roundedRect: shell, xRadius: 4, yRadius: 4).fill()
        NSColor(white: 0.28, alpha: 0.5 * alpha).setStroke()
        let shellBorder = NSBezierPath(roundedRect: shell, xRadius: 4, yRadius: 4)
        shellBorder.lineWidth = 1
        shellBorder.stroke()

        let headerH: CGFloat = 11
        let header = CGRect(x: shell.minX + 3, y: shell.minY + 3, width: shell.width - 6, height: headerH)
        NSColor(calibratedRed: 0.16, green: 0.48, blue: 0.62, alpha: 0.7 * alpha).setFill()
        NSBezierPath(roundedRect: header, xRadius: 2, yRadius: 2).fill()

        let body = CGRect(x: shell.minX + 3, y: header.maxY + 3, width: shell.width - 6, height: shell.height - headerH - 9)
        NSColor(white: 0.08, alpha: 0.9 * alpha).setFill()
        NSBezierPath(roundedRect: body, xRadius: 2, yRadius: 2).fill()
        if fetching, bodyFill < 1 {
            drawSyncFetchingMatrix(in: body, fillProgress: bodyFill, blockHeight: height)
        }
        if bodyFill > 0 {
            let fillH = body.height * bodyFill
            let fill = CGRect(x: body.minX, y: body.maxY - fillH, width: body.width, height: fillH)
            let fillColor: NSColor = fetching
                ? NSColor(calibratedRed: 1, green: 0.52, blue: 0.1, alpha: 0.35 * alpha)
                : NSColor(calibratedRed: 0.16, green: 0.68, blue: 0.38, alpha: 0.75 * alpha)
            fillColor.setFill()
            NSBezierPath(roundedRect: fill, xRadius: 2, yRadius: 2).fill()
        }

        if wired {
            NSColor(calibratedRed: 0.45, green: 1, blue: 0.68, alpha: 0.35 * alpha).setStroke()
            let port = NSBezierPath(ovalIn: CGRect(x: shell.maxX - 8, y: header.midY - 3, width: 6, height: 6))
            port.lineWidth = 1.2
            port.stroke()
        }

        if dissolve > 0.1 {
            NSColor(white: 0.55, alpha: 0.35 * dissolve).setStroke()
            let crack = NSBezierPath()
            crack.move(to: CGPoint(x: shell.minX + 4, y: shell.minY + 6))
            crack.line(to: CGPoint(x: shell.midX, y: shell.midY))
            crack.line(to: CGPoint(x: shell.maxX - 5, y: shell.maxY - 4))
            crack.lineWidth = 1.2
            crack.stroke()
        }

        if fetching {
            NSColor(calibratedRed: 1, green: 0.62, blue: 0.15, alpha: 0.9).setStroke()
            let glow = NSBezierPath(roundedRect: shell.insetBy(dx: -1.5, dy: -1.5), xRadius: 5, yRadius: 5)
            glow.lineWidth = 1.4
            glow.stroke()
        }

        if let pruneMB, dissolve > 0.05 {
            let tick = pruneMB - Int(dissolve * CGFloat(pruneMB))
            drawMonospaceTextCentered(
                "−\(tick) MB", at: CGPoint(x: shell.midX, y: body.midY - 2), size: fontMicro - 2, weight: .bold,
                color: NSColor(calibratedRed: 0.55, green: 0.9, blue: 1, alpha: alpha)
            )
            drawText(
                "pruning…", at: CGPoint(x: shell.midX, y: body.midY + 10), anchor: .topCenter,
                size: fontMicro - 3, weight: .semibold, color: NSColor(white: 0.55, alpha: alpha)
            )
        } else if !fetching || bodyFill >= 0.98 {
            let heightLabel = height >= 1_000_000 ? String(format: "%.2fM", Double(height) / 1_000_000) : Self.formatGrouped(height)
            drawMonospaceTextCentered(
                heightLabel, at: CGPoint(x: shell.midX, y: body.midY), size: fontMicro - 3, weight: .bold,
                color: NSColor(white: 0.72, alpha: alpha)
            )
        }
    }

    private func drawPruneDebris(near frame: CGRect, dissolve: CGFloat, seed: Int) {
        guard dissolve > 0.05 else { return }
        for p in 0..<10 {
            let angle = CGFloat(p) * 0.9 + animationPhase * 3
            let dist = dissolve * 18 + sin(angle) * 4
            let px = frame.midX + cos(angle) * dist * 0.5
            let py = frame.minY - CGFloat(p) * 2 - dissolve * 28 - sin(animationPhase * 5 + CGFloat(p)) * 3
            let size: CGFloat = 2 + CGFloat(p % 3)
            NSColor(white: 0.25 + CGFloat(p % 4) * 0.08, alpha: 0.5 * dissolve).setFill()
            NSBezierPath(roundedRect: CGRect(x: px, y: py, width: size, height: size * 0.7), xRadius: 1, yRadius: 1).fill()
        }
    }

    private func drawSyncPhysicalSegmentReplay(in frame: CGRect, cycle: SyncReplayCycle) {
        let blockCount = cycle.segmentCount
        let gap: CGFloat = 32
        let blockW = max(56, (frame.width - 32 - CGFloat(blockCount - 1) * gap) / CGFloat(blockCount))
        let blockH: CGFloat = 78
        let shelfY = frame.maxY - 18
        let topY = frame.minY + 8

        NSColor(white: 0.12, alpha: 0.85).setFill()
        NSBezierPath(rect: CGRect(x: frame.minX, y: shelfY, width: frame.width, height: 4)).fill()
        NSColor(white: 0.2, alpha: 0.5).setFill()
        NSBezierPath(rect: CGRect(x: frame.minX, y: shelfY + 4, width: frame.width, height: 2)).fill()

        let wireProgress: CGFloat
        let bodyFill: CGFloat
        let wireFlash: Bool
        let dissolve: CGFloat
        let trainShift: CGFloat
        switch cycle.phase {
        case .wire:
            let t = min(1, cycle.elapsed / Self.syncReplayWireSeconds)
            wireProgress = min(1, max(0, (t - 0.2) / 0.45))
            bodyFill = min(1, max(0, (t - 0.45) / 0.4))
            wireFlash = cycle.wireFlash > 0
            dissolve = 0
            trainShift = 0
        case .prune, .hold:
            wireProgress = 1
            bodyFill = 1
            wireFlash = false
            dissolve = cycle.phase == .hold ? 1 : min(1, cycle.elapsed / (Self.syncReplayPruneSeconds * 0.85))
            trainShift = dissolve * (blockW + gap)
        }

        var blockFrames: [CGRect] = []
        for i in 0..<blockCount {
            let shift = i == 0 ? 0 : trainShift
            let x = frame.minX + 16 + CGFloat(i) * (blockW + gap) + shift
            blockFrames.append(CGRect(x: x, y: topY, width: blockW, height: blockH))
        }

        for i in 0..<blockCount {
            let blockFrame = blockFrames[i]
            let height = cycle.tipBlockHeight - (blockCount - 1 - i)
            let isTip = i == blockCount - 1
            let isOldest = i == 0
            let fill: CGFloat = isTip ? bodyFill : 1
            let blockDissolve = isOldest ? dissolve : 0
            let fetching = isTip && cycle.phase == .wire && bodyFill < 1
            let pruneMB = isOldest && (cycle.phase == .prune || cycle.phase == .hold) ? 550 : nil

            if i > 0, !isOldest || dissolve < 0.95 {
                let prev = blockFrames[i - 1]
                let wireActive = isTip && cycle.phase == .wire
                let wireDone = i < blockCount - 1 || wireProgress >= 1 || cycle.phase != .wire
                if wireDone || wireActive {
                    let hash = syncBlockHashHex(height: height, length: 8)
                    drawPhysicalWire(
                        from: CGPoint(x: prev.maxX - 2, y: prev.minY + 10),
                        to: CGPoint(x: blockFrame.minX + 2, y: blockFrame.minY + 10),
                        progress: isTip ? wireProgress : 1,
                        hashLabel: hash,
                        flash: isTip && wireFlash
                    )
                }
            }

            drawPhysicalSyncBlock(
                in: blockFrame, height: height, bodyFill: fill,
                wired: i > 0, dissolve: blockDissolve, fetching: fetching, pruneMB: pruneMB
            )
            if isOldest {
                drawPruneDebris(near: blockFrame, dissolve: blockDissolve, seed: cycle.tipBlockHeight)
            }
        }

        if cycle.phase == .prune || cycle.phase == .hold {
            let keepIdx = blockCount - cycle.keepCount
            let keepX = blockFrames[keepIdx].minX - 6
            NSColor(calibratedRed: 0.45, green: 1, blue: 0.68, alpha: 0.4).setStroke()
            let bracket = NSBezierPath()
            bracket.move(to: CGPoint(x: keepX, y: topY - 8))
            bracket.line(to: CGPoint(x: keepX, y: shelfY + 2))
            bracket.line(to: CGPoint(x: blockFrames.last!.maxX + 6, y: shelfY + 2))
            bracket.line(to: CGPoint(x: blockFrames.last!.maxX + 6, y: topY - 8))
            bracket.lineWidth = 1.2
            bracket.stroke()
            let keptMB = 2048 - Int(dissolve * 550)
            drawText(
                "kept on disk ~\(max(1800, keptMB)) MB", at: CGPoint(x: keepX + 4, y: shelfY + 8), anchor: .topLeft,
                size: fontMicro - 2, weight: .semibold, color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.68, alpha: 0.8)
            )
        }

        if cycle.phase == .prune {
            let freed = Int(dissolve * 550)
            drawText(
                "−\(freed) MB freed", at: CGPoint(x: frame.maxX - 8, y: frame.minY + 6), anchor: .topRight,
                size: fontMicro - 2, weight: .bold, color: NSColor(calibratedRed: 0.55, green: 0.9, blue: 1, alpha: 0.9)
            )
        }
    }

    private func syncBlockHashLabel(index: Int, role: String) -> String {
        let seed = UInt32(truncatingIfNeeded: index &* 2_654_435_761 &+ role.hashValue)
        return String(format: "%04x", seed & 0xffff)
    }

    private func drawSyncDownloadWiringViz(in frame: CGRect, stepProgress: CGFloat) {
        let blockCount = 7
        let gap: CGFloat = 22
        let blockW = max(32, (frame.width - CGFloat(blockCount - 1) * gap) / CGFloat(blockCount))
        let headerH: CGFloat = 12
        let bodyH: CGFloat = 46
        let labelY = frame.minY + 8
        let headerY = labelY + 16
        let bodyY = headerY + headerH + 6
        let wireY = headerY + headerH / 2
        let frontier = stepProgress * CGFloat(blockCount)
        let completed = Int(floor(frontier))
        let partial = frontier - CGFloat(completed)

        drawText(
            "header only", at: CGPoint(x: frame.minX, y: labelY), anchor: .topLeft,
            size: fontMicro - 3, weight: .semibold, color: NSColor(calibratedRed: 0.35, green: 0.85, blue: 1, alpha: 0.75)
        )
        drawText(
            "full block data ↓", at: CGPoint(x: frame.minX, y: bodyY - 2), anchor: .topLeft,
            size: fontMicro - 3, weight: .semibold, color: NSColor(calibratedRed: 1, green: 0.62, blue: 0.15, alpha: 0.8)
        )

        for i in 0..<blockCount {
            let x = frame.minX + CGFloat(i) * (blockW + gap)
            let header = CGRect(x: x, y: headerY, width: blockW, height: headerH)
            let body = CGRect(x: x, y: bodyY, width: blockW, height: bodyH)
            let isFrontier = i == completed
            let isDone = i < completed
            let bodyFill: CGFloat = isDone ? 1 : (isFrontier ? partial : 0)
            let blockHeight = 872_000 + i

            NSColor(calibratedRed: 0.14, green: 0.42, blue: 0.55, alpha: 0.45).setFill()
            NSBezierPath(roundedRect: header, xRadius: 2, yRadius: 2).fill()
            if isFrontier || isDone {
                NSColor(calibratedRed: 0.35, green: 0.85, blue: 1, alpha: 0.55).setStroke()
                let outline = NSBezierPath(roundedRect: header, xRadius: 2, yRadius: 2)
                outline.lineWidth = 0.8
                outline.stroke()
            }

            NSColor(white: 0.09, alpha: 0.85).setFill()
            NSBezierPath(roundedRect: body, xRadius: 2, yRadius: 2).fill()
            if isFrontier, bodyFill < 1 {
                drawSyncFetchingMatrix(in: body, fillProgress: bodyFill, blockHeight: blockHeight)
            }
            if bodyFill > 0 {
                let fillH = body.height * bodyFill
                let fill = CGRect(x: body.minX, y: body.maxY - fillH, width: body.width, height: fillH)
                let fillColor: NSColor = isFrontier
                    ? NSColor(calibratedRed: 1, green: 0.55, blue: 0.12, alpha: 0.3)
                    : NSColor(calibratedRed: 0.18, green: 0.72, blue: 0.42, alpha: 0.65)
                fillColor.setFill()
                NSBezierPath(roundedRect: fill, xRadius: 2, yRadius: 2).fill()
            }
            if isFrontier {
                NSColor(calibratedRed: 1, green: 0.62, blue: 0.15, alpha: 0.9).setStroke()
                let outline = NSBezierPath(roundedRect: body.insetBy(dx: -1, dy: -1), xRadius: 3, yRadius: 3)
                outline.lineWidth = 1.2
                outline.stroke()
            }

            if i > 0 {
                let parentX = frame.minX + CGFloat(i - 1) * (blockW + gap)
                let wireStart = CGPoint(x: parentX + blockW + 1, y: wireY)
                let wireEnd = CGPoint(x: x - 1, y: wireY)
                let wired = i <= completed || (isFrontier && partial > 0.12)
                let wiring = isFrontier && partial < 0.75

                if wired || wiring {
                    let wireProgress: CGFloat = wiring ? max(0, min(1, (partial - 0.08) / 0.55)) : 1
                    let hash = syncBlockHashHex(height: blockHeight, length: 8)
                    let isActiveWire = isFrontier
                    if isActiveWire {
                        let flash = wiring && partial > 0.45 && sin(animationPhase * 12) > 0.6
                        NSColor(calibratedRed: 0.72, green: 0.58, blue: 0.22, alpha: flash ? 1 : 0.85).setStroke()
                        let wire = NSBezierPath()
                        wire.move(to: wireStart)
                        wire.line(to: wireEnd)
                        wire.lineWidth = wiring ? 2 : 1.4
                        wire.stroke()
                        let hashChars = Array(hash)
                        for packet in 0..<3 {
                            let packetT = max(0, min(1, wireProgress - CGFloat(packet) * 0.16 + sin(animationPhase * 7 + CGFloat(packet)) * 0.04))
                            guard packetT > 0.02 else { continue }
                            let dotX = wireStart.x + (wireEnd.x - wireStart.x) * packetT
                            let idx = Int(floor(animationPhase * 14 + CGFloat(packet) * 2.3)) % max(hashChars.count, 1)
                            drawMonospaceTextCentered(
                                String(hashChars[idx]), at: CGPoint(x: dotX, y: wireY),
                                size: fontMicro - 4, weight: .bold,
                                color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: flash ? 1 : 0.9)
                            )
                        }
                        let reveal = min(hash.count, max(2, Int(floor(wireProgress * CGFloat(hash.count + 2)))))
                        drawMonospaceTextCentered(
                            String(hash.prefix(reveal)), at: CGPoint(x: (wireStart.x + wireEnd.x) / 2, y: wireY - 9),
                            size: fontMicro - 4, weight: .bold,
                            color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 0.95)
                        )
                    } else {
                        NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 0.55).setStroke()
                        let wire = NSBezierPath()
                        wire.move(to: wireStart)
                        wire.line(to: wireEnd)
                        wire.lineWidth = 1.2
                        wire.stroke()
                        drawMonospaceTextCentered(
                            syncBlockHashLabel(index: i, role: "prev"),
                            at: CGPoint(x: (wireStart.x + wireEnd.x) / 2, y: wireY - 8),
                            size: fontMicro - 4, weight: .bold,
                            color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 0.6)
                        )
                    }
                } else {
                    NSColor(white: 0.16, alpha: 0.5).setStroke()
                    let wire = NSBezierPath()
                    wire.move(to: wireStart)
                    wire.line(to: wireEnd)
                    wire.lineWidth = 1
                    wire.setLineDash([3, 3], count: 2, phase: animationPhase * 10)
                    wire.stroke()
                    wire.setLineDash([], count: 0, phase: 0)
                }
            }
        }

        let legendY = frame.maxY - 10
        drawText(
            "prev_block hash in header → must equal parent header hash",
            at: CGPoint(x: frame.midX, y: legendY), anchor: .topCenter,
            size: fontMicro - 3, weight: .semibold, color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.72, alpha: 0.65)
        )
    }

    private func drawSyncBlockChainViz(in frame: CGRect, step: SyncPipelineStep, stepProgress: CGFloat, node: SaverNodeStatus?) {
        if step == .download {
            drawSyncDownloadWiringViz(in: frame, stepProgress: stepProgress)
            return
        }

        let blockCount = 18
        let blockW: CGFloat = max(8, (frame.width - CGFloat(blockCount - 1) * 3) / CGFloat(blockCount))
        let blockH: CGFloat = 22
        let y = frame.midY - blockH / 2
        let keepCount = 6
        let pruneWave = (animationPhase * 3).truncatingRemainder(dividingBy: 1)

        for i in 0..<blockCount {
            let x = frame.minX + CGFloat(i) * (blockW + 3)
            let cell = CGRect(x: x, y: y, width: blockW, height: blockH)
            let fillProgress: CGFloat
            switch step {
            case .connect, .headers:
                fillProgress = step == .headers ? min(1, stepProgress * CGFloat(blockCount + 2) - CGFloat(i) * 0.35) : 0
            case .download, .verify:
                fillProgress = min(1, max(0, stepProgress * CGFloat(blockCount + 3) - CGFloat(i)))
            case .prune, .ready:
                fillProgress = i >= blockCount - keepCount ? 1 : 0
            }
            let pruned = (step == .prune || step == .ready) && i < blockCount - keepCount
            let dissolving = pruned && CGFloat(i) < pruneWave * CGFloat(blockCount - keepCount)

            if dissolving {
                NSColor(white: 0.08, alpha: 0.35).setFill()
            } else if fillProgress > 0.85 {
                NSColor(calibratedRed: 0.18, green: 0.72, blue: 0.42, alpha: pruned ? 0.2 : 0.55).setFill()
            } else if fillProgress > 0 {
                NSColor(calibratedRed: 1, green: 0.55, blue: 0.12, alpha: 0.45 + 0.35 * fillProgress).setFill()
            } else {
                NSColor(white: 0.1, alpha: 0.65).setFill()
            }
            NSBezierPath(roundedRect: cell, xRadius: 2, yRadius: 2).fill()

            if i > 0, fillProgress > 0.2, !dissolving {
                let prevX = frame.minX + CGFloat(i - 1) * (blockW + 3) + blockW
                NSColor(calibratedRed: 0.3, green: 0.82, blue: 0.55, alpha: 0.25).setStroke()
                let link = NSBezierPath()
                link.move(to: CGPoint(x: prevX, y: cell.midY))
                link.line(to: CGPoint(x: cell.minX, y: cell.midY))
                link.lineWidth = 1.5
                link.stroke()
            }
        }

        if step == .prune || (step == .ready && node?.pruned == true) {
            let keepX = frame.minX + CGFloat(blockCount - keepCount) * (blockW + 3) - 2
            NSColor(calibratedRed: 0.45, green: 1, blue: 0.68, alpha: 0.35).setStroke()
            let bracket = NSBezierPath()
            bracket.move(to: CGPoint(x: keepX, y: y - 6))
            bracket.line(to: CGPoint(x: keepX, y: y + blockH + 6))
            bracket.line(to: CGPoint(x: frame.maxX, y: y + blockH + 6))
            bracket.line(to: CGPoint(x: frame.maxX, y: y - 6))
            bracket.lineWidth = 1
            bracket.stroke()
            drawText(
                "kept ~2 GB", at: CGPoint(x: keepX + 4, y: y + blockH + 10), anchor: .topLeft,
                size: fontMicro, weight: .semibold, color: NSColor(calibratedRed: 0.45, green: 1, blue: 0.68, alpha: 0.75)
            )
            drawText(
                "pruned", at: CGPoint(x: frame.minX, y: y - 8), anchor: .topLeft,
                size: fontMicro, weight: .regular, color: NSColor(white: 0.38, alpha: 1)
            )
        }
    }

    func drawSyncAnimationPanel(in panel: CGRect, mode: String?, node: SaverNodeStatus?, context: CGContext) {
        NSColor(white: 0.07, alpha: 0.92).setFill()
        NSBezierPath(roundedRect: panel, xRadius: 10, yRadius: 10).fill()
        NSColor(calibratedRed: 0.2, green: 0.55, blue: 0.9, alpha: 0.22).setStroke()
        let border = NSBezierPath(roundedRect: panel, xRadius: 10, yRadius: 10)
        border.lineWidth = 1.1
        border.stroke()

        let pad: CGFloat = 8
        let inner = panel.insetBy(dx: pad, dy: 10)
        var y = inner.minY

        drawText(
            "BITCOIN CORE SYNC", at: CGPoint(x: inner.minX, y: y), anchor: .topLeft,
            size: fontCaption, weight: .bold, color: NSColor(white: 0.62, alpha: 1)
        )
        let status = Self.nodeStatusPresentation(mode: mode, node: node)
        drawText(
            status.text, at: CGPoint(x: inner.maxX, y: y), anchor: .topRight,
            size: fontMicro, weight: .semibold, color: status.color
        )
        y += 22

        let pipeline = syncPipelinePresentation(mode: mode, node: node)
        let replayStep: SyncPipelineStep? = syncReplay.map {
            switch $0.phase {
            case .wire: return .download
            case .prune: return .prune
            case .hold: return .ready
            }
        }
        let steps = SyncPipelineStep.allCases
        let stepW = (inner.width - CGFloat(steps.count - 1) * 4) / CGFloat(steps.count)
        for (i, step) in steps.enumerated() {
            let chip = CGRect(x: inner.minX + CGFloat(i) * (stepW + 4), y: y, width: stepW, height: 20)
            let active = replayStep.map { $0 == step } ?? (step == pipeline.step)
            let done = replayStep.map { step.rawValue < $0.rawValue } ?? (step.rawValue < pipeline.step.rawValue || pipeline.step == .ready)
            let fill: NSColor = done
                ? NSColor(calibratedRed: 0.15, green: 0.65, blue: 0.38, alpha: 0.35)
                : (active
                    ? NSColor(calibratedRed: 1, green: 0.55, blue: 0.12, alpha: 0.35)
                    : NSColor(white: 0.1, alpha: 0.6))
            fill.setFill()
            NSBezierPath(roundedRect: chip, xRadius: 4, yRadius: 4).fill()
            if active {
                NSColor(calibratedRed: 1, green: 0.62, blue: 0.15, alpha: 0.85).setStroke()
                let outline = NSBezierPath(roundedRect: chip, xRadius: 4, yRadius: 4)
                outline.lineWidth = 1.2
                outline.stroke()
            }
            drawMonospaceTextCentered(
                step.label, at: CGPoint(x: chip.midX, y: chip.midY), size: fontMicro - 2,
                weight: active ? .bold : .medium,
                color: done
                    ? NSColor(calibratedRed: 0.45, green: 1, blue: 0.68, alpha: 0.9)
                    : (active
                        ? NSColor(calibratedRed: 1, green: 0.78, blue: 0.28, alpha: 1)
                        : NSColor(white: 0.42, alpha: 1))
            )
        }
        y += 28

        let vizH = syncVizHeight(for: pipeline.step, replay: syncReplay)
        let viz = CGRect(x: inner.minX, y: y, width: inner.width, height: vizH)
        if let replay = syncReplay {
            drawSyncPhysicalSegmentReplay(in: viz, cycle: replay)
        } else {
            drawSyncBlockChainViz(in: viz, step: pipeline.step, stepProgress: pipeline.stepProgress, node: node)
        }
        y = viz.maxY + 10

        let activeStep = syncReplay.map {
            switch $0.phase {
            case .wire: return SyncPipelineStep.download
            case .prune: return SyncPipelineStep.prune
            case .hold: return SyncPipelineStep.ready
            }
        } ?? pipeline.step

        let headline: String
        if let replay = syncReplay, replay.phase == .hold {
            headline = "Segment wired · tail pruned — node keeps marching forward"
        } else {
            headline = activeStep.caption
        }
        let captionColor: NSColor = activeStep == .download || activeStep == .prune
            ? NSColor(calibratedRed: 1, green: 0.72, blue: 0.28, alpha: 0.95)
            : NSColor(white: 0.52, alpha: 1)
        drawText(
            headline, at: CGPoint(x: inner.midX, y: y), anchor: .topCenter,
            size: fontMicro, weight: activeStep == .download || activeStep == .prune ? .semibold : .regular, color: captionColor
        )
        y += 20

        if let education = syncEducationCaption(step: pipeline.step, replay: syncReplay) {
            drawText(
                education, at: CGPoint(x: inner.midX, y: y), anchor: .topCenter,
                size: fontMicro - 1, weight: .regular, color: NSColor(white: 0.48, alpha: 1)
            )
            y += 36
        } else {
            y += 8
        }

        if let node, node.reachable != false, !pipeline.demo {
            let pct = (node.verificationprogress ?? 0) * 100
            let blocksLine: String
            if let blocks = node.blocks, let headers = node.headers {
                blocksLine = String(format: "%.1f%%  •  %@ / %@ blocks", pct, Self.formatGrouped(blocks), Self.formatGrouped(headers))
            } else {
                blocksLine = String(format: "%.1f%%", pct)
            }
            drawText(
                blocksLine, at: CGPoint(x: inner.minX, y: y), anchor: .topLeft,
                size: fontMicro, weight: .semibold, color: NSColor(white: 0.55, alpha: 1)
            )
        } else {
            drawText(
                pipeline.detail, at: CGPoint(x: inner.minX, y: y), anchor: .topLeft,
                size: fontMicro, weight: .medium, color: NSColor(white: 0.48, alpha: 1)
            )
        }
        y += 20

        let barRect = CGRect(x: inner.minX, y: y, width: inner.width, height: 10)
        NSColor(white: 0.12, alpha: 1).setFill()
        NSBezierPath(roundedRect: barRect, xRadius: 4, yRadius: 4).fill()
        let fillW = barRect.width * (pipeline.demo ? pipeline.stepProgress * 0.35 + pipeline.overall * 0.65 : pipeline.overall)
        if fillW > 0 {
            let fillColor: NSColor = pipeline.step == .ready
                ? NSColor(calibratedRed: 0.25, green: 0.85, blue: 0.45, alpha: 1)
                : (pipeline.step == .prune
                    ? NSColor(calibratedRed: 0.35, green: 0.75, blue: 1, alpha: 1)
                    : NSColor(calibratedRed: 1, green: 0.6, blue: 0.15, alpha: 1))
            fillColor.setFill()
            NSBezierPath(roundedRect: CGRect(x: barRect.minX, y: barRect.minY, width: fillW, height: barRect.height), xRadius: 4, yRadius: 4).fill()
        }
        y = barRect.maxY + 12

        if showsHashBuildReplayButton {
            let btnW: CGFloat = 196
            syncReplayButtonFrame = CGRect(
                x: panel.midX - btnW / 2,
                y: y,
                width: btnW,
                height: Self.syncReplayButtonH
            )
            let replaying = syncReplay != nil
            drawReplayButton(
                in: syncReplayButtonFrame,
                hovered: syncReplayButtonHovered,
                label: replaying ? "↻ Replaying segment…" : "↻ Replay wire + prune"
            )
        } else {
            syncReplayButtonFrame = .zero
        }
    }

    private static func syncProgress(node: SaverNodeStatus?) -> CGFloat {
        guard let node, node.reachable != false else { return 0 }
        if node.ready == true { return 1 }
        return CGFloat(min(1, max(0, node.verificationprogress ?? 0)))
    }
}
