import { useState, useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useRouter } from 'expo-router';
import { chatPushIsOnScreen } from '@/lib/chatFocus';
import { acceptInvite, declineInvite } from '@/lib/calls/callManager';
import { useAuth } from '@/lib/auth';
import {
  CALL_PUSH_ACTION_DECLINE,
  CALL_PUSH_ACTION_JOIN,
  CALL_PUSH_CATEGORY,
  CALL_PUSH_TYPE_MISSED,
  CALL_PUSH_TYPE_RING,
  parseCallRingPush,
  parseRecordingSummaryPush,
} from '@codecast/shared/contracts';

Notifications.setNotificationHandler({
  // The NEW field names. `shouldShowAlert` is the pre-SDK-53 API: on current
  // expo-notifications it is ignored, which silently disabled every FOREGROUND
  // banner — a chat push while the app was open showed nothing but the badge
  // ("no notifs but saw the red bubble").
  handleNotification: async (notification) => {
    const data = notification?.request?.content?.data as any;
    // A huddle ring reaching a FOREGROUND app is already ringing in-app (the
    // RingBanner + looped ringtone own it) — the push exists for closed apps.
    // This handler only runs in foreground, so suppressing here can never
    // silence a real away-ring.
    if (data?.type === CALL_PUSH_TYPE_RING) {
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    // The one silent case: a chat push about the room already on screen. The
    // transcript itself is the notification there — same rule as the web
    // toast tier. Everything else banners and sounds, foreground included.
    const onScreen = chatPushIsOnScreen(data ?? {});
    return {
      shouldShowBanner: !onScreen,
      shouldShowList: !onScreen,
      shouldPlaySound: !onScreen,
      shouldSetBadge: true,
    };
  },
});

if (__DEV__) {
  // Simulator e2e probe: notification permission state + a re-request trigger.
  (global as any).__notif = {
    perms: () => Notifications.getPermissionsAsync(),
    request: () => Notifications.requestPermissionsAsync(),
    presented: () => Notifications.getPresentedNotificationsAsync(),
  };
}

export function usePushNotifications() {
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [notification, setNotification] = useState<Notifications.Notification | null>(null);
  const notificationListener = useRef<Notifications.Subscription | null>(null);
  const responseListener = useRef<Notifications.Subscription | null>(null);
  const storePushToken = useMutation(api.users.storePushToken);
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  // Cold-start ring answers race Convex auth: on a killed app the mount effect
  // (and the launching notification response) runs BEFORE ConvexAuthProvider
  // has read the token from SecureStore, so respondInvite would go out
  // unauthenticated, throw, and land the user on an error stage. Buffer any
  // huddle response until isAuthenticated flips true; everything else routes
  // immediately (a screen push needs no mutation). The 45s TTL bounds staleness.
  const authedRef = useRef(isAuthenticated);
  authedRef.current = isAuthenticated;
  const pendingHuddle = useRef<Notifications.NotificationResponse | null>(null);
  const handleRef = useRef<(r: Notifications.NotificationResponse) => void>(() => {});
  useEffect(() => {
    if (isAuthenticated && pendingHuddle.current) {
      const r = pendingHuddle.current;
      pendingHuddle.current = null;
      handleRef.current(r);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    registerForPushNotificationsAsync().then(async (token) => {
      if (token) {
        setPushToken(token);
        try {
          await storePushToken({ push_token: token });
        } catch (error) {
          console.error('Failed to store push token:', error);
        }
      }
    });

    const handleNotificationResponse = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data;
      const ringPush = parseCallRingPush(data);
      if (ringPush && !authedRef.current) {
        pendingHuddle.current = response;
        return;
      }
      if (ringPush) {
        // Join is both the action button and the default tap; Decline settles
        // the invite without opening the app (best effort — a killed app
        // processes it on next launch, and the 45s TTL covers the gap).
        if (response.actionIdentifier === CALL_PUSH_ACTION_DECLINE) {
          void declineInvite(ringPush.invite_id);
        } else {
          void acceptInvite(ringPush.invite_id, ringPush.room_key);
          router.push('/call');
        }
        return;
      }
      const recordingPush = parseRecordingSummaryPush(data);
      if (recordingPush) {
        // The one push whose whole point is that nobody was looking at the
        // app when the work finished: the recording was stopped minutes ago
        // and the words arrived since. Open it.
        router.push({
          pathname: '/recording/[id]',
          params: { id: recordingPush.recordingId },
        } as never);
        return;
      }
      if (data.type === CALL_PUSH_TYPE_MISSED) {
        // Ring back from the missed-call notification: land on the team tab
        // where the huddle affordances live.
        router.push('/(tabs)/team');
        return;
      }
      if (data.conversationId) {
        router.push(`/session/${data.conversationId}`);
      } else if (data.channelId) {
        // A team chat push lands in the channel it came from — and when it was
        // a thread reply, in that thread, which is where the words actually
        // are. threadRootId rides along in the push payload for exactly this.
        // Object form + cast: expo's typed-route union only regenerates when
        // Metro runs, so a freshly added route is unknown to tsc until then.
        const m = data.messageId ? { m: String(data.messageId) } : {};
        if (data.threadRootId) {
          router.push({
            pathname: '/chat/thread/[id]',
            params: { id: String(data.threadRootId), channel: String(data.channelId), ...m },
          } as never);
        } else {
          router.push({ pathname: '/chat/[id]', params: { id: String(data.channelId), ...m } } as never);
        }
      } else if (data.type === 'aggregate') {
        // A batched push ("12 notifications") has no single session to open —
        // land on the list that itemizes them.
        router.push('/(tabs)/notifications');
      }
    };

    handleRef.current = handleNotificationResponse;
    // Cold-start tap: when the app is fully killed and a notification launches it,
    // the launching response is delivered here, not through the live listener below.
    let handledColdStart = false;
    Notifications.getLastNotificationResponseAsync()
      .then((last) => {
        if (last && !handledColdStart) {
          handledColdStart = true;
          handleNotificationResponse(last);
        }
      })
      .catch(() => {});

    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      setNotification(notification);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);

    return () => {
      // Subscription.remove() is the whole API now; the old module-level
      // removeNotificationSubscription no longer exists.
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  }, []);

  return {
    pushToken,
    notification,
  };
}

async function registerForPushNotificationsAsync() {
  let token;

  // Actionable ring: the server's huddle push carries categoryId
  // "huddle_ring"; these buttons render on the banner / long-press. Join
  // foregrounds into the call; Decline answers from the lock screen.
  await Notifications.setNotificationCategoryAsync(CALL_PUSH_CATEGORY, [
    {
      identifier: CALL_PUSH_ACTION_JOIN,
      buttonTitle: 'Join',
      options: { opensAppToForeground: true },
    },
    {
      identifier: CALL_PUSH_ACTION_DECLINE,
      buttonTitle: 'Decline',
      options: { opensAppToForeground: false },
    },
  ]).catch(() => {});

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
    // Chat rides its own channel: the server tags chat pushes with
    // channelId "chat", so people can tune (or silence) chat separately from
    // session alerts in Android's own settings — and a custom sound can bind
    // here once a native build ships the asset.
    await Notifications.setNotificationChannelAsync('chat', {
      name: 'Team chat',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 180, 120, 180],
      lightColor: '#2aa19899',
    });
  }

  // Permission is requested everywhere (the simulator can receive
  // simctl-pushed notifications for testing); only the Expo push TOKEN needs
  // real hardware.
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    console.log('Failed to get push token for push notification!');
    return;
  }
  if (Device.isDevice) {
    token = (await Notifications.getExpoPushTokenAsync({
      projectId: Constants.expoConfig?.extra?.eas?.projectId,
    })).data;
  } else {
    console.log('Must use physical device for Push Notifications');
  }

  return token;
}
