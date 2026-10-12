// The phone's read of a dropped server link, in the web's words. The web
// reads the browser's online flag and the Convex socket (hooks/useAppOffline);
// the phone has no browser flag, so the socket is the whole verdict, held for
// the web's grace (DISCONNECT_GRACE_MS) so the reconnect after every network
// change does not flash a warning.
import { useEffect, useState } from 'react';
import { DISCONNECT_GRACE_MS, connectionChipCopy, type ConnectionChipCopy } from '@codecast/web/hooks/useAppOffline';
import { useWsConnected } from '@codecast/web/hooks/useWsConnected';

/** The link's copy while it has been down past the grace, else null. */
export function useLinkDown(): ConnectionChipCopy | null {
  const connected = useWsConnected();
  const [downLong, setDownLong] = useState(false);
  useEffect(() => {
    if (connected) {
      setDownLong(false);
      return;
    }
    const t = setTimeout(() => setDownLong(true), DISCONNECT_GRACE_MS);
    return () => clearTimeout(t);
  }, [connected]);
  return connectionChipCopy({ offline: downLong, online: true });
}
