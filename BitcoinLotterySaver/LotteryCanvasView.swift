import AppKit

enum CanvasLayoutMode {
    case screensaver
    case app
}

private enum BlockHeaderField: Int, CaseIterable {
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

private enum BlockHeaderFieldState {
    case pending
    case settled
    case active
    case done
}

private enum SyncPipelineStep: Int, CaseIterable {
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

private enum HashBuildSection: CaseIterable {
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
    private var state: SaverLotteryState?
    private var loadError: String?
    private var animationPhase: CGFloat = 0
    private var quoteIndex = 0
    private var quoteElapsed: CGFloat = 0
    private var timer: Timer?
    private var rainColumns: [RainColumn] = []
    private var rainBoundsSize: CGSize = .zero
    private var rainHashPool: [String] = []
    private var rainHashPoolKey = ""
    private var hashScrambles: [String: HashScrambleCycle] = [:]
    private var hashBuild: HashBuildCycle?
    private var hashBuildHeight = -1
    private var syncReplay: SyncReplayCycle?
    private var replayButtonFrame: CGRect = .zero
    private var replayButtonHovered = false
    private var syncReplayButtonFrame: CGRect = .zero
    private var syncReplayButtonHovered = false
    var layoutMode: CanvasLayoutMode = .screensaver
    var showDebugInfo = false
    var showsHashBuildReplayButton = false

    private struct SyncReplayCycle {
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

    private struct HashBuildCycle {
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

    private struct HashScrambleCycle {
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

    private static let hashPreviewLength = 28
    private static let scrambleEncryptedLeadIn: CGFloat = 6
    private static let scrambleSnapInterval: CGFloat = 0.38
    private static let scrambleLockedHoldSeconds: CGFloat = 15
    private static let scrambleCompleteHoldSeconds: CGFloat = 15
    private static let scrambleLockFlashSeconds: CGFloat = 0.45
    private static let scrambleFrameDt: CGFloat = 1.0 / 30.0
    private static let hashBuildPreviewLength = 32
    private static let nonceAssembleSeconds: CGFloat = 4.0
    private static let nonceDigestSeconds: CGFloat = 4.0
    private static let nonceSnapSeconds: CGFloat = 1.5
    private static let merkleBuildSeconds: CGFloat = 7.5
    private static let headerPackSeconds: CGFloat = 5.0
    private static let sha256RoundSeconds: CGFloat = 4.0
    private static let hashRevealSnapInterval: CGFloat = 0.14
    private static let hashBuildHoldSeconds: CGFloat = 10.0
    private static let hashBuildHeaderH: CGFloat = 18
    private static let hashBuildBodyH: CGFloat = 22
    private static let hashBuildHeaderBodyH: CGFloat = 30
    private static let hashBuildHashBodyH: CGFloat = 28
    private static let hashBuildMerkleBodyH: CGFloat = 68
    private static let hashBuildBlueprintH: CGFloat = 48
    private static let hashBuildCompactDetailH: CGFloat = 68
    private static let hashBuildCompletedRowH: CGFloat = 22
    private static let hashBuildColumnHeaderH: CGFloat = 18
    private static let hashBuildCompletedHeaderH: CGFloat = 16
    private static let hashBuildCurrentStepHeaderH: CGFloat = 18
    private static let hashBuildCompletedPlaceholderH: CGFloat = 18
    private static let syncPanelAppH: CGFloat = 440
    private static let syncReplayButtonH: CGFloat = 26
    private static let syncReplayWireSeconds: CGFloat = 5.5
    private static let syncReplayPruneSeconds: CGFloat = 4.5
    private static let syncReplayHoldSeconds: CGFloat = 2.5
    private static let headerPackFields: [BlockHeaderField] = [.ver, .prev, .time, .bits]
    private static let hashBuildSectionHoldSeconds: CGFloat = 2.2
    private static let hashBuildPackFieldHoldSeconds: CGFloat = 1.4
    private static let hashBuildStepGap: CGFloat = 5
    private static let hashBuildReplayButtonH: CGFloat = 26
    private static let nonceSnapFlashSeconds: CGFloat = 0.45
    private static let hashSnapFlashSeconds: CGFloat = 0.38
    private static let headerFieldFlashSeconds: CGFloat = 0.5

    private struct RainColumn {
        let x: CGFloat
        var offset: CGFloat
        let speed: CGFloat
        var chars: [Character]
        let spark: Bool

        var length: Int { chars.count }
    }

    private static let hexAlphabet: [Character] = Array("0123456789abcdef")
    private static let cyberAlphabet: [Character] = Array("0123456789ABCDEFアイウエオカキクケコサシスセソタチツテトハヒフヘホマミムメモヤユヨラリルレロワヲン░▒▓█╳╬╣╠┼┤┴┬│─@#$%&*<>")
    private let fontTiny: CGFloat = 16
    private let fontMicro: CGFloat = 18
    private let fontCaption: CGFloat = 20
    private let fontSmall: CGFloat = 22
    private let fontSubtitle: CGFloat = 24
    private let rainCharHeight: CGFloat = 28
    private let rainColumnSpacing: CGFloat = 30

