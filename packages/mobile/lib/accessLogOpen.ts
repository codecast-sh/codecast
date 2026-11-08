// The phone's half of the regulated-data access log (convex accessLog.ts): a
// conversation opened here is reported once per mount, and only when its
// team is one of the viewer's regulated teams; the server decides again.
import { useEffect, useRef } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { viewerTeamIsRegulated } from '@codecast/web/lib/regulatedData';

export function useRecordConversationOpen(conversationId: string | null | undefined, teamId: string | null | undefined): void {
  const note = useMutation(api.accessLog.noteConversationAccess);
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationId || sent.current === conversationId || !viewerTeamIsRegulated(teamId)) return;
    sent.current = conversationId;
    void note({ conversation_id: conversationId as Id<'conversations'>, action: 'open', client: 'mobile' }).catch(() => {});
  }, [conversationId, teamId, note]);
}
