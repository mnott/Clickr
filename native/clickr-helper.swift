// clickr-helper — native macOS input/introspection daemon for the clickr MCP server.
//
// Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
// Every response carries `ok`; failures carry `error`.
//
// Coordinates are ALWAYS global points (top-left origin of the main display,
// +y downwards) — the same space CGEvent uses, so what you measure is what you click.

import AppKit
import ApplicationServices
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

// MARK: - Event source

let eventSource: CGEventSource? = {
    let src = CGEventSource(stateID: .hidSystemState)
    // Without this, macOS suppresses the user's own mouse/keyboard for ~0.25s
    // after every synthetic event, which makes the machine feel broken.
    src?.setLocalEventsFilterDuringSuppressionState(
        [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents],
        state: .eventSuppressionStateSuppressionInterval)
    src?.setLocalEventsFilterDuringSuppressionState(
        [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents],
        state: .eventSuppressionStateRemoteMouseDrag)
    return src
}()

// MARK: - Errors

struct HelperError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

// MARK: - JSON helpers

func num(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String { return Double(s) }
    return nil
}

func req(_ obj: [String: Any], _ key: String) throws -> Double {
    guard let v = num(obj[key]) else { throw HelperError("missing or non-numeric parameter '\(key)'") }
    return v
}

// MARK: - Modifiers & keycodes

func flags(from list: Any?) -> CGEventFlags {
    guard let names = list as? [String] else { return [] }
    var f: CGEventFlags = []
    for raw in names {
        switch raw.lowercased() {
        case "cmd", "command", "meta", "super": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "alt", "option", "opt": f.insert(.maskAlternate)
        case "ctrl", "control": f.insert(.maskControl)
        case "fn", "function": f.insert(.maskSecondaryFn)
        case "capslock": f.insert(.maskAlphaShift)
        default: break
        }
    }
    return f
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, " ": 49,
    "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "fwddelete": 117,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "keypadenter": 76, "clear": 71,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
    "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
]

// MARK: - Permissions

func accessibilityTrusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw HelperError(
            "Accessibility permission denied. Grant it in System Settings > Privacy & Security > "
                + "Accessibility for the app that launched this MCP server (e.g. iTerm2, Terminal, "
                + "or Claude), then restart that app. Run the check_permissions tool for details.")
    }
}

// MARK: - Displays

func displayList() -> [[String: Any]] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)

    var out: [[String: Any]] = []
    for (i, id) in ids.prefix(Int(count)).enumerated() {
        let bounds = CGDisplayBounds(id)  // global points, top-left origin
        let mode = CGDisplayCopyDisplayMode(id)
        let pixelWidth = mode?.pixelWidth ?? Int(bounds.width)
        let pixelHeight = mode?.pixelHeight ?? Int(bounds.height)
        let scale = bounds.width > 0 ? Double(pixelWidth) / Double(bounds.width) : 1.0
        out.append([
            "index": i + 1,  // 1-based: matches `screencapture -D`
            "id": Int(id),
            "x": Double(bounds.origin.x),
            "y": Double(bounds.origin.y),
            "width": Double(bounds.width),
            "height": Double(bounds.height),
            "pixelWidth": pixelWidth,
            "pixelHeight": pixelHeight,
            "scale": scale,
            "main": CGDisplayIsMain(id) != 0,
        ])
    }
    return out
}

/// Screen-recording permission is what makes window *titles* readable; without it
/// CGWindowListCopyWindowInfo silently omits kCGWindowName.
func screenRecordingGranted() -> Bool {
    return CGPreflightScreenCaptureAccess()
}

// MARK: - Windows

func windowList(appFilter: String?, onScreenOnly: Bool, includeAllLayers: Bool) -> [[String: Any]] {
    var opts: CGWindowListOption = [.excludeDesktopElements]
    if onScreenOnly { opts.insert(.optionOnScreenOnly) }
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    var out: [[String: Any]] = []
    for w in raw {
        let layer = w[kCGWindowLayer as String] as? Int ?? 0
        // Layer 0 is normal app windows; higher layers are menus, docks, overlays.
        if !includeAllLayers && layer != 0 { continue }

        let owner = w[kCGWindowOwnerName as String] as? String ?? ""
        if let f = appFilter, !f.isEmpty,
            !owner.localizedCaseInsensitiveContains(f) {
            let title = w[kCGWindowName as String] as? String ?? ""
            if !title.localizedCaseInsensitiveContains(f) { continue }
        }

        guard let boundsDict = w[kCGWindowBounds as String] as? [String: Any],
            let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else { continue }

        // Skip degenerate/offscreen slivers that are never clickable.
        if rect.width < 2 || rect.height < 2 { continue }

        out.append([
            "windowId": w[kCGWindowNumber as String] as? Int ?? 0,
            "app": owner,
            "title": w[kCGWindowName as String] as? String ?? "",
            "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
            "layer": layer,
            "x": Double(rect.origin.x),
            "y": Double(rect.origin.y),
            "width": Double(rect.width),
            "height": Double(rect.height),
            "onScreen": w[kCGWindowIsOnscreen as String] as? Bool ?? false,
        ])
    }
    return out
}

// MARK: - Applications

