import AppKit

/// Scrollable lottery window used by the main app and preview.
final class LotteryWindowController: NSWindowController, NSWindowDelegate {
    private let scrollView = NSScrollView()
    private let canvas = LotteryCanvasView()
    var onWindowWillClose: (() -> Void)?

    init(title: String, showDebugInfo: Bool = false) {
        canvas.layoutMode = .app
        canvas.showDebugInfo = showDebugInfo
        canvas.showsHashBuildReplayButton = true

        scrollView.documentView = canvas
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 920, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.contentView = scrollView
        window.setFrameAutosaveName("BitcoinLotteryWindow")
        window.minSize = NSSize(width: 640, height: 480)

        super.init(window: window)
        window.delegate = self
        relayoutDocument()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    var lotteryCanvas: LotteryCanvasView { canvas }

    func showLottery(activateApp: Bool = true) {
        relayoutDocument()
        window?.center()
        showWindow(self)
        window?.makeKeyAndOrderFront(nil)
        if activateApp {
            NSApp.activate(ignoringOtherApps: true)
        }
        canvas.startAnimating()
    }

    func refresh() {
        canvas.reloadState()
        relayoutDocument()
        canvas.needsDisplay = true
    }

    func replayAnimation() {
        canvas.replayHashBuildAnimation()
    }

    func replaySyncSegment() {
        canvas.replaySyncSegmentAnimation()
    }

    func relayoutDocument() {
        guard let window else { return }
        scrollView.layoutSubtreeIfNeeded()
        let width = max(320, scrollView.contentSize.width)
        let size = canvas.documentSize(forWidth: width)
        if canvas.frame.size != size {
            canvas.frame = NSRect(origin: .zero, size: size)
            scrollView.documentView = canvas
        }
        window.contentMinSize = NSSize(width: 640, height: 480)
    }

    func windowDidResize(_ notification: Notification) {
        relayoutDocument()
    }

    func windowWillClose(_ notification: Notification) {
        canvas.stopAnimating()
        onWindowWillClose?()
    }
}