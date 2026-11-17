// simstream: one simulator's screen out, a person's touches in.
//
// Built on the machine by sim/simstream.ts against the FBSimulatorControl
// frameworks axe installs, so it speaks to the simulator in process: a
// screenshot is ~30 ms here against ~300 ms for a fresh `axe` or `simctl`
// process, and a touch lands in the same frame it was sent.
//
// The device keeps a portrait framebuffer when it is turned (an app draws
// sideways into it), so the helper turns each frame upright for the device's
// orientation and maps a touch back from the upright picture to the panel.
// The orientation is a GraphicsServices event to the device's
// PurpleWorkspacePort, the way Simulator.app rotates, and it is kept in a
// small file beside the pool lock so every helper on the device agrees.
//
// Usage:
//   simstream <udid> <fps> <quality 0-1> <max px> <orientation file>
//   simstream <udid> --orient <1-4> <orientation file>     one-shot rotate
// Orientations are UIDeviceOrientation: 1 portrait, 2 upside down,
// 3 landscape left, 4 landscape right.
//
// stdout: frames, each a 12-byte header (big-endian uint32 length, width,
// height) and the JPEG, upright. A frame goes out only when the screen changed.
// stderr: `simstream: screen <wpx> <hpx> <scale> <orientation>` once attached
// and again on every turn (the size as shown, upright), `simstream: captured
// <path>` or `simstream: capture failed`, and diagnostics.
// stdin: one command per line. Any line wakes the frame loop to full rate.
//   down <x> <y> | up <x> <y>      touch, in points of the upright picture
//   key <hid keycode>              press and release one key
//   keydown <code> | keyup <code>  hold a key (shift, for a capital)
//   button <home|lock|side|siri|applepay>
//   rotate <1-4>                   turn the device
//   capture <path>                 a full resolution PNG, upright, to path
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
#include <mach/mach.h>
#include <math.h>

@interface NSObject (SimDeviceLookup)
- (mach_port_t)lookup:(NSString *)name error:(NSError **)error;
@end

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
static volatile int orientation = 1;
static NSString *orientationFile = nil;
// The panel in points, portrait, as the device has it.
static double panelW = 0, panelH = 0;

static int readOrientation(void) {
  if (!orientationFile) return 1;
  int o = [[NSString stringWithContentsOfFile:orientationFile encoding:NSUTF8StringEncoding error:nil] intValue];
  return o >= 1 && o <= 4 ? o : 1;
}

static BOOL sideways(int o) { return o == 3 || o == 4; }

/** A point in the upright picture, back on the portrait panel. */
static void toPanel(double x, double y, double *px, double *py) {
  switch (orientation) {
    case 2: *px = panelW - x; *py = panelH - y; break;
    case 3: *px = panelW - y; *py = x; break;
    case 4: *px = y; *py = panelH - x; break;
    default: *px = x; *py = y; break;
  }
}

/** The portrait image turned upright for the device's orientation. */
static CGImageRef upright(CGImageRef img, int o) {
  if (o == 1) return CGImageRetain(img);
  size_t w = CGImageGetWidth(img), h = CGImageGetHeight(img);
  size_t dw = sideways(o) ? h : w, dh = sideways(o) ? w : h;
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(NULL, dw, dh, 8, 0, cs, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
  CGColorSpaceRelease(cs);
  if (!ctx) return CGImageRetain(img);
  if (o == 3) { CGContextTranslateCTM(ctx, h, 0); CGContextRotateCTM(ctx, M_PI_2); }
  else if (o == 4) { CGContextTranslateCTM(ctx, 0, w); CGContextRotateCTM(ctx, -M_PI_2); }
  else { CGContextTranslateCTM(ctx, w, h); CGContextRotateCTM(ctx, M_PI); }
  CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), img);
  CGImageRef out = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  return out;
}

