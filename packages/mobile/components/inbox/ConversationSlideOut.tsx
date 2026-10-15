import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Keyboard } from 'react-native';
import { useRouter } from 'expo-router';
import { SlideOutDrawer } from '@/components/inbox/SlideOutDrawer';
import { InboxView } from '@/app/(tabs)/inbox';

// Set by a pick in the panel just before the conversation is replaced, so the
// next conversation mounts with the panel uncovered and slides it shut: the
// list stays under the thumb that picked from it.
let handoff = false;

const DrawerContext = createContext<{ open: () => void } | null>(null);

/** The slide-out around the conversation on screen, for its header's menu
 *  button; null where a session screen stands alone (a role's page). */
export function useConversationDrawer() {
  return useContext(DrawerContext);
}

/** A conversation with the app behind it: a rightward drag or the header's
 *  menu button slides the conversation aside to uncover the inbox (its lens
 *  and labels) and the app's other areas. Picking a row replaces this
 *  conversation in place and picking an area leaves for it, so a
 *  conversation is never something to go back from. */
export function ConversationSlideOut({ id, children }: { id: string; children: ReactNode }) {
  const router = useRouter();
  const [startOpen] = useState(() => {
    const was = handoff;
    handoff = false;
    return was;
  });
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback((next: boolean) => {
    if (next) Keyboard.dismiss();
    setOpenState(next);
  }, []);

  const openSession = useCallback((conversationId: string, messageId?: string) => {
    if (conversationId === id && !messageId) {
      setOpenState(false);
      return;
    }
    handoff = true;
    router.replace({
      pathname: '/session/[id]',
      params: { id: conversationId, swap: '1', ...(messageId ? { message: messageId } : {}) },
    } as never);
  }, [id, router]);

  const exit = useCallback(() => router.navigate('/(tabs)/inbox' as never), [router]);

  const drawer = useMemo(() => ({ open: () => setOpen(true) }), [setOpen]);

  return (
    <DrawerContext.Provider value={drawer}>
    <SlideOutDrawer
      enabled
      open={open}
      setOpen={setOpen}
      startOpen={startOpen}
      drawer={<InboxView panel currentId={id} onOpenSession={openSession} onExit={exit} />}
    >
      {children}
    </SlideOutDrawer>
    </DrawerContext.Provider>
  );
}
