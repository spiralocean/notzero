import AppKit

/// Cycling motivational quote shown under the title. Owns its rotation timer.
final class QuoteViz: VizModule {
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
    private static let secondsPerQuote: CGFloat = 14

    private var index = 0
    private var elapsed: CGFloat = 0

    func advance(dt: CGFloat) {
        elapsed += dt
        if elapsed >= Self.secondsPerQuote {
            elapsed = 0
            index = (index + 1) % Self.quotes.count
        }
    }

    func advance(_ ctx: VizContext) { advance(dt: ctx.dt) }

    func draw(centerX: CGFloat, quoteY: CGFloat, attribY: CGFloat, clock: CGFloat, painter: VizPainter) {
        let quote = Self.quotes[index]
        let pulse = 0.75 + 0.25 * sin(clock * 1.5)
        let color = NSColor(white: 0.45 + 0.15 * pulse, alpha: 1)
        painter.drawText(quote.text, at: CGPoint(x: centerX, y: quoteY), anchor: .topCenter,
                         size: painter.fontSmall, weight: .medium, color: color)
        if let attribution = quote.attribution {
            painter.drawText(attribution, at: CGPoint(x: centerX, y: attribY), anchor: .topCenter,
                             size: painter.fontMicro, weight: .regular, color: NSColor(white: 0.35, alpha: 1))
        }
    }
}

/// Next-block countdown as a progress ring. Self-positions via `center`/`radius`
/// so both the screensaver (small, top-right) and dashboard (large, focal) can reuse it.
struct CountdownRingViz {
    func draw(center: CGPoint, radius: CGFloat, valueFontSize: CGFloat = 13, display: SaverDisplay, painter: VizPainter) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let elapsed = CGFloat(display.blockElapsedSec ?? 0)
        let total = CGFloat(display.avgBlockSec ?? 600)
        let progress = min(1, elapsed / total)

        ctx.setStrokeColor(CGColor(gray: 0.25, alpha: 1))
        ctx.setLineWidth(4)
        ctx.addArc(center: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.strokePath()

        let end = -.pi / 2 + (.pi * 2 * progress)
        ctx.setStrokeColor(CGColor(red: 1, green: 0.65, blue: 0.15, alpha: 0.9))
        ctx.setLineWidth(4)
        ctx.setLineCap(.round)
        ctx.addArc(center: center, radius: radius, startAngle: -.pi / 2, endAngle: end, clockwise: false)
        ctx.strokePath()

        let mins = (display.blockCountdownSec ?? 0) / 60
        let secs = (display.blockCountdownSec ?? 0) % 60
        painter.drawText(String(format: "%d:%02d", mins, secs), at: center, size: valueFontSize, weight: .bold, color: .white)
        painter.drawText("next block", at: CGPoint(x: center.x, y: center.y + radius + 14), anchor: .topCenter,
                         size: painter.fontMicro, weight: .regular, color: NSColor(white: 0.55, alpha: 1))
    }
}

/// Horizontal "how close was your hash" meter. Parameterized by center + width.
struct ProximityMeterViz {
    func draw(centerX: CGFloat, barTopY: CGFloat, width: CGFloat, proximity: SaverProximity, painter: VizPainter) {
        let barRect = CGRect(x: centerX - width / 2, y: barTopY, width: width, height: 8)
        NSColor(white: 0.15, alpha: 1).setFill()
        NSBezierPath(roundedRect: barRect, xRadius: 4, yRadius: 4).fill()

        let fill = min(1, CGFloat(log10(max(proximity.percent, 1e-12)) / log10(100)))
        let glow = max(0.04, fill)
        let fillRect = CGRect(x: barRect.minX, y: barRect.minY, width: barRect.width * glow, height: barRect.height)
        NSColor(calibratedRed: 1, green: 0.55, blue: 0.1, alpha: 1).setFill()
        NSBezierPath(roundedRect: fillRect, xRadius: 4, yRadius: 4).fill()

        let label = proximity.won ? "TARGET HIT" : "Closeness \(proximity.label)  •  \(proximity.leadingZeroBits) zero bits"
        painter.drawText(label, at: CGPoint(x: centerX, y: barTopY + 18), anchor: .topCenter,
                         size: painter.fontCaption, weight: .medium, color: NSColor(white: 0.6, alpha: 1))
    }
}
