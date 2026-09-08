import { useCallback, useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import { useConvex } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { CONVEX_URL } from '@/lib/convex';
import { useAuth } from '@/lib/auth';
import {
  type CatchUpStorage,
  type CatchUpWatermark,
  type MissedNotification,
  loadWatermark,
  notificationKey,
  planCatchUp,
  readPushStamp,
  recordDelivered,
  saveWatermark,
} from '@/lib/notificationCatchUp';

// Recovers the pushes that arrived while this phone was unreachable (ct-49553).
// A push is not a message queue: the server ships it once and forgets it, so a
// phone that was asleep, killed or out of signal came back knowing only about
// the one notification it was tapped from. The backend keeps a ring of routed
// pushes now; this asks for what is missing whenever the phone can hear again,
// and shows it locally.
//
// Both triggers are the same question asked two ways. AppState "active" is the
// human coming back; the Convex socket reconnecting is the network coming back,
// and either can happen without the other (a phone on the lock screen regains
// signal; a foregrounded app is still offline).

// The KV store the rest of the mobile cache uses. Guarded require for the same
// reason idbCache.native guards it: expo-sqlite resolves its native module at
// module-eval time, and an OTA update can land this JS on a binary built before
// that module existed. No store means no watermark, which means no replay —
// never a crash on launch.
let storage: CatchUpStorage | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  storage = require('expo-sqlite/kv-store').default as CatchUpStorage;
} catch {
  storage = ((globalThis as any).__CODECAST_TEST_KV_STORAGE__ as CatchUpStorage) ?? null;
}

function backendHost(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\//, '');
  return withoutScheme.replace(/\/+$/, '');
}

const HOST = backendHost(CONVEX_URL);

// iOS wants camelCase where the push payload (an Expo field) is hyphenated.
function localInterruptionLevel(
  level: string | undefined,
): 'passive' | 'active' | 'timeSensitive' | 'critical' | undefined {
  if (level === 'time-sensitive') return 'timeSensitive';
  if (level === 'passive' || level === 'active' || level === 'critical') return level;
  return undefined;
}

async function presentMissed(entry: MissedNotification): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      // Keyed by backend host and entry id: presenting the same entry twice
      // replaces the banner instead of stacking a second one, so a retried
      // catch-up cannot double fire.
      identifier: notificationKey(HOST, entry.key),
      content: {
        title: entry.title,
        subtitle: entry.subtitle,
        body: entry.body,
        // The stamp rides the replayed copy too, so tapping it routes exactly
        // like the live push would have, and the live path recognises it.
        data: {
          ...((entry.data as Record<string, unknown>) ?? {}),
          notificationKey: entry.key,
          notificationSeq: entry.seq,
          notificationEpoch: entry.epoch,
        },
        // Silent on purpose: this is something that already happened. The
        // banner is the catch-up; a burst of alert sounds minutes late is not.
        sound: false,
        interruptionLevel: localInterruptionLevel(entry.interruption_level),
      },
      trigger: null,
    });
  } catch {
    // One entry failing to present must not abandon the rest of the batch.
  }
}

// Every watermark write is read-modify-write, and two of them race: a push can
// arrive live while a catch-up pass is deciding what to replay. Serialising
// them is what keeps the live record from being clobbered by the pass that
// started before it — the clobbered key would come back as a replayed copy.
let writes: Promise<unknown> = Promise.resolve();

function updateWatermark(
  userId: string,
  apply: (current: CatchUpWatermark) => CatchUpWatermark,
): Promise<void> {
  const next = writes.then(
    async () => {
      const current = await loadWatermark(storage!, HOST, userId);
      await saveWatermark(storage!, HOST, userId, apply(current));
    },
    () => {},
  );
  writes = next;
  return next;
}

export function useNotificationCatchUp(): {
  recordLivePush: (data: unknown) => void;
} {
  const convex = useConvex();
  const { currentUserId, isAuthenticated } = useAuth();
  const userRef = useRef(currentUserId);
  userRef.current = currentUserId;
  const running = useRef(false);

  const run = useCallback(async () => {
    const userId = userRef.current;
    if (!userId || !storage || running.current) return;
    running.current = true;
    try {
      const watermark = await loadWatermark(storage, HOST, userId);
      let answer: { epoch: string | null; entries: MissedNotification[] };
      try {
        answer = await convex.query(api.notifications.getMissedSince, {
          seq: watermark.seq,
          epoch: watermark.epoch ?? undefined,
        });
      } catch {
        // Enrichment, not a dependency: a backend that has not shipped the ring
        // yet (or a query that failed) leaves the phone exactly as it was — the
        // live stream still works and the in-app list is still complete.
        return;
      }
      // What iOS is still holding in its tray. A push delivered while the app
      // was killed never reached the live listener, so the tray is the only
      // evidence it was already shown — without this it would be replayed.
      let presentedKeys: string[] = [];
      try {
        presentedKeys = (await Notifications.getPresentedNotificationsAsync())
          .map((n) => readPushStamp(n.request.content.data))
          .filter((stamp): stamp is NonNullable<typeof stamp> => stamp !== null)
          .map((stamp) => notificationKey(HOST, stamp.key));
      } catch {
        // No tray reading (Android, or a permission-less state): the seen set
        // in the watermark still carries everything this device delivered.
      }
      // Planned against the CURRENT watermark, not the one the query was built
      // from: a push may have arrived live in between, and it is already
      // accounted for there.
      let present: MissedNotification[] = [];
      await updateWatermark(userId, (current) => {
        const plan = planCatchUp({
          host: HOST,
          watermark: current,
          missed: answer.entries ?? [],
          epoch: answer.epoch,
          presentedKeys,
        });
        present = plan.present;
        return plan.watermark;
      });
      for (const entry of present) await presentMissed(entry);
    } finally {
      running.current = false;
    }
  }, [convex]);

  // A push that arrives while the app is listening is accounted for right here,
  // so the catch-up never offers it back.
  const recordLivePush = useCallback((data: unknown) => {
    const stamp = readPushStamp(data);
    const userId = userRef.current;
    if (!stamp || !userId || !storage) return;
    void updateWatermark(userId, (current) => recordDelivered(HOST, current, stamp));
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !currentUserId) return;
    void run();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void run();
    });
    // The socket coming back is its own wake: a phone can regain signal without
    // anyone foregrounding the app. Only the down→up edge runs a pass.
    let connected = convex.connectionState().isWebSocketConnected;
    const unsubscribe = convex.subscribeToConnectionState(() => {
      const now = convex.connectionState().isWebSocketConnected;
      if (now && !connected) void run();
      connected = now;
    });
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, [convex, run, isAuthenticated, currentUserId]);

  return { recordLivePush };
}
