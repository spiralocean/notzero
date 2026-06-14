import AppKit

enum CanvasLayoutMode {
    case screensaver
    case app
}

enum BlockHeaderField: Int, CaseIterable {
    case ver = 0, prev, merkle, time, bits, nonce

    var label: String {
        switch self {
        case .ver: return "ver"
        case .prev: return "prev"
        case .merkle: return "merkle"
        case .time: return "time"
        case .bits: return "bits"
        case .nonce: return "NONCE"
        }
    }

    var weight: CGFloat {
        switch self {
        case .ver: return 0.08
        case .prev, .merkle: return 0.24
        case .time, .bits: return 0.14
        case .nonce: return 0.16
        }
    }
}

enum BlockHeaderFieldState {
    case pending
    case settled
    case active
    case done
}

enum SyncPipelineStep: Int, CaseIterable {
    case connect
    case headers
    case download
    case verify
    case prune
    case ready

    var label: String {
        switch self {
        case .connect: return "Connect"
        case .headers: return "Headers"
        case .download: return "Blocks"
        case .verify: return "Verify"
        case .prune: return "Prune"
        case .ready: return "Ready"
        }
    }

    var caption: String {
        switch self {
        case .connect:
            return "Lottery talks to Bitcoin Core over RPC on your Mac."
        case .headers:
            return "Downloads the chain skeleton first — every block height & hash, very lightweight."
        case .download:
            return "Downloading full blocks — txs, witnesses, and all header fields."
        case .verify:
            return "Checks proof-of-work and validates transactions against consensus rules."
        case .prune:
            return "Deleting old block files from disk — headers and UTXO set stay intact."
        case .ready:
            return "Node is synced. Live mode can submit real block templates to the network."
        }
    }
}

enum HashBuildSection: CaseIterable {
    case nonce
    case merkle
    case header
    case sha256
    case hash

    var label: String {
        switch self {
        case .nonce: return "NONCE"
        case .merkle: return "Merkle root"
        case .header: return "Header packed"
        case .sha256: return "SHA-256"
        case .hash: return "Block hash"
        }
    }
}

/// Shared animated canvas used by the screen saver, main app, and preview.
final class LotteryCanvasView: NSView {
    var state: SaverLotteryState?
    var loadError: String?
    var animationPhase: CGFloat = 0
    var timer: Timer?
    var rainColumns: [RainColumn] = []
    var rainBoundsSize: CGSize = .zero
    var rainHashPool: [String] = []
    var rainHashPoolKey = ""
    var hashScrambles: [String: HashScrambleCycle] = [:]
    var hashBuild: HashBuildCycle?
    var hashBuildHeight = -1
    var syncReplay: SyncReplayCycle?
    var replayButtonFrame: CGRect = .zero
    var replayButtonHovered = false
    var syncReplayButtonFrame: CGRect = .zero
    var syncReplayButtonHovered = false
    var layoutMode: CanvasLayoutMode = .screensaver
    var showDebugInfo = false
    var showsHashBuildReplayButton = false
    let painter = VizPainter()
    let chartsViz = ChartsViz()
    let quoteViz = QuoteViz()
    let countdownViz = CountdownRingViz()
    let proximityViz = ProximityMeterViz()

    /// Which dashboard sections are currently expanded (in-memory for now).
    private var dashboardExpanded: Set<DashboardSection> = [.nextBlock, .closeness]
    /// Section-header click targets, recomputed each dashboard draw.
    private var sectionHeaderHits: [(rect: CGRect, section: DashboardSection)] = []
    private var hoveredSection: DashboardSection?

    struct SyncReplayCycle {
        enum Phase {
            case wire
            case prune
            case hold
        }

        let tipBlockHeight: Int
        let segmentCount: Int
        let keepCount: Int
        var phase: Phase
        var elapsed: CGFloat
        var wireFlash: CGFloat

        init(tipBlockHeight: Int) {
            self.tipBlockHeight = tipBlockHeight
            segmentCount = 4
            keepCount = 3
            phase = .wire
            elapsed = 0
            wireFlash = 0
        }
    }

    struct HashBuildCycle {
        enum Phase {
            case nonceAssemble
            case nonceDigest
            case nonceSnap
            case merkleBuild
            case headerPack
            case sha256First
            case sha256Second
            case hashReveal
            case hold
        }

        let blockHeight: Int
        let machineSeed: String
        let hashHex: String
        let merkleRootHex: String
        let txCount: Int
        let previewLength: Int
        var phase: Phase
        var elapsed: CGFloat
        var flash: CGFloat
        var hashResolved: Set<Int>
        var hashRevealOrder: [Int]
        var nextHashRevealIn: CGFloat
        var hashFlashUntil: [Int: CGFloat]
        var headerFlashUntil: [BlockHeaderField: CGFloat]
        var lastPackFieldIndex: Int
        var sectionHold: CGFloat
        var pendingPhase: Phase?

