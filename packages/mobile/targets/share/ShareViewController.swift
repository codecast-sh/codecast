// "Codecast" in the share sheet. It saves the shared images into the app group
// (ShareInbox) and opens the app, which starts a new session with them
// attached. Nothing is uploaded here: the app owns sign-in, the upload and the
// choice of agent, machine and folder.
//
// If the app cannot be opened, the images still wait in the inbox and the new
// session sheet shows them the next time the app is opened.

import UIKit
import ImageIO
import UniformTypeIdentifiers

class ShareViewController: UIViewController {
    /// The inbox tab; the app takes the inbox's images whenever it becomes active.
    private static let appURL = URL(string: "codecast://inbox")!
    /// Longest edge of an image that has to be re-encoded.
    private static let maxPixels = 4096

    private var started = false

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true

        let image = UTType.image.identifier
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(image) }
        let batch = Int(Date().timeIntervalSince1970 * 1000)
        let group = DispatchGroup()
        for (index, provider) in providers.enumerated() {
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: image) { data, _ in
                if let data, let file = Self.uploadable(data) {
                    ShareInbox.save(file.data, ext: file.ext, batch: batch, index: index)
                }
                group.leave()
            }
        }
        group.notify(queue: .main) { [weak self] in
            self?.openApp()
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    /// PNG and JPEG go as they are (a screenshot stays pixel-exact). Anything
    /// else, HEIC photos above all, becomes a JPEG a browser and an agent's
    /// image reader can open, decoded at a bounded size: an extension is
    /// killed well below the memory a full 48MP decode takes.
    static func uploadable(_ data: Data) -> (data: Data, ext: String)? {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return (data, "png") }
        if data.starts(with: [0xFF, 0xD8, 0xFF]) { return (data, "jpg") }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixels,
              ] as CFDictionary),
              let jpeg = UIImage(cgImage: scaled).jpegData(compressionQuality: 0.8) else { return nil }
        return (jpeg, "jpg")
    }

    /// An extension has no public way to open its app. UIApplication is still
    /// at the end of the responder chain, and its open method is only marked
    /// unavailable to extensions at compile time, so it is called by name.
    private func openApp() {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication, current.responds(to: selector) {
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let open = unsafeBitCast(current.method(for: selector), to: Open.self)
                open(current, selector, Self.appURL as NSURL, NSDictionary(), nil)
                return
            }
            responder = current.next
        }
    }
}
