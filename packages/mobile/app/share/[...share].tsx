import { useEffect, useMemo } from 'react';
import { StyleSheet, ActivityIndicator, TouchableOpacity, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { parseSharePath } from '@codecast/shared/entities';
import { setShareTokenScope } from '@codecast/web/lib/shareTokenScope';
import { useAuth } from '@/lib/auth';

/**
 * The in-app half of codecast.sh/share links — all four kinds:
 *
 *   /share/<token>          → the session screen
 *   /share/message/<token>  → the session screen, scrolled to the message
 *   /share/doc/<token>      → the doc screen
 *   /share/plan/<token>     → the plan screen
 *
 * A share URL carries an opaque token, not an object id, so this screen runs
 * the same public token queries the web share pages use, then replaces itself
 * with the object's screen. For conversations it also records the presented
 * token (shareTokenScope, shared with web) so the transcript queries can
 * re-present it — that is what makes a link to a session outside your team
 * readable instead of empty.
 */
export default function ShareLinkScreen() {
  const params = useLocalSearchParams<{ share: string | string[] }>();
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  const segs = Array.isArray(params.share) ? params.share : params.share ? [params.share] : [];
  const parsed = useMemo(() => parseSharePath('/share/' + segs.join('/')), [segs.join('/')]);
  const kind = parsed?.kind;
  const token = parsed?.token;

  const conv = useQuery(
    api.conversations.getSharedConversationMeta,
    kind === 'conversation' && token ? { share_token: token } : 'skip',
  );
  const msg = useQuery(
    api.messages.getSharedMessage,
    kind === 'message' && token ? { share_token: token } : 'skip',
  );
  const doc = useQuery(
    (api as any).docs.getShared,
    kind === 'doc' && token ? { share_token: token } : 'skip',
  );
  const plan = useQuery(
    (api as any).plans.getShared,
    kind === 'plan' && token ? { share_token: token } : 'skip',
  );

  // undefined = still resolving, null = dead link, else the destination.
  const target = useMemo(():
    | { path: string; conversationId?: string }
    | null
    | undefined => {
    if (!parsed) return null;
    switch (kind) {
      case 'conversation': {
        if (conv === undefined) return undefined;
        const id = (conv as any)?.conversation_id;
        return id ? { path: `/session/${id}`, conversationId: id } : null;
      }
      case 'message': {
        if (msg === undefined) return undefined;
        const cid = msg?.conversation?._id;
        if (!cid) return null;
        return { path: `/session/${cid}?message=${msg.message._id}`, conversationId: cid };
      }
      case 'doc': {
        if (doc === undefined) return undefined;
        return doc?._id ? { path: `/doc/${doc._id}?share=${token}` } : null;
      }
      case 'plan': {
        if (plan === undefined) return undefined;
        return plan?.short_id ? { path: `/plan/${plan.short_id}?share=${token}` } : null;
      }
      default:
        return null;
    }
  }, [parsed, kind, token, conv, msg, doc, plan]);

  useEffect(() => {
    // Signed out, AuthGate is about to bounce this path through login and
    // restore it afterwards — navigating from here too would race it.
    if (!isAuthenticated || !target) return;
    if (token && target.conversationId) setShareTokenScope(target.conversationId, token);
    router.replace(target.path as any);
  }, [isAuthenticated, target?.path]);

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Shared link',
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { fontSize: 14, fontFamily: Mono.semiBold, color: Theme.textMuted },
        }}
      />
      <RNView style={styles.container}>
        {target === null ? (
          <>
            <FontAwesome name="chain-broken" size={28} color={Theme.textMuted0} />
            <RNText style={styles.title}>Invalid link</RNText>
            <RNText style={styles.text}>
              This share link is invalid or was revoked.
            </RNText>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <RNText style={styles.backBtnText}>Go back</RNText>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <ActivityIndicator size="small" color={Theme.textMuted} />
            <RNText style={styles.text}>Opening shared link...</RNText>
          </>
        )}
      </RNView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
  },
  title: { fontSize: 16, fontFamily: Mono.semiBold, color: Theme.text },
  text: { fontSize: 13, color: Theme.textMuted, textAlign: 'center' },
  backBtn: {
    marginTop: Spacing.md,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Theme.borderLight,
  },
  backBtnText: { fontSize: 13, color: Theme.text },
});
