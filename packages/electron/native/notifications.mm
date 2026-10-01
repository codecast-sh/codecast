// Notifications through the modern macOS API, read and written from the OS
// itself.
//
// macOS keeps the per-app notification setting inside Notification Center's
// own database (Full Disk Access to read), and since macOS 26 no longer
// mirrors it into ~/Library/Preferences/com.apple.ncprefs.plist — that file
// froze, so an app installed after the freeze has no entry there at all, and
// "no entry" reads as "never asked" for an app the user allowed long ago.
// The only honest source is UNUserNotificationCenter, and Notification Center
// answers it only for the bundle's MAIN executable (a helper binary inside the
// bundle is refused: "Entitlement com.apple.private.usernotifications.
// bundle-identifiers required"). Hence a native addon loaded into the Electron
// main process, not a helper tool.
//
// Posting lives here too, and not as a convenience: once a process has spoken
// to UNUserNotificationCenter at all, Notification Center refuses everything it
// sends over the legacy NSUserNotification API that Electron's `Notification`
// wraps ("You can't mix modern clients with legacy clients"), and it refuses
// silently. The permission read above makes this process a modern client at
// boot, so every notification the app shows has to come through here.
//
// Four calls, all plain N-API so the binary loads in Electron without a
// rebuild (scripts/build-native.sh):
//   authorizationStatus() → UNAuthorizationStatus as an integer, -1 if
//                           Notification Center didn't answer in time.
//                           osPermissions.js maps it to readiness.
//   requestAuthorization() → raises the macOS Allow / Don't Allow prompt
//                           (a no-op once decided). Fire-and-forget: the
//                           caller re-polls for the answer.
//   post(title, body, payload?)
//                         → delivers a notification; returns its identifier,
//                           or null outside a bundle. `payload` is an opaque
//                           string kept on the notification and handed back
//                           on click, so a banner outlives the process that
//                           posted it.
//   onActivate(cb)        → cb(identifier, payload) when the human clicks one
//                           of ours. Installs this addon as the center's
//                           delegate, chained in front of any delegate already
//                           there, which also lets a notification show while
//                           the app is in front (the default is to swallow
//                           those).
//
// It is also the app's one native addon, so the one window question Electron
// cannot answer lives here too:
//   windowFrame(windowId) → { x, y, width, height, onscreen } for any app's
//                           window by CGWindowID (a "window:<id>:0" capture
//                           source), in global points with a top-left origin,
//                           the same space as Electron's screen module. null
//                           when the window is gone. Bounds need no Screen
//                           Recording grant; only titles do.
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <CoreGraphics/CoreGraphics.h>
#include <node_api.h>
#include <string>

// UNUserNotificationCenter throws outside an app bundle (plain node running
// this addon), so every entry point checks for one first.
static bool InsideBundle() {
  return [[NSBundle mainBundle] bundleIdentifier] != nil;
}

static napi_value Undefined(napi_env env) {
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

static napi_value Null(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}

static long ReadAuthorizationStatus() {
  __block long status = -1;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  @try {
    [[UNUserNotificationCenter currentNotificationCenter]
        getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
          status = (long)settings.authorizationStatus;
          dispatch_semaphore_signal(done);
        }];
    // The completion arrives on a background queue via XPC, so blocking here
    // is safe and short (single-digit ms). A stuck daemon reads as unknown.
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  } @catch (NSException *) {
    status = -1;
  }
  return status;
}

static napi_value AuthorizationStatus(napi_env env, napi_callback_info) {
  long status = InsideBundle() ? ReadAuthorizationStatus() : -1;
  napi_value out;
  napi_create_int32(env, (int32_t)status, &out);
  return out;
}

static napi_value RequestAuthorization(napi_env env, napi_callback_info) {
  if (InsideBundle()) {
    @try {
      [[UNUserNotificationCenter currentNotificationCenter]
          requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                        completionHandler:^(BOOL, NSError *) {}];
    } @catch (NSException *) {
    }
  }
  return Undefined(env);
}

// ---- clicks -----------------------------------------------------------------

// Our banners carry this identifier prefix, so the delegate can tell them from
// Electron's own (web pages in a browser pane post through Electron) and hand
// those on.
static NSString *const kOurPrefix = @"cast-";
// The click target rides on the notification itself, in userInfo, so a banner
// still sitting in Notification Center after a relaunch knows where it goes.
static NSString *const kPayloadKey = @"cast";

// The JS callback, reachable from the delegate's queue. Unref'd so it never
// keeps the event loop alive on its own.
static napi_threadsafe_function g_activate = nullptr;

struct Activation {
  char *identifier;
  char *payload; // null when the banner carries none
};

static void CallActivate(napi_env env, napi_value js_cb, void *, void *data) {
  Activation *a = (Activation *)data;
  if (env != nullptr && js_cb != nullptr) {
    napi_value argv[2];
    napi_create_string_utf8(env, a->identifier, NAPI_AUTO_LENGTH, &argv[0]);
    if (a->payload != nullptr) napi_create_string_utf8(env, a->payload, NAPI_AUTO_LENGTH, &argv[1]);
    else argv[1] = Undefined(env);
    napi_call_function(env, Undefined(env), js_cb, 2, argv, nullptr);
  }
  free(a->identifier);
  free(a->payload);
  delete a;
}

static bool IsOurs(UNNotification *notification) {
  return [notification.request.identifier hasPrefix:kOurPrefix];
}

