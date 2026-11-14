import AppKit
import SwiftUI

// A SwiftUI window for `computer-bgmouse-matrix.ts`: a button, a tap target
// with no accessibility action, and a drag pad, each counting what reached it
// into a status file, so a background press is checked against the app.
// Like the bench fixture it never activates and opens at the back.
//
//   swiftui-fixture --status-file <path>

final class Model: ObservableObject {
    @Published var buttonPresses = 0
    @Published var taps = 0
    @Published var drags = 0
    @Published var scrolls = 0
    var activations: [String] = []
}

struct ProbeView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(spacing: 16) {
            Button("Probe Button") { model.buttonPresses += 1 }
                .controlSize(.large)
            Rectangle()
                .fill(Color.orange)
                .frame(width: 220, height: 90)
                .overlay(Text("TAP ZONE").font(.title).foregroundColor(.black))
                .onTapGesture { model.taps += 1 }
                .accessibilityHidden(true)
            Rectangle()
                .fill(Color.teal)
                .frame(width: 220, height: 90)
                .overlay(Text("DRAG ZONE").font(.title).foregroundColor(.black))
                .gesture(DragGesture(minimumDistance: 10).onEnded { _ in model.drags += 1 })
                .accessibilityHidden(true)
        }
        .padding(30)
        .frame(width: 320, height: 340)
    }
}

final class Fixture: NSObject, NSApplicationDelegate {
    let statusFile: String
    let model = Model()
    var window: NSWindow!
    var observers: [Any] = []

    init(statusFile: String) {
        self.statusFile = statusFile
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 360, y: 260, width: 320, height: 340), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "SwiftUI Probe"
        window.contentView = NSHostingView(rootView: ProbeView(model: model))
        window.orderBack(nil)
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                self?.model.activations.append(note.name.rawValue)
                self?.write()
            })
        }
        observers.append(model.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.write() } })
        write()
        print("READY pid=\(ProcessInfo.processInfo.processIdentifier) windows=SwiftUI Probe=\(window.windowNumber)")
        fflush(stdout)
    }

    func write() {
        let status: [String: Any] = [
            "buttonPresses": model.buttonPresses,
            "taps": model.taps,
            "drags": model.drags,
            "active": NSApp.isActive,
            "activations": model.activations,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: status) {
            try? data.write(to: URL(fileURLWithPath: statusFile), options: .atomic)
        }
    }
}

import Combine

let args = CommandLine.arguments
guard let i = args.firstIndex(of: "--status-file"), i + 1 < args.count else {
    fputs("usage: swiftui-fixture --status-file <path>\n", stderr)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Fixture(statusFile: args[i + 1])
app.delegate = delegate
app.run()