        init(
            blockHeight: Int,
            machineSeed: String,
            hashHex: String,
            merkleRootHex: String,
            txCount: Int,
            previewLength: Int
        ) {
            self.blockHeight = blockHeight
            self.machineSeed = machineSeed
            self.hashHex = hashHex
            self.merkleRootHex = merkleRootHex
            self.txCount = max(1, txCount)
            self.previewLength = previewLength
            phase = .nonceAssemble
            elapsed = 0
            flash = 0
            let charCount = min(previewLength, hashHex.count)
            hashResolved = []
            hashRevealOrder = charCount > 0 ? Array(0..<charCount).shuffled() : []
            nextHashRevealIn = 0.1
            hashFlashUntil = [:]
            headerFlashUntil = [:]
            lastPackFieldIndex = -1
            sectionHold = 0
            pendingPhase = nil
        }

        var ticketInput: String {
            NonceTicket.ticketInput(machineSeed: machineSeed, blockHeight: blockHeight)
        }

        var digestHex: String {
            NonceTicket.digestHex(for: machineSeed, blockHeight: blockHeight)
        }

        var firstFourHex: String {
            NonceTicket.firstFourBytesHex(for: machineSeed, blockHeight: blockHeight)
        }

        var nonce: UInt32 {
            NonceTicket.pickNonce(machineSeed: machineSeed, blockHeight: blockHeight)
        }

        var hashChars: [Character] {
            Array(hashHex.prefix(previewLength))
        }
    }

    struct HashScrambleCycle {
        enum Phase {
            case encrypted
            case locking
            case lockedHold
            case completeHold
        }

        let suffixCount: Int
        let maskCharCount: Int
        let isYours: Bool
        var phase: Phase
        var resolved: Set<Int>
        var revealOrder: [Int]
        var nextRevealIn: CGFloat
        var encryptedElapsed: CGFloat
        var lockedHoldElapsed: CGFloat
        var flashUntil: [Int: CGFloat]
        var completeHoldElapsed: CGFloat

        init(suffixCount: Int, maskCharCount: Int, isYours: Bool) {
            self.suffixCount = suffixCount
            self.maskCharCount = maskCharCount
            self.isYours = isYours
            phase = .encrypted
            resolved = []
            revealOrder = suffixCount > 0 ? Array(0..<suffixCount).shuffled() : []
            nextRevealIn = CGFloat.random(in: 0.2...0.6)
            encryptedElapsed = 0
            lockedHoldElapsed = 0
            flashUntil = [:]
            completeHoldElapsed = 0
        }
    }

    static let hashPreviewLength = 28
    static let scrambleEncryptedLeadIn: CGFloat = 6
    static let scrambleSnapInterval: CGFloat = 0.38
    static let scrambleLockedHoldSeconds: CGFloat = 15
    static let scrambleCompleteHoldSeconds: CGFloat = 15
    static let scrambleLockFlashSeconds: CGFloat = 0.45
    static let scrambleFrameDt: CGFloat = 1.0 / 30.0
    static let hashBuildPreviewLength = 32
    static let nonceAssembleSeconds: CGFloat = 4.0
    static let nonceDigestSeconds: CGFloat = 4.0
    static let nonceSnapSeconds: CGFloat = 1.5
    static let merkleBuildSeconds: CGFloat = 7.5
    static let headerPackSeconds: CGFloat = 5.0
    static let sha256RoundSeconds: CGFloat = 4.0
    static let hashRevealSnapInterval: CGFloat = 0.14
    static let hashBuildHoldSeconds: CGFloat = 10.0
    static let hashBuildHeaderH: CGFloat = 18
    static let hashBuildBodyH: CGFloat = 22
    static let hashBuildHeaderBodyH: CGFloat = 30
    static let hashBuildHashBodyH: CGFloat = 28
    static let hashBuildMerkleBodyH: CGFloat = 68
    static let hashBuildBlueprintH: CGFloat = 48
    static let hashBuildCompactDetailH: CGFloat = 68
    static let hashBuildCompletedRowH: CGFloat = 22
    static let hashBuildColumnHeaderH: CGFloat = 18
    static let hashBuildCompletedHeaderH: CGFloat = 16
    static let hashBuildCurrentStepHeaderH: CGFloat = 18
    static let hashBuildCompletedPlaceholderH: CGFloat = 18
    static let syncPanelAppH: CGFloat = 440
    static let syncReplayButtonH: CGFloat = 26
    static let syncReplayWireSeconds: CGFloat = 5.5
    static let syncReplayPruneSeconds: CGFloat = 4.5
    static let syncReplayHoldSeconds: CGFloat = 2.5
    static let headerPackFields: [BlockHeaderField] = [.ver, .prev, .time, .bits]
    static let hashBuildSectionHoldSeconds: CGFloat = 2.2
    static let hashBuildPackFieldHoldSeconds: CGFloat = 1.4
    static let hashBuildStepGap: CGFloat = 5
    static let hashBuildReplayButtonH: CGFloat = 26
    static let nonceSnapFlashSeconds: CGFloat = 0.45
    static let hashSnapFlashSeconds: CGFloat = 0.38
    static let headerFieldFlashSeconds: CGFloat = 0.5

