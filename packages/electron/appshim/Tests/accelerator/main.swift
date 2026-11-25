import Carbon.HIToolbox

// Built with Sources/Accelerator.swift by accelerator.test.js; exits nonzero on a failure.
var failures = 0
func expect(_ ok: Bool, _ label: String) {
    if !ok { failures += 1; print("FAIL: \(label)") }
}

let k = Accelerator.parse("CmdOrCtrl+Shift+K")
expect(k == Accelerator(keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(cmdKey | shiftKey)), "CmdOrCtrl+Shift+K")
expect(k?.modifierCount == 2, "two modifiers")
expect(Accelerator.parse("ctrl + alt + space") == Accelerator(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)), "spaces and case")
expect(Accelerator.parse("Command+Option+F12")?.keyCode == UInt32(kVK_F12), "F12")
expect(Accelerator.parse("Super+Shift+Plus")?.keyCode == UInt32(kVK_ANSI_Equal), "Plus")
expect(Accelerator.parse("K")?.modifierCount == 0, "bare key parses; the engine rejects it")
expect(Accelerator.parse("CmdOrCtrl+Shift+") == nil, "missing key")
expect(Accelerator.parse("CmdOrCtrl++") == nil, "empty part")
expect(Accelerator.parse("Hyper+K") == nil, "unknown modifier")
expect(Accelerator.parse("Cmd+Shift+Banana") == nil, "unknown key")
expect(Accelerator.parse("") == nil, "empty")

if failures > 0 { exit(1) }
print("ok")
