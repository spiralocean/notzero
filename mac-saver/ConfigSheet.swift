import AppKit
import ScreenSaver

// A minimal programmatic options sheet: pick the ambient style (The Deep / Rain),
// stored in ScreenSaverDefaults. Kept in code so there's no nib to ship.
final class ConfigSheet: NSObject {

    private static var retained: ConfigSheet?   // keep the target alive while the sheet is open

    let window: NSWindow
    private let defaults: ScreenSaverDefaults?
    private let popup: NSPopUpButton
    private let onApply: () -> Void

    private init(moduleName: String, onApply: @escaping () -> Void) {
        self.defaults = ScreenSaverDefaults(forModuleWithName: moduleName)
        self.onApply = onApply
        self.window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 150),
            styleMask: [.titled], backing: .buffered, defer: false)

        let title = NSTextField(labelWithString: "Ambient style")
        title.frame = NSRect(x: 20, y: 104, width: 300, height: 20)
        title.font = NSFont.boldSystemFont(ofSize: 13)

        popup = NSPopUpButton(frame: NSRect(x: 20, y: 66, width: 300, height: 26), pullsDown: false)
        popup.addItem(withTitle: "The Deep — swarm & coin")
        popup.lastItem?.representedObject = "breath"
        popup.addItem(withTitle: "Matrix rain — falling hashes")
        popup.lastItem?.representedObject = "rain"

        super.init()

        let current = defaults?.string(forKey: "style") ?? "breath"
        popup.selectItem(at: current == "rain" ? 1 : 0)

        let done = NSButton(title: "Done", target: self, action: #selector(done(_:)))
        done.frame = NSRect(x: 232, y: 16, width: 88, height: 30)
        done.bezelStyle = .rounded
        done.keyEquivalent = "\r"

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel(_:)))
        cancel.frame = NSRect(x: 138, y: 16, width: 88, height: 30)
        cancel.bezelStyle = .rounded

        let v = window.contentView!
        v.addSubview(title); v.addSubview(popup); v.addSubview(done); v.addSubview(cancel)
    }

    static func make(moduleName: String, onApply: @escaping () -> Void) -> NSWindow {
        let c = ConfigSheet(moduleName: moduleName, onApply: onApply)
        retained = c
        return c.window
    }

    @objc private func done(_ sender: Any?) {
        if let style = popup.selectedItem?.representedObject as? String {
            defaults?.set(style, forKey: "style")
            defaults?.synchronize()
        }
        onApply()
        end()
    }

    @objc private func cancel(_ sender: Any?) { end() }

    private func end() {
        if let parent = window.sheetParent { parent.endSheet(window) }
        else { window.orderOut(nil) }
        ConfigSheet.retained = nil
    }
}
