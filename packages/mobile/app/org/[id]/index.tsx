// A role's page on the phone (docs/architecture/scopes-and-feed.md F4): the
// conversation with the agent that holds the seat. The page IS the session
// screen on the role's standing conversation, so the composer is Talk and a
// line sent here is the wake, the same as web; the header's board button opens
// everything in the role's scope. "workspace" is the root: the workspace agent.
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from 'convex/react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api } from '@codecast/convex/convex/_generated/api';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { RoleFace } from '@/components/org/RoleFace';
import { useSyncOrgTree } from '@/hooks/useSyncOrgTree';
import { SessionScreen } from '../../session/[id]';
import { parentName } from '@codecast/web/components/org/orgMeta';
import { canEditRole, scopeSeatOf } from '@codecast/web/lib/scopePage';

export default function RoleScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { tree, meId, ready } = useSyncOrgTree();
  const { role, anchor } = scopeSeatOf(tree, id);
  // The pointer is on the role (org.tree stamps `standing`); the anchors row
  // stands in for a tree that predates it, and is the root's only source.
  const standingId = role?.standing?.conversation_id ?? anchor?.conversation_id;
  const boardHref = `/org/${id}/board`;

  const provisionMutation = useMutation((api as any).orgRoles.provision);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The tree re-syncs with the standing session when the server is done, and
  // this screen becomes the conversation on its own.
  const provision = useCallback(async () => {
    if (!role) return;
    setBusy(true); setProblem(null);
    try {
      await provisionMutation({ role_id: role._id });
    } catch (e: any) {
      setProblem(e?.message?.replace(/^\[Request ID: [^\]]+\] Server Error\s*/i, '').split('\n')[0] ?? 'Could not bring the role online');
      setBusy(false);
    }
  }, [role, provisionMutation]);

  if (standingId) return <SessionScreen id={standingId} boardHref={boardHref} />;

  const isRoot = id === 'workspace';
  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: role ? `@${role.handle}` : isRoot ? 'Workspace' : 'Role',
        headerBackTitle: 'Org',
        headerStyle: { backgroundColor: Theme.bgAlt },
        headerTintColor: Theme.text,
        headerTitleStyle: { fontSize: 14, fontFamily: Mono.semiBold, color: Theme.textMuted },
      }}
    />
  );

  if (!tree) {
    return (
      <>
        {header}
        <RNView style={styles.center}>
          {ready ? <RNText style={styles.body}>No org tree for this workspace.</RNText> : <ActivityIndicator size="small" color={Theme.textMuted} />}
        </RNView>
      </>
    );
  }
  if (!role && !isRoot) {
    return (
      <>
        {header}
        <RNView style={styles.center}>
          <FontAwesome name="sitemap" size={26} color={Theme.textDim} />
          <RNText style={styles.title}>No role {id} in this workspace.</RNText>
          <RNText style={styles.body}>It may be retired, or belong to another team. Switch the workspace or go back to the org.</RNText>
          <TouchableOpacity style={styles.primary} onPress={() => router.replace('/org' as never)}><RNText style={styles.primaryText}>Org</RNText></TouchableOpacity>
        </RNView>
      </>
    );
  }
  if (!role) {
    return (
      <>
        {header}
        <RNView style={styles.center}>
          <FontAwesome name="anchor" size={26} color={Theme.orange} />
          <RNText style={styles.title}>No workspace agent yet</RNText>
          <RNText style={styles.body}>Set one up from the org page on the web; this page then becomes the conversation with it.</RNText>
          <TouchableOpacity onPress={() => router.push(boardHref as never)}><RNText style={styles.link}>Open the board</RNText></TouchableOpacity>
        </RNView>
      </>
    );
  }

  // A seat with no standing agent yet: say what this area is, and offer the
  // one gesture that makes sense. An empty composer would go nowhere.
  const owns = [...role.scope_names.projects.map((p) => p.title), ...role.scope_names.plans.map((p) => p.title)];
  const charter = (role.charter ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  const hostName = tree.people.find((p) => p.user_id === role.host_user_id)?.name ?? 'the host';
  return (
    <>
      {header}
      <RNView style={styles.center}>
        <RoleFace role={role} size={64} />
        <RNText style={styles.title}>{role.name} is not online yet</RNText>
        <RNText style={styles.body}>
          {charter ? charter : owns.length > 0 ? `This seat owns ${owns.join(', ')}.` : 'This seat owns the whole workspace.'}
          {charter && owns.length > 0 ? ` It covers ${owns.join(', ')}.` : ''}
          {' '}It reports to {parentName(tree, role.reports_to)}.
        </RNText>
        {role.status === 'retired' ? (
          <RNText style={styles.note}>This seat is retired. Its board is still here.</RNText>
        ) : canEditRole(tree, role, meId) ? (
          <>
            <RNText style={styles.note}>Bring it online and this page becomes a conversation with it: ask for something here and it answers or starts a session for the work.</RNText>
            <TouchableOpacity style={[styles.primary, busy && { opacity: 0.6 }]} disabled={busy} onPress={provision}>
              <RNText style={styles.primaryText}>{busy ? 'Bringing it online…' : `Bring @${role.handle} online`}</RNText>
            </TouchableOpacity>
            {problem && <RNText style={[styles.note, { color: Theme.red }]}>{problem}</RNText>}
          </>
        ) : (
          <RNText style={styles.note}>Ask {hostName} to bring it online; until then the board is what there is.</RNText>
        )}
        <TouchableOpacity onPress={() => router.push(boardHref as never)}><RNText style={styles.link}>Open the board</RNText></TouchableOpacity>
      </RNView>
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, paddingHorizontal: Spacing.xxl, backgroundColor: Theme.bg },
  title: { fontSize: 17, fontWeight: '700', color: Theme.text, textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 19, color: Theme.textMuted, textAlign: 'center' },
  note: { fontSize: 12.5, lineHeight: 18, color: Theme.textDim, textAlign: 'center' },
  primary: { marginTop: Spacing.xs, paddingHorizontal: Spacing.lg, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: Theme.violet },
  primaryText: { fontSize: 13, fontWeight: '700', color: Theme.bg },
  link: { fontSize: 12.5, color: Theme.violet },
}));
