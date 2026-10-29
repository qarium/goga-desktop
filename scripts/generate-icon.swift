// Maintainer-only, macOS. Normal builds consume committed assets, not system fonts.
// Reproduces the approved native Goga wordmark as outlines; no font is distributed.
import AppKit
import CoreText
import ImageIO

let manager = FileManager.default
let output = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("resources", isDirectory: true)
try manager.createDirectory(at: output, withIntermediateDirectories: true)
let scratch = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    : manager.temporaryDirectory.appendingPathComponent("goga-icon-" + UUID().uuidString, isDirectory: true)
let iconset = scratch.appendingPathComponent("Goga.iconset", isDirectory: true)
try manager.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? manager.removeItem(at: scratch) }

let tile = CGRect(x: 64, y: 64, width: 896, height: 896)
let background = CGPath(roundedRect: tile, cornerWidth: 896 * 0.235, cornerHeight: 896 * 0.235, transform: nil)
let fontSize = tile.width * 0.295
let normalWeight = NSFont.Weight(rawValue: (NSFont.Weight.semibold.rawValue + NSFont.Weight.bold.rawValue) / 2)
let normalFont = NSFont.systemFont(ofSize: fontSize, weight: normalWeight)
let boldFont = NSFont.systemFont(ofSize: fontSize, weight: .black)
let text = NSMutableAttributedString(string: "Goga", attributes: [
    .font: normalFont,
    .kern: -fontSize * (0.6 / 21),
])
text.addAttribute(.font, value: boldFont, range: NSRange(location: 0, length: 2))
let line = CTLineCreateWithAttributedString(text)
let bounds = CTLineGetBoundsWithOptions(line, [.useGlyphPathBounds])
let origin = CGPoint(x: (1024 - bounds.width) / 2 - bounds.minX, y: (1024 - bounds.height) / 2 - bounds.minY)
var shapes: [(CGPath, String)] = []
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
    let font = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
    let count = CTRunGetGlyphCount(run)
    var glyphs = [CGGlyph](repeating: 0, count: count)
    var positions = [CGPoint](repeating: .zero, count: count)
    var indices = [CFIndex](repeating: 0, count: count)
    CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
    CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
    CTRunGetStringIndices(run, CFRange(location: 0, length: 0), &indices)
    for i in 0..<count {
        guard let glyph = CTFontCreatePathForGlyph(font, glyphs[i], nil) else { fatalError("Missing wordmark outline") }
        var transform = CGAffineTransform(translationX: origin.x + positions[i].x, y: origin.y + positions[i].y)
        guard let placed = glyph.copy(using: &transform) else { fatalError("Invalid outline") }
        shapes.append((placed, indices[i] < 2 ? "#20d4bf" : "#e4ebf6"))
    }
}

func number(_ value: CGFloat) -> String {
    String(format: "%.3f", locale: Locale(identifier: "en_US_POSIX"), Double(value))
}
func svgPath(_ path: CGPath) -> String {
    var result = ""
    path.applyWithBlock { pointer in
        let e = pointer.pointee
        func point(_ i: Int) -> String { number(e.points[i].x) + " " + number(e.points[i].y) }
        switch e.type {
        case .moveToPoint: result += "M" + point(0)
        case .addLineToPoint: result += "L" + point(0)
        case .addQuadCurveToPoint: result += "Q" + point(0) + " " + point(1)
        case .addCurveToPoint: result += "C" + point(0) + " " + point(1) + " " + point(2)
        case .closeSubpath: result += "Z"
        @unknown default: fatalError("Unsupported outline element")
        }
    }
    return result
}
let paths = shapes.map { "<path fill=\"\($0.1)\" d=\"\(svgPath($0.0))\"/>" }.joined(separator: "\n")
let svg = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Goga">
<title>Goga</title>
<rect x="64" y="64" width="896" height="896" rx="210.560" fill="#0d1323"/>
<g transform="translate(0 1024) scale(1 -1)">
\(paths)
</g>
</svg>

"""
try svg.write(to: output.appendingPathComponent("icon.svg"), atomically: true, encoding: .utf8)
func color(_ hex: String) -> CGColor {
    let rgb = UInt32(hex.dropFirst(), radix: 16)!
    return CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: [
        CGFloat((rgb >> 16) & 255) / 255,
        CGFloat((rgb >> 8) & 255) / 255,
        CGFloat(rgb & 255) / 255, 1,
    ])!
}
func render(_ size: Int, _ destination: URL) throws {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fatalError("Cannot create icon bitmap") }
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    context.addPath(background)
    context.setFillColor(color("#0d1323"))
    context.fillPath()
    for (path, fill) in shapes {
        context.addPath(path)
        context.setFillColor(color(fill))
        context.fillPath()
    }
    guard let image = context.makeImage(),
          let writer = CGImageDestinationCreateWithURL(destination as CFURL, "public.png" as CFString, 1, nil)
    else { fatalError("Cannot encode icon") }
    CGImageDestinationAddImage(writer, image, nil)
    guard CGImageDestinationFinalize(writer) else { fatalError("Cannot write icon") }
}
try render(1024, output.appendingPathComponent("icon.png"))
for size in [16, 32, 128, 256, 512] {
    try render(size, iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2, iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["--convert", "icns", "--output", output.appendingPathComponent("icon.icns").path, iconset.path]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Generated Goga SVG, PNG and ICNS in \(output.path)")
