// ZZTIMING: temporary capture benchmark for ct-94266. Deleted before handoff.
import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
@preconcurrency import ScreenCaptureKit
import VideoToolbox

final class ZZBox<T>: @unchecked Sendable { var value: T; init(_ v: T) { value = v } }

final class ZZGrabber: NSObject, SCStreamOutput, @unchecked Sendable {
    let lock = NSLock()
    var latest: CVPixelBuffer?
    var frames = 0
    var firstFrame = DispatchSemaphore(value: 0)
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, raw == SCFrameStatus.complete.rawValue,
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        lock.lock()
        let first = frames == 0
        latest = pixels
        frames += 1
        lock.unlock()
        if first { firstFrame.signal() }
    }
}

func zzWait<T>(_ body: @escaping @Sendable () async throws -> T) throws -> T {
    let box = ZZBox<Result<T, Error>?>(nil)
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        do { box.value = .success(try await body()) } catch { box.value = .failure(error) }
        done.signal()
    }
    done.wait()
    return try box.value!.get()
}

func zzMs(_ start: Double) -> Double { (ProcessInfo.processInfo.systemUptime - start) * 1000 }
func zzMedian(_ v: [Double]) -> Double { let s = v.sorted(); return s.isEmpty ? -1 : s[s.count / 2] }

func zzCaptureBench(windowId: CGWindowID, reps: Int) -> [String: Any] {
    var out: [String: Any] = [:]
    for (name, option) in [("cgBest", CGWindowImageOption.bestResolution), ("cgNominal", CGWindowImageOption.nominalResolution)] {
        var times: [Double] = []
        var size = ""
        for _ in 0..<reps {
            let t = ProcessInfo.processInfo.systemUptime
            let image = CGWindowListCreateImage(.null, [.optionIncludingWindow], windowId, [.boundsIgnoreFraming, option])
            times.append(zzMs(t))
            size = "\(image?.width ?? 0)x\(image?.height ?? 0)"
        }
        out[name] = ["medianMs": zzMedian(times), "size": size, "samples": times]
    }
    do {
        var t = ProcessInfo.processInfo.systemUptime
        let content = try zzWait { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        let contentMs = zzMs(t)
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else { out["sck"] = "window not in shareable content"; return out }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = Double(filter.pointPixelScale)
        config.width = Int(Double(window.frame.width) * scale)
        config.height = Int(Double(window.frame.height) * scale)
        config.showsCursor = false
        config.capturesAudio = false
        config.pixelFormat = kCVPixelFormatType_32BGRA
        // One-shot, the way main.swift's note says was rejected.
        var oneShot: [Double] = []
        for _ in 0..<reps {
            t = ProcessInfo.processInfo.systemUptime
            _ = try zzWait { try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
            oneShot.append(zzMs(t))
        }
        out["sckOneShot"] = ["medianMs": zzMedian(oneShot), "samples": oneShot, "shareableContentMs": contentMs]
        // A persistent stream: start cost once, then each read takes the latest frame.
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 3
        let grabber = ZZGrabber()
        t = ProcessInfo.processInfo.systemUptime
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(grabber, type: .screen, sampleHandlerQueue: DispatchQueue(label: "zz.sck"))
        try zzWait { try await stream.startCapture() }
        let startMs = zzMs(t)
        let gotFirst = grabber.firstFrame.wait(timeout: .now() + 3) == .success
        let firstFrameMs = zzMs(t)
        var reads: [Double] = []
        for _ in 0..<reps {
            t = ProcessInfo.processInfo.systemUptime
            grabber.lock.lock(); let pixels = grabber.latest; grabber.lock.unlock()
            var image: CGImage?
            if let pixels { VTCreateCGImageFromCVPixelBuffer(pixels, options: nil, imageOut: &image) }
            reads.append(zzMs(t))
            usleep(50_000)
        }
        let framesBefore = grabber.frames
        usleep(1_000_000)
        let idleFps = grabber.frames - framesBefore
        try? zzWait { try await stream.stopCapture() }
        out["sckStream"] = [
            "startMs": startMs, "firstFrameMs": gotFirst ? firstFrameMs : -1,
            "readMedianMs": zzMedian(reads), "readSamples": reads, "framesPerIdleSecond": idleFps,
            "size": "\(config.width)x\(config.height)",
        ]
    } catch {
        out["sckError"] = "\(error)"
    }
    return out
}