    struct RainColumn {
        let x: CGFloat
        var offset: CGFloat
        let speed: CGFloat
        var chars: [Character]
        let spark: Bool

        var length: Int { chars.count }
    }

    static let hexAlphabet: [Character] = Array("0123456789abcdef")
    let fontTiny: CGFloat = 16
    let fontMicro: CGFloat = 18
    let fontCaption: CGFloat = 20
    let fontSmall: CGFloat = 22
    let fontSubtitle: CGFloat = 24
    let rainCharHeight: CGFloat = 28
    let rainColumnSpacing: CGFloat = 30

    override var isFlipped: Bool { true }

    struct Layout {
        let pad: CGFloat
        let gap: CGFloat
        let lineH: CGFloat
        let priceChart: CGRect
        let hashrateChart: CGRect
        let halvingChart: CGRect
        let syncPanel: CGRect
        let titleY: CGFloat
        let subtitleY: CGFloat
        let quoteY: CGFloat
        let quoteAttribY: CGFloat
        let footerStatsY: CGFloat
        let footerSublineY: CGFloat
        let footerPayoutY: CGFloat
        let centerBlockY: CGFloat
        let ticketY: CGFloat
        let hashBuildFrame: CGRect
        let hashFrame: CGRect
        let proximityY: CGFloat
        let resultY: CGFloat
        let contentHeight: CGFloat

        init(rect: NSRect, view: ScreensaverView, mode: CanvasLayoutMode = .screensaver) {
            let app = mode == .app
            let compact = !app && rect.height < 820
            pad = 36
            gap = app ? 24 : 12
            lineH = 34
            let chartH: CGFloat = app ? 110 : (compact ? 92 : 100)
            let syncH: CGFloat = app ? LotteryCanvasView.syncPanelAppH : (compact ? 88 : 100)

            titleY = 36
            subtitleY = 72
            quoteY = 108
            quoteAttribY = 138
            let headerBottom: CGFloat = 166
            let winnerReserve: CGFloat
            switch view {
            case .matrixRain: winnerReserve = 0
            case .matrixWinner: winnerReserve = app ? 160 : (compact ? 136 : 148)
            case .winnerContrast: winnerReserve = app ? 290 : (compact ? 246 : 270)
            }

            if app {
                centerBlockY = headerBottom + winnerReserve + 28
                ticketY = centerBlockY + 48
                let buildH: CGFloat = 560
                hashBuildFrame = CGRect(x: rect.minX + 24, y: centerBlockY + 58, width: rect.width - 48, height: buildH)
                hashFrame = CGRect(x: rect.minX + 40, y: hashBuildFrame.maxY + 28, width: rect.width - 80, height: 40)
                proximityY = hashFrame.maxY + 40
                resultY = proximityY + 56
                footerStatsY = resultY + 64
                footerSublineY = footerStatsY + lineH
                footerPayoutY = footerSublineY + lineH
                let chartsTop = footerPayoutY + gap + 12
                let chartW = (rect.width - pad * 2 - gap * 2) / 3
                priceChart = CGRect(x: pad, y: chartsTop, width: chartW, height: chartH)
                hashrateChart = CGRect(x: priceChart.maxX + gap, y: chartsTop, width: chartW, height: chartH)
                halvingChart = CGRect(x: hashrateChart.maxX + gap, y: chartsTop, width: chartW, height: chartH)
                syncPanel = CGRect(x: pad, y: halvingChart.maxY + gap, width: rect.width - pad * 2, height: syncH)
                contentHeight = syncPanel.maxY + 64
            } else {
                var bottom = rect.maxY - 12
                bottom -= chartH
                let chartW = (rect.width - pad * 2 - gap * 2) / 3
                priceChart = CGRect(x: pad, y: bottom, width: chartW, height: chartH)
                hashrateChart = CGRect(x: priceChart.maxX + gap, y: bottom, width: chartW, height: chartH)
                halvingChart = CGRect(x: hashrateChart.maxX + gap, y: bottom, width: chartW, height: chartH)

                bottom -= gap
                bottom -= syncH
                syncPanel = CGRect(x: pad, y: bottom, width: rect.width - pad * 2, height: syncH)

                footerPayoutY = syncPanel.minY - gap - lineH
                footerSublineY = footerPayoutY - lineH
                footerStatsY = footerSublineY - lineH

                let centerContentHeight: CGFloat = compact ? 268 : 288
                let centerTop = headerBottom + winnerReserve + (compact ? 6 : 12)
                let centerBottom = footerStatsY - gap - 6
                let available = max(0, centerBottom - centerTop)
                centerBlockY = centerTop + max(0, (available - centerContentHeight) * 0.32)

                ticketY = centerBlockY + 44
                let buildH: CGFloat = compact ? 370 : 390
                hashBuildFrame = CGRect(x: rect.minX + 24, y: centerBlockY + 56, width: rect.width - 48, height: buildH)
                hashFrame = CGRect(x: rect.minX + 40, y: hashBuildFrame.maxY + 8, width: rect.width - 80, height: 36)
                proximityY = hashFrame.maxY + 18
                resultY = proximityY + 44
                contentHeight = rect.height
            }
        }

