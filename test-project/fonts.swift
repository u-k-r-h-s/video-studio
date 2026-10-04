import AppKit
let fm = NSFontManager.shared
for f in fm.availableFontFamilies where f.contains("Devanagari") || f.contains("Kohinoor") || f == "Arial" || f == "Helvetica Neue" || f.contains("Marker") || f.contains("Bangers") || f == "Impact" { print(f) }