// The delegate that was installed before ours: Electron's, once its
// notification presenter exists. Electron installs it whenever that presenter
// is first created (a web page calling `new Notification`, or the main process
// touching Electron's Notification), which used to replace ours and drop every
// click on our banners. We chain instead: its banners go back to it. Weak,
// because its presenter owns it and frees it at shutdown.
static __weak id<UNUserNotificationCenterDelegate> g_next = nil;

@interface CastNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation CastNotificationDelegate
// A notification that arrives while the app is frontmost still shows: the
// update banner and a message from a teammate are worth seeing either way.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  id<UNUserNotificationCenterDelegate> next = g_next;
  if (!IsOurs(notification) && [next respondsToSelector:_cmd]) {
    [next userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completionHandler];
    return;
  }
  completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList |
                    UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
  id<UNUserNotificationCenterDelegate> next = g_next;
  if (!IsOurs(response.notification) && [next respondsToSelector:_cmd]) {
    [next userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completionHandler];
    return;
  }
  if (g_activate != nullptr && [response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
    const char *identifier = response.notification.request.identifier.UTF8String;
    id payload = response.notification.request.content.userInfo[kPayloadKey];
    const char *payload8 = [payload isKindOfClass:[NSString class]] ? [(NSString *)payload UTF8String] : nullptr;
    if (identifier != nullptr) {
      Activation *a = new Activation{strdup(identifier), payload8 != nullptr ? strdup(payload8) : nullptr};
      if (napi_call_threadsafe_function(g_activate, a, napi_tsfn_nonblocking) != napi_ok) {
        free(a->identifier);
        free(a->payload);
        delete a;
      }
    }
  }
  completionHandler();
}
@end

static CastNotificationDelegate *g_delegate = nil;

// Make ours the center's delegate, keeping whatever held the post before as
// the one ours hands foreign banners to. Runs on every post as well as at
// wiring time, so a delegate Electron installed in between is taken back
// before the next banner goes up.
static void ClaimDelegate() {
  if (g_activate == nullptr || !InsideBundle()) return;
  @try {
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    if (g_delegate == nil) g_delegate = [CastNotificationDelegate new];
    id<UNUserNotificationCenterDelegate> current = center.delegate;
    if (current == g_delegate) return;
    if (current != nil) g_next = current;
    center.delegate = g_delegate;
  } @catch (NSException *) {
  }
}

static napi_value OnActivate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type = napi_undefined;
  if (argc < 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function) return Undefined(env);

  if (g_activate != nullptr) {
    napi_release_threadsafe_function(g_activate, napi_tsfn_release);
    g_activate = nullptr;
  }
  napi_value name;
  napi_create_string_utf8(env, "castNotificationActivate", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallActivate, &g_activate) != napi_ok) {
    g_activate = nullptr;
    return Undefined(env);
  }
  napi_unref_threadsafe_function(env, g_activate);
  ClaimDelegate();
  return Undefined(env);
}

// ---- posting ----------------------------------------------------------------

static NSString *ReadString(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return @"";
  std::string buffer(length + 1, '\0');
  napi_get_value_string_utf8(env, value, &buffer[0], length + 1, &length);
  NSString *out = [NSString stringWithUTF8String:buffer.c_str()];
  return out != nil ? out : @"";
}

static napi_value Post(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!InsideBundle() || argc < 2) return Null(env);

  ClaimDelegate();
  NSString *identifier = [kOurPrefix stringByAppendingString:[[NSUUID UUID] UUIDString]];
  @try {
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = ReadString(env, argv[0]);
    content.body = ReadString(env, argv[1]);
    content.sound = [UNNotificationSound defaultSound];
    napi_valuetype payloadType = napi_undefined;
    if (argc >= 3 && napi_typeof(env, argv[2], &payloadType) == napi_ok && payloadType == napi_string) {
      content.userInfo = @{kPayloadKey : ReadString(env, argv[2])};
    }
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
    [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request
                                                           withCompletionHandler:^(NSError *) {}];
  } @catch (NSException *) {
    return Null(env);
  }
  napi_value out;
  napi_create_string_utf8(env, identifier.UTF8String, NAPI_AUTO_LENGTH, &out);
  return out;
}

static void SetNumber(napi_env env, napi_value obj, const char *key, double value) {
  napi_value v;
  napi_create_double(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

static napi_value WindowFrame(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return Null(env);
  int64_t id = 0;
  if (napi_get_value_int64(env, argv[0], &id) != napi_ok || id <= 0) return Null(env);

  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)id);
  if (!list) return Null(env);
  napi_value out = Null(env);
  if (CFArrayGetCount(list) > 0) {
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(list, 0);
    CGRect rect;
    CFDictionaryRef bounds = (__bridge CFDictionaryRef)info[(__bridge NSString *)kCGWindowBounds];
    if (bounds && CGRectMakeWithDictionaryRepresentation(bounds, &rect)) {
      napi_create_object(env, &out);
      SetNumber(env, out, "x", rect.origin.x);
      SetNumber(env, out, "y", rect.origin.y);
      SetNumber(env, out, "width", rect.size.width);
      SetNumber(env, out, "height", rect.size.height);
      napi_value onscreen;
      napi_get_boolean(env, [info[(__bridge NSString *)kCGWindowIsOnscreen] boolValue], &onscreen);
      napi_set_named_property(env, out, "onscreen", onscreen);
    }
  }
  CFRelease(list);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"authorizationStatus", nullptr, AuthorizationStatus, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"requestAuthorization", nullptr, RequestAuthorization, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"post", nullptr, Post, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"onActivate", nullptr, OnActivate, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"windowFrame", nullptr, WindowFrame, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(notifications, Init)
