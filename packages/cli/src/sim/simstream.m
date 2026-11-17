// simstream: one simulator's screen out, a person's touches in.
//
// Built on the machine by sim/simstream.ts against the FBSimulatorControl
// frameworks axe installs, so it speaks to the simulator in process: a
// screenshot is ~30 ms here against ~300 ms for a fresh `axe` or `simctl`
// process, and a touch lands in the same frame it was sent.
//
// stdout: frames, each a 12-byte header (big-endian uint32 length, width,
// height) and the JPEG. A frame goes out only when the screen changed.
// stderr: a line `simstream: screen <wpx> <hpx> <scale>` once attached, then
// diagnostics.
// stdin: one command per line. Any line wakes the frame loop to full rate.
//   down <x> <y> | up <x> <y>      touch, in points (a down while down moves)
//   key <hid keycode>              press and release one key
//   keydown <code> | keyup <code>  hold a key (shift, for a capital)
//   button <home|lock|side|siri|applepay>
//   wake                           nothing else
// stdin closing ends the process, so it never outlives the daemon.

#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#import <FBControlCore/FBControlCore.h>
#import <FBSimulatorControl/FBSimulatorControl.h>
#include <signal.h>
#include <unistd.h>
#include <arpa/inet.h>

// Change is judged on a small decode, never on the JPEG: the simulator
// re-encodes an unchanged screen to different bytes. JPEG decodes this small
// by subsampling, a fraction of a full decode.
#define PROBE_DIM 330
// After this many unchanged polls the loop slows to IDLE_INTERVAL; a change
// or any command puts it back to full rate.
#define IDLE_AFTER 30
#define IDLE_INTERVAL 0.5

static volatile int still = 0;
static NSData *lastProbe = nil;

static void writeAll(const void *buf, size_t len) {
  const uint8_t *p = buf;
  while (len > 0) {
    ssize_t n = write(STDOUT_FILENO, p, len);
    if (n <= 0) exit(0);
    p += n;
    len -= (size_t)n;
  }
}

static CGImageRef thumbnail(NSData *jpeg, int maxDim) {
  CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)jpeg, NULL);
  if (!src) return NULL;
  NSDictionary *opts = @{
    (id)kCGImageSourceCreateThumbnailFromImageAlways : @YES,
    (id)kCGImageSourceThumbnailMaxPixelSize : @(maxDim),
    (id)kCGImageSourceCreateThumbnailWithTransform : @YES,
  };
  CGImageRef img = CGImageSourceCreateThumbnailAtIndex(src, 0, (__bridge CFDictionaryRef)opts);
  CFRelease(src);
  return img;
}

static NSData *probePixels(NSData *jpeg) {
  CGImageRef img = thumbnail(jpeg, PROBE_DIM);
  if (!img) return nil;
  NSData *px = CFBridgingRelease(CGDataProviderCopyData(CGImageGetDataProvider(img)));
  CGImageRelease(img);
  return px;
}

static NSData *encodeFrame(NSData *jpeg, int maxDim, double quality, uint32_t *w, uint32_t *h) {
  CGImageRef img = thumbnail(jpeg, maxDim);
  if (!img) return nil;
  *w = (uint32_t)CGImageGetWidth(img);
  *h = (uint32_t)CGImageGetHeight(img);
  NSMutableData *out = [NSMutableData data];
  CGImageDestinationRef dst = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)out, CFSTR("public.jpeg"), 1, NULL);
  CGImageDestinationAddImage(dst, img, (__bridge CFDictionaryRef)@{(id)kCGImageDestinationLossyCompressionQuality : @(quality)});
  BOOL ok = CGImageDestinationFinalize(dst);
  CFRelease(dst);
  CGImageRelease(img);
  return ok ? out : nil;
}

static int buttonNamed(NSString *name) {
  if ([name isEqualToString:@"home"]) return FBSimulatorHIDButtonHomeButton;
  if ([name isEqualToString:@"lock"]) return FBSimulatorHIDButtonLock;
  if ([name isEqualToString:@"side"]) return FBSimulatorHIDButtonSideButton;
  if ([name isEqualToString:@"siri"]) return FBSimulatorHIDButtonSiri;
  if ([name isEqualToString:@"applepay"]) return FBSimulatorHIDButtonApplePay;
  return 0;
}

// iOS ignores a touch lifted the instant it landed, and a click relayed
// through the daemon arrives as a down and an up back to back. A finger stays
// down at least this long.
#define MIN_TOUCH_SECONDS 0.06
static CFAbsoluteTime touchDownAt = 0;

