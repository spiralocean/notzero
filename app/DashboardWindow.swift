import AppKit

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private struct SettingsSnapshot {
    let payoutAddress: String
    let machineSeed: String
    let live: Bool
    let pricePollIntervalMin: Int
    let menuBarDisplay: String
    let notificationsEnabled: Bool
    let notifyClosenessAboveZero: Bool
    let notifyBlockWon: Bool
    let notifyNodeSynced: Bool
    let notifyNodeOutOfSync: Bool
    let showWalletBalance: Bool
}

final class DashboardWindowController: NSWindowController, NSWindowDelegate {
    private let scrollView = NSScrollView()
    private let documentView = FlippedView()
    private let footerView = NSView()
    private var payoutField = NSTextField()
    private var showWalletBalanceBox = NSButton()
    private var walletBalanceLabel = NSTextField(labelWithString: "")
    private var versionLabel = NSTextField(labelWithString: "")
    private var modeControl = NSSegmentedControl(labels: ["Practice", "Live"], trackingMode: .selectOne, target: nil, action: nil)
    private var modeHelpLabel = NSTextField(labelWithString: "")
    private var machineSeedField = NSTextField()
    private var machineSeedHelpLabel = NSTextField(labelWithString: "")
    private var noncePreviewLabel = NSTextField(labelWithString: "")
    private var nodeHelpLabel = NSTextField(labelWithString: "")
    private var statusBanner = NSTextField(labelWithString: "")
    private var nodeStatusLabel = NSTextField(labelWithString: "")
    private var nodeSetupSummaryLabel = NSTextField(labelWithString: "")
    private var syncBar = NSProgressIndicator()
    private var setupPrunedNodeButton = NSButton()
    private var installBitcoinCoreButton = NSButton()
    private var startBitcoinCoreButton = NSButton()
    private var ticketLabel = NSTextField(labelWithString: "—")
    private var hashLabel = NSTextField(labelWithString: "—")
    private var attemptsLabel = NSTextField(labelWithString: "—")
    private var blockLabel = NSTextField(labelWithString: "—")
    private var priceLabel = NSTextField(labelWithString: "—")
    private var countdownLabel = NSTextField(labelWithString: "—")
    private var proximityLabel = NSTextField(labelWithString: "—")
    private var halvingLabel = NSTextField(labelWithString: "—")
    private var priceIntervalField = NSTextField()
    private var menuBarDisplayControl = NSSegmentedControl(labels: ["Block", "Price", "Closeness"], trackingMode: .selectOne, target: nil, action: nil)
    private var notificationsEnabledBox = NSButton()
    private var notifyClosenessBox = NSButton()
    private var notifyJackpotBox = NSButton()
    private var notifyNodeSyncedBox = NSButton()
    private var notifyNodeOutOfSyncBox = NSButton()
    private var testNotificationButton = NSButton()
    private var saveButton = NSButton()
    private var daemonHelpLabel = NSTextField(labelWithString: "")
    private var daemonStatusLabel = NSTextField(labelWithString: "")
    private var stopDaemonButton = NSButton()
    private var startDaemonButton = NSButton()
    private var uninstallDaemonButton = NSButton()
    private var refreshTimer: Timer?
    private var nodeSectionScrollY: CGFloat = 0
    private var titleLabel = NSTextField(labelWithString: "")
    private var subtitleLabel = NSTextField(labelWithString: "")
    private var introLabel = NSTextField(wrappingLabelWithString: "")
    private var walletHelpLabel = NSTextField(wrappingLabelWithString: "")
    private var menuBarHelpLabel = NSTextField(wrappingLabelWithString: "")
    private var notifyHelpLabel = NSTextField(wrappingLabelWithString: "")
    private var priceIntervalCaption = NSTextField(labelWithString: "")
    private var sectionMiningLabel = NSTextField(labelWithString: "")
    private var sectionWalletLabel = NSTextField(labelWithString: "")
    private var sectionTicketLabel = NSTextField(labelWithString: "")
    private var sectionStatsLabel = NSTextField(labelWithString: "")
    private var sectionPriceLabel = NSTextField(labelWithString: "")
    private var sectionMenuBarLabel = NSTextField(labelWithString: "")
    private var sectionNotifyLabel = NSTextField(labelWithString: "")
    private var sectionNodeLabel = NSTextField(labelWithString: "")
    private var sectionDaemonLabel = NSTextField(labelWithString: "")

    private static let contentPad: CGFloat = 24
    private static let itemGap: CGFloat = 10
    private static let sectionGap: CGFloat = 18

    private func brand(_ text: String) -> String { BitcoinBrand.format(text) }

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = BitcoinBrand.format("Bitcoin Lottery Settings (v\(LotteryVersion.string))")
        window.minSize = NSSize(width: 480, height: 560)
        super.init(window: window)
        window.delegate = self
        buildUI()
        refresh()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func buildUI() {
        guard let content = window?.contentView else { return }

        footerView.translatesAutoresizingMaskIntoConstraints = false
        footerView.wantsLayer = true
        footerView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        content.addSubview(footerView)

        saveButton = NSButton(title: "Save wallet & settings", target: self, action: #selector(saveSettings))
        saveButton.bezelStyle = .rounded
        saveButton.keyEquivalent = "\r"
        saveButton.translatesAutoresizingMaskIntoConstraints = false
        footerView.addSubview(saveButton)

        let refreshButton = NSButton(title: "Refresh", target: self, action: #selector(refresh))
        refreshButton.bezelStyle = .rounded
        refreshButton.translatesAutoresizingMaskIntoConstraints = false
        footerView.addSubview(refreshButton)

        versionLabel.font = NSFont.systemFont(ofSize: 12)
        versionLabel.textColor = .secondaryLabelColor
        versionLabel.stringValue = "v\(LotteryVersion.string)"
        versionLabel.translatesAutoresizingMaskIntoConstraints = false
        footerView.addSubview(versionLabel)

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true
        content.addSubview(scrollView)

        documentView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = documentView

        NSLayoutConstraint.activate([
            footerView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            footerView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            footerView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            footerView.heightAnchor.constraint(equalToConstant: 52),

            saveButton.leadingAnchor.constraint(equalTo: footerView.leadingAnchor, constant: 20),
            saveButton.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),
            saveButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),

            refreshButton.leadingAnchor.constraint(equalTo: saveButton.trailingAnchor, constant: 12),
            refreshButton.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),

            versionLabel.trailingAnchor.constraint(equalTo: footerView.trailingAnchor, constant: -20),
            versionLabel.centerYAnchor.constraint(equalTo: footerView.centerYAnchor),

            scrollView.topAnchor.constraint(equalTo: content.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: footerView.topAnchor),

            documentView.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
        ])