/// The frontmost app, queried fresh every time.
///
/// NSRunningApplication.isActive is KVO-backed and only updates while a run loop
/// is processing workspace notifications. This helper has no run loop, so isActive
/// is permanently stale here — every "is this app frontmost?" question must go
/// through NSWorkspace.frontmostApplication instead.
func frontmostPid() -> pid_t? {
    NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func appList() -> [[String: Any]] {
    let front = frontmostPid()
    return NSWorkspace.shared.runningApplications.compactMap { app in
        guard app.activationPolicy == .regular else { return nil }
        return [
            "pid": Int(app.processIdentifier),
            "name": app.localizedName ?? "",
            "bundleId": app.bundleIdentifier ?? "",
            "active": app.processIdentifier == front,
            "hidden": app.isHidden,
        ]
    }
}

func findApp(_ obj: [String: Any]) throws -> NSRunningApplication {
    if let pid = num(obj["pid"]).map({ pid_t($0) }) {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw HelperError("no running application with pid \(pid)")
        }
        return app
    }
    let running = NSWorkspace.shared.runningApplications
    if let bundleId = obj["bundleId"] as? String, !bundleId.isEmpty {
        guard let app = running.first(where: { $0.bundleIdentifier == bundleId }) else {
            throw HelperError("no running application with bundle id '\(bundleId)'")
        }
        return app
    }
    guard let name = obj["name"] as? String, !name.isEmpty else {
        throw HelperError("provide one of 'pid', 'name' or 'bundleId'")
    }
    // Exact match wins over a substring match so "Notes" doesn't grab "Notesnook".
    if let exact = running.first(where: { $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame }) {
        return exact
    }
    guard let fuzzy = running.first(where: {
        $0.localizedName?.localizedCaseInsensitiveContains(name) == true
            || $0.bundleIdentifier?.localizedCaseInsensitiveContains(name) == true
    }) else {
        throw HelperError("no running application matching '\(name)'")
    }
    return fuzzy
}

// MARK: - Mouse

func currentMouse() -> CGPoint {
    // NSEvent gives bottom-left origin coordinates; CGEvent gives us the
    // top-left global space we standardise on, so read it from a null event.
    if let e = CGEvent(source: nil) { return e.location }
    return .zero
}

func postMouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton,
               _ mods: CGEventFlags, clickState: Int64 = 1) {
    guard let e = CGEvent(mouseEventSource: eventSource, mouseType: type,
                          mouseCursorPosition: point, mouseButton: button)
    else { return }
    if !mods.isEmpty { e.flags = mods }
    if clickState > 1 { e.setIntegerValueField(.mouseEventClickState, value: clickState) }
    e.post(tap: .cghidEventTap)
}

func mouseButton(_ name: String?) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
    switch (name ?? "left").lowercased() {
    case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case "middle", "center": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

/// Frontmost normal window containing a point. The window list comes back in
/// front-to-back order, so the first hit is the one a user would have clicked.
func windowUnderPoint(_ p: CGPoint) -> [String: Any]? {
    guard let raw = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return nil }
    for w in raw {
        guard (w[kCGWindowLayer as String] as? Int ?? 0) == 0 else { continue }
        guard let bd = w[kCGWindowBounds as String] as? [String: Any],
            let r = CGRect(dictionaryRepresentation: bd as CFDictionary)
        else { continue }
        if r.contains(p) { return w }
    }
    return nil
}

func doClick(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let point = CGPoint(x: try req(obj, "x"), y: try req(obj, "y"))
    let (button, down, up, _) = mouseButton(obj["button"] as? String)
    let mods = flags(from: obj["modifiers"])
    let count = max(1, min(3, Int(num(obj["count"]) ?? 1)))
    let restore = obj["restore"] as? Bool ?? false
    let origin = currentMouse()

    // A real click activates the app it lands on; a synthetic one does not.
    // Without this, the click updates the target's internal focus but keyboard
    // input keeps going to whatever was frontmost before — typically the
    // terminal that launched this server, which is a genuinely dangerous place
    // to send keystrokes. Activate first, matching real click semantics.
    var activated: String? = nil
    if obj["activate"] as? Bool ?? true,
        let w = windowUnderPoint(point),
        let ownerPid = w[kCGWindowOwnerPID as String] as? Int,
        frontmostPid() != pid_t(ownerPid),
        let app = NSRunningApplication(processIdentifier: pid_t(ownerPid)) {
        let (ok, method) = activateApp(app)
        activated = ok ? "\(app.localizedName ?? "") (via \(method))" : nil
    }

    // Move first so hover/tracking states settle before the press lands.
    postMouse(.mouseMoved, point, .left, [])
    usleep(30_000)

    for i in 1...count {
        postMouse(down, point, button, mods, clickState: Int64(i))
        usleep(20_000)
        postMouse(up, point, button, mods, clickState: Int64(i))
        if i < count { usleep(60_000) }
    }

    if restore {
        usleep(30_000)
        postMouse(.mouseMoved, origin, .left, [])
    }
    var result: [String: Any] = [
        "x": point.x, "y": point.y,
        "button": (obj["button"] as? String) ?? "left", "count": count,
        "frontmostApp": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
    ]
    if let activated = activated { result["activatedApp"] = activated }
    if let w = windowUnderPoint(point) {
        result["clickedWindow"] = [
            "windowId": w[kCGWindowNumber as String] as? Int ?? 0,
            "app": w[kCGWindowOwnerName as String] as? String ?? "",
            "title": w[kCGWindowName as String] as? String ?? "",
        ]
    }
    // Report what was actually hit, so the caller can confirm the click landed on the
    // intended control without spending a screenshot on verification.
    if obj["describeTarget"] as? Bool ?? true, let hit = elementAtPoint(point) {
        var summary: [String: Any] = ["role": hit["role"] ?? ""]
        for key in ["subrole", "title", "description", "value", "enabled", "focused"] {
            if let v = hit[key] { summary[key] = v }
        }
        if let parent = hit["parent"] { summary["parent"] = parent }
        result["hitElement"] = summary
    }
    return result
}

func doMove(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let point = CGPoint(x: try req(obj, "x"), y: try req(obj, "y"))
    postMouse(.mouseMoved, point, .left, [])
    return ["x": point.x, "y": point.y]
}

