import { Stack, useLocalSearchParams } from 'expo-router';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { PaneTerminal } from '@/components/terminal/PaneTerminal';

/** /terminal/<conversation id>: the session's live pane. */
export default function TerminalRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const target = useInboxStore((s) => (s.sessions[id] as any)?.tmux_session ?? (s.conversations[id] as any)?.tmux_session ?? null) as string | null;
  const title = useInboxStore((s) => (s.sessions[id] as any)?.title ?? (s.conversations[id] as any)?.title ?? 'Terminal') as string;
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <PaneTerminal conversationId={id} target={target} title={title} hydrated={hydrated} />
    </>
  );
}
