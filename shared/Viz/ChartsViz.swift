import AppKit

/// Bottom-row sparkline panels: BTC price, network hashrate, and halving progress.
/// Stateless — renders directly from `SaverDisplay` / `SaverPrice` via the painter.
struct ChartsViz {
    func drawEmpty(in chart: CGRect, title: String, subtitle: String, painter: VizPainter) {
        NSColor(white: 0.08, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: chart, xRadius: 8, yRadius: 8).fill()
        painter.drawText(title, at: CGPoint(x: chart.minX + 10, y: chart.minY + 8), anchor: .topLeft,
                         size: painter.fontSmall, weight: .semibold, color: NSColor(white: 0.55, alpha: 1))
        painter.drawText(subtitle, at: CGPoint(x: chart.midX, y: chart.midY), anchor: .topCenter,
                         size: painter.fontCaption, weight: .regular, color: NSColor(white: 0.4, alpha: 1))
    }

    func drawHashrate(in chart: CGRect, display: SaverDisplay, painter: VizPainter) {
        NSColor(white: 0.08, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: chart, xRadius: 8, yRadius: 8).fill()

        let current = display.networkHashrateEh ?? display.networkHashrateHistory?.last?.eh
        let title = current.map { String(format: "Network %.0f EH/s", $0) } ?? "Network hashrate"
        painter.drawText(title, at: CGPoint(x: chart.minX + 10, y: chart.minY + 8), anchor: .topLeft,
                         size: painter.fontSmall, weight: .semibold, color: NSColor(calibratedRed: 1, green: 0.55, blue: 0.2, alpha: 1))
        painter.drawText("1 week", at: CGPoint(x: chart.maxX - 10, y: chart.minY + 8), anchor: .topRight,
                         size: painter.fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))

        let points = display.networkHashrateHistory ?? []
        guard points.count >= 2 else {
            painter.drawText("Collecting hashrate history…", at: CGPoint(x: chart.midX, y: chart.midY), anchor: .topCenter,
                             size: painter.fontCaption, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
            return
        }

        drawSparkline(
            in: chart,
            values: points.map(\.eh),
            padY: 40,
            stroke: NSColor(calibratedRed: 1, green: 0.55, blue: 0.15, alpha: 0.95),
            fill: NSColor(calibratedRed: 0.55, green: 0.25, blue: 0.05, alpha: 0.35),
            painter: painter,
            formatValue: { String(format: "%.0f", $0) }
        )
    }

    func drawHalving(in chart: CGRect, display: SaverDisplay, painter: VizPainter) {
        NSColor(white: 0.08, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: chart, xRadius: 8, yRadius: 8).fill()

        let subsidy = display.blockSubsidyBtc ?? 3.125
        let blocksUntil = display.blocksUntilHalving ?? 0
        let countdown = display.halvingCountdownSec ?? 0
        let progress = CGFloat(display.halvingEpochProgress ?? 0)
        let nextHeight = display.nextHalvingHeight ?? 0

        painter.drawText(String(format: "Reward %.3f BTC", subsidy), at: CGPoint(x: chart.minX + 10, y: chart.minY + 8), anchor: .topLeft,
                         size: painter.fontSmall, weight: .semibold, color: NSColor(calibratedRed: 1, green: 0.75, blue: 0.2, alpha: 1))
        painter.drawText(Self.formatHalvingETA(countdown), at: CGPoint(x: chart.maxX - 10, y: chart.minY + 8), anchor: .topRight,
                         size: painter.fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))

        let detail = "Block \(VizPainter.formatGrouped(nextHeight))  •  \(VizPainter.formatGrouped(blocksUntil)) blocks left"
        painter.drawText(detail, at: CGPoint(x: chart.midX, y: chart.minY + 34), anchor: .topCenter,
                         size: painter.fontMicro, weight: .medium, color: NSColor(white: 0.55, alpha: 1))

        let barRect = CGRect(x: chart.minX + 10, y: chart.maxY - 24, width: chart.width - 20, height: 12)
        NSColor(white: 0.14, alpha: 1).setFill()
        NSBezierPath(roundedRect: barRect, xRadius: 4, yRadius: 4).fill()
        if progress > 0 {
            let fillRect = CGRect(x: barRect.minX, y: barRect.minY, width: barRect.width * min(1, progress), height: barRect.height)
            NSColor(calibratedRed: 1, green: 0.62, blue: 0.12, alpha: 1).setFill()
            NSBezierPath(roundedRect: fillRect, xRadius: 4, yRadius: 4).fill()
        }
        painter.drawText(String(format: "%.0f%% of era", progress * 100), at: CGPoint(x: chart.midX, y: barRect.minY - 4), anchor: .topCenter,
                         size: painter.fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
    }