func doDrag(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let from = CGPoint(x: try req(obj, "fromX"), y: try req(obj, "fromY"))
    let to = CGPoint(x: try req(obj, "toX"), y: try req(obj, "toY"))
    let (button, down, up, dragged) = mouseButton(obj["button"] as? String)
    let mods = flags(from: obj["modifiers"])
    let steps = max(2, min(200, Int(num(obj["steps"]) ?? 25)))

    postMouse(.mouseMoved, from, .left, [])
    usleep(40_000)
    postMouse(down, from, button, mods)
    usleep(60_000)
    // Interpolate: apps that implement drag tracking ignore a single jump.
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        postMouse(dragged, p, button, mods)
        usleep(8_000)
    }
    usleep(60_000)
    postMouse(up, to, button, mods)
    return ["fromX": from.x, "fromY": from.y, "toX": to.x, "toY": to.y, "steps": steps]
}

func doScroll(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    if let x = num(obj["x"]), let y = num(obj["y"]) {
        postMouse(.mouseMoved, CGPoint(x: x, y: y), .left, [])
        usleep(30_000)
    }
    let dx = Int32(num(obj["dx"]) ?? 0)
    let dy = Int32(num(obj["dy"]) ?? 0)
    let unit: CGScrollEventUnit = (obj["units"] as? String)?.lowercased() == "pixel" ? .pixel : .line
    let mods = flags(from: obj["modifiers"])
    guard let e = CGEvent(scrollWheelEvent2Source: eventSource, units: unit,
                          wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    else { throw HelperError("could not create scroll event") }
    if !mods.isEmpty { e.flags = mods }
    e.post(tap: .cghidEventTap)
    return ["dx": Int(dx), "dy": Int(dy), "units": unit == .pixel ? "pixel" : "line"]
}

// MARK: - Keyboard

func typeUnicode(_ text: String, delayMs: UInt32) {
    // One character per event pair. Packing several characters into a single
    // keyboard event looks like it should work, but text arrives corrupted —
    // the character at the batch boundary gets duplicated ahead of the batch.
    // Per-character events are slightly slower and completely faithful; use
    // paste mode when speed matters.
    for character in text {
        var utf16 = Array(String(character).utf16)
        guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false)
        else { continue }
        // Clear inherited modifier state. The HID event source reports the real
        // keyboard's flags, so a modifier that is down (or stuck from an earlier
        // synthetic shortcut) would turn these characters into keyboard shortcuts
        // and silently insert nothing.
        down.flags = []
        up.flags = []
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        down.post(tap: .cghidEventTap)
        usleep(2_000)
        up.post(tap: .cghidEventTap)
        if delayMs > 0 { usleep(delayMs * 1_000) }
    }
}

/// Keyboard events go to whatever application is frontmost, which is not
/// necessarily the one that was last clicked. `expectApp` lets a caller assert
/// the intended destination and fail loudly instead of typing somewhere harmful.
@discardableResult
func verifyDestination(_ obj: [String: Any]) throws -> String {
    let front = NSWorkspace.shared.frontmostApplication
    let name = front?.localizedName ?? ""
    guard let expect = obj["expectApp"] as? String, !expect.isEmpty else { return name }
    let bundleId = front?.bundleIdentifier ?? ""
    let matches = name.localizedCaseInsensitiveContains(expect)
        || bundleId.localizedCaseInsensitiveContains(expect)
    if !matches {
        throw HelperError(
            "refusing to send input: expected '\(expect)' to be frontmost, but '\(name)' is. "
                + "Activate the target app or click its window first.")
    }
    return name
}

func doType(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    guard let text = obj["text"] as? String else { throw HelperError("missing parameter 'text'") }
    let destination = try verifyDestination(obj)
    // 20ms measured 13/13 exact across trials; 8ms dropped characters in 1 of 10.
    // Long text should use paste mode rather than a smaller delay.
    let delay = UInt32(max(0, min(500, num(obj["delay"]) ?? 20)))
    typeUnicode(text, delayMs: delay)
    return ["typed": text.count, "frontmostApp": destination]
}

func doKey(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    guard let name = obj["key"] as? String else { throw HelperError("missing parameter 'key'") }
    guard let code = keyCodes[name.lowercased()] else {
        throw HelperError("unknown key '\(name)'. Known keys: \(keyCodes.keys.sorted().joined(separator: ", "))")
    }
    let destination = try verifyDestination(obj)
    let mods = flags(from: obj["modifiers"])
    let count = max(1, min(100, Int(num(obj["count"]) ?? 1)))
    for _ in 1...count {
        guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true),
            let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)
        else { throw HelperError("could not create key event") }
        down.flags = mods
        up.flags = mods
        down.post(tap: .cghidEventTap)
        usleep(15_000)
        up.post(tap: .cghidEventTap)
        usleep(15_000)
    }
    return ["key": name, "count": count, "frontmostApp": destination]
}

// MARK: - Clipboard

func clipboardGet() -> [String: Any] {
    let text = NSPasteboard.general.string(forType: .string)
    return ["text": text ?? "", "hasText": text != nil]
}

func clipboardSet(_ text: String) -> [String: Any] {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
    return ["length": text.count]
}

// MARK: - Window control (Accessibility API)

func axWindows(pid: pid_t) throws -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    guard err == .success, let windows = value as? [AXUIElement] else {
        throw HelperError("could not read windows of pid \(pid) (AXError \(err.rawValue)). "
            + "The app may have no windows, or Accessibility permission is missing.")
    }
    return windows
}

func axGeometry(_ window: AXUIElement) -> (CGPoint, CGSize) {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef)
    AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef)
    var pos = CGPoint.zero
    var size = CGSize.zero
    if let p = posRef { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
    if let s = sizeRef { AXValueGetValue(s as! AXValue, .cgSize, &size) }
    return (pos, size)
}

func axTitle(_ window: AXUIElement) -> String {
    var ref: CFTypeRef?
    AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &ref)
    return (ref as? String) ?? ""
}

