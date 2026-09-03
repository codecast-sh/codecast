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
//   post(title, body)     → delivers a notification; returns its identifier,
//                           or null outside a bundle.
//   onActivate(cb)        → cb(identifier) when the human clicks one of ours.
//                           Installs this addon as the center's delegate, which
//                           also lets a notification show while the app is in
//                           front (the default is to swallow those).
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
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

// The JS callback, reachable from the delegate's queue. Unref'd so it never
// keeps the event loop alive on its own.
static napi_threadsafe_function g_activate = nullptr;

static void CallActivate(napi_env env, napi_value js_cb, void *, void *data) {
  char *identifier = (char *)data;
  if (env != nullptr && js_cb != nullptr) {
    napi_value arg;
    napi_create_string_utf8(env, identifier, NAPI_AUTO_LENGTH, &arg);
    napi_call_function(env, Undefined(env), js_cb, 1, &arg, nullptr);
  }
  free(identifier);
}

@interface CastNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation CastNotificationDelegate
// A notification that arrives while the app is frontmost still shows: the
// update banner and a message from a teammate are worth seeing either way.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList |
                    UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
  if (g_activate != nullptr && [response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
    const char *utf8 = response.notification.request.identifier.UTF8String;
    if (utf8 != nullptr) {
      napi_call_threadsafe_function(g_activate, strdup(utf8), napi_tsfn_nonblocking);
    }
  }
  completionHandler();
}
@end

static CastNotificationDelegate *g_delegate = nil;

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

  if (InsideBundle()) {
    @try {
      if (g_delegate == nil) g_delegate = [CastNotificationDelegate new];
      [UNUserNotificationCenter currentNotificationCenter].delegate = g_delegate;
    } @catch (NSException *) {
    }
  }
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
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!InsideBundle() || argc < 2) return Null(env);

  NSString *identifier = [[NSUUID UUID] UUIDString];
  @try {
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = ReadString(env, argv[0]);
    content.body = ReadString(env, argv[1]);
    content.sound = [UNNotificationSound defaultSound];
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

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"authorizationStatus", nullptr, AuthorizationStatus, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"requestAuthorization", nullptr, RequestAuthorization, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"post", nullptr, Post, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"onActivate", nullptr, OnActivate, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(notifications, Init)