    func drawPrice(in chart: CGRect, price: SaverPrice, painter: VizPainter) {
        NSColor(white: 0.08, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: chart, xRadius: 8, yRadius: 8).fill()

        painter.drawText("BTC \(VizPainter.formatUSD(price.usd))", at: CGPoint(x: chart.minX + 10, y: chart.minY + 8), anchor: .topLeft,
                         size: painter.fontSmall, weight: .semibold, color: NSColor(calibratedRed: 0.3, green: 0.9, blue: 0.5, alpha: 1))

        if let interval = price.pollIntervalMin {
            painter.drawText("every \(interval)m", at: CGPoint(x: chart.maxX - 10, y: chart.minY + 8), anchor: .topRight,
                             size: painter.fontMicro, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
        }

        let points = price.history
        guard points.count >= 2 else {
            painter.drawText("Collecting price history…", at: CGPoint(x: chart.midX, y: chart.midY), anchor: .topCenter,
                             size: painter.fontCaption, weight: .regular, color: NSColor(white: 0.42, alpha: 1))
            return
        }

        drawSparkline(
            in: chart,
            values: points.map(\.usd),
            padY: 40,
            stroke: NSColor(calibratedRed: 0.3, green: 0.9, blue: 0.45, alpha: 0.95),
            fill: NSColor(calibratedRed: 0.15, green: 0.55, blue: 0.25, alpha: 0.35),
            painter: painter,
            formatValue: { VizPainter.formatUSD($0) }
        )
    }

    private func drawSparkline(
        in chart: CGRect,
        values: [Double],
        padY: CGFloat,
        stroke: NSColor,
        fill: NSColor,
        painter: VizPainter,
        formatValue: (Double) -> String
    ) {
        guard let minV = values.min(), let maxV = values.max(), maxV > minV else { return }
        let plotH = chart.height - padY - 8
        let plotW = chart.width - 20
        let step = plotW / CGFloat(values.count - 1)

        let linePath = NSBezierPath()
        let fillPath = NSBezierPath()
        for (i, v) in values.enumerated() {
            let x = chart.minX + 10 + CGFloat(i) * step
            let norm = CGFloat((v - minV) / (maxV - minV))
            let y = chart.minY + padY + norm * plotH
            let pt = CGPoint(x: x, y: y)
            if i == 0 {
                linePath.move(to: pt)
                fillPath.move(to: CGPoint(x: x, y: chart.minY + padY))
                fillPath.line(to: pt)
            } else {
                linePath.line(to: pt)
                fillPath.line(to: pt)
            }
        }
        fillPath.line(to: CGPoint(x: chart.maxX - 10, y: chart.minY + padY))
        fillPath.close()

        fill.setFill()
        fillPath.fill()
        stroke.setStroke()
        linePath.lineWidth = 1.5
        linePath.stroke()

        if let last = values.last {
            let x = chart.maxX - 10
            let norm = CGFloat((last - minV) / (maxV - minV))
            let y = chart.minY + padY + norm * plotH
            stroke.setFill()
            NSBezierPath(ovalIn: CGRect(x: x - 3, y: y - 3, width: 6, height: 6)).fill()
        }

        painter.drawText(formatValue(maxV), at: CGPoint(x: chart.maxX - 10, y: chart.minY + padY + plotH + 2), anchor: .topRight,
                         size: painter.fontTiny, weight: .regular, color: NSColor(white: 0.4, alpha: 1))
        painter.drawText(formatValue(minV), at: CGPoint(x: chart.maxX - 10, y: chart.minY + padY - 2), anchor: .topRight,
                         size: painter.fontTiny, weight: .regular, color: NSColor(white: 0.4, alpha: 1))
    }

    private static func formatHalvingETA(_ seconds: Int) -> String {
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        if days > 0 { return "~\(days)d \(hours)h" }
        if hours > 0 { return "~\(hours)h" }
        return "~\(max(1, seconds / 60))m"
    }
}