/// Resolves the exact window to act on.
///
/// A CGWindowID (what list_windows reports) and an AXUIElement live in different
/// identifier spaces with no public bridge, so when the caller names a windowId we
/// match on geometry and title — which is unambiguous in practice and far safer
/// than assuming the app's frontmost window is the one the caller meant.
func resolveWindow(_ obj: [String: Any], pid: pid_t) throws -> (AXUIElement, Int, String) {
    let windows = try axWindows(pid: pid)
    guard !windows.isEmpty else { throw HelperError("application has no windows") }

    if let wid = num(obj["windowId"]).map({ Int($0) }) {
        let cgWindows = windowList(appFilter: nil, onScreenOnly: false, includeAllLayers: true)
        guard let cg = cgWindows.first(where: { ($0["windowId"] as? Int) == wid }) else {
            throw HelperError("no window with id \(wid); call list_windows for current ids")
        }
        let target = CGRect(x: cg["x"] as? Double ?? 0, y: cg["y"] as? Double ?? 0,
                            width: cg["width"] as? Double ?? 0, height: cg["height"] as? Double ?? 0)
        let title = cg["title"] as? String ?? ""

        var best: (AXUIElement, Int, Double)?
        for (i, w) in windows.enumerated() {
            let (pos, size) = axGeometry(w)
            let dx: Double = abs(Double(pos.x) - Double(target.minX))
            let dy: Double = abs(Double(pos.y) - Double(target.minY))
            let dw: Double = abs(Double(size.width) - Double(target.width))
            let dh: Double = abs(Double(size.height) - Double(target.height))
            let delta: Double = dx + dy + dw + dh
            // An exact title match breaks ties between identically sized windows.
            let titlePenalty: Double = (axTitle(w) == title && !title.isEmpty) ? 0 : 1
            let score: Double = delta + titlePenalty
            if best == nil || score < best!.2 { best = (w, i, score) }
        }
        guard let (window, idx, score) = best, score < 40 else {
            throw HelperError(
                "could not match window id \(wid) to an accessibility window of that app. "
                    + "Try omitting windowId to use windowIndex instead.")
        }
        return (window, idx, "windowId \(wid)")
    }

    let idx = Int(num(obj["windowIndex"]) ?? 0)
    guard idx >= 0 && idx < windows.count else {
        throw HelperError("windowIndex \(idx) out of range; app has \(windows.count) window(s)")
    }
    return (windows[idx], idx, "windowIndex \(idx)")
}

// MARK: - Accessibility element queries
//
// This is the cheap alternative to screenshotting. A screenshot of a display costs
// roughly width*height/750 vision tokens and stays in the conversation forever;
// the same UI described through the accessibility tree is a few hundred tokens of
// text and already carries exact click coordinates.

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success else { return nil }
    return ref
}

func axStr(_ el: AXUIElement, _ attr: String) -> String? {
    guard let v = axCopy(el, attr) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    (axCopy(el, attr) as? NSNumber)?.boolValue
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    var pos = CGPoint.zero
    var size = CGSize.zero
    guard let p = axCopy(el, kAXPositionAttribute as String),
        let s = axCopy(el, kAXSizeAttribute as String),
        AXValueGetValue(p as! AXValue, .cgPoint, &pos),
        AXValueGetValue(s as! AXValue, .cgSize, &size)
    else { return nil }
    return CGRect(origin: pos, size: size)
}

