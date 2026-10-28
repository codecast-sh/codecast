// A decision's team thread on the phone (convex decisionThread.ts; the web's
// components/decisions/DecisionDiscussion.tsx on the shared comment
// components). The same thread: replies, @mentions of people, roles and the
// session, edit and remove your own, markdown with pills, photos, a draft that
// survives leaving the screen, resolve, the "New" line, and asking the
// decision's session, whose answer fills a placeholder here. Opening the
// screen reads it.
import { useMemo, useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useConvex } from 'convex/react';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { memberHandle } from '@codecast/shared/chat';
import { Text } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { RelativeTime } from '@/components/RelativeTime';
import { ChatComposerBar } from '@/components/chat/ChatComposerBar';
import type { MentionCandidate } from '@/components/chat/MentionStrip';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useDecisionThread, useDecisionThreadReadAt, useDecisionThreadUnread } from '@codecast/web/hooks/useDecisionThread';
import { useWatchEffect } from '@codecast/web/hooks/useWatchEffect';
import { commentAuthorName, firstUnreadIndex, isOwnComment, isThreadResolved, withImages, type Comment } from '@codecast/web/lib/commentThread';
import { askDecisionSession, decisionThreadComments, markDecisionThreadRead, newDecisionCommentId, sendDecisionComment } from '@codecast/web/lib/decisionThread';

const api = _api as any;

function Row({ c, fresh, mine, replyingTo, onReply, onEdit, onRemove }: { c: Comment; fresh: boolean; mine: boolean; replyingTo?: string; onReply: () => void; onEdit: () => void; onRemove: () => void }) {
  const Theme = useTheme();
  const agent = c.author_kind === 'agent';
  const name = commentAuthorName(c);
  const thinking = agent && c.agent_status === 'thinking' && !c.content;
  if (c.event) {
    return (
      <View style={styles.row}>
        <Text style={styles.event}><Text style={styles.name}>{name}</Text> {c.event}</Text>
        {c.content ? <MarkdownContent text={c.content} baseStyle={styles.body} /> : null}
      </View>
    );
  }
  return (
    <View style={[styles.row, agent && styles.agent]}>
      <View style={styles.head}>
        {fresh ? <View style={[styles.dot, { backgroundColor: Theme.cyan }]} /> : null}
        <Text style={[styles.name, agent && { color: Theme.cyan }]}>{name}</Text>
        <RelativeTime timestamp={c.created_at} style={styles.time} />
      </View>
      {replyingTo ? <Text style={styles.meta}>↳ {replyingTo}</Text> : null}
      {thinking ? <Text style={styles.meta}>thinking…</Text> : <MarkdownContent text={c.content} baseStyle={[styles.body, c.agent_status === 'error' && { color: Theme.red }]} />}
      {thinking ? null : (
        <View style={styles.actions}>
          <TouchableOpacity onPress={onReply} hitSlop={6}><Text style={styles.action}>Reply</Text></TouchableOpacity>
          {mine ? <TouchableOpacity onPress={onEdit} hitSlop={6}><Text style={styles.action}>Edit</Text></TouchableOpacity> : null}
          {mine ? <TouchableOpacity onPress={onRemove} hitSlop={6}><Text style={[styles.action, { color: Theme.red }]}>Remove</Text></TouchableOpacity> : null}
        </View>
      )}
    </View>
  );
}