        titleLabel.stringValue = BitcoinBrand.format("Bitcoin Lottery")
        titleLabel.font = NSFont.systemFont(ofSize: 28, weight: .bold)
        documentView.addSubview(titleLabel)

        subtitleLabel.stringValue = "One hash per block — true solo lottery"
        subtitleLabel.font = NSFont.systemFont(ofSize: 13)
        subtitleLabel.textColor = .secondaryLabelColor
        documentView.addSubview(subtitleLabel)

        introLabel.stringValue =
            "Works out of the box in Practice mode — no blockchain download. Live mode is optional and uses a space-efficient pruned node (~15 GB disk, not 600 GB).\n\n"
            + "Click the ₿ icon in the menu bar for settings and options."
        introLabel.font = NSFont.systemFont(ofSize: 14)
        introLabel.textColor = .secondaryLabelColor
        configureWrapping(introLabel)
        documentView.addSubview(introLabel)

        statusBanner.isBordered = true
        statusBanner.isBezeled = true
        statusBanner.isEditable = false
        statusBanner.backgroundColor = NSColor(calibratedRed: 0.12, green: 0.12, blue: 0.14, alpha: 1)
        statusBanner.textColor = NSColor(calibratedRed: 1, green: 0.72, blue: 0.2, alpha: 1)
        statusBanner.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        statusBanner.alignment = .center
        statusBanner.lineBreakMode = .byWordWrapping
        statusBanner.maximumNumberOfLines = 0
        statusBanner.cell?.wraps = true
        statusBanner.cell?.isScrollable = false
        documentView.addSubview(statusBanner)

        modeControl.selectedSegment = 0
        modeControl.target = self
        modeControl.action = #selector(modeChanged)
        documentView.addSubview(modeControl)

        modeHelpLabel.font = NSFont.systemFont(ofSize: 14)
        modeHelpLabel.textColor = .secondaryLabelColor
        configureWrapping(modeHelpLabel)
        documentView.addSubview(modeHelpLabel)

        machineSeedHelpLabel.stringValue =
            "Your lucky word. Pick any word, name, or phrase you like — each block combines it with the block height → SHA-256 → your one nonce (your single guess). Leave blank to use this Mac's name."
        machineSeedHelpLabel.font = NSFont.systemFont(ofSize: 14)
        machineSeedHelpLabel.textColor = .secondaryLabelColor
        configureWrapping(machineSeedHelpLabel)
        documentView.addSubview(machineSeedHelpLabel)

        machineSeedField.placeholderString = "a lucky word, your name…  (blank = this Mac's name)"
        machineSeedField.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        machineSeedField.target = self
        machineSeedField.action = #selector(machineSeedChanged)
        documentView.addSubview(machineSeedField)

        noncePreviewLabel.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        noncePreviewLabel.textColor = .secondaryLabelColor
        configureWrapping(noncePreviewLabel)
        documentView.addSubview(noncePreviewLabel)

        walletHelpLabel.stringValue =
            "Optional in Practice mode. Required for Live mode — if you win a block, the current network reward is sent here (updates automatically at each halving)."
        walletHelpLabel.font = NSFont.systemFont(ofSize: 14)
        walletHelpLabel.textColor = .secondaryLabelColor
        configureWrapping(walletHelpLabel)
        documentView.addSubview(walletHelpLabel)

        payoutField.placeholderString = "bc1q… or 1…"
        payoutField.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        documentView.addSubview(payoutField)

        showWalletBalanceBox = NSButton(checkboxWithTitle: "Show wallet balance (via mempool.space)", target: nil, action: nil)
        showWalletBalanceBox.font = NSFont.systemFont(ofSize: 14)
        documentView.addSubview(showWalletBalanceBox)

        walletBalanceLabel.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        walletBalanceLabel.textColor = .secondaryLabelColor
        configureWrapping(walletBalanceLabel)
        documentView.addSubview(walletBalanceLabel)

        blockLabel = makeValueLabel()
        ticketLabel = makeValueLabel()
        hashLabel = makeValueLabel()
        hashLabel.font = NSFont.monospacedSystemFont(ofSize: 22, weight: .regular)
        attemptsLabel = makeValueLabel()
        countdownLabel = makeValueLabel()
        proximityLabel = makeValueLabel()
        halvingLabel = makeValueLabel()
        priceLabel = makeValueLabel()

        priceIntervalCaption.stringValue = "Update every (min)"
        priceIntervalCaption.font = NSFont.systemFont(ofSize: 14)
        documentView.addSubview(priceIntervalCaption)
        priceIntervalField = NSTextField()
        documentView.addSubview(priceIntervalField)

        menuBarHelpLabel.stringValue = BitcoinBrand.format(
            "Choose what appears next to ₿ in the menu bar. While Bitcoin Core is syncing in Live mode, sync % overrides your choice until the node is fully caught up — then Block, Price, or Closeness is shown."
        )
        menuBarHelpLabel.font = NSFont.systemFont(ofSize: 14)
        menuBarHelpLabel.textColor = .secondaryLabelColor
        configureWrapping(menuBarHelpLabel)
        documentView.addSubview(menuBarHelpLabel)

        menuBarDisplayControl.selectedSegment = 0
        documentView.addSubview(menuBarDisplayControl)

        notifyHelpLabel.stringValue =
            "macOS alerts for notable lottery and node events. Closeness uses the same 4-decimal display as the menu bar. "
            + "Use Test notification to trigger the macOS permission prompt and confirm alerts are working."
        notifyHelpLabel.font = NSFont.systemFont(ofSize: 14)
        notifyHelpLabel.textColor = .secondaryLabelColor
        configureWrapping(notifyHelpLabel)
        documentView.addSubview(notifyHelpLabel)