func axActionNames(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

/// Compact description of one element. Long values are truncated: the point is to
/// identify and locate a control, not to reproduce a document.
func describe(_ el: AXUIElement, depth: Int) -> [String: Any]? {
    guard let frame = axFrame(el) else { return nil }
    // Zero-sized and offscreen elements cannot be clicked, so they are noise.
    guard frame.width >= 1, frame.height >= 1 else { return nil }

    var out: [String: Any] = [
        "role": axStr(el, kAXRoleAttribute as String) ?? "",
        "x": frame.minX, "y": frame.minY,
        "width": frame.width, "height": frame.height,
        // Ready to hand straight to `click`.
        "centerX": (frame.midX).rounded(),
        "centerY": (frame.midY).rounded(),
        "depth": depth,
    ]
    if let v = axStr(el, kAXSubroleAttribute as String), !v.isEmpty { out["subrole"] = v }
    if let v = axStr(el, kAXTitleAttribute as String), !v.isEmpty { out["title"] = v }
    if let v = axStr(el, kAXDescriptionAttribute as String), !v.isEmpty { out["description"] = v }
    if let v = axStr(el, kAXHelpAttribute as String), !v.isEmpty { out["help"] = v }
    if let v = axStr(el, kAXValueAttribute as String), !v.isEmpty {
        out["value"] = v.count > 200 ? String(v.prefix(200)) + "…" : v
    }
    if let v = axBool(el, kAXEnabledAttribute as String) { out["enabled"] = v }
    if let v = axBool(el, kAXFocusedAttribute as String), v { out["focused"] = true }
    let actions = axActionNames(el)
    if !actions.isEmpty { out["actions"] = actions }
    return out
}

struct ElementFilter {
    var role: String?
    var titleContains: String?
    var onlyActionable: Bool
    var includeOffscreen: Bool
    var bounds: CGRect?
}

func matches(_ info: [String: Any], _ f: ElementFilter) -> Bool {
    if let role = f.role, !role.isEmpty {
        let actual = (info["role"] as? String ?? "")
        let sub = (info["subrole"] as? String ?? "")
        if actual.caseInsensitiveCompare(role) != .orderedSame
            && sub.caseInsensitiveCompare(role) != .orderedSame { return false }
    }
    if let needle = f.titleContains, !needle.isEmpty {
        let haystack = [
            info["title"] as? String, info["description"] as? String,
            info["value"] as? String, info["help"] as? String,
        ].compactMap { $0 }.joined(separator: " ")
        if !haystack.localizedCaseInsensitiveContains(needle) { return false }
    }
    if f.onlyActionable {
        let actions = info["actions"] as? [String] ?? []
        if !actions.contains(kAXPressAction as String) { return false }
    }
    if let b = f.bounds {
        let r = CGRect(x: info["x"] as? Double ?? 0, y: info["y"] as? Double ?? 0,
                       width: info["width"] as? Double ?? 0, height: info["height"] as? Double ?? 0)
        if !b.intersects(r) { return false }
    }
    return true
}

/// Breadth-first walk with hard caps. Some apps (browsers especially) expose tens of
/// thousands of nodes, so an unbounded walk would hang and blow the response size.
func walkElements(root: AXUIElement, filter: ElementFilter,
                  maxDepth: Int, maxResults: Int, nodeBudget: Int) -> ([[String: Any]], Bool) {
    var results: [[String: Any]] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = 0
    var truncated = false

    while !queue.isEmpty {
        let (el, depth) = queue.removeFirst()
        visited += 1
        if visited > nodeBudget { truncated = true; break }

        if depth > 0, let info = describe(el, depth: depth) {
            if matches(info, filter) {
                results.append(info)
                if results.count >= maxResults { truncated = true; break }
            }
        }
        if depth >= maxDepth { continue }
        if let children = axCopy(el, kAXChildrenAttribute as String) as? [AXUIElement] {
            for child in children { queue.append((child, depth + 1)) }
        }
    }
    return (results, truncated)
}

func doFindElements(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let app = try findApp(obj)
    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)
    // Never let an unresponsive app hang the server.
    AXUIElementSetMessagingTimeout(axApp, 2.0)

    var bounds: CGRect? = nil
    if let r = obj["region"] as? [String: Any],
        let x = num(r["x"]), let y = num(r["y"]),
        let w = num(r["width"]), let h = num(r["height"]) {
        bounds = CGRect(x: x, y: y, width: w, height: h)
    }

    let filter = ElementFilter(
        role: obj["role"] as? String,
        titleContains: obj["titleContains"] as? String,
        onlyActionable: obj["onlyActionable"] as? Bool ?? false,
        includeOffscreen: obj["includeOffscreen"] as? Bool ?? false,
        bounds: bounds)

    let maxDepth = Int(num(obj["maxDepth"]) ?? 18)
    let maxResults = Int(num(obj["maxResults"]) ?? 40)
    let nodeBudget = Int(num(obj["nodeBudget"]) ?? 20000)

    // Searching a single window is dramatically cheaper than the whole app.
    var root = axApp
    var scope = "application"
    if let wid = num(obj["windowId"]).map({ Int($0) }) {
        let (window, _, matchedBy) = try resolveWindow(["windowId": wid], pid: pid)
        root = window
        scope = matchedBy
    } else if let idx = num(obj["windowIndex"]).map({ Int($0) }) {
        let (window, _, matchedBy) = try resolveWindow(["windowIndex": idx], pid: pid)
        root = window
        scope = matchedBy
    }

    let (results, truncated) = walkElements(
        root: root, filter: filter, maxDepth: maxDepth,
        maxResults: maxResults, nodeBudget: nodeBudget)

    return [
        "app": app.localizedName ?? "", "pid": Int(pid), "scope": scope,
        "count": results.count, "truncated": truncated,
        "elements": results,
    ]
}

/// What is actually under a point — the cheap way to confirm a click target or a
/// click result without capturing an image.
func elementAtPoint(_ p: CGPoint) -> [String: Any]? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 2.0)
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &el) == .success,
        let element = el
    else { return nil }
    var info = describe(element, depth: 0)
    // The immediate parent usually carries the label when the hit lands on inner text.
    if var i = info, let parent = axCopy(element, kAXParentAttribute as String) {
        // swiftlint:disable:next force_cast
        let parentEl = parent as! AXUIElement
        if let p = describe(parentEl, depth: 0) {
            var summary: [String: Any] = ["role": p["role"] ?? ""]
            if let t = p["title"] { summary["title"] = t }
            if let d = p["description"] { summary["description"] = d }
            i["parent"] = summary
        }
        info = i
    }
    return info
}

func doElementAt(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    let p = CGPoint(x: try req(obj, "x"), y: try req(obj, "y"))
    guard let info = elementAtPoint(p) else {
        throw HelperError("no accessibility element at (\(Int(p.x)), \(Int(p.y)))")
    }
    return ["x": p.x, "y": p.y, "element": info]
}

