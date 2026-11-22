// Images shared to Codecast from the iOS share sheet start a new session.
//
// The share extension (targets/share) leaves the files in the app group and
// opens the app. Each time the app becomes active, signed in, this takes what
// is waiting and opens the new session sheet with it attached. Signed out, the
// files stay where they are until someone signs in.

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { shareInboxNative } from '@/modules/codecast-share-inbox';
import { openCompose } from '@/lib/compose';

function takeShared() {
  let uris: string[] = [];
  try {
    uris = shareInboxNative?.takeAll() ?? [];
  } catch {}
  if (!uris.length) return;
  openCompose(null, uris.map((uri) => ({ uri, mime: uri.endsWith('.png') ? 'image/png' : 'image/jpeg' })));
}

export function useShareInbox(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn || !shareInboxNative) return;
    takeShared();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') takeShared();
    });
    return () => sub.remove();
  }, [signedIn]);
}
