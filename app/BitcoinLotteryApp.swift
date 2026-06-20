import AppKit

extension Notification.Name {
    static let bitcoinLotteryConfigDidSave = Notification.Name("BitcoinLotteryConfigDidSave")
}

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusMenu = NSMenu()
    private var timer: Timer?
    private var dashboard: DashboardWindowController?
    private var lottery: LotteryWindowController?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.target = self
            button.action = #selector(statusBarButtonClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        dashboard = DashboardWindowController()
        NotificationManager.shared.requestAuthorizationIfNeeded()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(configDidSave),
            name: .bitcoinLotteryConfigDidSave,
            object: nil
        )
        updateMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.updateMenu()
        }
    }

    @objc private func statusBarButtonClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else {
            statusMenu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
            return
        }
        let isRightClick = event.type == .rightMouseUp
            || event.type == .rightMouseDown
            || event.buttonNumber == 1
            || event.modifierFlags.contains(.control)
        if isRightClick {
            openLottery()
        } else {
            statusMenu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
        }
    }

    private func addMenuItem(_ menu: NSMenu, title: String, action: Selector?, key: String = "") -> NSMenuItem {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        item.target = action == nil ? nil : self
        return item
    }

    private func updateMenu() {
        guard let button = statusItem.button else { return }
        let state = LotteryState.load()
        let config = LotteryConfig.load()
        let display = MenuBarDisplay.from(config: config)
        button.title = MenuBarDisplay.statusBarTitle(state: state, config: config)
        NotificationManager.shared.evaluate(state: state, config: config)

        let payout = resolvedPayoutAddress(config: config, state: state)
        statusMenu.removeAllItems()
        addMenuItem(statusMenu, title: "Lottery… (or right-click ₿)", action: #selector(openLottery), key: "l")
        addMenuItem(statusMenu, title: "Settings…", action: #selector(openDashboard), key: "d")
        addMenuItem(statusMenu, title: BitcoinBrand.format("Bitcoin Core Setup…"), action: #selector(openNodeSetup), key: "b")
        statusMenu.addItem(.separator())
        let mode = state?.mode ?? config?.mode ?? "symbolic"
        addMenuItem(statusMenu, title: mode == "live" ? "Mode: Live (needs synced node)" : "Mode: Practice (no node needed)", action: nil)
        statusMenu.addItem(.separator())

        let menuBarSubmenu = NSMenu()
        for option in MenuBarDisplay.allCases {
            let item = menuBarSubmenu.addItem(
                withTitle: option.menuLabel,
                action: #selector(setMenuBarDisplay(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = option.rawValue
            item.state = option == display ? .on : .off
        }
        let menuBarItem = NSMenuItem(title: "Menu bar shows", action: nil, keyEquivalent: "")
        menuBarItem.submenu = menuBarSubmenu
        statusMenu.addItem(menuBarItem)

        let browserSubmenu = NSMenu()
        let currentBrowser = UserDefaults.standard.string(forKey: Self.browserDefaultsKey) ?? "default"
        for choice in Self.browserChoices() {
            let item = browserSubmenu.addItem(withTitle: choice.name, action: #selector(setDashboardBrowser(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = choice.id
            item.state = choice.id == currentBrowser ? .on : .off
        }
        let browserItem = NSMenuItem(title: "Open dashboard in", action: nil, keyEquivalent: "")
        browserItem.submenu = browserSubmenu
        statusMenu.addItem(browserItem)
        statusMenu.addItem(.separator())

        if let state, let attempt = state.lastAttempt {
            addMenuItem(statusMenu, title: "Block \(attempt.height) — Ticket #\(attempt.nonce)", action: nil)
            addMenuItem(statusMenu, title: attempt.won ? "JACKPOT!" : "Last: no match", action: nil)
            if mode == "live" {
                let live = state.stats.liveAttempts ?? 0
                addMenuItem(statusMenu, title: "Live tickets submitted: \(live)", action: nil)
            } else {
                addMenuItem(statusMenu, title: "Attempts: \(state.stats.totalAttempts)", action: nil)
            }
        }
        if let prox = state?.display?.hashProximity {
            let closeness = prox.won == true ? "JACKPOT" : Formatters.closeness(prox.percent ?? 0)
            addMenuItem(statusMenu, title: "Closeness: \(closeness)", action: nil)
        }
        if let price = state?.price?.usd {
            addMenuItem(statusMenu, title: "BTC price: \(Formatters.usd(price))", action: nil)
        }
        if !payout.isEmpty {
            addMenuItem(statusMenu, title: "Payout: \(maskAddress(payout))", action: nil)
        } else {
            addMenuItem(statusMenu, title: "⚠ Payout wallet not set", action: #selector(openDashboard))
        }
        if mode == "live", let node = state?.node {
            addMenuItem(statusMenu, title: node.menuSummary, action: nil)
        }
        if config?.showWalletBalance == true, !payout.isEmpty {
            if let balance = state?.walletBalance?.btc {
                let detail = balance == 0 && (state?.walletBalance?.txCount ?? 0) == 0
                    ? "Wallet balance: 0 BTC (no on-chain txs yet)"
                    : "Wallet balance: \(Formatters.btc(balance))"
                addMenuItem(statusMenu, title: detail, action: nil)
            } else if let err = state?.walletBalance?.lastError {
                addMenuItem(statusMenu, title: "Wallet balance: unavailable (\(err))", action: nil)
            }
        }
        statusMenu.addItem(.separator())
        addMenuItem(statusMenu, title: "Version \(LotteryVersion.string)", action: nil)
        addMenuItem(statusMenu, title: "Quit", action: #selector(NSApplication.terminate(_:)), key: "q")
    }

    @objc private func configDidSave() {
        updateMenu()
        lottery?.refresh()
    }

    @objc private func setMenuBarDisplay(_ sender: NSMenuItem) {
        guard var config = LotteryConfig.load(),
              let raw = sender.representedObject as? String,
              MenuBarDisplay(rawValue: raw) != nil else { return }
        config.menuBarDisplay = raw
        try? config.save()
        updateMenu()
        dashboard?.refresh()
    }

    @objc private func openDashboard() {
        if dashboard == nil {
            dashboard = DashboardWindowController()
        }
        dashboard?.showDashboard()
    }

    @objc private func openNodeSetup() {
        if dashboard == nil {
            dashboard = DashboardWindowController()
        }
        dashboard?.showDashboard(scrollToNodeSetup: true)
    }

    // The dashboard now lives in the browser (cross-platform). The menu bar opens it.
    // Dev: local server. TODO: swap to the GitHub Pages URL when we ship.
    private static let dashboardURL = "http://localhost:8787/"
    private static let browserDefaultsKey = "BitcoinLottery.dashboardBrowser"

    /// "Default browser" plus whichever known browsers are actually installed.
    private static func browserChoices() -> [(name: String, id: String)] {
        var list: [(String, String)] = [("Default browser", "default")]
        let known = [
            ("Safari", "com.apple.Safari"),
            ("Google Chrome", "com.google.Chrome"),
            ("Brave", "com.brave.Browser"),
            ("Firefox", "org.mozilla.firefox"),
            ("Arc", "company.thebrowser.Browser"),
        ]
        for (name, bid) in known where NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) != nil {
            list.append((name, bid))
        }
        return list
    }

    @objc private func setDashboardBrowser(_ sender: NSMenuItem) {
        guard let bid = sender.representedObject as? String else { return }
        UserDefaults.standard.set(bid, forKey: Self.browserDefaultsKey)
        updateMenu()
    }

    @objc private func openLottery() {
        guard let url = URL(string: Self.dashboardURL) else { return }
        let bid = UserDefaults.standard.string(forKey: Self.browserDefaultsKey) ?? "default"
        if bid != "default", let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) {
            NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
        } else {
            NSWorkspace.shared.open(url)
        }
    }

}