        notificationsEnabledBox = NSButton(checkboxWithTitle: "Enable notifications", target: self, action: #selector(notificationMasterChanged))
        notificationsEnabledBox.font = NSFont.systemFont(ofSize: 14)
        documentView.addSubview(notificationsEnabledBox)
        notifyClosenessBox = NSButton(checkboxWithTitle: "Hash closeness above 0.0000% (per block)", target: nil, action: nil)
        notifyClosenessBox.font = NSFont.systemFont(ofSize: 14)
        documentView.addSubview(notifyClosenessBox)
        notifyJackpotBox = NSButton(checkboxWithTitle: "Block won (jackpot)", target: nil, action: nil)
        notifyJackpotBox.font = NSFont.systemFont(ofSize: 14)
        documentView.addSubview(notifyJackpotBox)
        notifyNodeSyncedBox = NSButton(checkboxWithTitle: BitcoinBrand.format("Bitcoin Core finished syncing"), target: nil, action: nil)
        notifyNodeSyncedBox.font = NSFont.systemFont(ofSize: 14)
        documentView.addSubview(notifyNodeSyncedBox)
        notifyNodeOutOfSyncBox = NSButton(checkboxWithTitle: BitcoinBrand.format("Bitcoin Core went out of sync"), target: nil, action: nil)
        notifyNodeOutOfSyncBox.font = NSFont.systemFont(ofSize: 14)
        documentView.addSubview(notifyNodeOutOfSyncBox)

        testNotificationButton = NSButton(title: "Test notification", target: self, action: #selector(testNotification))
        testNotificationButton.bezelStyle = .rounded
        documentView.addSubview(testNotificationButton)

        nodeHelpLabel.stringValue = brand(
            "Not needed for Practice mode. For Live mode, use the buttons below to set up a pruned node (~15–18 GB on disk — old blocks are discarded as it syncs, not 600 GB). Initial sync still takes days over the network.\n\n"
            + "1. Set up pruned node — writes bitcoin.conf and connects the lottery app.\n"
            + "2. Install Bitcoin Core — via Homebrew if available, or download from bitcoin.org.\n"
            + "3. Start Bitcoin Core — begins syncing; switch to Live mode once synced."
        )
        nodeHelpLabel.font = NSFont.systemFont(ofSize: 14)
        nodeHelpLabel.textColor = .secondaryLabelColor
        configureWrapping(nodeHelpLabel)
        documentView.addSubview(nodeHelpLabel)

        setupPrunedNodeButton = NSButton(title: "Set up pruned node…", target: self, action: #selector(setupPrunedNode))
        setupPrunedNodeButton.bezelStyle = .rounded
        documentView.addSubview(setupPrunedNodeButton)
        installBitcoinCoreButton = NSButton(title: BitcoinBrand.format("Install Bitcoin Core…"), target: self, action: #selector(installBitcoinCore))
        installBitcoinCoreButton.bezelStyle = .rounded
        documentView.addSubview(installBitcoinCoreButton)
        startBitcoinCoreButton = NSButton(title: BitcoinBrand.format("Start Bitcoin Core"), target: self, action: #selector(startBitcoinCore))
        startBitcoinCoreButton.bezelStyle = .rounded
        documentView.addSubview(startBitcoinCoreButton)

        nodeSetupSummaryLabel.font = NSFont.systemFont(ofSize: 16, weight: .medium)
        nodeSetupSummaryLabel.textColor = .secondaryLabelColor
        configureWrapping(nodeSetupSummaryLabel)
        documentView.addSubview(nodeSetupSummaryLabel)

        nodeStatusLabel.font = NSFont.systemFont(ofSize: 15)
        nodeStatusLabel.textColor = .secondaryLabelColor
        configureWrapping(nodeStatusLabel)
        documentView.addSubview(nodeStatusLabel)

        syncBar.isIndeterminate = false
        syncBar.minValue = 0
        syncBar.maxValue = 100
        documentView.addSubview(syncBar)

        daemonHelpLabel.stringValue = brand(
            "Mining runs as a separate background daemon (installed by ./scripts/install.sh). Closing this menu bar app does not stop mining — tickets keep playing, and Live mode keeps submitting when your node is ready.\n\n"
            + "• Stop — pause mining; no new tickets until you start again.\n"
            + "• Uninstall — remove the daemon from LaunchAgents. Settings, stats, and logs stay in ~/Library/Application Support/BitcoinLottery/.\n"
            + "• Bitcoin Core (if installed) is separate and is not stopped by these actions.\n"
            + "• Reinstall anytime: ./scripts/install.sh"
        )
        daemonHelpLabel.font = NSFont.systemFont(ofSize: 14)
        daemonHelpLabel.textColor = .secondaryLabelColor
        configureWrapping(daemonHelpLabel)
        documentView.addSubview(daemonHelpLabel)

        daemonStatusLabel.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        daemonStatusLabel.textColor = .labelColor
        configureWrapping(daemonStatusLabel)
        documentView.addSubview(daemonStatusLabel)

        stopDaemonButton = NSButton(title: "Stop mining daemon", target: self, action: #selector(stopMiningDaemon))
        stopDaemonButton.bezelStyle = .rounded
        documentView.addSubview(stopDaemonButton)
        startDaemonButton = NSButton(title: "Start mining daemon", target: self, action: #selector(startMiningDaemon))
        startDaemonButton.bezelStyle = .rounded
        documentView.addSubview(startDaemonButton)
        uninstallDaemonButton = NSButton(title: "Uninstall daemon…", target: self, action: #selector(uninstallMiningDaemon))
        uninstallDaemonButton.bezelStyle = .rounded
        documentView.addSubview(uninstallDaemonButton)

        sectionMiningLabel = makeSectionLabel("Mining mode")
        sectionWalletLabel = makeSectionLabel("Your payout wallet")
        sectionTicketLabel = makeSectionLabel("Last ticket")
        sectionStatsLabel = makeSectionLabel("Stats")
        sectionPriceLabel = makeSectionLabel("Bitcoin price")
        sectionMenuBarLabel = makeSectionLabel("Menu bar display")
        sectionNotifyLabel = makeSectionLabel("Notifications")
        sectionNodeLabel = makeSectionLabel("Bitcoin Core — live mode only (optional)")
        sectionDaemonLabel = makeSectionLabel("Background mining daemon")

        relayoutDocument()
    }

    private func makeSectionLabel(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: BitcoinBrand.format(title).uppercased())
        label.font = NSFont.systemFont(ofSize: 18, weight: .bold)
        label.textColor = NSColor(calibratedRed: 1, green: 0.6, blue: 0.1, alpha: 1)
        configureWrapping(label)
        documentView.addSubview(label)
        return label
    }

    private func contentWidth() -> CGFloat {
        let scrollWidth = scrollView.contentSize.width
        let base = scrollWidth > 0 ? scrollWidth : (window?.contentView?.bounds.width ?? 560)
        return max(400, base - Self.contentPad * 2)
    }

    private func configureWrapping(_ field: NSTextField) {
        field.isEditable = false
        field.isBezeled = false
        field.drawsBackground = false
        field.isSelectable = false
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 0
        field.cell?.wraps = true
        field.cell?.isScrollable = false
    }

    private func textHeight(_ text: String, font: NSFont, width: CGFloat) -> CGFloat {
        guard !text.isEmpty else { return font.boundingRectForFont.height + 4 }
        let rect = (text as NSString).boundingRect(
            with: NSSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        )
        return max(font.boundingRectForFont.height + 4, ceil(rect.height) + 6)
    }

    private func placeWrapping(_ field: NSTextField, x: CGFloat, y: inout CGFloat, width: CGFloat) {
        let font = field.font ?? NSFont.systemFont(ofSize: 14)
        let height = textHeight(field.stringValue, font: font, width: width)
        field.frame = NSRect(x: x, y: y, width: width, height: height)
        y += height + Self.itemGap
    }

    private func placeSectionLabel(_ label: NSTextField, x: CGFloat, y: inout CGFloat, width: CGFloat) {
        let font = label.font ?? NSFont.systemFont(ofSize: 18, weight: .bold)
        let height = textHeight(label.stringValue, font: font, width: width)
        label.frame = NSRect(x: x, y: y, width: width, height: height)
        y += height + Self.itemGap
    }

    private func placeCheckbox(_ box: NSButton, x: CGFloat, y: inout CGFloat, width: CGFloat) {
        let font = box.font ?? NSFont.systemFont(ofSize: 14)
        let textWidth = width - 28
        let height = max(24, textHeight(box.title, font: font, width: textWidth))
        box.frame = NSRect(x: x, y: y, width: width, height: height)
        y += height + 6
    }

    private func makeValueLabel() -> NSTextField {
        let label = NSTextField(labelWithString: "—")
        label.font = NSFont.systemFont(ofSize: 16, weight: .medium)
        configureWrapping(label)
        documentView.addSubview(label)
        return label
    }

    private func relayoutDocument() {
        let pad = Self.contentPad
        let w = contentWidth()
        var y: CGFloat = 20

        titleLabel.frame = NSRect(x: pad, y: y, width: w, height: 34)
        y += 38
        subtitleLabel.frame = NSRect(x: pad, y: y, width: w, height: 20)
        y += 24 + Self.sectionGap

        placeWrapping(introLabel, x: pad, y: &y, width: w)
        y += 4
        placeWrapping(statusBanner, x: pad, y: &y, width: w)
        y += Self.sectionGap

        placeSectionLabel(sectionMiningLabel, x: pad, y: &y, width: w)
        modeControl.frame = NSRect(x: pad, y: y, width: min(220, w), height: 28)
        y += 36
        placeWrapping(modeHelpLabel, x: pad, y: &y, width: w)
        placeWrapping(machineSeedHelpLabel, x: pad, y: &y, width: w)
        machineSeedField.frame = NSRect(x: pad, y: y, width: w, height: 28)
        y += 34
        placeWrapping(noncePreviewLabel, x: pad, y: &y, width: w)
        y += Self.sectionGap

        placeSectionLabel(sectionWalletLabel, x: pad, y: &y, width: w)
        placeWrapping(walletHelpLabel, x: pad, y: &y, width: w)
        payoutField.frame = NSRect(x: pad, y: y, width: w, height: 28)
        y += 34
        placeCheckbox(showWalletBalanceBox, x: pad, y: &y, width: w)
        if !walletBalanceLabel.isHidden {
            placeWrapping(walletBalanceLabel, x: pad, y: &y, width: w)
        }
        y += Self.sectionGap

        placeSectionLabel(sectionTicketLabel, x: pad, y: &y, width: w)
        placeWrapping(blockLabel, x: pad, y: &y, width: w)
        placeWrapping(ticketLabel, x: pad, y: &y, width: w)
        placeWrapping(hashLabel, x: pad, y: &y, width: w)
        y += Self.sectionGap

        placeSectionLabel(sectionStatsLabel, x: pad, y: &y, width: w)
        placeWrapping(attemptsLabel, x: pad, y: &y, width: w)
        placeWrapping(countdownLabel, x: pad, y: &y, width: w)
        placeWrapping(proximityLabel, x: pad, y: &y, width: w)
        placeWrapping(halvingLabel, x: pad, y: &y, width: w)
        y += Self.sectionGap

        placeSectionLabel(sectionPriceLabel, x: pad, y: &y, width: w)
        placeWrapping(priceLabel, x: pad, y: &y, width: w)
        priceIntervalCaption.frame = NSRect(x: pad, y: y, width: 160, height: 22)
        priceIntervalField.frame = NSRect(x: pad + 168, y: y - 2, width: 80, height: 24)
        y += 30 + Self.sectionGap

        placeSectionLabel(sectionMenuBarLabel, x: pad, y: &y, width: w)
        placeWrapping(menuBarHelpLabel, x: pad, y: &y, width: w)
        menuBarDisplayControl.frame = NSRect(x: pad, y: y, width: min(360, w), height: 28)
        y += 38 + Self.sectionGap

        placeSectionLabel(sectionNotifyLabel, x: pad, y: &y, width: w)
        placeWrapping(notifyHelpLabel, x: pad, y: &y, width: w)
        placeCheckbox(notificationsEnabledBox, x: pad, y: &y, width: w)
        placeCheckbox(notifyClosenessBox, x: pad, y: &y, width: w)
        placeCheckbox(notifyJackpotBox, x: pad, y: &y, width: w)
        placeCheckbox(notifyNodeSyncedBox, x: pad, y: &y, width: w)
        placeCheckbox(notifyNodeOutOfSyncBox, x: pad, y: &y, width: w)
        testNotificationButton.frame = NSRect(x: pad, y: y, width: 180, height: 28)
        y += 36
        y += Self.sectionGap

        nodeSectionScrollY = y
        placeSectionLabel(sectionNodeLabel, x: pad, y: &y, width: w)
        placeWrapping(nodeHelpLabel, x: pad, y: &y, width: w)
        y += 4

        let btnW = max(140, (w - 16) / 3)
        setupPrunedNodeButton.frame = NSRect(x: pad, y: y, width: btnW, height: 28)
        installBitcoinCoreButton.frame = NSRect(x: pad + btnW + 8, y: y, width: btnW, height: 28)
        startBitcoinCoreButton.frame = NSRect(x: pad + (btnW + 8) * 2, y: y, width: btnW, height: 28)
        y += 36

        placeWrapping(nodeSetupSummaryLabel, x: pad, y: &y, width: w)
        placeWrapping(nodeStatusLabel, x: pad, y: &y, width: w)
        syncBar.frame = NSRect(x: pad, y: y, width: w, height: 20)
        y += 30 + Self.sectionGap

        placeSectionLabel(sectionDaemonLabel, x: pad, y: &y, width: w)
        placeWrapping(daemonHelpLabel, x: pad, y: &y, width: w)
        placeWrapping(daemonStatusLabel, x: pad, y: &y, width: w)

        let daemonBtnW = max(150, (w - 16) / 3)
        stopDaemonButton.frame = NSRect(x: pad, y: y, width: daemonBtnW, height: 28)
        startDaemonButton.frame = NSRect(x: pad + daemonBtnW + 8, y: y, width: daemonBtnW, height: 28)
        uninstallDaemonButton.frame = NSRect(x: pad + (daemonBtnW + 8) * 2, y: y, width: daemonBtnW, height: 28)
        y += 38

        let docWidth = max(560, scrollView.contentSize.width)
        documentView.frame = NSRect(x: 0, y: 0, width: docWidth, height: y + 24)
    }

    @objc private func notificationMasterChanged() {
        let enabled = notificationsEnabledBox.state == .on
        notifyClosenessBox.isEnabled = enabled
        notifyJackpotBox.isEnabled = enabled
        notifyNodeSyncedBox.isEnabled = enabled
        notifyNodeOutOfSyncBox.isEnabled = enabled
        testNotificationButton.isEnabled = true
        if enabled {
            NotificationManager.shared.requestAuthorizationIfNeeded()
        }
    }

    @objc private func testNotification() {
        testNotificationButton.isEnabled = false
        testNotificationButton.title = "Testing…"
        NotificationManager.shared.sendTestNotification { [weak self] message in
            self?.statusBanner.stringValue = message
            self?.testNotificationButton.title = "Test notification"
            self?.testNotificationButton.isEnabled = true
            self?.relayoutDocument()
        }
    }

    @objc private func modeChanged() {
        updateModeHelp()
        relayoutDocument()
    }

    private func updateModeHelp() {
        if modeControl.selectedSegment == 1 {
            modeHelpLabel.stringValue = brand(
                "Advanced: submits real candidate blocks via your local Bitcoin Core node once it is fully synced. "
                + "Until sync completes, blocks are not submitted to the network (like funds sent to a wallet you cannot see yet). "
                + "Requires a pruned node (~15 GB disk) and a payout wallet."
            )
        } else {
            modeHelpLabel.stringValue = brand(
                "Recommended: one hash per block using public chain data. No Bitcoin Core, no blockchain download — ready immediately."
            )
        }
    }

    @objc private func machineSeedChanged() {
        updateNoncePreview(config: LotteryConfig.load(), state: LotteryState.load())
    }

    private func updateNoncePreview(config: LotteryConfig?, state: LotteryState?) {
        let seed = NonceTicket.resolvedMachineSeed(stored: machineSeedField.stringValue.isEmpty
            ? config?.machineSeed
            : machineSeedField.stringValue)
        let height = state?.lastAttempt?.height ?? state?.currentTipHeight ?? 0
        guard height > 0 else {
            noncePreviewLabel.stringValue = "Preview: waiting for a block height…"
            return
        }
        let nonce = NonceTicket.pickNonce(machineSeed: seed, blockHeight: height)
        let input = NonceTicket.ticketInput(machineSeed: seed, blockHeight: height)
        let bytes = NonceTicket.firstFourBytesHex(for: seed, blockHeight: height)
        noncePreviewLabel.stringValue =
            "Preview block \(height): \(NonceTicket.shortSeed(input)) → SHA-256 → 0x\(bytes) → #\(NonceTicket.formattedNonce(nonce))"
    }

    private func isLiveMode(config: LotteryConfig?, state: LotteryState?) -> Bool {
        (state?.mode ?? config?.mode ?? "symbolic") == "live"
    }

    @objc func refresh() {
        let config = LotteryConfig.load()
        let state = LotteryState.load()
        let live = isLiveMode(config: config, state: state)
        let node = state?.node

        if let config {
            payoutField.stringValue = config.payoutAddress
            machineSeedField.stringValue = config.machineSeed
            modeControl.selectedSegment = config.mode == "live" ? 1 : 0
            priceIntervalField.stringValue = "\(config.pricePollIntervalMin)"
            let display = MenuBarDisplay.from(config: config)
            menuBarDisplayControl.selectedSegment = MenuBarDisplay.allCases.firstIndex(of: display) ?? 0
            notificationsEnabledBox.state = config.notificationsEnabled ? .on : .off
            notifyClosenessBox.state = config.notifyClosenessAboveZero ? .on : .off
            notifyJackpotBox.state = config.notifyBlockWon ? .on : .off
            notifyNodeSyncedBox.state = config.notifyNodeSynced ? .on : .off
            notifyNodeOutOfSyncBox.state = config.notifyNodeOutOfSync ? .on : .off
            showWalletBalanceBox.state = config.showWalletBalance ? .on : .off
            notificationMasterChanged()
        }
        updateModeHelp()
        updateNoncePreview(config: config, state: state)

        let payout = resolvedPayoutAddress(config: config, state: state)
        updateStatusBanner(config: config, state: state, node: node, live: live, payout: payout)
        updateNodeSection(node: node, live: live)
        updateNodeSetupButtons()
        updateDaemonSection()

        if let attempt = state?.lastAttempt {
            let seed = NonceTicket.resolvedMachineSeed(stored: config?.machineSeed ?? state?.machineSeed)
            blockLabel.stringValue = "Block \(attempt.height)\(attempt.won ? "  🎉 JACKPOT" : "")"
            ticketLabel.stringValue = NonceTicket.ticketSummary(
                machineSeed: seed, blockHeight: attempt.height, nonce: attempt.nonce
            )
            hashLabel.stringValue = "Hash  \(attempt.hashHex)"
        } else {
            blockLabel.stringValue = "No attempts yet"
            ticketLabel.stringValue = "Waiting for daemon…"
            hashLabel.stringValue = "Run ./scripts/install.sh"
        }

        if live {
            let liveAttempts = state?.stats.liveAttempts ?? 0
            let liveWins = state?.stats.liveWins ?? 0
            attemptsLabel.stringValue = "\(liveAttempts) live tickets submitted  •  \(liveWins) wins  •  mode: live"
        } else {
            let attempts = state?.stats.totalAttempts ?? 0
            let wins = state?.stats.wins ?? 0
            attemptsLabel.stringValue = "\(attempts) tickets played  •  \(wins) wins  •  mode: practice"
        }

        updateWalletBalance(config: config, state: state, payout: payout)

        if let countdown = state?.display?.blockCountdownSec {
            countdownLabel.stringValue = String(format: "Next block ~%d:%02d", countdown / 60, countdown % 60)
        } else {
            countdownLabel.stringValue = "Next block countdown: —"
        }

        if let prox = state?.display?.hashProximity {
            let closeness = prox.won == true ? "JACKPOT" : Formatters.closeness(prox.percent ?? 0)
            proximityLabel.stringValue = "Hash closeness: \(closeness) (\(prox.leadingZeroBits) zero bits)"
        } else {
            proximityLabel.stringValue = "Hash closeness: —"
        }

        updateWalletHelp(state: state)
        updateHalvingStats(state: state)

        if let price = state?.price {
            let updated = price.updatedAt ?? "unknown"
            priceLabel.stringValue = "\(Formatters.usd(price.usd))  •  updated \(String(updated.prefix(19)))"
        } else {
            priceLabel.stringValue = "Price: waiting for first poll…"
        }

        relayoutDocument()
    }

    private func updateWalletHelp(state: LotteryState?) {
        let subsidy = state?.display?.blockSubsidyBtc ?? 3.125
        walletHelpLabel.stringValue = brand(
            String(format: "Optional in Practice mode. Required for Live mode — if you win a block, the current network reward (~%.3f BTC) is sent here. Live mode reads the reward from Bitcoin Core, which updates automatically at each halving.", subsidy)
        )
    }

    private func updateHalvingStats(state: LotteryState?) {
        guard let display = state?.display,
              let next = display.nextHalvingHeight,
              let blocksUntil = display.blocksUntilHalving,
              let countdown = display.halvingCountdownSec,
              let subsidy = display.blockSubsidyBtc else {
            halvingLabel.stringValue = "Next halving: —"
            return
        }
        let progress = (display.halvingEpochProgress ?? 0) * 100
        halvingLabel.stringValue =
            String(format: "Block reward now: %.3f BTC  •  Next halving at block %@ (%@ blocks, %@ away, %.1f%% through this era)",
                   subsidy,
                   Formatters.grouped(next),
                   Formatters.grouped(blocksUntil),
                   Formatters.durationShort(countdown),
                   progress)
    }

    private func updateWalletBalance(config: LotteryConfig?, state: LotteryState?, payout: String) {
        let enabled = config?.showWalletBalance == true
        let wasHidden = walletBalanceLabel.isHidden
        walletBalanceLabel.isHidden = !enabled
        guard enabled else {
            if !wasHidden { relayoutDocument() }
            return
        }
        if payout.isEmpty {
            walletBalanceLabel.stringValue = "Enter a payout wallet above to fetch balance"
            return
        }
        if let balance = state?.walletBalance {
            if let btc = balance.btc {
                let confirmed = balance.confirmedBtc.map { Formatters.btc($0) } ?? Formatters.btc(btc)
                if btc == 0 && (balance.txCount ?? 0) == 0 {
                    walletBalanceLabel.stringValue =
                        "Balance: 0 BTC — valid on-chain address with no transactions yet. "
                        + "Strike, Cash App, and other one-time deposit addresses often show 0 until BTC actually arrives on-chain (Lightning balances are not shown here)."
                } else {
                    walletBalanceLabel.stringValue = "Balance: \(Formatters.btc(btc))  •  confirmed \(confirmed)"
                }
            } else if let err = balance.lastError {
                walletBalanceLabel.stringValue = "Balance unavailable: \(err)"
            } else {
                walletBalanceLabel.stringValue = "Balance: waiting for first poll…"
            }
        } else {
            walletBalanceLabel.stringValue = "Balance: waiting for daemon poll…"
        }
    }

    private func updateStatusBanner(
        config: LotteryConfig?,
        state: LotteryState?,
        node: NodeStatus?,
        live: Bool,
        payout: String
    ) {
        if !live {
            if payout.isEmpty {
                statusBanner.stringValue = "Practice mode — playing now. Add a payout wallet anytime."
            } else {
                statusBanner.stringValue = "Practice mode — one ticket per block, no node required"
            }
            return
        }

        if payout.isEmpty {
            statusBanner.stringValue = "Live mode needs a payout wallet — enter one above, then Save"
            return
        }

        guard let node else {
            statusBanner.stringValue = brand("Live mode selected — use Set up pruned node, then Install & Start Bitcoin Core")
            return
        }

        if node.ready {
            statusBanner.stringValue = "Live mode ready — synced pruned node connected"
            return
        }

        let pct = node.syncPercent
        if node.initialblockdownload == true {
            statusBanner.stringValue = String(
                format: "Live mode waiting on sync (%.1f%%) — lottery keeps running in Practice until ready",
                pct
            )
        } else {
            statusBanner.stringValue = String(format: "Live mode waiting on verification (%.1f%%)", pct)
        }
    }

    private func updateNodeSection(node: NodeStatus?, live: Bool) {
        if !live {
            syncBar.doubleValue = 0
            if let node {
                let pct = node.syncPercent
                if node.ready {
                    nodeStatusLabel.stringValue = brand(
                        "Bitcoin Core is synced and ready if you switch to Live mode (~\(node.blocks ?? 0) blocks, pruned)."
                    )
                } else {
                    nodeStatusLabel.stringValue = brand(String(
                        format: "Bitcoin Core installed but still syncing (%.1f%%) — not required while you stay in Practice mode.",
                        pct
                    ))
                    syncBar.doubleValue = pct
                }
            } else {
                nodeStatusLabel.stringValue = "Not required in Practice mode. Use the buttons above when you want Live mode."
            }
            return
        }

        guard let node else {
            syncBar.doubleValue = 0
            nodeStatusLabel.stringValue = brand(
                "Bitcoin Core not detected yet. Set up pruned config, install Bitcoin Core, then start it to sync."
            )
            return
        }

        let pct = node.syncPercent
        syncBar.doubleValue = pct
        if node.ready {
            nodeStatusLabel.stringValue =
                "Ready  •  \(node.blocks ?? 0) blocks  •  pruned: \(node.pruned == true ? "yes" : "no")  •  ~15 GB disk"
        } else if node.initialblockdownload == true {
            nodeStatusLabel.stringValue = String(
                format: "Syncing %.1f%%  •  %@ / %@ blocks  •  pruned node (~15 GB disk, not 600 GB)",
                pct,
                Formatters.grouped(node.blocks ?? 0),
                Formatters.grouped(node.headers ?? 0)
            )
        } else {
            nodeStatusLabel.stringValue = "Verifying… \(String(format: "%.1f", pct))%"
        }
    }

    private func updateNodeSetupButtons() {
        nodeSetupSummaryLabel.stringValue = NodeSetupManager.setupSummary

        let conf = NodeSetupManager.prunedConfigStatus()
        let core = NodeSetupManager.bitcoinCoreStatus()

        switch conf {
        case .missing:
            setupPrunedNodeButton.title = "Set up pruned node…"
            setupPrunedNodeButton.isEnabled = true
        case .configured:
            setupPrunedNodeButton.title = "Pruned config ready"
            setupPrunedNodeButton.isEnabled = true
        }

        installBitcoinCoreButton.isEnabled = core == .notInstalled || NodeSetupManager.brewExecutable() != nil
        startBitcoinCoreButton.isEnabled = core != .notInstalled
    }

    @objc private func setupPrunedNode() {
        let alert = NSAlert()
        alert.messageText = brand("Set up pruned Bitcoin Core?")
        alert.informativeText = brand(
            "This writes ~/Library/Application Support/Bitcoin/bitcoin.conf with pruning enabled "
            + "(~15–18 GB disk, not 600 GB), generates RPC credentials, and saves them to the lottery app.\n\n"
            + "If bitcoin.conf already exists, lottery settings are appended without erasing your file."
        )
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Set up")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        setupPrunedNodeButton.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let error = NodeSetupManager.setupPrunedNode()
            DispatchQueue.main.async {
                if let error {
                    self?.statusBanner.stringValue = self?.brand(error) ?? error
                } else {
                    self?.statusBanner.stringValue = self?.brand(
                        "Pruned node config ready — install and start Bitcoin Core, then wait for sync"
                    ) ?? ""
                    NotificationCenter.default.post(name: .bitcoinLotteryConfigDidSave, object: nil)
                }
                self?.updateNodeSetupButtons()
                self?.refresh()
            }
        }
    }

    @objc private func installBitcoinCore() {
        let alert = NSAlert()
        alert.messageText = brand("Install Bitcoin Core")
        if NodeSetupManager.brewExecutable() != nil {
            alert.informativeText = brand(
                "Homebrew can install the bitcoind command-line tools (recommended on Mac).\n\n"
                + "Or download the Bitcoin-Qt app from bitcoin.org if you prefer a graphical installer."
            )
            alert.addButton(withTitle: "Install via Homebrew")
            alert.addButton(withTitle: "Download from bitcoin.org")
            alert.addButton(withTitle: "Cancel")
            let response = alert.runModal()
            if response == .alertThirdButtonReturn { return }
            if response == .alertSecondButtonReturn {
                NodeSetupManager.openBitcoinCoreDownloadPage()
                statusBanner.stringValue = brand("Download Bitcoin Core, then click Start Bitcoin Core after installing")
                return
            }
            installBitcoinCoreButton.isEnabled = false
            installBitcoinCoreButton.title = "Installing…"
            statusBanner.stringValue = brand("Installing Bitcoin Core via Homebrew — may take several minutes")
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let error = NodeSetupManager.installBitcoinCoreViaHomebrew()
                DispatchQueue.main.async {
                    self?.installBitcoinCoreButton.title = self?.brand("Install Bitcoin Core…") ?? ""
                    if let error {
                        self?.statusBanner.stringValue = self?.brand(error) ?? error
                    } else {
                        self?.statusBanner.stringValue = self?.brand(
                            "Bitcoin Core installed — click Start Bitcoin Core to begin syncing"
                        ) ?? ""
                    }
                    self?.updateNodeSetupButtons()
                    self?.refresh()
                }
            }
        } else {
            alert.informativeText = brand(
                "Homebrew was not found. Download Bitcoin Core from bitcoin.org and install the macOS app."
            )
            alert.addButton(withTitle: "Open download page")
            alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            NodeSetupManager.openBitcoinCoreDownloadPage()
            statusBanner.stringValue = brand("Download Bitcoin Core, then click Start Bitcoin Core after installing")
        }
    }

    @objc private func startBitcoinCore() {
        startBitcoinCoreButton.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let error = NodeSetupManager.startBitcoinCore()
            DispatchQueue.main.async {
                if let error {
                    self?.statusBanner.stringValue = self?.brand(error) ?? error
                } else {
                    self?.statusBanner.stringValue = self?.brand(
                        "Bitcoin Core started — sync progress appears below (days for first sync)"
                    ) ?? ""
                }
                self?.updateNodeSetupButtons()
                self?.refresh()
            }
        }
    }

    private func updateDaemonSection() {
        let daemonStatus = DaemonManager.status()
        daemonStatusLabel.stringValue = DaemonManager.statusLabel

        switch daemonStatus {
        case .running:
            daemonStatusLabel.textColor = NSColor(calibratedRed: 0.25, green: 0.85, blue: 0.45, alpha: 1)
            stopDaemonButton.isEnabled = true
            startDaemonButton.isEnabled = false
            uninstallDaemonButton.isEnabled = true
        case .stopped:
            daemonStatusLabel.textColor = NSColor(calibratedRed: 1, green: 0.65, blue: 0.2, alpha: 1)
            stopDaemonButton.isEnabled = false
            startDaemonButton.isEnabled = true
            uninstallDaemonButton.isEnabled = true
        case .notInstalled:
            daemonStatusLabel.textColor = .secondaryLabelColor
            stopDaemonButton.isEnabled = false
            startDaemonButton.isEnabled = false
            uninstallDaemonButton.isEnabled = false
        }
    }

    @objc private func stopMiningDaemon() {
        stopDaemonButton.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let error = DaemonManager.stop()
            DispatchQueue.main.async {
                self?.finishDaemonAction(error, success: "Mining daemon stopped — no new tickets until started again")
            }
        }
    }

    @objc private func startMiningDaemon() {
        startDaemonButton.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let error = DaemonManager.start()
            DispatchQueue.main.async {
                self?.finishDaemonAction(error, success: "Mining daemon started — one ticket per block")
            }
        }
    }

    @objc private func uninstallMiningDaemon() {
        let alert = NSAlert()
        alert.messageText = "Uninstall mining daemon?"
        alert.informativeText = brand(
            "This stops background mining and removes the LaunchAgent from your account.\n\n"
            + "Your wallet settings, stats, and logs stay in ~/Library/Application Support/BitcoinLottery/. "
            + "Bitcoin Core (if installed) keeps running separately.\n\n"
            + "Reinstall anytime with ./scripts/install.sh"
        )
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Uninstall")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        uninstallDaemonButton.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let error = DaemonManager.uninstall()
            DispatchQueue.main.async {
                self?.finishDaemonAction(error, success: "Mining daemon uninstalled — settings and history preserved")
            }
        }
    }