    private struct Quote {
        let text: String
        let attribution: String?
    }

    private static let quotes: [Quote] = [
        Quote(text: "So you're tellin' me there's a chance?", attribution: "— Dumb and Dumber"),
        Quote(text: "The odds are astronomical — but not zero.", attribution: nil),
        Quote(text: "Someone wins every block. Why not you?", attribution: nil),
        Quote(text: "You miss 100% of the hashes you don't make.", attribution: nil),
        Quote(text: "Luck is probability taken personally.", attribution: nil),
        Quote(text: "Fortune favors the one who shows up.", attribution: nil),
        Quote(text: "One ticket per block. One shot at glory.", attribution: nil),
        Quote(text: "In a universe of noise, you still bought a ticket.", attribution: nil),
        Quote(text: "The lottery is hope with a timestamp.", attribution: nil),
        Quote(text: "Probability never sleeps — neither does the network.", attribution: nil),
        Quote(text: "A million to one? Those are practically certainties.", attribution: nil),
        Quote(text: "The chain doesn't care about your odds. Neither should you.", attribution: nil),
        Quote(text: "One in 2²⁵⁶ is still one.", attribution: nil),
        Quote(text: "Long odds are still odds.", attribution: nil),
        Quote(text: "Chance favors the prepared miner.", attribution: nil),
        Quote(text: "The dice don't remember the last roll.", attribution: nil),
        Quote(text: "Rare events happen all the time — just not to everyone.", attribution: nil),
        Quote(text: "Variance is cruel. Variance is also how winners exist.", attribution: nil),
        Quote(text: "Every hash is a roll of the cosmic dice.", attribution: nil),
        Quote(text: "The mempool doesn't know your odds.", attribution: nil),
        Quote(text: "Statistically improbable ≠ impossible.", attribution: nil),
        Quote(text: "Today's long shot is tomorrow's block reward.", attribution: nil),
        Quote(text: "Entropy doesn't play favorites.", attribution: nil),
        Quote(text: "Miracles are just rare events that finally happened.", attribution: nil),
        Quote(text: "You can't win the block you never hash.", attribution: nil),
        Quote(text: "Underneath every block header, someone's ticket matched.", attribution: nil),
        Quote(text: "The improbable becomes routine — every ten minutes.", attribution: nil),
        Quote(text: "Hope is not a strategy. Neither is quitting.", attribution: nil),
        Quote(text: "Against all odds, blocks still get found.", attribution: nil),
        Quote(text: "Your wallet won't care how unlikely it was.", attribution: nil),
        Quote(text: "You could solve a block by hand — pencil, paper, and a trillion years.", attribution: nil),
        Quote(text: "SHA-256 on paper is possible. Winning is the hard part.", attribution: nil),
        Quote(text: "Someone hashed a block by hand once. The network didn't mind.", attribution: nil),
        Quote(text: "The protocol doesn't care if you used an ASIC or a pencil.", attribution: nil),
        Quote(text: "Every nonce is a lottery number the universe hasn't read yet.", attribution: nil),
        Quote(text: "The difficulty adjusts. Your hope doesn't have to.", attribution: nil),
        Quote(text: "Lightning strikes somewhere on Earth every second. So do blocks.", attribution: nil),
        Quote(text: "Buy the ticket. Show up for the draw. Repeat every block.", attribution: nil),
        Quote(text: "The hash doesn't know it's supposed to be impossible.", attribution: nil),
        Quote(text: "Somewhere right now, a miner just got impossibly lucky.", attribution: nil),
        Quote(text: "Patience is a virtue. So is a working random number generator.", attribution: nil),
        Quote(text: "The block reward doesn't ask how many hashes you tried.", attribution: nil),
        Quote(text: "In an infinite multiverse, you've already won. In this one, keep hashing.", attribution: nil),
        Quote(text: "Odds are a suggestion. Blocks are a fact.", attribution: nil),
        Quote(text: "The only hash that matters is the one that hits.", attribution: nil),
        Quote(text: "Dream in satoshis. Mine in reality.", attribution: nil),
        Quote(text: "Every block is someone else's miracle — until it isn't.", attribution: nil),
        Quote(text: "Fortune favors the bold nonce.", attribution: nil),
        Quote(text: "The suspense is terrible. I hope it'll last.", attribution: "— Willy Wonka"),
        Quote(text: "We are the music makers, and we are the dreamers of dreams.", attribution: "— Willy Wonka"),
        Quote(text: "There's no earthly way of knowing which direction we are going.", attribution: "— Willy Wonka"),
        Quote(text: "Don't forget the man who got everything he wanted — he lived happily ever after.", attribution: "— Willy Wonka"),
        Quote(text: "93% perspiration, 6% electricity, 4% evaporation, and 2% butterscotch ripple.", attribution: "— Willy Wonka"),
        Quote(text: "So much time and so little to do. Wait. Strike that. Reverse it.", attribution: "— Willy Wonka"),
    ]
    private let secondsPerQuote: CGFloat = 14

