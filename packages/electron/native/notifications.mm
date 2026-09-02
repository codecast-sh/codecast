// Notification permission, read from the OS itself.
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
// Two calls, both plain N-API so the binary loads in Electron without a
// rebuild (scripts/build-native.sh):
//   authorizationStatus() → UNAuthorizationStatus as an integer, -1 if
//                           Notification Center didn't answer in time.
//                           osPermissions.js maps it to readiness.
//   requestAuthorization() → raises the macOS Allow / Don't Allow prompt
//                           (a no-op once decided). Fire-and-forget: the
//                           caller re-polls for the answer.
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

// UNUserNotificationCenter throws outside an app bundle (plain node running
// this addon), so every entry point checks for one first.
static bool InsideBundle() {
  return [[NSBundle mainBundle] bundleIdentifier] != nil;
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
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"authorizationStatus", nullptr, AuthorizationStatus, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"requestAuthorization", nullptr, RequestAuthorization, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(notifications, Init)
