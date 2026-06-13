import AppKit

@main
final class PreviewAppDelegate: NSObject, NSApplicationDelegate {
    private var lottery: LotteryWindowController!

    static func main() {
        let app = NSApplication.shared
        let delegate = PreviewAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        lottery = LotteryWindowController(
            title: BitcoinBrand.format("Bitcoin Lottery Preview (v\(LotteryVersion.string))"),
            showDebugInfo: true
        )
        lottery.showLottery()

        let menu = NSMenu()
        let appMenu = NSMenuItem()
        menu.addItem(appMenu)
        let submenu = NSMenu()
        submenu.addItem(withTitle: "Refresh", action: #selector(refresh), keyEquivalent: "r")
        submenu.addItem(withTitle: "Replay Animation", action: #selector(replayAnimation), keyEquivalent: "a")
        submenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenu.submenu = submenu
        NSApp.mainMenu = menu
    }

    @objc private func refresh() {
        lottery.refresh()
    }

    @objc private func replayAnimation() {
        lottery.replayAnimation()
    }
}