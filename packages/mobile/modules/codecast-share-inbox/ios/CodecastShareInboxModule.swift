// The app's side of the share inbox (ShareInbox.swift holds the storage both
// sides share; the extension's side is targets/share).

import ExpoModulesCore

public class CodecastShareInboxModule: Module {
    public func definition() -> ModuleDefinition {
        Name("CodecastShareInbox")

        Function("takeAll") { () -> [String] in
            ShareInbox.takeAll()
        }
    }
}