func doSetWindow(_ obj: [String: Any]) throws -> [String: Any] {
    try requireAccessibility()
    var lookup = obj
    // A windowId already identifies the owning process; don't make callers repeat it.
    if let wid = num(obj["windowId"]).map({ Int($0) }), obj["pid"] == nil,
        obj["name"] == nil, obj["bundleId"] == nil {
        let cgWindows = windowList(appFilter: nil, onScreenOnly: false, includeAllLayers: true)
        guard let cg = cgWindows.first(where: { ($0["windowId"] as? Int) == wid }) else {
            throw HelperError("no window with id \(wid); call list_windows for current ids")
        }
        lookup["pid"] = cg["pid"]
    }
    let app = try findApp(lookup)
    let pid = app.processIdentifier
    let (window, idx, matchedBy) = try resolveWindow(obj, pid: pid)
    var changed: [String] = []

    func applySize(_ w: Double, _ h: Double) {
        var size = CGSize(width: w, height: h)
        if let v = AXValueCreate(.cgSize, &size) {
            AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, v)
        }
    }
    func applyPosition(_ x: Double, _ y: Double) {
        var point = CGPoint(x: x, y: y)
        if let v = AXValueCreate(.cgPoint, &point) {
            AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, v)
        }
    }

    let newX = num(obj["x"])
    let newY = num(obj["y"])
    let newW = num(obj["width"])
    let newH = num(obj["height"])

    // Order matters. macOS clamps a move that would push a window off screen, so
    // moving a still-oversized window lands it somewhere else entirely. Shrinking
    // first, then moving, then re-applying the size handles both grow and shrink.
    if let w = newW, let h = newH {
        applySize(w, h)
        changed.append("size")
    }
    if let x = newX, let y = newY {
        applyPosition(x, y)
        changed.append("position")
    }
    if let w = newW, let h = newH {
        applySize(w, h)
        // A grow can itself be clamped by the old position, so settle the move again.
        if let x = newX, let y = newY { applyPosition(x, y) }
    }
    if obj["raise"] as? Bool ?? true {
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        app.activate()
        changed.append("raise")
    }

    // Read back so the caller learns the real geometry the app settled on —
    // apps are free to clamp or ignore what we asked for.
    let (pos, size) = axGeometry(window)

    return [
        "app": app.localizedName ?? "", "pid": Int(pid), "windowIndex": idx,
        "matchedBy": matchedBy, "changed": changed,
        "x": pos.x, "y": pos.y, "width": size.width, "height": size.height,
    ]
}

/// Brings an app to the front, and *verifies* that it worked.
///
/// NSRunningApplication.activate() reports success but is silently ignored when
/// the caller is an unbundled command-line tool — macOS restricts cross-app
/// activation. Setting kAXFrontmost through the Accessibility API does work and
/// needs no permission beyond the one clickr already requires. AppleScript is the
/// last resort because it triggers a separate Automation permission prompt.
@discardableResult
func activateApp(_ app: NSRunningApplication) -> (Bool, String) {
    let pid = app.processIdentifier
    app.unhide()

    func settled() -> Bool {
        for _ in 0..<12 {
            usleep(40_000)
            if frontmostPid() == pid { return true }
        }
        return false
    }

    app.activate()
    if settled() { return (true, "NSRunningApplication") }

    let axApp = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if settled() { return (true, "accessibility") }

    // Raising a window explicitly nudges apps that ignore the frontmost attribute.
    if let windows = try? axWindows(pid: pid), let first = windows.first {
        AXUIElementPerformAction(first, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        if settled() { return (true, "accessibility-raise") }
    }

    if let name = app.localizedName {
        let source = "tell application id \"\(app.bundleIdentifier ?? name)\" to activate"
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
        if error == nil && settled() { return (true, "applescript") }
    }

    return (frontmostPid() == pid, "failed")
}

func doActivate(_ obj: [String: Any]) throws -> [String: Any] {
    let app = try findApp(obj)
    let (ok, method) = activateApp(app)
    return [
        "app": app.localizedName ?? "", "pid": Int(app.processIdentifier),
        "bundleId": app.bundleIdentifier ?? "",
        "activated": ok, "method": method,
        "frontmostApp": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
    ]
}

// MARK: - Image processing (crop / scale / coordinate grid)

func loadImage(_ path: String) throws -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { throw HelperError("could not read image at \(path)") }
    return img
}

func writePNG(_ image: CGImage, to path: String) throws {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)
    else { throw HelperError("could not create PNG at \(path)") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { throw HelperError("could not write PNG at \(path)") }
}

/// Draws an upright label with a dark plate behind it.
/// `x`/`baselineY` are in CoreGraphics-native space (origin bottom-left), which is
/// why the context is deliberately never flipped — a flipped CTM mirrors glyphs.
func drawLabel(_ text: String, x: CGFloat, baselineY: CGFloat, in ctx: CGContext,
               fontSize: CGFloat) {
    let font = CTFontCreateWithName("Menlo-Bold" as CFString, fontSize, nil)
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: CGColor(red: 1, green: 1, blue: 1, alpha: 1),
    ]
    let line = CTLineCreateWithAttributedString(
        NSAttributedString(string: text, attributes: attrs))
    let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)

    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.78))
    ctx.fill(CGRect(x: x - 2, y: baselineY + bounds.minY - 2,
                    width: bounds.width + 5, height: bounds.height + 4))

    ctx.textPosition = CGPoint(x: x, y: baselineY)
    CTLineDraw(line, ctx)
}

