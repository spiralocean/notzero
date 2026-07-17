import ScreenSaver
import WebKit
import AppKit

// A node-less macOS screensaver: a thin ScreenSaverView hosting a WKWebView that
// loads the SAME web canvas the desktop app uses (ambient.html / ambient-rain.html).
// Loaded via file:// the pages run fully self-contained — no server, no node, no network.
@objc(NotZeroSaverView)
final class NotZeroSaverView: ScreenSaverView {

    static let moduleName = "com.getnotzero.saver"
    private var web: WKWebView!

    override init?(frame: NSRect, isPreview: Bool) {
        super.init(frame: frame, isPreview: isPreview)
        buildWeb()
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        buildWeb()
    }

    private func chosenStyle() -> String {
        let d = ScreenSaverDefaults(forModuleWithName: NotZeroSaverView.moduleName)
        let s = d?.string(forKey: "style") ?? "breath"
        return s == "rain" ? "rain" : "breath"
    }

    private func buildWeb() {
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor

        let cfg = WKWebViewConfiguration()
        cfg.suppressesIncrementalRendering = false
        web = WKWebView(frame: bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        // let our black layer show through until the canvas paints (avoids a white flash)
        web.setValue(false, forKey: "drawsBackground")
        addSubview(web)
        loadContent()
    }

    private func loadContent() {
        let resource = chosenStyle() == "rain" ? "ambient-rain" : "ambient"
        let bundle = Bundle(for: NotZeroSaverView.self)
        guard let url = bundle.url(forResource: resource, withExtension: "html") else { return }
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // The page animates itself via requestAnimationFrame, so we don't need a per-frame tick.
    override func startAnimation() { super.startAnimation() }
    override func stopAnimation()  { super.stopAnimation() }
    override func animateOneFrame() { }

    // ---- System Settings → "Screen Saver Options…" ----
    override var hasConfigureSheet: Bool { true }
    override var configureSheet: NSWindow? {
        return ConfigSheet.make(moduleName: NotZeroSaverView.moduleName) { [weak self] in
            self?.loadContent()   // apply the new style live
        }
    }
}
