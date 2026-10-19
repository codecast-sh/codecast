import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard } from 'react-native';
import { useRouter } from 'expo-router';
import { SlideOutDrawer } from '@/components/inbox/SlideOutDrawer';
import { InboxView } from '@/app/(tabs)/inbox';

const DrawerContext = createContext<{ open: () => void } | null>(null);

/** The slide-out around the conversation on screen, for its header's menu
 *  button; null where a session screen stands alone (a role's page). */
export function useConversationDrawer() {
  return useContext(DrawerContext);
}

/** A conversation with the app behind it: a rightward drag or the header's
 *  menu button slides the conversation aside to uncover the inbox (its lens
 *  and labels) and the app's other areas. Picking a row swaps the
 *  conversation in place under the open panel (the route's id changes, the
 *  panel and its list stay mounted) and the panel slides shut over it;
 *  picking an area leaves for it, so a conversation is never something to go
 *  back from. */
export function ConversationSlideOut({ id, children }: { id: string; children: ReactNode }) {
  const router = useRouter();
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback((next: boolean) => {
    if (next) Keyboard.dismiss();
    setOpenState(next);
  }, []);

  // One handler for the panel's lifetime: it is every row's onPress, and the
  // id it compares against changes with each pick.
  const idRef = useRef(id);
  idRef.current = id;
  const openSession = useCallback((conversationId: string, messageId?: string) => {
    setOpenState(false);
    if (conversationId === idRef.current && !messageId) return;
    router.setParams({ id: conversationId, message: messageId, focus: undefined } as never);
  }, [router]);

  const exit = useCallback(() => router.navigate('/(tabs)/inbox' as never), [router]);

  const drawer = useMemo(() => ({ open: () => setOpen(true) }), [setOpen]);

  return (
    <DrawerContext.Provider value={drawer}>
    <SlideOutDrawer
      enabled
      open={open}
      setOpen={setOpen}
      drawer={<InboxView panel currentId={id} onOpenSession={openSession} onExit={exit} />}
    >
      {children}
    </SlideOutDrawer>
    </DrawerContext.Provider>
  );
}
