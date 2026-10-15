import { useCallback, useState, type ReactNode } from 'react';
import { Keyboard } from 'react-native';
import { useRouter } from 'expo-router';
import { SlideOutDrawer } from '@/components/inbox/SlideOutDrawer';
import { InboxView } from '@/app/(tabs)/inbox';

// Set by a pick in the panel just before the conversation is replaced, so the
// next conversation mounts with the panel uncovered and slides it shut: the
// list stays under the thumb that picked from it.
let handoff = false;

/** A conversation with the inbox behind it: a rightward drag slides the
 *  conversation aside to uncover the whole inbox (its lens and labels
 *  included), and picking a row there replaces this conversation in place, so
 *  moving between conversations never stacks screens. */
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

  const exit = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/inbox' as never);
  }, [router]);

  return (
    <SlideOutDrawer
      enabled
      open={open}
      setOpen={setOpen}
      startOpen={startOpen}
      drawer={<InboxView panel currentId={id} onOpenSession={openSession} onExit={exit} />}
    >
      {children}
    </SlideOutDrawer>
  );
}