    private func finishDaemonAction(_ error: String?, success: String) {
        if let error {
            statusBanner.stringValue = brand(error)
        } else {
            statusBanner.stringValue = success
        }
        updateDaemonSection()
        refresh()
    }

    @objc private func saveSettings() {
        let address = payoutField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let live = modeControl.selectedSegment == 1
        if live && address.isEmpty {
            statusBanner.stringValue = "Live mode requires a payout wallet address"
            return
        }

        let displayIndex = menuBarDisplayControl.selectedSegment
        let displays = MenuBarDisplay.allCases
        let snapshot = SettingsSnapshot(
            payoutAddress: address,
            machineSeed: machineSeedField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
            live: live,
            pricePollIntervalMin: Int(priceIntervalField.stringValue) ?? 15,
            menuBarDisplay: displays.indices.contains(displayIndex)
                ? displays[displayIndex].rawValue
                : MenuBarDisplay.block.rawValue,
            notificationsEnabled: notificationsEnabledBox.state == .on,
            notifyClosenessAboveZero: notifyClosenessBox.state == .on,
            notifyBlockWon: notifyJackpotBox.state == .on,
            notifyNodeSynced: notifyNodeSyncedBox.state == .on,
            notifyNodeOutOfSync: notifyNodeOutOfSyncBox.state == .on,
            showWalletBalance: showWalletBalanceBox.state == .on
        )

        saveButton.isEnabled = false
        saveButton.title = "Saving…"

        DispatchQueue.global(qos: .userInitiated).async {
            let result = Self.persist(snapshot)
            DispatchQueue.main.async { [weak self] in
                self?.finishSave(result)
            }
        }
    }