        static func documentSize(width: CGFloat, view: ScreensaverView, mode: CanvasLayoutMode) -> NSSize {
            let height = Layout(
                rect: NSRect(x: 0, y: 0, width: width, height: mode == .app ? 10_000 : 720),
                view: view,
                mode: mode
            ).contentHeight
            return NSSize(width: width, height: height)
        }
    }

    func documentSize(forWidth width: CGFloat) -> NSSize {
        if layoutMode == .app {
            let content = layoutDashboardSections(width: width).totalHeight
            let clip = enclosingScrollView?.contentSize.height ?? 0
            return NSSize(width: width, height: max(content, clip))
        }
        return Layout.documentSize(width: width, view: state?.viewMode ?? .matrixRain, mode: layoutMode)
    }

    // MARK: - Dashboard layout (.app) — collapsible sections

    /// Stacked, collapsible dashboard sections. Each can be expanded to a detailed
    /// visualization (built out section-by-section) or collapsed to a summary row.
    enum DashboardSection: String, CaseIterable {
        case nextBlock, closeness, hashBuild, network, sync

        var title: String {
            switch self {
            case .nextBlock: return "NEXT BLOCK"
            case .closeness: return "YOUR CLOSENESS"
            case .hashBuild: return "HASH BUILD"
            case .network: return "NETWORK"
            case .sync: return "NODE SYNC"
            }
        }
    }

    static let dashboardPad: CGFloat = 36
    static let dashboardTopReserve: CGFloat = 120
    static let dashboardHeaderH: CGFloat = 40
    static let dashboardSectionGap: CGFloat = 12

    /// Live mode with a node that isn't fully synced yet → show the sync section.
    func isAppSyncing() -> Bool {
        guard state?.mode == "live", let node = state?.node else { return false }
        return node.ready != true
    }

    private func dashboardVisibleSections() -> [DashboardSection] {
        DashboardSection.allCases.filter { $0 != .sync || isAppSyncing() }
    }

    private func sectionContentHeight(_ section: DashboardSection) -> CGFloat {
        switch section {
        case .nextBlock: return 150
        case .closeness: return 124
        case .hashBuild: return 470   // full vertical ceremony needs the room
        case .network: return 132
        case .sync: return 210
        }
    }

    struct DashboardSectionFrame {
        let section: LotteryCanvasView.DashboardSection
        let headerRect: CGRect
        let contentRect: CGRect?
    }

    /// Single source of truth for dashboard geometry — used by both draw and documentSize.
    func layoutDashboardSections(width: CGFloat) -> (frames: [DashboardSectionFrame], totalHeight: CGFloat) {
        let pad = Self.dashboardPad
        var y = Self.dashboardTopReserve
        var frames: [DashboardSectionFrame] = []
        for section in dashboardVisibleSections() {
            let headerRect = CGRect(x: pad, y: y, width: width - pad * 2, height: Self.dashboardHeaderH)
            y += Self.dashboardHeaderH
            var contentRect: CGRect?
            if dashboardExpanded.contains(section) {
                let ch = sectionContentHeight(section)
                contentRect = CGRect(x: pad, y: y + 4, width: width - pad * 2, height: ch)
                y += 4 + ch
            }
            y += Self.dashboardSectionGap
            frames.append(DashboardSectionFrame(section: section, headerRect: headerRect, contentRect: contentRect))
        }
        return (frames, y + 16)
    }

    func toggleSection(_ section: DashboardSection) {
        if dashboardExpanded.contains(section) {
            dashboardExpanded.remove(section)
        } else {
            dashboardExpanded.insert(section)
        }
        saveExpandedSections()
        syncDashboardFrameHeight()
        needsDisplay = true
    }

    private static let expandedDefaultsKey = "BitcoinLottery.dashboard.expandedSections"

    func loadExpandedSections() {
        guard layoutMode == .app,
              let raw = UserDefaults.standard.array(forKey: Self.expandedDefaultsKey) as? [String] else { return }
        dashboardExpanded = Set(raw.compactMap { DashboardSection(rawValue: $0) })
    }

    private func saveExpandedSections() {
        guard layoutMode == .app else { return }
        UserDefaults.standard.set(dashboardExpanded.map(\.rawValue), forKey: Self.expandedDefaultsKey)
    }

    /// Keep the document view's height in step with the expanded sections (and with
    /// state-driven section visibility like the sync section appearing).
    func syncDashboardFrameHeight() {
        guard layoutMode == .app, bounds.width > 0 else { return }
        let content = layoutDashboardSections(width: bounds.width).totalHeight
        let clip = enclosingScrollView?.contentSize.height ?? 0
        let h = max(content, clip)
        if abs(frame.height - h) > 0.5 {
            setFrameSize(NSSize(width: bounds.width, height: h))
        }
    }

