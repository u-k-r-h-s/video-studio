// Renders one subtitle cue to a transparent PNG with macOS CoreText (proper complex-script shaping, e.g. Devanagari).
// usage: subpng "<text>" "<font family>" <size> <width> <out.png> [stroke percent] [box alpha 0..1]
import AppKit
let a = CommandLine.arguments
let text = a[1], family = a[2], size = CGFloat(Double(a[3])!), maxW = CGFloat(Double(a[4])!), out = a[5]
let fm = NSFontManager.shared
let font = fm.font(withFamily: family, traits: .boldFontMask, weight: 9, size: size) ?? NSFont.boldSystemFont(ofSize: size)
let para = NSMutableParagraphStyle(); para.alignment = .center; para.lineBreakMode = .byWordWrapping; para.lineSpacing = 6
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white, .strokeColor: NSColor.black, .strokeWidth: (CommandLine.arguments.count > 6 ? -Double(CommandLine.arguments[6])! : -3.0), .paragraphStyle: para]
let s = NSAttributedString(string: text, attributes: attrs)
let pad: CGFloat = 20
let b = s.boundingRect(with: NSSize(width: maxW - 2 * pad, height: 10000), options: [.usesLineFragmentOrigin, .usesFontLeading])
let w = Int(ceil(maxW)), h = Int(ceil(b.height + 2 * pad))
let boxAlpha = CommandLine.arguments.count > 7 ? CGFloat(Double(CommandLine.arguments[7]) ?? 0) : 0
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
ctx.cgContext.clear(CGRect(x: 0, y: 0, width: w, height: h))
if boxAlpha > 0 {
  // translucent dark rounded box: keeps white text readable on any background
  NSColor(white: 0, alpha: boxAlpha).setFill()
  NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: w, height: h), xRadius: 26, yRadius: 26).fill()
}
s.draw(with: NSRect(x: pad, y: pad, width: CGFloat(w) - 2 * pad, height: b.height), options: [.usesLineFragmentOrigin, .usesFontLeading])
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("\(out) \(w)x\(h) font=\(font.fontName)")