// One command line from the daemon, run on the HID queue so a burst of moves
// lands in order.
static void runCommand(FBSimulatorHID *hid, NSString *line) {
  NSArray<NSString *> *f = [line componentsSeparatedByString:@" "];
  if (f.count == 0 || !hid) return;
  NSString *verb = f[0];
  NSError *err = nil;
  if (([verb isEqualToString:@"down"] || [verb isEqualToString:@"up"]) && f.count >= 3) {
    FBSimulatorHIDDirection dir = [verb isEqualToString:@"down"] ? FBSimulatorHIDDirectionDown : FBSimulatorHIDDirectionUp;
    if (dir == FBSimulatorHIDDirectionDown) {
      if (touchDownAt == 0) touchDownAt = CFAbsoluteTimeGetCurrent();
    } else {
      double held = CFAbsoluteTimeGetCurrent() - touchDownAt;
      if (touchDownAt > 0 && held < MIN_TOUCH_SECONDS) usleep((useconds_t)((MIN_TOUCH_SECONDS - held) * 1e6));
      touchDownAt = 0;
    }
    [[hid sendTouchWithType:dir x:f[1].doubleValue y:f[2].doubleValue] await:&err];
  } else if ([verb isEqualToString:@"key"] && f.count >= 2) {
    unsigned int code = (unsigned int)f[1].intValue;
    [[hid sendKeyboardEventWithDirection:FBSimulatorHIDDirectionDown keyCode:code] await:&err];
    [[hid sendKeyboardEventWithDirection:FBSimulatorHIDDirectionUp keyCode:code] await:&err];
  } else if (([verb isEqualToString:@"keydown"] || [verb isEqualToString:@"keyup"]) && f.count >= 2) {
    FBSimulatorHIDDirection dir = [verb isEqualToString:@"keydown"] ? FBSimulatorHIDDirectionDown : FBSimulatorHIDDirectionUp;
    [[hid sendKeyboardEventWithDirection:dir keyCode:(unsigned int)f[1].intValue] await:&err];
  } else if ([verb isEqualToString:@"button"] && f.count >= 2) {
    int b = buttonNamed(f[1]);
    if (b) {
      [[hid sendButtonEventWithDirection:FBSimulatorHIDDirectionDown button:b] await:&err];
      [[hid sendButtonEventWithDirection:FBSimulatorHIDDirectionUp button:b] await:&err];
    }
  }
  if (err) fprintf(stderr, "simstream: %s failed: %s\n", verb.UTF8String, err.localizedDescription.UTF8String);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    if (argc < 2) {
      fprintf(stderr, "usage: simstream <udid> [fps] [quality 0-1] [max dimension px]\n");
      return 2;
    }
    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    double fps = argc > 2 ? atof(argv[2]) : 15;
    double quality = argc > 3 ? atof(argv[3]) : 0.6;
    int maxDim = argc > 4 ? atoi(argv[4]) : 1280;
    if (fps <= 0 || fps > 60) fps = 15;
    if (quality <= 0 || quality > 1) quality = 0.6;
    if (maxDim < 64) maxDim = 1280;

    [FBSimulatorControlFrameworkLoader.essentialFrameworks loadPrivateFrameworksOrAbort];
    [FBSimulatorControlFrameworkLoader.xcodeFrameworks loadPrivateFrameworksOrAbort];

    // FBFuture resolves on the main queue, so nothing below may await on it:
    // the work runs on background queues and main only parks.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSError *err = nil;
      FBSimulatorControlConfiguration *cfg = [FBSimulatorControlConfiguration configurationWithDeviceSetPath:nil logger:nil reporter:nil];
      FBSimulatorControl *control = [FBSimulatorControl withConfiguration:cfg error:&err];
      if (!control) { fprintf(stderr, "simstream: %s\n", err.localizedDescription.UTF8String); exit(1); }
      FBSimulator *sim = [control.set simulatorWithUDID:udid];
      if (!sim) { fprintf(stderr, "simstream: no simulator %s\n", udid.UTF8String); exit(3); }
      if (sim.state != FBiOSTargetStateBooted) { fprintf(stderr, "simstream: simulator %s is not booted\n", udid.UTF8String); exit(5); }
      FBiOSTargetScreenInfo *screen = sim.screenInfo;
      fprintf(stderr, "simstream: screen %lu %lu %.2f\n", (unsigned long)screen.widthPixels, (unsigned long)screen.heightPixels, screen.scale);

      FBSimulatorHID *hid = [[FBSimulatorHID hidForSimulator:sim] await:&err];
      if (hid) [[hid connect] await:&err];
      if (!hid) fprintf(stderr, "simstream: no input: %s\n", err.localizedDescription.UTF8String);
      dispatch_queue_t hidQueue = dispatch_queue_create("simstream.hid", DISPATCH_QUEUE_SERIAL);

      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        char buf[512];
        while (fgets(buf, sizeof buf, stdin)) {
          still = 0;
          NSString *line = [[NSString stringWithUTF8String:buf] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
          if (line.length && ![line isEqualToString:@"wake"]) dispatch_async(hidQueue, ^{ runCommand(hid, line); });
        }
        exit(0);
      });

      int failures = 0;
      const double interval = 1.0 / fps;
      for (;;) {
        @autoreleasepool {
          NSDate *start = [NSDate date];
          NSError *e = nil;
          NSData *raw = [[sim takeScreenshot:FBScreenshotFormatJPEG] await:&e];
          if (!raw) {
            if (++failures >= 20) { fprintf(stderr, "simstream: %s\n", e.localizedDescription.UTF8String); exit(4); }
            usleep(250000);
            continue;
          }
          failures = 0;
          NSData *probe = probePixels(raw);
          BOOL changed = !probe || !lastProbe || ![probe isEqualToData:lastProbe];
          if (changed) {
            lastProbe = probe;
            still = 0;
            uint32_t w = 0, h = 0;
            NSData *frame = encodeFrame(raw, maxDim, quality, &w, &h);
            if (frame) {
              uint32_t head[3] = {htonl((uint32_t)frame.length), htonl(w), htonl(h)};
              writeAll(head, sizeof head);
              writeAll(frame.bytes, frame.length);
            }
          } else {
            still++;
          }
          double left = (still >= IDLE_AFTER ? IDLE_INTERVAL : interval) + [start timeIntervalSinceNow];
          if (left > 0) usleep((useconds_t)(left * 1e6));
        }
      }
    });
    dispatch_main();
  }
  return 0;
}