    func drawDashboard(in rect: NSRect, context ctx: CGContext, ceremony: Bool) {
        // Ambient backdrop: gradient + matrix rain (kept alive, dimmed by the scrim).
        drawBackground(in: rect, context: ctx, ceremony: ceremony, state: state, view: .matrixRain)

        drawText(BitcoinBrand.format("BITCOIN LOTTERY"), at: CGPoint(x: rect.midX, y: 30),
                 anchor: .topCenter, size: 28, weight: .bold, color: .white)
        if state != nil {
            quoteViz.draw(centerX: rect.midX, quoteY: 74, attribY: 100, clock: animationPhase, painter: painter)
        } else {
            drawText(loadError ?? "Waiting for daemon…", at: CGPoint(x: rect.midX, y: 74),
                     anchor: .topCenter, size: fontSmall, weight: .regular, color: NSColor(white: 0.5, alpha: 1))
        }

        sectionHeaderHits = []
        guard state != nil else {
            drawText("Start daemon: ./scripts/install.sh", at: CGPoint(x: rect.midX, y: rect.midY),
                     anchor: .topCenter, size: 15, weight: .regular, color: NSColor(white: 0.6, alpha: 1))
            return
        }

        let layout = layoutDashboardSections(width: rect.width)
        for f in layout.frames {
            drawSectionHeader(f.section, in: f.headerRect, expanded: f.contentRect != nil)
            sectionHeaderHits.append((f.headerRect, f.section))
            if let cr = f.contentRect {
                drawSectionContent(f.section, in: cr, context: ctx)
            }
        }

        drawText("v\(LotteryVersion.string)", at: CGPoint(x: rect.maxX - Self.dashboardPad, y: rect.maxY - 22),
                 anchor: .topRight, size: fontMicro, weight: .regular, color: NSColor(white: 0.32, alpha: 1))
    }

    private func drawSectionHeader(_ section: DashboardSection, in rect: CGRect, expanded: Bool) {
        let hovered = hoveredSection == section
        NSColor(white: hovered ? 0.13 : 0.08, alpha: 0.7).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
        NSColor(calibratedRed: 1, green: 0.55, blue: 0.12, alpha: hovered ? 0.5 : 0.22).setStroke()
        let border = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
        border.lineWidth = 1
        border.stroke()

        let accent = NSColor(calibratedRed: 1, green: 0.6, blue: 0.1, alpha: hovered ? 1 : 0.85)
        drawText(expanded ? "▾" : "▸", at: CGPoint(x: rect.minX + 16, y: rect.midY),
                 anchor: .center, size: fontCaption, weight: .bold, color: accent)
        let textY = rect.minY + (rect.height - 18) / 2
        drawText(section.title, at: CGPoint(x: rect.minX + 34, y: textY),
                 anchor: .topLeft, size: fontMicro, weight: .bold, color: accent)
        if !expanded {
            drawText(dashboardSummary(section), at: CGPoint(x: rect.maxX - 14, y: textY),
                     anchor: .topRight, size: fontMicro, weight: .regular, color: NSColor(white: 0.62, alpha: 1))
        }
    }

    private func dashboardSummary(_ section: DashboardSection) -> String {
        switch section {
        case .nextBlock:
            if let c = state?.display?.blockCountdownSec { return String(format: "%d:%02d", c / 60, c % 60) }
            return "—"
        case .closeness:
            if let p = state?.display?.hashProximity {
                return p.won ? "TARGET HIT" : "\(p.label) · \(p.leadingZeroBits) zero bits"
            }
            return "—"
        case .hashBuild:
            if let a = state?.lastAttempt { return "0x\(String(a.hashHex.prefix(10)))…" }
            return "—"
        case .network:
            if let p = state?.price { return "BTC \(VizPainter.formatUSD(p.usd))" }
            return "—"
        case .sync:
            if let n = state?.node { return String(format: "Syncing %.1f%%", (n.verificationprogress ?? 0) * 100) }
            return "—"
        }
    }

