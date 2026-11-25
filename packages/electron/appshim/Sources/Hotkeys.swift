import Carbon.HIToolbox

/// Global shortcuts through Carbon's RegisterEventHotKey, which needs no
/// Accessibility grant. Fires `onFire` with the accelerator as registered.
@MainActor
final class Hotkeys {
    static let shared = Hotkeys()
    var onFire: ((String) -> Void)?
    private var registered: [String: (id: UInt32, ref: EventHotKeyRef)] = [:]
    private var nextId: UInt32 = 1
    private var handlerInstalled = false

    /// Returns nil on success, or why it failed.
    func register(_ accelerator: String) -> String? {
        if registered[accelerator] != nil { return nil }
        guard let parsed = Accelerator.parse(accelerator) else { return "cannot parse \(accelerator)" }
        installHandler()
        var ref: EventHotKeyRef?
        let id = nextId
        nextId += 1
        let hotKeyId = EventHotKeyID(signature: OSType(0x4343_4150), id: id) // 'CCAP'
        let status = RegisterEventHotKey(parsed.keyCode, parsed.modifiers, hotKeyId, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            return status == eventHotKeyExistsErr ? "\(accelerator) is taken by another app" : "RegisterEventHotKey failed (\(status))"
        }
        registered[accelerator] = (id, ref)
        return nil
    }

    func unregister(_ accelerator: String) {
        guard let entry = registered.removeValue(forKey: accelerator) else { return }
        UnregisterEventHotKey(entry.ref)
    }

    fileprivate func fire(_ id: UInt32) {
        if let accelerator = registered.first(where: { $0.value.id == id })?.key { onFire?(accelerator) }
    }

    private func installHandler() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hotKeyId = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyId)
            MainActor.assumeIsolated { Hotkeys.shared.fire(hotKeyId.id) }
            return noErr
        }, 1, &spec, nil, nil)
    }
}