    private static func persist(_ snapshot: SettingsSnapshot) -> String? {
        guard var config = LotteryConfig.load() else {
            return "Config missing — run ./scripts/install.sh first"
        }

        config.payoutAddress = snapshot.payoutAddress
        config.machineSeed = snapshot.machineSeed
        config.mode = snapshot.live ? "live" : "symbolic"
        if snapshot.pricePollIntervalMin >= 1, snapshot.pricePollIntervalMin <= 1440 {
            config.pricePollIntervalMin = snapshot.pricePollIntervalMin
        }
        config.menuBarDisplay = snapshot.menuBarDisplay
        config.notificationsEnabled = snapshot.notificationsEnabled
        config.notifyClosenessAboveZero = snapshot.notifyClosenessAboveZero
        config.notifyBlockWon = snapshot.notifyBlockWon
        config.notifyNodeSynced = snapshot.notifyNodeSynced
        config.notifyNodeOutOfSync = snapshot.notifyNodeOutOfSync
        config.showWalletBalance = snapshot.showWalletBalance

        do {
            try config.save()
            return nil
        } catch {
            return "Save failed — \(error.localizedDescription)"
        }
    }

    private func finishSave(_ errorMessage: String?) {
        if let errorMessage {
            saveButton.isEnabled = true
            saveButton.title = "Save wallet & settings"
            statusBanner.stringValue = errorMessage
            return
        }
        NotificationCenter.default.post(name: .bitcoinLotteryConfigDidSave, object: nil)
        dismissDashboard()
    }