    private func drawSectionContent(_ section: DashboardSection, in rect: CGRect, context ctx: CGContext) {
        switch section {
        case .nextBlock:
            if let display = state?.display {
                let ringCenter = CGPoint(x: rect.minX + 92, y: rect.midY)
                countdownViz.draw(center: ringCenter, radius: 52, valueFontSize: 20, display: display, painter: painter)

                func fmt(_ s: Int) -> String { String(format: "%d:%02d", s / 60, s % 60) }
                let height = state?.lastAttempt?.height ?? state?.display?.nextHalvingHeight
                let rows: [(String, String)] = [
                    ("Elapsed", fmt(display.blockElapsedSec ?? 0)),
                    ("Avg block", "~" + fmt(display.avgBlockSec ?? 600)),
                    ("Last block", height.map { "#\(VizPainter.formatGrouped($0))" } ?? "—"),
                ]
                let sx = rect.minX + 208
                var sy = rect.midY - 44
                for (label, value) in rows {
                    drawText(label, at: CGPoint(x: sx, y: sy), anchor: .topLeft,
                             size: fontMicro, weight: .regular, color: NSColor(white: 0.5, alpha: 1))
                    drawText(value, at: CGPoint(x: sx + 132, y: sy), anchor: .topLeft,
                             size: fontMicro, weight: .semibold, color: NSColor(white: 0.85, alpha: 1))
                    sy += 30
                }
            } else {
                drawText("waiting…", at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center,
                         size: fontCaption, weight: .regular, color: NSColor(white: 0.5, alpha: 1))
            }
        case .closeness:
            if let prox = state?.display?.hashProximity {
                proximityViz.draw(centerX: rect.midX, barTopY: rect.minY + 10,
                                  width: min(440, rect.width * 0.8), proximity: prox, painter: painter)
                // The block hash itself, leading zeros lit — a tangible "how close".
                if let hash = state?.lastAttempt?.hashHex, VizPainter.isHexHash(hash) {
                    let chars = Array(hash.lowercased().prefix(32))
                    let leadingZeros = VizPainter.leadingZeroHexChars(in: hash)
                    let rowY = rect.minY + 72
                    let spacing = (rect.width - 40) / CGFloat(max(chars.count, 1))
                    for (i, ch) in chars.enumerated() {
                        let x = rect.minX + 20 + spacing * (CGFloat(i) + 0.5)
                        let isLead = i < leadingZeros
                        drawMonospaceTextCentered(
                            String(ch), at: CGPoint(x: x, y: rowY),
                            size: fontMicro, weight: isLead ? .bold : .regular,
                            color: isLead
                                ? NSColor(calibratedRed: 1, green: 0.78, blue: 0.2, alpha: 1)
                                : NSColor(white: 0.5, alpha: 1)
                        )
                    }
                    drawText("\(leadingZeros) leading zero hex · \(prox.leadingZeroBits) zero bits",
                             at: CGPoint(x: rect.midX, y: rowY + 22), anchor: .topCenter,
                             size: fontMicro, weight: .regular, color: NSColor(white: 0.45, alpha: 1))
                }
            } else {
                drawText("waiting for a draw…", at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center,
                         size: fontCaption, weight: .regular, color: NSColor(white: 0.5, alpha: 1))
            }
        case .hashBuild:
            if let attempt = state?.lastAttempt {
                let seed = NonceTicket.resolvedMachineSeed(stored: state?.machineSeed)
                if let build = currentHashBuild(for: attempt, machineSeed: seed) {
                    drawHashBuild(buildFrame: rect, hashFrame: .zero, build: build, attemptNonce: attempt.nonce)
                } else {
                    drawHashVisualization(hash: attempt.hashHex, in: rect)
                }
            } else {
                drawText("Waiting for first block draw…", at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center,
                         size: 15, weight: .regular, color: NSColor(white: 0.6, alpha: 1))
            }
        case .network:
            let gap: CGFloat = 24
            let cw = (rect.width - gap * 2) / 3
            let price = CGRect(x: rect.minX, y: rect.minY, width: cw, height: rect.height)
            let hashrate = CGRect(x: price.maxX + gap, y: rect.minY, width: cw, height: rect.height)
            let halving = CGRect(x: hashrate.maxX + gap, y: rect.minY, width: cw, height: rect.height)
            if let p = state?.price {
                chartsViz.drawPrice(in: price, price: p, painter: painter)
            } else {
                chartsViz.drawEmpty(in: price, title: "BTC price", subtitle: "Collecting…", painter: painter)
            }
            if let d = state?.display {
                chartsViz.drawHashrate(in: hashrate, display: d, painter: painter)
            } else {
                chartsViz.drawEmpty(in: hashrate, title: "Network hashrate", subtitle: "Collecting…", painter: painter)
            }
            if let d = state?.display, d.nextHalvingHeight != nil {
                chartsViz.drawHalving(in: halving, display: d, painter: painter)
            } else {
                chartsViz.drawEmpty(in: halving, title: "Next halving", subtitle: "Collecting…", painter: painter)
            }
        case .sync:
            if var replay = syncReplay {
                advanceSyncReplay(&replay, dt: Self.scrambleFrameDt)
                if replay.phase == .hold, replay.elapsed >= Self.syncReplayHoldSeconds {
                    syncReplay = nil
                } else {
                    syncReplay = replay
                }
            }
            drawSyncAnimationPanel(in: rect, mode: state?.mode, node: state?.node, context: ctx)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateTrackingAreas()
        window?.acceptsMouseMovedEvents = showsHashBuildReplayButton
        loadExpandedSections()
        if window != nil { startAnimating() } else { stopAnimating() }
    }

    func startAnimating() {
        stopAnimating()
        reloadState()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            animationPhase += 0.02
            quoteViz.advance(dt: 1.0 / 30.0)
            reloadState()
            syncDashboardFrameHeight()
            needsDisplay = true
        }
    }

    func stopAnimating() {
        timer?.invalidate()
        timer = nil
    }

    func reloadState() {
        let result = LotteryStateLoader.load()
        state = result.state
        loadError = result.error
    }