export function DecisionThread({ decisionId, conversationId }: { decisionId: string; conversationId?: string }) {
  const Theme = useTheme();
  const convex = useConvex();
  const { owner, rows } = useDecisionThread(decisionId);
  const unread = useDecisionThreadUnread(decisionId);
  const readAt = useDecisionThreadReadAt(decisionId);
  const [frozen] = useState(() => (unread > 0 ? readAt : undefined));
  const me = useInboxStore((s) => String(s.currentUser?._id ?? ''));
  const sessionId = owner?.conversation_id ?? conversationId ?? '';
  const session = useInboxStore((s) => s.sessions[sessionId] as { short_id?: string; title?: string } | undefined);
  const teamMembers = useInboxStore((s) => s.teamMembers) as any[];
  const roles = useInboxStore((s) => ((s as any).orgTree?.roles ?? []) as Array<{ _id: string; name?: string; handle?: string }>);
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [editing, setEditing] = useState<{ messageId: string; content: string } | null>(null);
  const [asking, setAsking] = useState(false);
  useWatchEffect(() => { if (unread > 0 && rows.length > 0) markDecisionThreadRead(decisionId); }, [unread, rows.length, decisionId]);

  const comments = useMemo(() => decisionThreadComments(rows, sessionId), [rows, sessionId]);
  const resolved = isThreadResolved(comments);
  const firstNew = firstUnreadIndex(comments, frozen, me);
  const names = useMemo(() => new Map(comments.map((c) => [c._id, commentAuthorName(c)])), [comments]);
  const ownerName = owner?.name ?? session?.title ?? 'the session that asked';

  // The same handles the server resolves: people, the decision's session by its short id, and roles.
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    for (const m of teamMembers ?? []) {
      const handle = m ? memberHandle(m) : null;
      if (handle) out.push({ id: String(m._id), handle, name: m.name || handle, avatarUrl: m.github_avatar_url || m.image || undefined, isAgent: m.is_bot });
    }
    const short = owner?.short_id ?? session?.short_id;
    if (short) out.push({ id: sessionId, handle: short, name: ownerName, isAgent: true });
    for (const r of roles) if (r.handle) out.push({ id: r._id, handle: r.handle, name: r.name ?? r.handle, isAgent: true });
    return out;
  }, [teamMembers, roles, owner, session, sessionId, ownerName]);

  const toast = (why: string | null) => { if (why) setRefused(why); };
  const [refused, setRefused] = useState<string | null>(null);
  const ask = () => { void askDecisionSession(decisionId).then(toast); };

  const send = async (content: string, attachments: Array<{ storage_id: string }>) => {
    setRefused(null);
    const text = await withImages(content, attachments.filter((a) => a.storage_id).map((a) => ({ storageId: a.storage_id })), (ids) => convex.query(api.images.getImageUrls, { storageIds: ids }));
    if (!text.trim()) return;
    const parent = replyTo && !replyTo._id.startsWith('dcstub-') ? replyTo._id : undefined;
    setReplyTo(null);
    const why = await sendDecisionComment(decisionId, text, newDecisionCommentId(), parent);
    toast(why);
    if (!why && asking) { setAsking(false); ask(); }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Text style={styles.kicker}>Comments</Text>
        <TouchableOpacity onPress={() => setAsking(true)} style={[styles.ask, asking && { backgroundColor: Theme.cyan + '22' }]} hitSlop={6}>
          <Text style={{ color: Theme.cyan, fontWeight: '600', fontSize: 13 }}>Discuss with {ownerName}</Text>
        </TouchableOpacity>
      </View>
      {comments.map((c, i) => (
        <View key={c.client_id ?? c._id}>
          {i === firstNew ? <Text style={[styles.newLine, { color: Theme.cyan }]}>New</Text> : null}
          <Row
            c={c}
            fresh={firstNew >= 0 && i >= firstNew && !isOwnComment(c, me)}
            mine={isOwnComment(c, me) && !c.event}
            replyingTo={c.parent_comment_id ? names.get(c.parent_comment_id) : undefined}
            onReply={() => setReplyTo(c)}
            onEdit={() => setEditing({ messageId: c._id, content: c.content })}
            onRemove={() => { void useInboxStore.getState().deleteDecisionComment(c._id); }}
          />
        </View>
      ))}
      {comments.length > 0 ? (
        <TouchableOpacity onPress={() => useInboxStore.getState().resolveDecisionThread(decisionId, !resolved)} hitSlop={6}>
          <Text style={[styles.action, resolved && { color: Theme.green }]}>{resolved ? 'Resolved · Reopen' : 'Resolve'}</Text>
        </TouchableOpacity>
      ) : null}
      {replyTo ? (
        <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={6}>
          <Text style={styles.meta}>Replying to {names.get(replyTo._id)} ✕</Text>
        </TouchableOpacity>
      ) : null}
      {refused ? <Text style={[styles.meta, { color: Theme.red }]}>Not sent: {refused}</Text> : null}
      <View style={styles.composer}>
        <ChatComposerBar
          channelId={undefined}
          draftKey={`comment:decision:${decisionId}`}
          placeholder={asking ? `Ask ${ownerName}…` : 'Comment for the team'}
          placeholderTint={asking ? Theme.cyan : undefined}
          mentionCandidates={mentionCandidates}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          onSubmitEdit={(id, content) => { void useInboxStore.getState().editDecisionComment(id, content); setEditing(null); }}
          onSend={(content, attachments) => { void send(content, attachments); }}
        />
      </View>
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  wrap: { gap: Spacing.sm, marginTop: Spacing.lg },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  kicker: { fontSize: 12, fontWeight: '600', color: Theme.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  ask: { borderWidth: 1, borderColor: Theme.cyan + '66', borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: 6 },
  row: { gap: 2, paddingVertical: 4 },
  agent: { backgroundColor: Theme.card, borderRadius: BorderRadius.md, padding: Spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  name: { fontSize: 12, fontWeight: '600', color: Theme.text },
  time: { fontSize: 11, color: Theme.textMuted },
  meta: { fontSize: 12, color: Theme.textMuted },
  body: { fontSize: 14, lineHeight: 20, color: Theme.text },
  event: { fontSize: 13, color: Theme.textMuted },
  actions: { flexDirection: 'row', gap: Spacing.md, marginTop: 2 },
  action: { fontSize: 12, color: Theme.textMuted },
  newLine: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  composer: { marginHorizontal: -Spacing.lg },
}));
