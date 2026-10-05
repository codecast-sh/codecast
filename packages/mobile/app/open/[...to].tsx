// The stop a deep link makes when it names a conversation or a decision
// (lib/laneOpen viaOpener). A link is routed before the store is read back,
// when nobody knows yet whether this person lives in the assistant lane; this
// screen waits for that, then replaces itself with the screen the link
// belongs on, so back never returns here.
import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { View } from '@/components/Themed';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { openerTarget, routeFromOutside, type LaneOpenStore } from '@/lib/laneOpen';

export default function Opener() {
  const { to, ...query } = useLocalSearchParams<{ to: string[] }>();
  const target = openerTarget(to, query as Record<string, string | string[] | undefined>);
  useEffect(() => {
    let live = true;
    void routeFromOutside(target, useInboxStore as unknown as LaneOpenStore).then((route) => {
      if (live) router.replace(route as never);
    });
    return () => {
      live = false;
    };
  }, [target]);
  return <View style={{ flex: 1 }} />;
}