    func replayHashBuildAnimation() {
        guard let attempt = state?.lastAttempt else { return }
        let machineSeed = NonceTicket.resolvedMachineSeed(stored: state?.machineSeed)
        hashBuild = HashBuildCycle(
            blockHeight: attempt.height,
            machineSeed: machineSeed,
            hashHex: attempt.hashHex,
            merkleRootHex: attempt.merkleRootHex ?? "",
            txCount: attempt.txCount ?? 1,
            previewLength: Self.hashBuildPreviewLength
        )
        hashBuildHeight = attempt.height
        needsDisplay = true
    }

    func replaySyncSegmentAnimation() {
        let tip = state?.node?.blocks ?? state?.node?.headers ?? 872_000
        syncReplay = SyncReplayCycle(tipBlockHeight: tip)
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        guard showsHashBuildReplayButton else { return }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if layoutMode == .app {
            for hit in sectionHeaderHits where hit.rect.contains(point) {
                toggleSection(hit.section)
                return
            }
        }
        guard showsHashBuildReplayButton else {
            super.mouseDown(with: event)
            return
        }
        if !syncReplayButtonFrame.isEmpty, syncReplayButtonFrame.contains(point) {
            replaySyncSegmentAnimation()
            return
        }
        if !replayButtonFrame.isEmpty, replayButtonFrame.contains(point) {
            replayHashBuildAnimation()
            return
        }
        super.mouseDown(with: event)
    }

