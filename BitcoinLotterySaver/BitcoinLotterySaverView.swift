import ScreenSaver
import AppKit

final class BitcoinLotterySaverView: ScreenSaverView {
    private let canvas = LotteryCanvasView()

    override init?(frame: NSRect, isPreview: Bool) {
        super.init(frame: frame, isPreview: isPreview)
        animationTimeInterval = 1.0 / 30.0
        canvas.translatesAutoresizingMaskIntoConstraints = false
        addSubview(canvas)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        animationTimeInterval = 1.0 / 30.0
        canvas.translatesAutoresizingMaskIntoConstraints = false
        addSubview(canvas)
    }

    override func layout() {
        super.layout()
        canvas.frame = bounds
    }

    override func startAnimation() {
        super.startAnimation()
        canvas.startAnimating()
    }

    override func stopAnimation() {
        canvas.stopAnimating()
        super.stopAnimation()
    }

    override func animateOneFrame() {
        canvas.reloadState()
        canvas.needsDisplay = true
    }

    override var hasConfigureSheet: Bool { false }
}