/// Overlays a labelled grid in *global point* coordinates so a coordinate can be
/// read straight off the image without arithmetic.
///
/// Image row 0 is the top of the capture, but the context uses CG-native
/// bottom-left origin, so a top-down image offset maps to `height - offset`.
func drawGrid(in ctx: CGContext, imageWidth: Int, imageHeight: Int,
              originX: Double, originY: Double, pointsPerPixel: Double, step: Double) {
    let stepPx = step / pointsPerPixel
    guard stepPx >= 8 else { return }

    let W = Double(imageWidth)
    let H = Double(imageHeight)
    let fontSize = max(9.0, min(13.0, stepPx / 5))
    // Every line gets a label when there is room; otherwise only every fifth,
    // so labels never overlap into an unreadable smear.
    let labelEvery = stepPx >= 45 ? step : step * 5

    func isLabelled(_ v: Double) -> Bool {
        abs(v.truncatingRemainder(dividingBy: labelEvery)) < 1e-6
            || abs(abs(v.truncatingRemainder(dividingBy: labelEvery)) - labelEvery) < 1e-6
    }
    func isMajor(_ v: Double) -> Bool {
        let m = abs(v.truncatingRemainder(dividingBy: step * 5))
        return m < 1e-6 || abs(m - step * 5) < 1e-6
    }

    ctx.setLineWidth(1)

    // Vertical lines: global x = originX + imageX * pointsPerPixel
    var gx = (originX / step).rounded(.up) * step
    while true {
        let imgX = (gx - originX) / pointsPerPixel
        if imgX > W { break }
        if imgX >= 0 {
            let major = isMajor(gx)
            ctx.setStrokeColor(CGColor(red: 1, green: 0.11, blue: 0.42,
                                       alpha: major ? 0.85 : 0.30))
            ctx.setLineWidth(major ? 1.5 : 1)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: imgX, y: 0))
            ctx.addLine(to: CGPoint(x: imgX, y: H))
            ctx.strokePath()
            if isLabelled(gx) {
                // Along the top edge, nudged inside so nothing is clipped.
                drawLabel("\(Int(gx.rounded()))", x: imgX + 3,
                          baselineY: H - fontSize - 4, in: ctx, fontSize: fontSize)
            }
        }
        gx += step
    }

    // Horizontal lines
    var gy = (originY / step).rounded(.up) * step
    while true {
        let imgY = (gy - originY) / pointsPerPixel
        if imgY > H { break }
        if imgY >= 0 {
            let major = isMajor(gy)
            ctx.setStrokeColor(CGColor(red: 1, green: 0.11, blue: 0.42,
                                       alpha: major ? 0.85 : 0.30))
            ctx.setLineWidth(major ? 1.5 : 1)
            let cgY = H - imgY
            ctx.beginPath()
            ctx.move(to: CGPoint(x: 0, y: cgY))
            ctx.addLine(to: CGPoint(x: W, y: cgY))
            ctx.strokePath()
            if isLabelled(gy) {
                // Sits just below its line; the first row is pushed down so it
                // does not collide with the x-axis labels in the corner.
                let baseline = imgY < fontSize * 2 ? cgY - fontSize * 2.2 : cgY - fontSize - 3
                drawLabel("\(Int(gy.rounded()))", x: 3, baselineY: baseline,
                          in: ctx, fontSize: fontSize)
            }
        }
        gy += step
    }
}

func doImage(_ obj: [String: Any]) throws -> [String: Any] {
    guard let input = obj["input"] as? String, let output = obj["output"] as? String else {
        throw HelperError("missing 'input' or 'output'")
    }
    var image = try loadImage(input)
    let sourcePixelWidth = image.width
    let sourcePixelHeight = image.height

    // Crop in source pixels.
    if let cx = num(obj["cropX"]), let cy = num(obj["cropY"]),
        let cw = num(obj["cropW"]), let ch = num(obj["cropH"]) {
        let rect = CGRect(x: cx, y: cy, width: cw, height: ch)
            .intersection(CGRect(x: 0, y: 0, width: sourcePixelWidth, height: sourcePixelHeight))
        guard !rect.isNull, rect.width >= 1, rect.height >= 1 else {
            throw HelperError("crop rectangle does not overlap the captured image")
        }
        guard let cropped = image.cropping(to: rect.integral) else {
            throw HelperError("crop failed")
        }
        image = cropped
    }

    let targetW = max(1, Int(num(obj["targetW"]) ?? Double(image.width)))
    let targetH = max(1, Int(num(obj["targetH"]) ?? Double(image.height)))
    let grid = obj["grid"] as? [String: Any]

    // Redraw at the target size (also gives us a context to overlay the grid on).
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
        let ctx = CGContext(data: nil, width: targetW, height: targetH,
                            bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw HelperError("could not create drawing context") }

    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: targetW, height: targetH))

    if let grid = grid {
        drawGrid(in: ctx, imageWidth: targetW, imageHeight: targetH,
                 originX: num(grid["originX"]) ?? 0,
                 originY: num(grid["originY"]) ?? 0,
                 pointsPerPixel: num(grid["pointsPerPixel"]) ?? 1,
                 step: num(grid["step"]) ?? 100)
    }

    guard let out = ctx.makeImage() else { throw HelperError("could not render output image") }
    try writePNG(out, to: output)

    let attrs = try? FileManager.default.attributesOfItem(atPath: output)
    return [
        "output": output, "width": targetW, "height": targetH,
        "sourcePixelWidth": sourcePixelWidth, "sourcePixelHeight": sourcePixelHeight,
        "bytes": (attrs?[.size] as? Int) ?? 0,
    ]
}

// MARK: - Local OCR
//
// macOS ships an on-device text recogniser, so a screen region can be turned into
// text *locally* and only the text sent onward. A full-display screenshot costs
// ~1800 vision tokens and stays in context forever; the same screen read as text
// is a few hundred tokens and carries click coordinates with it.

func doOCR(_ obj: [String: Any]) throws -> [String: Any] {
    guard let input = obj["input"] as? String else { throw HelperError("missing 'input'") }
    let image = try loadImage(input)

    // Maps recognised boxes back into the global point space.
    let originX = num(obj["originX"]) ?? 0
    let originY = num(obj["originY"]) ?? 0
    let scale = num(obj["scale"]) ?? 1  // capture pixels per point
    let minConfidence = Float(num(obj["minConfidence"]) ?? 0.3)

    let request = VNRecognizeTextRequest()
    request.recognitionLevel =
        (obj["fast"] as? Bool ?? false) ? .fast : .accurate
    request.usesLanguageCorrection = obj["languageCorrection"] as? Bool ?? true
    if let langs = obj["languages"] as? [String], !langs.isEmpty {
        request.recognitionLanguages = langs
    }

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw HelperError("text recognition failed: \(error.localizedDescription)")
    }

    let pixelW = Double(image.width)
    let pixelH = Double(image.height)
    var lines: [[String: Any]] = []

    for observation in (request.results ?? []) {
        guard let candidate = observation.topCandidates(1).first else { continue }
        if candidate.confidence < minConfidence { continue }

        // Vision boxes are normalised with a bottom-left origin; the rest of clickr
        // is top-left in points, so flip and rescale.
        let b = observation.boundingBox
        let xPx = b.minX * pixelW
        let yPxFromTop = (1.0 - b.maxY) * pixelH
        let wPx = b.width * pixelW
        let hPx = b.height * pixelH

        let gx = originX + xPx / scale
        let gy = originY + yPxFromTop / scale
        let gw = wPx / scale
        let gh = hPx / scale

        lines.append([
            "text": candidate.string,
            "confidence": Double(candidate.confidence),
            "x": gx.rounded(), "y": gy.rounded(),
            "width": gw.rounded(), "height": gh.rounded(),
            // Ready to pass straight to `click`.
            "centerX": (gx + gw / 2).rounded(),
            "centerY": (gy + gh / 2).rounded(),
        ])
    }

    // Reading order: top to bottom, then left to right.
    lines.sort { a, b in
        let ay = a["y"] as? Double ?? 0, by = b["y"] as? Double ?? 0
        if abs(ay - by) > 6 { return ay < by }
        return (a["x"] as? Double ?? 0) < (b["x"] as? Double ?? 0)
    }

    return ["lineCount": lines.count, "lines": lines]
}

