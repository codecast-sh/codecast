// The app's part of the Lock Screen Live Activity.
//
// The server derives and pushes the strip (convex/liveActivity.ts); the app
// only hands it the credentials ActivityKit mints — the push-to-start token
// and each activity's update token — and covers the one case a push cannot:
// a phone without push-to-start (iOS 16.2–17.1) gets its activity started
// here while the app is open, after which the server updates it like any
// other. Mounted once, inside the auth gate, beside usePushNotifications.

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { liveActivityNative } from '@/modules/codecast-live-activity';
import { useAuth } from '@/lib/auth';

export function useLiveActivity() {
  const native = liveActivityNative;
  const { isAuthenticated } = useAuth();
  const registerPushToStartToken = useMutation(api.liveActivity.registerPushToStartToken);
  const reportActivity = useMutation(api.liveActivity.reportActivity);
  const reportActivityEnded = useMutation(api.liveActivity.reportActivityEnded);
  // Once this phone has handed over a push-to-start token the server drives
  // everything and the app needs no live view of the strip at all.
  const [hasStartToken, setHasStartToken] = useState(false);

  useEffect(() => {
    if (!native || !isAuthenticated) return;
    const environment = native.environment;
    const swallow = (what: string) => (error: unknown) => console.warn(`[liveActivity] ${what} failed`, error);
    const subs = [
      native.addListener('onPushToStartToken', ({ token }) => {
        // The server drives from here only once it holds the token; until the
        // registration lands the local path stays armed.
        registerPushToStartToken({ token, environment })
          .then(() => setHasStartToken(true))
          .catch(swallow('token registration'));
      }),
      native.addListener('onActivity', ({ id, token }) => {
        reportActivity({ activity_id: id, token, environment }).catch(swallow('activity report'));
      }),
      native.addListener('onActivityEnded', ({ id }) => {
        reportActivityEnded({ activity_id: id }).catch(swallow('activity end report'));
      }),
    ];
    return () => {
      for (const sub of subs) sub.remove();
    };
  }, [native, isAuthenticated, registerPushToStartToken, reportActivity, reportActivityEnded]);

  const needsLocalStart = !!native && isAuthenticated && (!native.supportsPushToStart || !hasStartToken);

  if (__DEV__ && native) {
    // Simulator probe: render any strip variant without a server round trip.
    (global as any).__liveActivity = {
      start: (state: unknown) => native.start(state as any),
      update: (state: unknown) => native.update(state as any),
      endAll: () => native.endAll(),
      ids: () => native.activityIds(),
      enabled: () => native.isEnabled(),
    };
  }
  const current = useQuery(api.liveActivity.currentState, needsLocalStart ? {} : 'skip');
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    if (!native || !needsLocalStart) return;
    const maybeStart = async () => {
      const snapshot = currentRef.current;
      if (!snapshot || !snapshot.may_start || snapshot.has_push_to_start) return;
      if (AppState.currentState !== 'active') return;
      if (!native.isEnabled() || native.activityIds().length > 0) return;
      try {
        await native.start(snapshot.state);
      } catch (error) {
        console.warn('[liveActivity] local start failed', error);
      }
    };
    void maybeStart();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void maybeStart();
    });
    return () => sub.remove();
  }, [native, needsLocalStart, current?.may_start, current?.has_push_to_start]);
}