    override var isFlipped: Bool { true }

    private struct Layout {
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
        Layout.documentSize(width: width, view: state?.viewMode ?? .matrixRain, mode: layoutMode)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateTrackingAreas()
        window?.acceptsMouseMovedEvents = showsHashBuildReplayButton
        if window != nil { startAnimating() } else { stopAnimating() }
    }

    func startAnimating() {
        stopAnimating()
        reloadState()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            animationPhase += 0.02
            quoteElapsed += 1.0 / 30.0
            if quoteElapsed >= secondsPerQuote {
                quoteElapsed = 0
                quoteIndex = (quoteIndex + 1) % Self.quotes.count
            }
            reloadState()
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
        guard showsHashBuildReplayButton else {
            super.mouseDown(with: event)
            return
        }
        let point = convert(event.locationInWindow, from: nil)
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
        let syncHovered = !syncReplayButtonFrame.isEmpty && syncReplayButtonFrame.contains(point)
        let hashHovered = !replayButtonFrame.isEmpty && replayButtonFrame.contains(point)
        if syncHovered != syncReplayButtonHovered || hashHovered != replayButtonHovered {
            syncReplayButtonHovered = syncHovered
            replayButtonHovered = hashHovered
            needsDisplay = true
        }
        super.mouseMoved(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let rect = bounds
        let viewMode = state?.viewMode ?? .matrixRain
        let layout = Layout(rect: rect, view: viewMode, mode: layoutMode)
        let ceremony = state?.display?.ceremonyActive == true

        drawBackground(in: rect, context: ctx, ceremony: ceremony, state: state, view: viewMode)

        if viewMode.showsWinnerPanel {
            drawWinnerPanel(in: rect, layout: layout, state: state, ceremony: ceremony, large: viewMode.largeWinnerPanel)
        }

        drawText(BitcoinBrand.format("BITCOIN LOTTERY"), at: CGPoint(x: rect.midX, y: layout.titleY), anchor: .topCenter,
                 size: 26, weight: .bold, color: .white)
        drawText("One ticket per block", at: CGPoint(x: rect.midX, y: layout.subtitleY), anchor: .topCenter,
                 size: fontSubtitle, weight: .semibold, color: NSColor(white: 0.75, alpha: 1))

        if state != nil {
            drawCyclingQuote(in: rect, layout: layout)
        } else {
            drawText(loadError ?? "Waiting for daemon…", at: CGPoint(x: rect.midX, y: layout.quoteY), anchor: .topCenter,
                     size: fontSmall, weight: .regular, color: NSColor(white: 0.5, alpha: 1))
        }

        if let display = state?.display {
            drawCountdownRing(in: rect, display: display, context: ctx)
        }

        if let state, let attempt = state.lastAttempt {
            let blockY = layout.centerBlockY
            let machineSeed = NonceTicket.resolvedMachineSeed(stored: state.machineSeed)
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

            if ceremony {
                drawCeremony(in: rect, attempt: attempt, machineSeed: machineSeed, build: hashBuild)
            } else {
                drawText("Block \(attempt.height)", at: CGPoint(x: rect.midX, y: blockY), anchor: .topCenter,
                         size: 40, weight: .heavy, color: NSColor(calibratedRed: 1, green: 0.6, blue: 0.1, alpha: 1))
            }

            if let build = hashBuild {
                drawHashBuild(in: layout, build: build, attemptNonce: attempt.nonce)
            } else {
                drawHashVisualization(hash: attempt.hashHex, in: layout.hashFrame)
            }

            if let prox = state.display?.hashProximity {
                drawProximityMeter(in: rect, proximity: prox, y: layout.proximityY)
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
            drawHashrateChart(in: layout.hashrateChart, display: display, context: ctx)
        } else {
            drawEmptyChart(in: layout.hashrateChart, title: "Network hashrate", subtitle: "Collecting…", context: ctx)
        }

        if let price = state?.price {
            drawPriceChart(in: layout.priceChart, price: price, context: ctx)
        } else {
            drawEmptyChart(in: layout.priceChart, title: "BTC price", subtitle: "Collecting…", context: ctx)
        }

        if let display = state?.display, display.nextHalvingHeight != nil {
            drawHalvingChart(in: layout.halvingChart, display: display, context: ctx)
        } else {
            drawEmptyChart(in: layout.halvingChart, title: "Next halving", subtitle: "Collecting…", context: ctx)
        }

        drawText("v\(LotteryVersion.string)", at: CGPoint(x: rect.maxX - layout.pad, y: rect.maxY - 10),
                 anchor: .topRight, size: fontMicro, weight: .regular, color: NSColor(white: 0.32, alpha: 1))

        if showDebugInfo {
            drawText("state: \(LotteryStateLoader.stateURL.path)", at: CGPoint(x: rect.midX, y: rect.maxY - 14),
                     anchor: .topCenter, size: fontMicro, weight: .regular, color: NSColor(white: 0.35, alpha: 1))
        }
    }

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

    private func advanceSyncReplay(_ cycle: inout SyncReplayCycle, dt: CGFloat) {
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

    private func drawSyncAnimationPanel(in panel: CGRect, mode: String?, node: SaverNodeStatus?, context: CGContext) {
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

    // MARK: - Quotes

    private func drawCyclingQuote(in rect: NSRect, layout: Layout) {
        let quote = Self.quotes[quoteIndex]
        let pulse = 0.75 + 0.25 * sin(animationPhase * 1.5)
        let color = NSColor(white: 0.45 + 0.15 * pulse, alpha: 1)
        drawText(quote.text, at: CGPoint(x: rect.midX, y: layout.quoteY), anchor: .topCenter,
                 size: fontSmall, weight: .medium, color: color)
        if let attribution = quote.attribution {
            drawText(attribution, at: CGPoint(x: rect.midX, y: layout.quoteAttribY), anchor: .topCenter,
                     size: fontMicro, weight: .regular, color: NSColor(white: 0.35, alpha: 1))
        }
    }

    // MARK: - Countdown

    private func drawCountdownRing(in rect: NSRect, display: SaverDisplay, context: CGContext) {
        let elapsed = CGFloat(display.blockElapsedSec ?? 0)
        let total = CGFloat(display.avgBlockSec ?? 600)
        let progress = min(1, elapsed / total)
        let center = CGPoint(x: rect.maxX - 72, y: 118)
        let radius: CGFloat = 38

        context.setStrokeColor(CGColor(gray: 0.25, alpha: 1))
        context.setLineWidth(4)
        context.addArc(center: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        context.strokePath()

        let end = -.pi / 2 + (.pi * 2 * progress)
        context.setStrokeColor(CGColor(red: 1, green: 0.65, blue: 0.15, alpha: 0.9))
        context.setLineWidth(4)
        context.setLineCap(.round)
        context.addArc(center: center, radius: radius, startAngle: -.pi / 2, endAngle: end, clockwise: false)
        context.strokePath()

        let mins = (display.blockCountdownSec ?? 0) / 60
        let secs = (display.blockCountdownSec ?? 0) % 60
        drawText(String(format: "%d:%02d", mins, secs), at: center, size: 13, weight: .bold, color: .white)
        drawText("next block", at: CGPoint(x: center.x, y: center.y + 52), anchor: .topCenter,
                 size: fontMicro, weight: .regular, color: NSColor(white: 0.55, alpha: 1))
    }

    // MARK: - Proximity

    private func drawProximityMeter(in rect: NSRect, proximity: SaverProximity, y: CGFloat) {
        let barRect = CGRect(x: rect.midX - 150, y: y, width: 300, height: 8)
        NSColor(white: 0.15, alpha: 1).setFill()
        NSBezierPath(roundedRect: barRect, xRadius: 4, yRadius: 4).fill()

        let fill = min(1, CGFloat(log10(max(proximity.percent, 1e-12)) / log10(100)))
        let glow = max(0.04, fill)
        let fillRect = CGRect(x: barRect.minX, y: barRect.minY, width: barRect.width * glow, height: barRect.height)
        NSColor(calibratedRed: 1, green: 0.55, blue: 0.1, alpha: 1).setFill()
        NSBezierPath(roundedRect: fillRect, xRadius: 4, yRadius: 4).fill()

        let label = proximity.won ? "TARGET HIT" : "Closeness \(proximity.label)  •  \(proximity.leadingZeroBits) zero bits"
        drawText(label, at: CGPoint(x: rect.midX, y: y + 18), anchor: .topCenter,
                 size: fontCaption, weight: .medium, color: NSColor(white: 0.6, alpha: 1))
    }

    // MARK: - Ceremony

    private func drawCeremony(
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

    private func beginHashBuildSectionHold(_ cycle: inout HashBuildCycle, next: HashBuildCycle.Phase) {
        guard cycle.pendingPhase == nil, cycle.sectionHold <= 0 else { return }
        cycle.pendingPhase = next
        cycle.sectionHold = Self.hashBuildSectionHoldSeconds
    }

    private func advanceHashBuild(_ cycle: inout HashBuildCycle, dt: CGFloat) {
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

    private func drawHashBuild(in layout: Layout, build: HashBuildCycle, attemptNonce: Int) {
        var panel = layout.hashBuildFrame
        if showsHashBuildReplayButton {
            panel.size.height -= Self.hashBuildReplayButtonH + 6
        }
        drawHashBuildVertical(in: panel, build: build, attemptNonce: attemptNonce)
        if build.phase == .hold {
            drawHashVisualization(hash: build.hashHex, in: layout.hashFrame)
        }
        if showsHashBuildReplayButton {
            let btnW: CGFloat = 156
            replayButtonFrame = CGRect(
                x: layout.hashBuildFrame.midX - btnW / 2,
                y: layout.hashBuildFrame.maxY - Self.hashBuildReplayButtonH - 6,
                width: btnW,
                height: Self.hashBuildReplayButtonH
            )
            drawReplayButton(in: replayButtonFrame, hovered: replayButtonHovered)
        } else {
            replayButtonFrame = .zero
        }
    }

    private func hashBuildPhaseOrder(_ phase: HashBuildCycle.Phase) -> Int {
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

    private func hashBuildSectionCompleted(_ section: HashBuildSection, build: HashBuildCycle) -> Bool {
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

    private func resolvedMerkleRootHex(for build: HashBuildCycle) -> String {
        if !build.merkleRootHex.isEmpty { return build.merkleRootHex }
        return String(format: "%08x", build.blockHeight) + String(repeating: "0", count: 56)
    }

    private func hashBuildCompletedSections(for build: HashBuildCycle) -> [HashBuildSection] {
        HashBuildSection.allCases.filter { hashBuildSectionCompleted($0, build: build) }
    }

    private func hashBuildSectionValue(
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

    private func drawHashBuildCompletedSections(
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

    private func blockHeaderBlueprintContext(
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

    private func blockHeaderCellText(
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

    private func hashBuildStatus(for build: HashBuildCycle, attemptNonce: Int) -> (title: String, detail: String) {
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

    private func drawBlockHeaderBlueprint(in frame: CGRect, build: HashBuildCycle, attemptNonce: Int) {
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

    private func drawHashBuildPhaseDetail(in frame: CGRect, build: HashBuildCycle, attemptNonce: Int) {
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

    private func hashBuildHeaderColumnHeight(completedCount: Int) -> CGFloat {
        let rowsH = completedCount > 0
            ? CGFloat(completedCount) * (Self.hashBuildCompletedRowH + 3) - 3
            : Self.hashBuildCompletedPlaceholderH
        return 10
            + Self.hashBuildColumnHeaderH + 6
            + Self.hashBuildBlueprintH + 10
            + Self.hashBuildCompletedHeaderH + 4
            + rowsH + 10
    }

    private func drawHashBuildHeaderColumn(
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

    private func drawHashBuildVertical(in frame: CGRect, build: HashBuildCycle, attemptNonce: Int) {
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

    private func drawSha256LineProgress(in body: CGRect, progress: CGFloat, hashHex: String) {
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

    private func drawReplayButton(in frame: CGRect, hovered: Bool, label: String = "↻ Replay animation") {
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

    private func drawHashBuildNonceStep(
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

    private func drawHashBuildSummaryChip(
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

    private func drawHashBuildWaiting(in frame: CGRect, label: String, detail: String) {
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

    private func merkleTxHashSeed(blockHeight: Int, index: Int, rootHex: String) -> UInt32 {
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

    private func merkleParticleLabel(blockHeight: Int, index: Int, rootHex: String, mergeLevel: Int) -> String {
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

    private func merkleLeafX(frame: CGRect, index: Int, count: Int) -> CGFloat {
        let slot = count > 1 ? CGFloat(index) / CGFloat(count - 1) : 0.5
        return frame.minX + 8 + slot * (frame.width - 16)
    }

    private func drawMerkleTreeNode(
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

    private func drawMerkleBuildAnimation(in frame: CGRect, build: HashBuildCycle) {
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

    private func drawAnimatedBlockHeader(
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

    private func drawSha256Round(in frame: CGRect, round: Int, elapsed: CGFloat, hashHex: String) {
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

    private func drawAnimatedHashReveal(in frame: CGRect, build: HashBuildCycle, inset: Bool = false) {
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

    private func drawNonceTicketChip(
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

    private func drawBlockHeaderDiagram(in frame: CGRect, nonce: Int, pulse: CGFloat) {
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

    // MARK: - Charts

    private func drawEmptyChart(in chart: CGRect, title: String, subtitle: String, context: CGContext) {
        NSColor(white: 0.08, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: chart, xRadius: 8, yRadius: 8).fill()
        drawText(title, at: CGPoint(x: chart.minX + 10, y: chart.minY + 8), anchor: .topLeft,
                 size: fontSmall, weight: .semibold, color: NSColor(white: 0.55, alpha: 1))
        drawText(subtitle, at: CGPoint(x: chart.midX, y: chart.midY), anchor: .topCenter,
                 size: fontCaption, weight: .regular, color: NSColor(white: 0.4, alpha: 1))
    }

    private func drawHashrateChart(in chart: CGRect, display: SaverDisplay, context: CGContext) {
        NSColor(white: 0.08, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: chart, xRadius: 8, yRadius: 8).fill()

        let current = display.networkHashrateEh ?? display.networkHashrateHistory?.last?.eh
        let title = current.map { String(format: "Network %.0f EH/s", $0) } ?? "Network hashrate"
        drawText(title, at: CGPoint(x: chart.minX + 10, y: chart.minY + 8), anchor: .topLeft,
                 size: fontSmall, weight: .semibold, color: NSColor(calibratedRed: 1, green: 0.55, blue: 0.2, alpha: 1))
        drawText("1 week", at: CGPoint(x: chart.maxX - 10, y: chart.minY + 8), anchor: .topRight,
                 size: fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))

        let points = display.networkHashrateHistory ?? []
        guard points.count >= 2 else {
            drawText("Collecting hashrate history…", at: CGPoint(x: chart.midX, y: chart.midY), anchor: .topCenter,
                     size: fontCaption, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
            return
        }

        drawSparkline(
            in: chart,
            values: points.map(\.eh),
            padY: 40,
            stroke: NSColor(calibratedRed: 1, green: 0.55, blue: 0.15, alpha: 0.95),
            fill: NSColor(calibratedRed: 0.55, green: 0.25, blue: 0.05, alpha: 0.35),
            formatValue: { String(format: "%.0f", $0) }
        )
    }

    private func drawHalvingChart(in chart: CGRect, display: SaverDisplay, context: CGContext) {
        NSColor(white: 0.08, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: chart, xRadius: 8, yRadius: 8).fill()

        let subsidy = display.blockSubsidyBtc ?? 3.125
        let blocksUntil = display.blocksUntilHalving ?? 0
        let countdown = display.halvingCountdownSec ?? 0
        let progress = CGFloat(display.halvingEpochProgress ?? 0)
        let nextHeight = display.nextHalvingHeight ?? 0

        drawText(String(format: "Reward %.3f BTC", subsidy), at: CGPoint(x: chart.minX + 10, y: chart.minY + 8), anchor: .topLeft,
                 size: fontSmall, weight: .semibold, color: NSColor(calibratedRed: 1, green: 0.75, blue: 0.2, alpha: 1))
        drawText(Self.formatHalvingETA(countdown), at: CGPoint(x: chart.maxX - 10, y: chart.minY + 8), anchor: .topRight,
                 size: fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))

        let detail = "Block \(Self.formatGrouped(nextHeight))  •  \(Self.formatGrouped(blocksUntil)) blocks left"
        drawText(detail, at: CGPoint(x: chart.midX, y: chart.minY + 34), anchor: .topCenter,
                 size: fontMicro, weight: .medium, color: NSColor(white: 0.55, alpha: 1))

        let barRect = CGRect(x: chart.minX + 10, y: chart.maxY - 24, width: chart.width - 20, height: 12)
        NSColor(white: 0.14, alpha: 1).setFill()
        NSBezierPath(roundedRect: barRect, xRadius: 4, yRadius: 4).fill()
        if progress > 0 {
            let fillRect = CGRect(x: barRect.minX, y: barRect.minY, width: barRect.width * min(1, progress), height: barRect.height)
            NSColor(calibratedRed: 1, green: 0.62, blue: 0.12, alpha: 1).setFill()
            NSBezierPath(roundedRect: fillRect, xRadius: 4, yRadius: 4).fill()
        }
        drawText(String(format: "%.0f%% of era", progress * 100), at: CGPoint(x: chart.midX, y: barRect.minY - 4), anchor: .topCenter,
                 size: fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
    }

    private static func formatHalvingETA(_ seconds: Int) -> String {
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        if days > 0 { return "~\(days)d \(hours)h" }
        if hours > 0 { return "~\(hours)h" }
        return "~\(max(1, seconds / 60))m"
    }

    private func drawPriceChart(in chart: CGRect, price: SaverPrice, context: CGContext) {
        NSColor(white: 0.08, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: chart, xRadius: 8, yRadius: 8).fill()

        drawText("BTC \(Self.formatUSD(price.usd))", at: CGPoint(x: chart.minX + 10, y: chart.minY + 8), anchor: .topLeft,
                 size: fontSmall, weight: .semibold, color: NSColor(calibratedRed: 0.3, green: 0.9, blue: 0.5, alpha: 1))

        if let interval = price.pollIntervalMin {
            drawText("every \(interval)m", at: CGPoint(x: chart.maxX - 10, y: chart.minY + 8), anchor: .topRight,
                     size: fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
        }

        let points = price.history
        guard points.count >= 2 else {
            drawText("Collecting price history…", at: CGPoint(x: chart.midX, y: chart.midY), anchor: .topCenter,
                     size: fontCaption, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
            return
        }

        drawSparkline(
            in: chart,
            values: points.map(\.usd),
            padY: 40,
            stroke: NSColor(calibratedRed: 0.3, green: 0.9, blue: 0.45, alpha: 0.95),
            fill: NSColor(calibratedRed: 0.15, green: 0.55, blue: 0.25, alpha: 0.35),
            formatValue: { Self.formatUSD($0) }
        )
    }

    private func drawSparkline(
        in chart: CGRect,
        values: [Double],
        padY: CGFloat,
        stroke: NSColor,
        fill: NSColor,
        formatValue: (Double) -> String
    ) {
        guard let minV = values.min(), let maxV = values.max(), maxV > minV else { return }
        let plotH = chart.height - padY - 8
        let plotW = chart.width - 20
        let step = plotW / CGFloat(values.count - 1)

        let linePath = NSBezierPath()
        let fillPath = NSBezierPath()
        for (i, v) in values.enumerated() {
            let x = chart.minX + 10 + CGFloat(i) * step
            let norm = CGFloat((v - minV) / (maxV - minV))
            let y = chart.minY + padY + norm * plotH
            let pt = CGPoint(x: x, y: y)
            if i == 0 {
                linePath.move(to: pt)
                fillPath.move(to: CGPoint(x: x, y: chart.minY + padY))
                fillPath.line(to: pt)
            } else {
                linePath.line(to: pt)
                fillPath.line(to: pt)
            }
        }
        fillPath.line(to: CGPoint(x: chart.maxX - 10, y: chart.minY + padY))
        fillPath.close()

        fill.setFill()
        fillPath.fill()
        stroke.setStroke()
        linePath.lineWidth = 1.5
        linePath.stroke()

        if let last = values.last {
            let x = chart.maxX - 10
            let norm = CGFloat((last - minV) / (maxV - minV))
            let y = chart.minY + padY + norm * plotH
            stroke.setFill()
            NSBezierPath(ovalIn: CGRect(x: x - 3, y: y - 3, width: 6, height: 6)).fill()
        }

        drawText(formatValue(maxV), at: CGPoint(x: chart.maxX - 10, y: chart.minY + padY + plotH + 2), anchor: .topRight,
                 size: fontTiny, weight: .regular, color: NSColor(white: 0.4, alpha: 1))
        drawText(formatValue(minV), at: CGPoint(x: chart.maxX - 10, y: chart.minY + padY - 2), anchor: .topRight,
                 size: fontTiny, weight: .regular, color: NSColor(white: 0.4, alpha: 1))
    }

    // MARK: - Background & hash

    private func drawBackground(
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

    private func drawWinnerPanel(
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

    private func drawHashMatchBridges(winnerFrame: CGRect, yoursFrame: CGRect, matchCount: Int, charCount: Int) {
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

    private func drawComparedHash(
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

    private func advanceHashScramble(
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

    private func tickFlashTimers(_ timers: inout [Int: CGFloat], dt: CGFloat) {
        guard !timers.isEmpty else { return }
        for slot in Array(timers.keys) {
            timers[slot, default: 0] -= dt
            if timers[slot, default: 0] <= 0 {
                timers.removeValue(forKey: slot)
            }
        }
    }

    private func tickHeaderFlashTimers(_ timers: inout [BlockHeaderField: CGFloat], dt: CGFloat) {
        guard !timers.isEmpty else { return }
        for field in Array(timers.keys) {
            timers[field, default: 0] -= dt
            if timers[field, default: 0] <= 0 {
                timers.removeValue(forKey: field)
            }
        }
    }

    private func tickFlashTimers(_ cycle: inout HashScrambleCycle, dt: CGFloat) {
        tickFlashTimers(&cycle.flashUntil, dt: dt)
    }

    private func monospaceCharHeight(size: CGFloat, weight: NSFont.Weight) -> CGFloat {
        let font = Self.resolveFont(monospaced: true, size: size, weight: weight)
        return NSAttributedString(string: "8", attributes: [.font: font]).size().height
    }

    private func cryptStreamChar(seed: Int, depth: Int = 0) -> Character {
        let alphabet = Self.cyberAlphabet
        let idx = Int(floor(animationPhase * 14 + CGFloat(seed) * 0.63 + CGFloat(depth) * 0.55)) % alphabet.count
        return alphabet[max(0, idx)]
    }

    private func drawMatrixCryptBackdrop(in frame: CGRect, intensity: CGFloat = 0.32, seed: Int = 0) {
        let colSpacing: CGFloat = 20
        let cols = max(1, Int(frame.width / colSpacing))
        for c in 0..<cols {
            let x = frame.minX + CGFloat(c) * colSpacing + 6
            let streamLen = 3 + (c % 4)
            let phaseOffset = CGFloat(c) * 0.55 + animationPhase * 4
            let travel = max(16, frame.height - CGFloat(streamLen) * 14)
            for d in 0..<streamLen {
                let y = frame.minY + 4 + (phaseOffset * 18 + CGFloat(d) * 14).truncatingRemainder(dividingBy: travel)
                let ch = cryptStreamChar(seed: seed + c * 13 + d * 5, depth: d)
                let alpha = intensity * (d == 0 ? 0.55 : max(0.06, 0.3 - CGFloat(d) * 0.09))
                let color: NSColor = d == 0
                    ? NSColor(calibratedRed: 1, green: 0.65, blue: 0.12, alpha: alpha)
                    : NSColor(calibratedRed: 0.1, green: 0.36, blue: 0.32, alpha: alpha * 0.85)
                drawMonospaceText(String(ch), at: CGPoint(x: x, y: y), size: fontTiny - 2, weight: .regular, color: color)
            }
        }
    }

    private func drawCryptHexRow(
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
                    at: x, centerY: centerY, slotIndex: seed + i, realChar: ch,
                    cellWidth: spacing, rowHeight: rowHeight, size: max(12, size - 2),
                    yours: yours, snapped: false, flashStrength: 0
                )
            }
        }
    }

    private func drawLockFlashCell(at x: CGFloat, centerY: CGFloat, cellWidth: CGFloat, rowHeight: CGFloat) {
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

    private func drawEncryptedCharSlot(
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
        let phase = animationPhase * 14 + CGFloat(slotIndex) * 0.63
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

    private func ensureRainColumns(for rect: NSRect) {
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

    private static func realHashPool(from state: SaverLotteryState?) -> [String] {
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

    private func updateRainFromRealHashes(_ hashes: [String]) {
        rainHashPool = hashes
        let key = hashes.joined(separator: "|")
        guard key != rainHashPoolKey, !rainColumns.isEmpty else { return }
        rainHashPoolKey = key
        guard !hashes.isEmpty else { return }
        for i in rainColumns.indices {
            rainColumns[i].chars = Self.charsFromHashPool(hashes, column: i, count: rainColumns[i].chars.count)
        }
    }

    private static func charsFromHashPool(_ hashes: [String], column: Int, count: Int) -> [Character] {
        let hashChars = Array(hashes[column % hashes.count].filter { hexAlphabet.contains($0) })
        guard !hashChars.isEmpty else { return randomHexChars(count: count) }
        let start = (column * 5) % hashChars.count
        return (0..<count).map { hashChars[(start + $0) % hashChars.count] }
    }

    private func updateRainColumns(in rect: NSRect, ceremony: Bool) {
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

    private func drawHashRain(in rect: NSRect, ceremony: Bool) {
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

    private func rainTrailColor(distance: Int, length: Int, spark: Bool, ceremony: Bool) -> NSColor {
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

    private static func randomHexChars(count: Int) -> [Character] {
        (0..<count).map { _ in hexAlphabet[Int.random(in: 0..<hexAlphabet.count)] }
    }

    private static func leadingZeroHexChars(in hash: String) -> Int {
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

    private static func isHexHash(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 8 else { return false }
        return trimmed.allSatisfy { $0.isHexDigit }
    }

    private static func resolveFont(monospaced: Bool, size: CGFloat, weight: NSFont.Weight) -> NSFont {
        let pointSize = max(8, size)
        if monospaced {
            let font = NSFont.monospacedSystemFont(ofSize: pointSize, weight: weight)
            if font.pointSize > 0 { return font }
            return NSFont.userFixedPitchFont(ofSize: pointSize) ?? NSFont.systemFont(ofSize: pointSize, weight: .regular)
        }
        return NSFont.systemFont(ofSize: pointSize, weight: weight)
    }

    private enum MonospaceAnchor {
        case topLeft, topCenter, topRight
    }

    private func drawMonospaceText(
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

    private func drawMonospaceTextCentered(
        _ text: String,
        at center: CGPoint,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor
    ) {
        drawMonospaceText(text, at: center, size: size, weight: weight, color: color, anchor: .topCenter)
    }

    private func drawFittedMonospace(
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

    private func monospaceTextSize(_ text: String, size: CGFloat, weight: NSFont.Weight) -> CGSize {
        let font = Self.resolveFont(monospaced: true, size: size, weight: weight)
        return NSAttributedString(string: text, attributes: [.font: font]).size()
    }

    private func truncateMonospace(_ text: String, maxWidth: CGFloat, size: CGFloat) -> String {
        guard monospaceTextSize(text, size: size, weight: .medium).width > maxWidth else { return text }
        var clipped = text
        while clipped.count > 1, monospaceTextSize(clipped + "…", size: size, weight: .medium).width > maxWidth {
            clipped.removeLast()
        }
        return clipped + "…"
    }

    private func drawHashVisualization(hash: String, in frame: CGRect) {
        let chars = Array(hash.prefix(32))
        guard !chars.isEmpty else { return }
        let spacing = frame.width / CGFloat(chars.count)
        for (i, ch) in chars.enumerated() {
            let brightness = 0.35 + 0.65 * abs(sin(animationPhase * 2 + CGFloat(i) * 0.4))
            let color = NSColor(calibratedRed: 1, green: CGFloat(brightness) * 0.7, blue: 0.15, alpha: 1)
            drawText(String(ch), at: CGPoint(x: frame.minX + spacing * (CGFloat(i) + 0.5), y: frame.midY),
                     size: 16, weight: .bold, color: color)
        }
    }

    // MARK: - Formatting

    private static func nodeStatusPresentation(mode: String?, node: SaverNodeStatus?) -> (text: String, color: NSColor) {
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

    private static func formatGrouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.groupingSeparator = ","
        formatter.usesGroupingSeparator = true
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    private static func formatUSD(_ value: Double) -> String {
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

    // MARK: - Text

    private enum TextAnchor {
        case center, topCenter, topLeft, topRight
    }

    private func drawText(
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

    private func drawWrappedText(
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
}