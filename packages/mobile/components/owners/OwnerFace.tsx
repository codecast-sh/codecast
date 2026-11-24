// A session's owners as faces, on the phone, under the session_owners model
// (the web OwnersMenu's OwnerFace / OwnerFaces): a person's picture or
// initials, a role's tile, the parent session's face. No face is ringed.
import { useMemo } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';
import { RoleFace } from '@/components/org/RoleFace';
import { MobileSessionFace } from '@/components/identity';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { identityRowOf, identitySig } from '@codecast/web/lib/sessionIdentity';
import { coOwnersOf, type CoOwners } from '@codecast/web/lib/coOwners';
import { ownersReadOf } from '@codecast/web/store/sessionOwnersSlice';
import { teamMembersOf } from '@codecast/web/lib/activeTeam';
import { roleLikeOf, type OwnerPerson, type OwnerRoleFace, type SessionOwnersView } from '@codecast/web/hooks/useSessionOwners';

/** A person's face: their picture, else their initials on a tinted disc that
 *  stands off any header. Under 20pt one letter, which fits the disc. */
export function PersonFace({ name, image, size = 18 }: { name: string; image?: string | null; size?: number }) {
  const Theme = useTheme();
  if (image) return <Image source={{ uri: image }} style={{ width: size, height: size, borderRadius: size / 2 }} accessibilityLabel={name} />;
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, size < 20 ? 1 : 2).toUpperCase();
  return (
    <View
      accessibilityLabel={name}
      style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: Theme.cyan + '33', borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.cyan + '80',
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      }}
    >
      <Text allowFontScaling={false} style={{ fontSize: Math.round(size * 0.55), lineHeight: size, fontWeight: '600', color: Theme.text }} testID="person-face-initials">{initials || '?'}</Text>
    </View>
  );
}

export function OwnerFace({ person, role, size = 18 }: { person?: OwnerPerson; role?: OwnerRoleFace | null; size?: number }) {
  if (role) return <RoleFace role={roleLikeOf(role) as any} size={size} />;
  return <PersonFace name={person?.name ?? '?'} image={person?.image} size={size} />;
}

/** The face of the session that owns this one, read off its identity alone. */
export function ParentSessionFace({ sessionId, size = 18 }: { sessionId: string; size?: number }) {
  const Theme = useTheme();
  const sig = useInboxStore((s: any) => {
    const row = s.sessions?.[sessionId] ?? s.conversations?.[sessionId];
    return row ? `${identitySig(row)}\u0000${row.agent_type ?? ''}` : '';
  });
  const row = useMemo(() => {
    const s = useInboxStore.getState() as any;
    const r = s.sessions?.[sessionId] ?? s.conversations?.[sessionId];
    return r ? { ...identityRowOf(r), agent_type: r.agent_type as string | undefined } : { _id: sessionId, title: null, agent_type: undefined };
  }, [sessionId, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ width: size, height: size, borderRadius: 5, backgroundColor: Theme.bgAlt, alignItems: 'center', justifyContent: 'center' }} testID="owner-session-face">
      <MobileSessionFace row={row as any} size={size} badge={<AgentLogoSvg agentType={row.agent_type ?? 'claude_code'} size={Math.max(8, Math.round(size * 0.6))} />} />
    </View>
  );
}

/** Every owner's face, in order: people (three, then +N), the role, the parent session. */
export function OwnerFaces({ view, size = 16 }: { view: Pick<SessionOwnersView, 'people' | 'role' | 'parent'>; size?: number }) {
  const Theme = useTheme();
  return (
    <View style={styles.stack}>
      {view.people.slice(0, 3).map((p) => <PersonFace key={p._id} name={p.name} image={p.image} size={size} />)}
      {view.people.length > 3 && <Text style={{ fontSize: 11, color: Theme.textMuted }}>+{view.people.length - 3}</Text>}
      {view.role && <OwnerFace role={view.role} size={size} />}
      {view.parent && <ParentSessionFace sessionId={view.parent.id} size={size} />}
    </View>
  );
}

/** An inbox row's other owners (web lib/coOwners) as faces beside its time. */
export function CoOwnerFaces({ owners }: { owners: CoOwners }) {
  const Theme = useTheme();
  return (
    // One element, read as its title: the faces inside carry their own
    // labels, which VoiceOver would otherwise read again after it.
    <View style={styles.stack} accessible accessibilityLabel={owners.title} importantForAccessibility="no-hide-descendants" testID="row-owners">
      {owners.people.map((p) => <PersonFace key={p.key} name={p.name} image={p.image} size={14} />)}
      {owners.more > 0 && <Text style={{ fontSize: 10, color: Theme.textMuted }}>+{owners.more}</Text>}
      {owners.role && <RoleFace role={owners.role as any} size={14} />}
      {owners.parentId && <ParentSessionFace sessionId={owners.parentId} size={14} />}
    </View>
  );
}

/** "You, Ashot Petrosian, Eval Suite lead, <session>": the faces read aloud. */
/** The owners a session's header chip says aloud: its row's owners line once
 *  the owners read is in, and only "Owners" while it loads, naming no one it
 *  has not read. */
export function ownersSpoken(s: Parameters<typeof coOwnersOf>[0] & { currentUser?: { _id?: unknown } | null }, conversationId: string): string {
  if (!ownersReadOf(s as never, conversationId)) return 'Owners';
  return coOwnersOf(s, conversationId, s.currentUser?._id ? String(s.currentUser._id) : null, teamMembersOf(s as never))?.title ?? 'Owners: You';
}

export function ownersLabel(view: Pick<SessionOwnersView, 'people' | 'role' | 'parent' | 'meId'>): string {
  return [...view.people.map((p) => (p._id === view.meId ? 'You' : p.name)), ...(view.role ? [view.role.name] : []), ...(view.parent ? [view.parent.title] : [])].join(', ');
}

const styles = StyleSheet.create({
  stack: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