    override func mouseMoved(with event: NSEvent) {
        guard showsHashBuildReplayButton else {
            super.mouseMoved(with: event)
            return
        }
        let point = convert(event.locationInWindow, from: nil)
        var changed = false
        if layoutMode == .app {
            let hov = sectionHeaderHits.first(where: { $0.rect.contains(point) })?.section
            if hov != hoveredSection { hoveredSection = hov; changed = true }
        }
        let syncHovered = !syncReplayButtonFrame.isEmpty && syncReplayButtonFrame.contains(point)
        let hashHovered = !replayButtonFrame.isEmpty && replayButtonFrame.contains(point)
        if syncHovered != syncReplayButtonHovered || hashHovered != replayButtonHovered {
            syncReplayButtonHovered = syncHovered
            replayButtonHovered = hashHovered
            changed = true
        }
        if changed { needsDisplay = true }
        super.mouseMoved(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let rect = bounds
        let viewMode = state?.viewMode ?? .matrixRain
        let layout = Layout(rect: rect, view: viewMode, mode: layoutMode)
        let ceremony = state?.display?.ceremonyActive == true

        if layoutMode == .app {
            drawDashboard(in: rect, context: ctx, ceremony: ceremony)
            return
        }

        drawBackground(in: rect, context: ctx, ceremony: ceremony, state: state, view: viewMode)

        if viewMode.showsWinnerPanel {
            drawWinnerPanel(in: rect, layout: layout, state: state, ceremony: ceremony, large: viewMode.largeWinnerPanel)
        }

        drawText(BitcoinBrand.format("BITCOIN LOTTERY"), at: CGPoint(x: rect.midX, y: layout.titleY), anchor: .topCenter,
                 size: 26, weight: .bold, color: .white)
        drawText("One ticket per block", at: CGPoint(x: rect.midX, y: layout.subtitleY), anchor: .topCenter,
                 size: fontSubtitle, weight: .semibold, color: NSColor(white: 0.75, alpha: 1))

        if state != nil {
            quoteViz.draw(centerX: rect.midX, quoteY: layout.quoteY, attribY: layout.quoteAttribY,
                          clock: animationPhase, painter: painter)
        } else {
            drawText(loadError ?? "Waiting for daemon…", at: CGPoint(x: rect.midX, y: layout.quoteY), anchor: .topCenter,
                     size: fontSmall, weight: .regular, color: NSColor(white: 0.5, alpha: 1))
        }

        if let display = state?.display {
            countdownViz.draw(center: CGPoint(x: rect.maxX - 72, y: 118), radius: 38, display: display, painter: painter)
        }

        if let state, let attempt = state.lastAttempt {
            let blockY = layout.centerBlockY
            let machineSeed = NonceTicket.resolvedMachineSeed(stored: state.machineSeed)
            let build = currentHashBuild(for: attempt, machineSeed: machineSeed)

            if ceremony {
                drawCeremony(in: rect, attempt: attempt, machineSeed: machineSeed, build: build)
            } else {
                drawText("Block \(attempt.height)", at: CGPoint(x: rect.midX, y: blockY), anchor: .topCenter,
                         size: 40, weight: .heavy, color: NSColor(calibratedRed: 1, green: 0.6, blue: 0.1, alpha: 1))
            }

            if let build {
                drawHashBuild(buildFrame: layout.hashBuildFrame, hashFrame: layout.hashFrame, build: build, attemptNonce: attempt.nonce)
            } else {
                drawHashVisualization(hash: attempt.hashHex, in: layout.hashFrame)
            }

            if let prox = state.display?.hashProximity {
                proximityViz.draw(centerX: rect.midX, barTopY: layout.proximityY, width: 300, proximity: prox, painter: painter)
            }

            let result = attempt.won ? "JACKPOT" : "No match"
            drawText(result, at: CGPoint(x: rect.midX, y: layout.resultY), anchor: .topCenter, size: 15, weight: .semibold,
                     color: attempt.won ? NSColor(calibratedRed: 0.2, green: 1, blue: 0.4, alpha: 1) : NSColor(white: 0.65, alpha: 1))

            let statsLine: String
            if state.mode == "live" {
                let live = state.stats.liveAttempts ?? 0
                let wins = state.stats.liveWins ?? 0
                statsLine = "Live tickets submitted: \(live)   Wins: \(wins)"
            } else {
                statsLine = "Attempts: \(state.stats.totalAttempts)   Wins: \(state.stats.wins)"
            }
            drawText(statsLine, at: CGPoint(x: rect.midX, y: layout.footerStatsY), anchor: .topCenter,
                     size: fontSmall, weight: .regular, color: NSColor(white: 0.5, alpha: 1))
            drawText("You: 1 hash per block", at: CGPoint(x: rect.midX, y: layout.footerSublineY), anchor: .topCenter,
                     size: fontCaption, weight: .regular, color: NSColor(white: 0.45, alpha: 1))

            if let payout = state.payoutAddress, !payout.isEmpty {
                drawText("Payout \(payout)", at: CGPoint(x: rect.midX, y: layout.footerPayoutY), anchor: .topCenter,
                         size: fontCaption, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
            }
        } else if let state {
            drawText("Waiting for first block draw…", at: CGPoint(x: rect.midX, y: rect.midY - 20), anchor: .topCenter,
                     size: 15, weight: .regular, color: NSColor(white: 0.6, alpha: 1))
            let nodeStatus = Self.nodeStatusPresentation(mode: state.mode, node: state.node)
            drawText(nodeStatus.text, at: CGPoint(x: rect.midX, y: rect.midY + 8), anchor: .topCenter,
                     size: fontSmall, weight: .medium, color: nodeStatus.color)
        } else {
            drawText("Start daemon: ./scripts/install.sh", at: CGPoint(x: rect.midX, y: rect.midY), anchor: .topCenter,
                     size: 15, weight: .regular, color: NSColor(white: 0.6, alpha: 1))
        }

        if var replay = syncReplay {
            advanceSyncReplay(&replay, dt: Self.scrambleFrameDt)
            if replay.phase == .hold, replay.elapsed >= Self.syncReplayHoldSeconds {
                syncReplay = nil
            } else {
                syncReplay = replay
            }
        }
        drawSyncAnimationPanel(in: layout.syncPanel, mode: state?.mode, node: state?.node, context: ctx)

        if let display = state?.display {
            chartsViz.drawHashrate(in: layout.hashrateChart, display: display, painter: painter)
        } else {
            chartsViz.drawEmpty(in: layout.hashrateChart, title: "Network hashrate", subtitle: "Collecting…", painter: painter)
        }

        if let price = state?.price {
            chartsViz.drawPrice(in: layout.priceChart, price: price, painter: painter)
        } else {
            chartsViz.drawEmpty(in: layout.priceChart, title: "BTC price", subtitle: "Collecting…", painter: painter)
        }

        if let display = state?.display, display.nextHalvingHeight != nil {
            chartsViz.drawHalving(in: layout.halvingChart, display: display, painter: painter)
        } else {
            chartsViz.drawEmpty(in: layout.halvingChart, title: "Next halving", subtitle: "Collecting…", painter: painter)
        }

        drawText("v\(LotteryVersion.string)", at: CGPoint(x: rect.maxX - layout.pad, y: rect.maxY - 10),
                 anchor: .topRight, size: fontMicro, weight: .regular, color: NSColor(white: 0.32, alpha: 1))

        if showDebugInfo {
            drawText("state: \(LotteryStateLoader.stateURL.path)", at: CGPoint(x: rect.midX, y: rect.maxY - 14),
                     anchor: .topCenter, size: fontMicro, weight: .regular, color: NSColor(white: 0.35, alpha: 1))
        }
    }

    // MARK: - Formatting

    static func nodeStatusPresentation(mode: String?, node: SaverNodeStatus?) -> (text: String, color: NSColor) {
        VizPainter.nodeStatusPresentation(mode: mode, node: node)
    }

    static func formatGrouped(_ value: Int) -> String {
        VizPainter.formatGrouped(value)
    }

    static func formatUSD(_ value: Double) -> String {
        VizPainter.formatUSD(value)
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
        painter.drawText(text, at: point, anchor: anchor, size: size, weight: weight, color: color)
    }

    func drawWrappedText(
        _ text: String,
        in rect: CGRect,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor,
        alignment: NSTextAlignment
    ) {
        painter.drawWrappedText(text, in: rect, size: size, weight: weight, color: color, alignment: alignment)
    }
}