static NSData *encodeImage(CGImageRef img, CFStringRef type, double quality) {
  NSMutableData *out = [NSMutableData data];
  CGImageDestinationRef dst = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)out, type, 1, NULL);
  NSDictionary *props = quality > 0 ? @{(id)kCGImageDestinationLossyCompressionQuality : @(quality)} : @{};
  CGImageDestinationAddImage(dst, img, (__bridge CFDictionaryRef)props);
  BOOL ok = CGImageDestinationFinalize(dst);
  CFRelease(dst);
  return ok ? out : nil;
}

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
  CGImageRef small = thumbnail(jpeg, maxDim);
  if (!small) return nil;
  CGImageRef img = upright(small, orientation);
  CGImageRelease(small);
  *w = (uint32_t)CGImageGetWidth(img);
  *h = (uint32_t)CGImageGetHeight(img);
  NSData *out = encodeImage(img, CFSTR("public.jpeg"), quality);
  CGImageRelease(img);
  return out;
}

static void announceScreen(FBiOSTargetScreenInfo *screen) {
  unsigned long w = screen.widthPixels, h = screen.heightPixels;
  if (sideways(orientation)) { unsigned long t = w; w = h; h = t; }
  fprintf(stderr, "simstream: screen %lu %lu %.2f %d\n", w, h, screen.scale, orientation);
}

/** Turn the device: a GSEvent of type 50 (device orientation changed) to its
 *  PurpleWorkspacePort, the message Simulator.app's rotate menu sends. */
