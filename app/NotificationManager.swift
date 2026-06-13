import AppKit
import Foundation
import UserNotifications

final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    private struct Tracker: Codable {
        var lastClosenessHeight: Int?
        var lastWinHeight: Int?
        var lastNodeReady: Bool?
        var lastNodeReachable: Bool?
    }

    private let trackerURL = LotteryConfig.appSupport.appendingPathComponent("notification-state.json")
    private var tracker = Tracker()
    private var didRequestAuth = false

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
        loadTracker()
    }

    func requestAuthorizationIfNeeded() {
        guard !didRequestAuth else { return }
        didRequestAuth = true
        requestAuthorization { _, _ in }
    }

    func requestAuthorization(completion: @escaping (Bool, UNAuthorizationStatus) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                DispatchQueue.main.async {
                    completion(granted, settings.authorizationStatus)
                }
            }
        }
    }

    func sendTestNotification(completion: @escaping (String) -> Void) {
        didRequestAuth = true
        requestAuthorization { [weak self] _, status in
            guard let self else { return }
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                DispatchQueue.main.async {
                    completion(self.testNotificationMessage(status: status, settings: settings))
                }
            }
        }
    }

    private func testNotificationMessage(status: UNAuthorizationStatus, settings: UNNotificationSettings) -> String {
        switch status {
        case .notDetermined:
            return "Waiting for your response to the macOS permission prompt — choose Allow, then tap Test again."
        case .denied:
            Self.openNotificationSettings()
            return BitcoinBrand.format("Notifications are blocked — opened System Settings → Notifications. Enable Bitcoin Lottery, then tap Test again.")
        case .authorized, .provisional, .ephemeral:
            if settings.alertSetting == .disabled {
                Self.openNotificationSettings()
                return BitcoinBrand.format("Alerts are off for Bitcoin Lottery — opened System Settings. Turn on banners/alerts, then tap Test again.")
            }
            post(
                identifier: "test-\(Int(Date().timeIntervalSince1970))",
                title: BitcoinBrand.format("Bitcoin Lottery test"),
                body: "Notifications are working. You'll get alerts for jackpots, closeness, and node sync."
            )
            return "Test notification sent — check the top-right of your screen or Notification Center."
        @unknown default:
            return "Could not determine notification permission status."
        }
    }

    static func openNotificationSettings() {
        let bundleID = Bundle.main.bundleIdentifier ?? "com.bitcoinlottery.app"
        let candidates = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(bundleID)",
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ]
        for raw in candidates {
            if let url = URL(string: raw), NSWorkspace.shared.open(url) {
                return
            }
        }
    }

    func evaluate(state: LotteryState?, config: LotteryConfig?) {
        guard let config, config.notificationsEnabled else { return }
        requestAuthorizationIfNeeded()

        if config.notifyClosenessAboveZero {
            checkCloseness(state: state)
        }
        if config.notifyBlockWon {
            checkJackpot(state: state)
        }
        if config.notifyNodeSynced || config.notifyNodeOutOfSync {
            checkNodeSync(state: state, config: config)
        }

        saveTracker()
    }

    // MARK: - Checks

    private func checkCloseness(state: LotteryState?) {
        guard let attempt = state?.lastAttempt,
              let prox = state?.display?.hashProximity,
              prox.won != true,
              let percent = prox.percent,
              closenessShowsAboveZero(percent),
              tracker.lastClosenessHeight != attempt.height else { return }

        tracker.lastClosenessHeight = attempt.height
        post(
            identifier: "closeness-\(attempt.height)",
            title: "Hash closeness above zero",
            body: "Block \(attempt.height): \(Formatters.closeness(percent)) to target"
        )
    }

    private func checkJackpot(state: LotteryState?) {
        guard let attempt = state?.lastAttempt,
              attempt.won,
              tracker.lastWinHeight != attempt.height else { return }

        tracker.lastWinHeight = attempt.height
        post(
            identifier: "jackpot-\(attempt.height)",
            title: "JACKPOT — block mined!",
            body: "Block \(attempt.height) matched the network target. Ticket #\(attempt.nonce)."
        )
    }

    private func checkNodeSync(state: LotteryState?, config: LotteryConfig?) {
        let node = state?.node
        let reachable = node?.reachable != false && node != nil
        let ready = node?.ready == true && reachable

        defer {
            tracker.lastNodeReady = ready
            tracker.lastNodeReachable = reachable
        }

        guard let wasReady = tracker.lastNodeReady else { return }

        if config?.notifyNodeSynced == true, !wasReady, ready {
            post(
                identifier: "node-synced-\(Int(Date().timeIntervalSince1970))",
                title: BitcoinBrand.format("Bitcoin Core synced"),
                body: "Your pruned node is ready for Live mode."
            )
            return
        }

        guard config?.notifyNodeOutOfSync == true, wasReady else { return }

        if !ready {
            let body: String
            if node?.reachable == false {
                body = BitcoinBrand.format("Bitcoin Core is no longer reachable.")
            } else if node?.initialblockdownload == true {
                let pct = node?.syncPercent ?? 0
                body = String(format: "Node reverted to syncing (%.1f%%).", pct)
            } else {
                let pct = node?.syncPercent ?? 0
                body = String(format: "Node is verifying again (%.1f%%).", pct)
            }
            post(
                identifier: "node-out-of-sync-\(Int(Date().timeIntervalSince1970))",
                title: BitcoinBrand.format("Bitcoin Core out of sync"),
                body: body
            )
        }
    }

    private func closenessShowsAboveZero(_ percent: Double) -> Bool {
        percent > 0 && String(format: "%.4f", percent) != "0.0000"
    }

    // MARK: - Delivery

    private func post(identifier: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // MARK: - Persistence

    private func loadTracker() {
        guard let data = try? Data(contentsOf: trackerURL),
              let saved = try? JSONDecoder().decode(Tracker.self, from: data) else { return }
        tracker = saved
    }

    private func saveTracker() {
        try? FileManager.default.createDirectory(at: LotteryConfig.appSupport, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(tracker) else { return }
        try? data.write(to: trackerURL, options: .atomic)
    }
}