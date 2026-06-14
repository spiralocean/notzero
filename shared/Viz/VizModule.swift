import AppKit

/// Immutable per-frame snapshot handed to every viz module. Replaces the ad-hoc
/// reads of `LotteryCanvasView.animationPhase` and friends — modules read the
/// timeline and current lottery state exclusively through this.
struct VizContext {
    /// Decoded lottery state for this frame (nil while waiting for the daemon).
    let state: SaverLotteryState?
    /// Why `state` is nil, if known (surfaced as a waiting message).
    let loadError: String?
    /// Monotonic animation clock (the former `animationPhase`). Advances ~0.02/frame.
    let clock: CGFloat
    /// Seconds elapsed since the previous frame (fixed 1/30 today).
    let dt: CGFloat
    /// Which surface is hosting the modules.
    let layoutMode: CanvasLayoutMode
    /// True while a jackpot ceremony is active.
    let ceremony: Bool
    /// Selected screensaver/lottery view variant.
    let viewMode: ScreensaverView
    /// id of the hit region currently under the cursor, if any (for hover styling).
    let hoveredRegionID: String?
}

/// A clickable region a module exposes for the current frame. The host hit-tests
/// these against mouse events instead of modules mutating shared frame state.
struct VizHitRegion {
    let id: String
    let frame: CGRect
    let action: () -> Void
}

/// Lifecycle contract for a stateful viz module. Each module owns its animation
/// cycle(s); the host ticks `advance` once per frame and may collect `hitRegions`
/// for mouse routing. Drawing itself is done through module-specific methods that
/// the per-surface layout calls with explicit frames — deliberately not part of
/// this protocol, since modules range from single panels to full-bleed overlays.
/// Reference type so `advance` can mutate owned state in place across frames.
protocol VizModule: AnyObject {
    /// Tick this module's owned animation state forward by `ctx.dt`.
    func advance(_ ctx: VizContext)
    /// Clickable regions exposed this frame (default: none).
    var hitRegions: [VizHitRegion] { get }
}

extension VizModule {
    func advance(_ ctx: VizContext) {}
    var hitRegions: [VizHitRegion] { [] }
}