static BOOL sendOrientation(FBSimulator *sim, int o) {
  NSError *err = nil;
  mach_port_t port = [(NSObject *)sim.device lookup:@"PurpleWorkspacePort" error:&err];
  if (!port) {
    fprintf(stderr, "simstream: rotate failed: no PurpleWorkspacePort (%s)\n", err.localizedDescription.UTF8String);
    return NO;
  }
  uint8_t buf[112] = {0};
  uint32_t v;
  v = 0x13; memcpy(buf + 0x00, &v, 4);            // MACH_MSGH_BITS(COPY_SEND, 0)
  v = 108; memcpy(buf + 0x04, &v, 4);             // msgh_size
  memcpy(buf + 0x08, &port, 4);                   // msgh_remote_port
  v = 0x7B; memcpy(buf + 0x14, &v, 4);            // msgh_id
  v = 50 | 0x20000; memcpy(buf + 0x18, &v, 4);    // kGSEventDeviceOrientationChanged | host flag
  v = 4; memcpy(buf + 0x48, &v, 4);               // record_info_size
  v = (uint32_t)o; memcpy(buf + 0x4C, &v, 4);     // the orientation
  kern_return_t kr = mach_msg((mach_msg_header_t *)buf, MACH_SEND_MSG | MACH_SEND_TIMEOUT, 108, 0, MACH_PORT_NULL, 2000, MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    fprintf(stderr, "simstream: rotate failed: mach_msg %d\n", kr);
    return NO;
  }
  orientation = o;
  if (orientationFile) [[NSString stringWithFormat:@"%d\n", o] writeToFile:orientationFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
  return YES;
}

static void capture(FBSimulator *sim, NSString *path) {
  NSError *err = nil;
  NSData *png = [[sim takeScreenshot:FBScreenshotFormatPNG] await:&err];
  CGImageSourceRef src = png ? CGImageSourceCreateWithData((__bridge CFDataRef)png, NULL) : NULL;
  CGImageRef raw = src ? CGImageSourceCreateImageAtIndex(src, 0, NULL) : NULL;
  if (src) CFRelease(src);
  if (!raw) {
    fprintf(stderr, "simstream: capture failed\n");
    return;
  }
  CGImageRef img = upright(raw, orientation);
  CGImageRelease(raw);
  NSData *out = encodeImage(img, CFSTR("public.png"), 0);
  CGImageRelease(img);
  if (out && [out writeToFile:path atomically:YES]) fprintf(stderr, "simstream: captured %s\n", path.UTF8String);
  else fprintf(stderr, "simstream: capture failed\n");
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
static void runCommand(FBSimulator *sim, FBSimulatorHID *hid, NSString *line) {
  NSArray<NSString *> *f = [line componentsSeparatedByString:@" "];
  if (f.count == 0) return;
  NSString *verb = f[0];
  NSError *err = nil;
  if ([verb isEqualToString:@"rotate"] && f.count >= 2) {
    int o = f[1].intValue;
    if (o >= 1 && o <= 4 && sendOrientation(sim, o)) {
      lastProbe = nil;
      announceScreen(sim.screenInfo);
    }
    return;
  }
  if ([verb isEqualToString:@"capture"] && f.count >= 2) {
    capture(sim, [[f subarrayWithRange:NSMakeRange(1, f.count - 1)] componentsJoinedByString:@" "]);
    return;
  }
  if (!hid) return;
  if (([verb isEqualToString:@"down"] || [verb isEqualToString:@"up"]) && f.count >= 3) {
    FBSimulatorHIDDirection dir = [verb isEqualToString:@"down"] ? FBSimulatorHIDDirectionDown : FBSimulatorHIDDirectionUp;
    if (dir == FBSimulatorHIDDirectionDown) {
      if (touchDownAt == 0) touchDownAt = CFAbsoluteTimeGetCurrent();
    } else {
      double held = CFAbsoluteTimeGetCurrent() - touchDownAt;
      if (touchDownAt > 0 && held < MIN_TOUCH_SECONDS) usleep((useconds_t)((MIN_TOUCH_SECONDS - held) * 1e6));
      touchDownAt = 0;
    }
    double px, py;
    toPanel(f[1].doubleValue, f[2].doubleValue, &px, &py);
    [[hid sendTouchWithType:dir x:px y:py] await:&err];
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
      fprintf(stderr, "usage: simstream <udid> <fps> <quality 0-1> <max px> <orientation file>\n       simstream <udid> --orient <1-4> <orientation file>\n");
      return 2;
    }
    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    BOOL oneShot = argc > 3 && strcmp(argv[2], "--orient") == 0;
    int wanted = oneShot ? atoi(argv[3]) : 0;
    if (oneShot && (wanted < 1 || wanted > 4)) { fprintf(stderr, "simstream: orientation is 1-4\n"); return 2; }
    double fps = !oneShot && argc > 2 ? atof(argv[2]) : 15;
    double quality = !oneShot && argc > 3 ? atof(argv[3]) : 0.6;
    int maxDim = !oneShot && argc > 4 ? atoi(argv[4]) : 1280;
    int fileArg = oneShot ? 4 : 5;
    if (argc > fileArg) orientationFile = [NSString stringWithUTF8String:argv[fileArg]];
    orientation = readOrientation();
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
      if (oneShot) exit(sendOrientation(sim, wanted) ? 0 : 6);
      FBiOSTargetScreenInfo *screen = sim.screenInfo;
      panelW = screen.widthPixels / screen.scale;
      panelH = screen.heightPixels / screen.scale;
      announceScreen(screen);

      FBSimulatorHID *hid = [[FBSimulatorHID hidForSimulator:sim] await:&err];
      if (hid) [[hid connect] await:&err];
      if (!hid) fprintf(stderr, "simstream: no input: %s\n", err.localizedDescription.UTF8String);
      dispatch_queue_t hidQueue = dispatch_queue_create("simstream.hid", DISPATCH_QUEUE_SERIAL);

      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        char buf[512];
        while (fgets(buf, sizeof buf, stdin)) {
          still = 0;
          NSString *line = [[NSString stringWithUTF8String:buf] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
          if (line.length && ![line isEqualToString:@"wake"]) dispatch_async(hidQueue, ^{ runCommand(sim, hid, line); });
        }
        // The daemon's last lines (a finger lifted as the viewer left) still land.
        dispatch_sync(hidQueue, ^{});
        exit(0);
      });

      int failures = 0;
      const double interval = 1.0 / fps;
      CFAbsoluteTime orientationReadAt = CFAbsoluteTimeGetCurrent();
      for (;;) {
        @autoreleasepool {
          NSDate *start = [NSDate date];
          // Another helper (`cast sim rotate`) may have turned the device.
          if (CFAbsoluteTimeGetCurrent() - orientationReadAt > 1.0) {
            orientationReadAt = CFAbsoluteTimeGetCurrent();
            int o = readOrientation();
            if (o != orientation) {
              orientation = o;
              lastProbe = nil;
              announceScreen(screen);
            }
          }
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