    private func dismissDashboard() {
        refreshTimer?.invalidate()
        refreshTimer = nil
        saveButton.isEnabled = true
        saveButton.title = "Save wallet & settings"
        window?.orderOut(nil)
        close()
        NSApp.setActivationPolicy(.accessory)
    }

    func windowWillClose(_ notification: Notification) {
        refreshTimer?.invalidate()
        refreshTimer = nil
        NSApp.setActivationPolicy(.accessory)
    }

    func windowDidResize(_ notification: Notification) {
        relayoutDocument()
    }

    func showDashboard(scrollToNodeSetup: Bool = false) {
        if refreshTimer == nil {
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
                self?.refresh()
            }
        }
        NSApp.setActivationPolicy(.regular)
        window?.center()
        showWindow(self)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refresh()
        if scrollToNodeSetup {
            DispatchQueue.main.async { [weak self] in
                self?.scrollToNodeSetup()
            }
        }
    }

    private func scrollToNodeSetup() {
        guard nodeSectionScrollY > 0 else { return }
        window?.layoutIfNeeded()
        scrollView.layoutSubtreeIfNeeded()
        let clipHeight = scrollView.contentView.bounds.height
        let documentHeight = documentView.bounds.height
        let targetY = min(nodeSectionScrollY, max(0, documentHeight - clipHeight))
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: targetY))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
}