// MARK: - Occlusion

/// Windows stacked above `windowId` that overlap it. A window capture composites the
/// target unoccluded, so its image can show content that is really hidden — and a
/// click at those coordinates would land on whatever is actually on top.
func doOcclusion(_ obj: [String: Any]) throws -> [String: Any] {
    let wid = Int(try req(obj, "windowId"))
    guard let raw = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { throw HelperError("could not read the window list") }

    guard let targetIndex = raw.firstIndex(where: { ($0[kCGWindowNumber as String] as? Int) == wid })
    else { throw HelperError("window \(wid) is not on screen") }

    guard let bd = raw[targetIndex][kCGWindowBounds as String] as? [String: Any],
        let target = CGRect(dictionaryRepresentation: bd as CFDictionary)
    else { throw HelperError("window \(wid) has no bounds") }

    var occluders: [[String: Any]] = []
    var coveredArea = 0.0
    // The list is front-to-back, so anything before the target sits above it.
    for w in raw[..<targetIndex] {
        guard (w[kCGWindowLayer as String] as? Int ?? 0) <= 0 else { continue }
        guard let obd = w[kCGWindowBounds as String] as? [String: Any],
            let r = CGRect(dictionaryRepresentation: obd as CFDictionary)
        else { continue }
        let overlap = r.intersection(target)
        if overlap.isNull || overlap.width < 1 || overlap.height < 1 { continue }
        coveredArea += Double(overlap.width * overlap.height)
        occluders.append([
            "windowId": w[kCGWindowNumber as String] as? Int ?? 0,
            "app": w[kCGWindowOwnerName as String] as? String ?? "",
            "title": w[kCGWindowName as String] as? String ?? "",
            "x": Double(overlap.minX), "y": Double(overlap.minY),
            "width": Double(overlap.width), "height": Double(overlap.height),
        ])
    }

    let total = Double(target.width * target.height)
    return [
        "windowId": wid,
        "occluded": !occluders.isEmpty,
        "coveredFraction": total > 0 ? min(1.0, coveredArea / total) : 0,
        "occluders": occluders,
    ]
}

// MARK: - Dispatch

func handle(_ obj: [String: Any]) throws -> [String: Any] {
    guard let cmd = obj["cmd"] as? String else { throw HelperError("missing 'cmd'") }
    switch cmd {
    case "ping":
        return ["pong": true]
    case "permissions":
        let prompt = obj["prompt"] as? Bool ?? false
        return [
            "accessibility": prompt ? accessibilityTrusted(prompt: true) : AXIsProcessTrusted(),
            "screenRecording": screenRecordingGranted(),
        ]
    case "requestScreenRecording":
        return ["requested": CGRequestScreenCaptureAccess()]
    case "displays":
        return ["displays": displayList()]
    case "windows":
        return ["windows": windowList(
            appFilter: obj["app"] as? String,
            onScreenOnly: obj["onScreenOnly"] as? Bool ?? true,
            includeAllLayers: obj["includeAllLayers"] as? Bool ?? false)]
    case "apps":
        return ["apps": appList()]
    case "mouse":
        let p = currentMouse()
        return ["x": p.x, "y": p.y]
    case "click": return try doClick(obj)
    case "move": return try doMove(obj)
    case "drag": return try doDrag(obj)
    case "scroll": return try doScroll(obj)
    case "type": return try doType(obj)
    case "key": return try doKey(obj)
    case "clipget": return clipboardGet()
    case "clipset":
        guard let text = obj["text"] as? String else { throw HelperError("missing 'text'") }
        return clipboardSet(text)
    case "activate": return try doActivate(obj)
    case "setwindow": return try doSetWindow(obj)
    case "image": return try doImage(obj)
    case "elements": return try doFindElements(obj)
    case "elementat": return try doElementAt(obj)
    case "ocr": return try doOCR(obj)
    case "occlusion": return try doOcclusion(obj)
    default:
        throw HelperError("unknown command '\(cmd)'")
    }
}

// MARK: - Main loop

func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.fragmentsAllowed]),
        var line = String(data: data, encoding: .utf8)
    else {
        FileHandle.standardOutput.write("{\"ok\":false,\"error\":\"response encoding failed\"}\n".data(using: .utf8)!)
        return
    }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }

    var id: Any = NSNull()
    do {
        guard let data = trimmed.data(using: .utf8),
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw HelperError("request is not a JSON object") }
        id = obj["id"] ?? NSNull()
        var response = try handle(obj)
        response["ok"] = true
        response["id"] = id
        emit(response)
    } catch let e as HelperError {
        emit(["ok": false, "error": e.message, "id": id])
    } catch {
        emit(["ok": false, "error": "\(error)", "id": id])
    }
}
