import { StyleSheet, TouchableOpacity, View as RNView, Animated as RNAnimated, PanResponder, Image, Pressable } from 'react-native';
import { probeRender, PERF_PROBE } from '@/lib/perfProbe';
import { Text as RNText } from '@/components/Themed';
import { createContext, memo, useContext, useRef, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cleanUserMessage } from '@codecast/web/components/sessionMessage';
import { showsBlockedBadge, useInboxStore } from '@codecast/web/store/inboxStore';
import { apiErrorBadge } from '@codecast/web/lib/apiErrorBadge';
import { useAckAssignment } from '@codecast/web/hooks/useAckAssignment';
import { threadStateView } from '@codecast/web/lib/threadState';
import { agentStatusAt } from '@codecast/web/lib/liveness';
import { gestureHandler } from '@/lib/gestureHandler';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { MOBILE_PULSE, MOBILE_SESSION_STYLE } from '@codecast/shared/render/mobileSessionStyle';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { ImageViewer } from '@/components/chat/ImageViewer';
import { useModeWords, useSurface } from '@codecast/web/lib/surfaces';
import { PersonifyOverride, usePersonifyAll } from '@codecast/web/hooks/usePersonifyAll';
import { isHostedAgentType } from '@codecast/shared/contracts';
import { conversationState, conversationSubline, conversationTitle, titleIsAsk } from '@codecast/web/components/simple/lane';
import { hostedRowTitle } from '@codecast/web/lib/hostedRowTitle';
import { hostedRowTime } from '@codecast/web/lib/sameNameSuffix';
import { MobileIdentityFace, MobileSessionIdentityLine, useSessionIdentityRow } from '@/components/identity';

export type SessionData = {
  _id: string;
  session_id?: string;
  title?: string;
  subtitle?: string;
  updated_at: number;
  started_at?: number;
  project_path?: string | null;
  git_root?: string | null;
  agent_type?: string;
  message_count: number;
  is_idle?: boolean;
  is_unresponsive?: boolean;
  is_connected?: boolean;
  has_pending?: boolean;
  // The daemon's raw status; the row's dot reads the verdict (agentStatusAt).
  agent_status?: string;
  last_heartbeat?: number | null;
  open_tasks?: unknown[] | null;
  open_tasks_at?: number | null;
  is_deferred?: boolean;
  is_pinned?: boolean;
  last_user_message?: string | null;
  idle_summary?: string | null;
  // The agent's pinned "where this stands" line (cast state) and its
  // provenance: when it was written, and the message count it was written at.
  thread_state?: string | null;
  thread_state_at?: number | null;
  thread_state_msg_count?: number | null;
  thread_state_status?: string | null;
  session_error?: string;
  author_name?: string | null;
  is_own?: boolean;
  icon?: string;
  icon_color?: string;
  is_favorite?: boolean;
  model?: string | null;
  inbox_stashed_at?: number | null;
  inbox_stash_hidden?: boolean | null;
  inbox_dismissed_at?: number | null;
  // Newest image in the session (server-denormalized) — the row thumbnail
  // when the inbox_image_thumbs pref is on.
  image_preview_url?: string | null;
  // Unacknowledged handoff: a teammate assigned this session to the current
  // user (see listInboxSessions enrichment). "Got it" acks it in place.
  assigned_ping?: { by_name: string; note?: string | null; at: number } | null;
  role?: { handle: string; name: string; short_id?: string } | null;
};

export * from '@/components/sessionFormat';
import { formatRelativeTime, isProducingStatus, sessionTitle, projectColor, statusColor, statusLabel, projectName } from '@/components/sessionFormat';

/** A project's name on a row: its colour as a small dot, the name in quiet
 *  ink. The inbox row and a search hit draw it the same. */
export function ProjectTag({ name, maxFontSizeMultiplier }: { name: string; maxFontSizeMultiplier?: number }) {
  return (
    <RNView style={styles.projectTag}>
      <RNView style={[styles.projectDot, { backgroundColor: projectColor(name) }]} />
      <RNText style={styles.projectText} numberOfLines={1} maxFontSizeMultiplier={maxFontSizeMultiplier}>{name}</RNText>
    </RNView>
  );
}

export function PulsingDot({ color }: { color: string }) {
  const Theme = useTheme();
  const opacity = useRef(new RNAnimated.Value(1)).current;
  useEffect(() => {
    const animation = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(opacity, { toValue: MOBILE_PULSE.status.low, duration: MOBILE_PULSE.status.leg, useNativeDriver: true }),
        RNAnimated.timing(opacity, { toValue: 1, duration: MOBILE_PULSE.status.leg, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);
  return <RNAnimated.View style={[styles.statusDot, { backgroundColor: color, opacity }]} />;
}

function StatusDot({ session }: { session: SessionData }) {
  const Theme = useTheme();
  const color = statusColor(session);
  const isAnimated = isProducingStatus(agentStatusAt(session, Date.now())) || session.has_pending;
  if (isAnimated) return <PulsingDot color={color} />;
  return <RNView style={[styles.statusDot, { backgroundColor: color }]} />;
}

/** A hosted row's one mark, in the web rail's terms: the working dot is ink
 *  with a soft pulse, unread is a neutral dot, and anything else keeps the
 *  slot empty so titles stay aligned. */
function HostedRowDot({ working, unread }: { working: boolean; unread: boolean }) {
  const Theme = useTheme();
  if (working) return <PulsingDot color={Theme.text} />;
  return <RNView style={[styles.statusDot, { backgroundColor: unread ? Theme.text : 'transparent' }]} />;
}

// What every row of a list reads from the store, read once by the list and
// handed down. A subscription inside each row runs its selector on every store
// write, for every row (store/storeListenerCensus), and a list holds hundreds.
type InboxRowEnv = {
  /** Hosted mode hides project chips (lib/surfaces gitChips). */
  gitChips: boolean;
  /** Developer rows show their internals (lib/surfaces inbox.rowInternals). */
  internals: boolean;
  /** The project the list is narrowed to: its rows leave the chip off. */
  projectFilter: string | null;
  /** The inbox_image_thumbs pref, stamped LWW so the toggle follows the user. */
  showImageThumb: boolean;
  /** The swipe's word for setting a row aside. */
  stashLabel: string;
};
const InboxRowEnvContext = createContext<InboxRowEnv | null>(null);

/** Wraps a list of session rows (SwipeableSessionItem). */
export function InboxRowEnvProvider({ children }: { children: ReactNode }) {
  const gitChips = useSurface('gitChips');
  const internals = useSurface('inbox.rowInternals');
  const projectFilter = useInboxStore((s) => s.activeProjectFilter);
  const showImageThumb = useInboxStore((s) => s.clientState?.ui?.inbox_image_thumbs === true);
  const stashLabel = useModeWords().stash;
  // The faces and identity lines read this instead of each subscribing.
  const personifyAll = usePersonifyAll();
  const env = useMemo(
    () => ({ gitChips, internals, projectFilter, showImageThumb, stashLabel }),
    [gitChips, internals, projectFilter, showImageThumb, stashLabel],
  );
  return (
    <PersonifyOverride.Provider value={personifyAll}>
      <InboxRowEnvContext.Provider value={env}>{children}</InboxRowEnvContext.Provider>
    </PersonifyOverride.Provider>
  );
}

function useRowEnv(): InboxRowEnv {
  const env = useContext(InboxRowEnvContext);
  if (!env) throw new Error('A session row renders inside InboxRowEnvProvider');
  return env;
}

export function SessionItem({ session, isUnread, selected, onPress, onLongPress, roleSessions, onOpenRole, awaiting, asked, titleSuffix, reviveAt }: { session: SessionData; isUnread?: boolean; selected?: boolean; onPress: () => void; awaiting?: boolean; asked?: string; roleSessions?: number; onOpenRole?: () => void; onLongPress?: () => void; titleSuffix?: string; reviveAt?: number }) {
  if (PERF_PROBE) probeRender('SessionItem');
  const Theme = useTheme();
  const { gitChips, internals, projectFilter, showImageThumb } = useRowEnv();
  // The project names itself on the row unless the inbox is already narrowed
  // to it (the title says it then).
  const rowProject = gitChips ? projectName(session) : null;
  const project = rowProject && rowProject !== projectFilter ? rowProject : null;
  // Hosted mode draws a row as its title, its time and one quiet line
  // (lib/surfaces inbox.rowInternals): where it stands while it is live
  // (the lane's own state rule and words), else the agent's pinned line,
  // else what the person asked. The generated summary is left out: it is
  // written as bullets about "the user", for someone triaging a fleet.
  const sColor = statusColor(session);
  const sLabel = statusLabel(session);
  const showAuthor = session.author_name && session.is_own === false;
  // Same preview filter as the web inbox cards: machine-delivered messages
  // (cast send, teammate broadcasts, scheduled tasks) and harness noise never
  // surface as "what the human said".
  const userMessage = cleanUserMessage(session.last_user_message);
  // The agent's pinned thread state, shared with the web card so both surfaces
  // agree on the headline and on when a state has gone stale. Read at render
  // rather than on a ticker: a row re-renders on every list update, and the
  // freshness only drives a colour.
  const stateView = threadStateView(session, session.message_count ?? 0, Date.now());
  // Parked on an account banner (signed out, out of usage): the same amber
  // pill and rule as web's card. Opening the session offers the fix.
  const blockedBadge = showsBlockedBadge((session as any).pending_api_error, !!session.has_pending, reviveAt, Date.now())
    ? apiErrorBadge((session as any).pending_api_error_kind, session.agent_type)
    : null;
  const [thumbZoom, setThumbZoom] = useState(false);
  // Broken preview image → drop the slot, otherwise it reserves row width.
  const [thumbBroken, setThumbBroken] = useState(false);
  // Row thumbnail for sessions that contain images (env.showImageThumb).
  // Tapping it zooms the image in a modal instead of opening the session
  // (the nested Pressable wins the touch over the row's TouchableOpacity).
  const thumbUrl = showImageThumb && !thumbBroken ? session.image_preview_url : null;
  const identityRow = useSessionIdentityRow(session._id, session as any);
  const ackAssignment = useAckAssignment();
  // Handoff note starts clamped; tapping the pill body reveals the full reason.
  const [pingExpanded, setPingExpanded] = useState(false);
  // A conversation with the assistant is named the way its own screen names
  // it, so a row never reads "New session" while its title is on the way.
  // A title still on its way is the person's own ask (titleIsAsk), and the
  // quiet line never says the ask a second time under it.
  const hostedRow = isHostedAgentType(session.agent_type);
  // Hosted mode names a row by the one hosted name rule (hostedRowTitle), as
  // the web rail and the conversation's header do.
  const storeTitle = useInboxStore((s) => (hostedRow && !internals ? hostedRowTitle(s, session._id) : ''));
  const title = storeTitle || sessionTitle(session);
  const laneState = internals ? null : conversationState(session as any, awaiting ? 1 : 0, Date.now());
  const quiet = internals ? '' : (
    conversationSubline({ last_user_message: null }, laneState!, asked)
    || stateView?.cardLine
    || (userMessage && userMessage !== title && !(hostedRow && titleIsAsk(session)) ? userMessage : '')
  );

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress ? () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onLongPress(); } : undefined}
      delayLongPress={400}
      style={[styles.conversationContent, thumbUrl ? styles.contentWithThumb : null, selected ? { backgroundColor: Theme.bgHighlight } : null]}
      activeOpacity={0.6}
    >
      <RNView style={thumbUrl ? styles.contentColumn : null}>
      <RNView style={styles.conversationHeader}>
        <RNView style={styles.titleRow}>
          <RNView style={styles.iconWithStatus}>
            {internals ? <StatusDot session={session} /> : <HostedRowDot working={laneState === 'working'} unread={!!isUnread} />}
          </RNView>
          {session.is_favorite && (
            <Feather name="star" size={11} color={Theme.accent} style={{ marginRight: 3 }} />
          )}
          {/* Unread carries by WEIGHT plus a leading dot — the same two signals
              the web card and the chat rail use, never a count. Hosted mode's
              dot is the row's one mark, drawn in the status slot. */}
          {internals && isUnread && <RNView style={styles.unreadDot} />}
          {/* Personified: the face, then the name leading the title (the web
              card's order). Nobody opted in: the row reads as it always did. */}
          <MobileIdentityFace
            row={identityRow}
            size={18}
            style={styles.identityFace}
            badge={session.agent_type ? <AgentLogoSvg agentType={session.agent_type} size={8} /> : undefined}
          />
          <MobileSessionIdentityLine
            row={identityRow}
            title={title}
            suffix={titleSuffix}
            style={internals
              ? [styles.conversationTitle, isUnread && styles.conversationTitleUnread]
              : [styles.conversationTitle, styles.hostedTitle, isUnread && styles.hostedTitleUnread]}
          />
        </RNView>
        <RNView style={styles.rightMeta}>
          {internals && sLabel && <RNText style={[styles.statusBadge, { color: sColor }]}>{sLabel}</RNText>}
          {/* Hosted times read as the web rail's ("now", a clock time,
              Yesterday, a weekday, a date), the accent only on unread rows. */}
          <RNText style={[styles.timeText, !internals && styles.hostedTime, !internals && isUnread && styles.hostedTimeUnread]}>
            {internals ? formatRelativeTime(session.updated_at) : hostedRowTime(session.updated_at, Date.now())}
          </RNText>
          {session.is_pinned && (
            <FontAwesome name="thumb-tack" size={10} color={Theme.magenta} />
          )}
        </RNView>
      </RNView>

      {session.assigned_ping && (
        // Mirror of the web card's handoff pill: who handed this over, their
        // note, and "Got it" to accept without opening the session. The nested
        // Pressable wins the touch over the row's TouchableOpacity.
        <RNView style={styles.assignedPingRow}>
          <FontAwesome name="user-plus" size={10} color={Theme.violet} style={{ marginTop: 3 }} />
          {/* The note is the REASON for the handoff — clamped for the list,
              tap the body to read all of it without opening the session. */}
          <Pressable
            style={{ flex: 1, minWidth: 0 }}
            onPress={session.assigned_ping.note ? () => setPingExpanded((v) => !v) : onPress}
          >
            <RNText style={styles.assignedPingTitle} numberOfLines={1}>
              {session.assigned_ping.by_name} assigned this to you
            </RNText>
            {session.assigned_ping.note ? (
              <RNText style={styles.assignedPingNote} numberOfLines={pingExpanded ? undefined : 2}>
                “{session.assigned_ping.note}”
              </RNText>
            ) : null}
          </Pressable>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              ackAssignment(session._id);
            }}
            hitSlop={8}
            style={styles.assignedPingAck}
          >
            <RNText style={styles.assignedPingAckText}>Got it</RNText>
          </Pressable>
        </RNView>
      )}

      {/* A role's sessions are the role's (org-staffing.md S23.3): never rows
          in the inbox; the card says how many and opens the role's page. */}
      {!!roleSessions && roleSessions > 0 && (
        <Pressable onPress={onOpenRole} hitSlop={6} style={{ alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border }} accessibilityRole="button" accessibilityLabel={`${roleSessions} ${roleSessions === 1 ? 'session' : 'sessions'} under this role`}>
          <RNText maxFontSizeMultiplier={1.2} style={{ fontSize: 11, color: Theme.textSecondary }}>{roleSessions} {roleSessions === 1 ? 'session' : 'sessions'}</RNText>
        </Pressable>
      )}
      {quiet ? <RNText style={[styles.summaryText, !internals && styles.hostedQuiet]} numberOfLines={1}>{quiet}</RNText> : null}
      {internals && stateView ? (
        // The agent's pinned "where this stands" line (cast state) replaces the
        // generated summary, same rule as the web card. It dims once the
        // thread has run far past the write, so a neglected line stops
        // reading as current.
        <RNText style={[styles.stateText, stateView.freshness !== 'fresh' && styles.stateTextStale]} numberOfLines={2}>
          {stateView.cardLine}
        </RNText>
      ) : null}
      {/* A phone row carries one line of detail: the agent's pinned state,
          else the generated summary, else what the person last asked. */}
      {internals && !stateView && (session.idle_summary || session.subtitle) ? (
        <RNText style={styles.summaryText} numberOfLines={1}>
          {(session.idle_summary || session.subtitle)!.replace(/^\s*[-*•]\s+/, '')}
        </RNText>
      ) : null}

      {internals && !stateView && !(session.idle_summary || session.subtitle) && userMessage && (
        <RNText style={styles.userMessage} numberOfLines={1}>
          <RNText style={styles.userMessageCaret}>&gt; </RNText>
          {userMessage}
        </RNText>
      )}

      {(project || showAuthor || blockedBadge) ? (
      <RNView style={styles.conversationMeta}>
        {project && <ProjectTag name={project} />}
        {showAuthor && (
          <RNText style={styles.authorText}>{session.author_name}</RNText>
        )}
        {blockedBadge && (
          <RNText style={styles.blockedBadge}>{blockedBadge.label}</RNText>
        )}
      </RNView>
      ) : null}
      </RNView>
      {thumbUrl && (
        <Pressable onPress={() => setThumbZoom(true)} hitSlop={6}>
          <Image source={{ uri: thumbUrl }} style={styles.imageThumb} resizeMode="cover" onError={() => setThumbBroken(true)} />
        </Pressable>
      )}
      {thumbZoom && thumbUrl && <ImageViewer uri={thumbUrl} onClose={() => setThumbZoom(false)} />}
    </TouchableOpacity>
  );
}

// Memoized: the inbox holds every row at once, so a store write re-renders
// only the rows whose props changed. The callbacks take the row's id (or the
// row) so the list passes the same functions to every row.
export const SwipeableSessionItem = memo(function SwipeableSessionItem({ session, isUnread, selected, onPress, onDismiss, onLongPress, roleSessions, onOpenRole, awaiting, asked, titleSuffix, reviveAt }: {
  session: SessionData;
  isUnread?: boolean;
  /** The row is the conversation on screen (a conversation's inbox panel). */
  selected?: boolean;
  onPress: (conversationId: string) => void;
  onDismiss: (conversationId: string) => void;
  onLongPress?: (session: SessionData) => void;
  roleSessions?: number;
  /** Opens the role the row belongs to, by its short id. */
  onOpenRole?: (roleShortId: string) => void;
  /** A clock tick (the list passes the minute). Unread here: a new value
   *  re-renders the row, which reads its relative time and staleness at
   *  render. */
  clock?: number;
  /** The row has an open question for the person. */
  awaiting?: boolean;
  /** The open question a waiting row asks, shown as its quiet line. */
  asked?: string;
  /** Tells two same-name rows apart (lib/sameNameSuffix). */
  titleSuffix?: string;
  /** When a revive was asked for this row (store blockedReviveRequestedAt). */
  reviveAt?: number;
}) {
  const Theme = useTheme();
  const { stashLabel } = useRowEnv();
  const translateX = useRef(new RNAnimated.Value(0)).current;
  const didSwipe = useRef(false);

  // Keep the latest action callbacks reachable from the once-created responder.
  const id = session._id;
  const cb = useRef({ onDismiss: () => onDismiss(id) });
  cb.current = { onDismiss: () => onDismiss(id) };
  const press = useCallback(() => { if (!didSwipe.current) onPress(id); }, [onPress, id]);
  const longPress = useMemo(() => (onLongPress ? () => onLongPress(session) : undefined), [onLongPress, session]);
  const roleShortId = session.role?.short_id;
  const openRole = useMemo(() => (onOpenRole && roleShortId ? () => onOpenRole(roleShortId) : undefined), [onOpenRole, roleShortId]);

  const springBack = useCallback((after?: () => void) => {
    RNAnimated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
      tension: 100,
      friction: 10,
    }).start(after ? () => after() : undefined);
  }, [translateX]);

  // Shared release logic for both gesture paths below. vx is px/s: a committed
  // drag (past the distance threshold) OR a flick (shorter drag at speed)
  // triggers the action; anything else springs back.
  const settle = useCallback((dx: number, vx: number) => {
    if (dx < -100 || (dx < -48 && vx < -800)) {
      // tactile confirm at the commit point — a destructive dismiss reads as
      // accidental without it.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      RNAnimated.timing(translateX, {
        toValue: -400,
        duration: 200,
        useNativeDriver: true,
      }).start(() => cb.current.onDismiss());
    } else {
      springBack();
    }
    requestAnimationFrame(() => { didSwipe.current = false; });
  }, [springBack, translateX]);

  // Gesture-handler pan with NATIVE arbitration. The previous JS PanResponder
  // raced the FlatList's native scroll recognizer and usually lost (the swipe
  // only triggered from a standstill, perfectly horizontal), and even when it
  // won, JS cannot cancel a native scroll — the list kept scrolling vertically
  // under the swipe. activeOffsetX/failOffsetY arbitrate on the native side:
  // 10px of horizontal travel claims the touch AND cancels the scroll
  // recognizer (scroll locks); 15px of vertical travel first fails the pan and
  // scrolling proceeds untouched. While undetermined (a stationary press)
  // gesture-handler does not consume touches, so the inner TouchableOpacity's
  // tap and long-press still fire; on activation it cancels them, so a swipe
  // cannot misfire a tap. Callbacks hop to the JS thread (runOnJS) because they
  // drive an RN Animated value — arbitration stays native regardless.
  const panGesture = useMemo(() => {
    if (!gestureHandler) return null;
    // Leftward only: a rightward drag fails here and belongs to the inbox's
    // slide-out panel (components/inbox/SlideOutDrawer). Pin lives in the
    // long-press menu.
    return gestureHandler.Gesture.Pan()
      .activeOffsetX(-10)
      .failOffsetX(10)
      .failOffsetY([-15, 15])
      .onStart(() => { didSwipe.current = true; })
      .onUpdate((e: any) => translateX.setValue(Math.min(0, e.translationX)))
      .onEnd((e: any) => settle(e.translationX, e.velocityX))
      .onFinalize((_e: any, success: boolean) => {
        // Cancelled mid-swipe (e.g. a system gesture took over) — onEnd never
        // ran. Guarded on didSwipe so the finalize that follows every failed
        // non-swipe touch (taps, scrolls) doesn't spawn no-op springs.
        if (!success && didSwipe.current) {
          springBack();
          requestAnimationFrame(() => { didSwipe.current = false; });
        }
      })
      .runOnJS(true);
  }, [settle, springBack, translateX]);

  // Fallback for binaries whose native build lacks gesture-handler (see
  // lib/gestureHandler.tsx): the old JS PanResponder. Worse arbitration, but
  // the feature stays functional. PanResponder vx is px/ms; settle takes px/s.
  const responder = useRef(
    gestureHandler ? null : PanResponder.create({
      onMoveShouldSetPanResponder: (_e, gs) =>
        Math.abs(gs.dx) > 8 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5,
      onPanResponderGrant: () => {
        didSwipe.current = true;
      },
      onPanResponderMove: (_e, gs) => {
        translateX.setValue(Math.min(0, gs.dx));
      },
      onPanResponderRelease: (_e, gs) => settle(gs.dx, gs.vx * 1000),
      onPanResponderTerminate: () => {
        springBack();
        requestAnimationFrame(() => { didSwipe.current = false; });
      },
    })
  ).current;

  const swipeBehindOpacity = translateX.interpolate({
    inputRange: [-400, -1, 0, 1, 400],
    outputRange: [1, 1, 0, 0, 0],
  });
  const card = (
    <RNAnimated.View
      style={[styles.conversationItem, { transform: [{ translateX }] }]}
      {...(responder ? responder.panHandlers : {})}
    >
      <SessionItem session={session} selected={selected} awaiting={awaiting} asked={asked} titleSuffix={titleSuffix} roleSessions={roleSessions} onOpenRole={openRole} isUnread={isUnread} onPress={press} onLongPress={longPress} reviveAt={reviveAt} />
      <RNView style={styles.separator} />
    </RNAnimated.View>
  );

  return (
    <RNView style={styles.swipeContainer}>
      <RNAnimated.View style={[styles.swipeBehind, { opacity: swipeBehindOpacity }]}>
        <FontAwesome name="archive" size={16} color="#fff" />
        <RNText style={styles.swipeBehindText}>{stashLabel}</RNText>
      </RNAnimated.View>
      {panGesture ? (
        <gestureHandler.GestureDetector gesture={panGesture}>{card}</gestureHandler.GestureDetector>
      ) : card}
    </RNView>
  );
});

export const styles = themedStyles((Theme) => StyleSheet.create({
  swipeContainer: {
    overflow: 'hidden',
  },
  // Stash is set-aside (agent keeps running) — orange, not destructive red.
  swipeBehind: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    backgroundColor: Theme.orange,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: 20,
    gap: 8,
  },
  swipeBehindText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  conversationItem: {
    backgroundColor: Theme.bg,
  },
  // Inset like an iOS list: the rule starts where the text does.
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: Spacing.lg + 14,
    backgroundColor: Theme.bgHighlight,
  },
  conversationContent: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
  },
  // Thumb variant: content column + thumbnail side by side.
  contentWithThumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  contentColumn: {
    flex: 1,
    minWidth: 0,
  },
  imageThumb: {
    width: 54,
    height: 54,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  },
  conversationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  identityFace: { marginRight: 6 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: Spacing.md,
  },
  iconWithStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: Spacing.sm,
  },
  statusDot: MOBILE_SESSION_STYLE.dot,
  conversationTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.text,
    flex: 1,
  },
  conversationTitleUnread: {
    fontWeight: '700',
  },
  // Hosted mode: unread titles are 600 in ink, read ones muted.
  hostedTitle: {
    fontWeight: '500',
    color: Theme.textMuted,
  },
  hostedTitleUnread: {
    fontWeight: '600',
    color: Theme.text,
  },
  hostedTime: {
    fontSize: 12,
    color: Theme.textMuted,
    fontVariant: ['tabular-nums'],
  },
  hostedQuiet: {
    color: Theme.textDim,
  },
  hostedTimeUnread: {
    color: Theme.accent,
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.cyan,
    marginRight: 5,
  },
  rightMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  timeText: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontWeight: '400',
  },
  // msgs count is sol-orange on web's inbox cards — the one loud meta value.
  blockedBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: Theme.accent,
    backgroundColor: Theme.accent + '1a',
    borderColor: Theme.accent + '4d',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 4,
    overflow: 'hidden',
  },
  userMessage: {
    fontSize: 13,
    color: Theme.textMuted,
    marginLeft: 14,
    marginBottom: 2,
    lineHeight: 18,
  },
  userMessageCaret: {
    color: Theme.textMuted0,
  },
  summaryText: {
    fontSize: 13,
    color: Theme.textMuted,
    marginLeft: 14,
    marginBottom: 2,
    lineHeight: 17,
  },
  // Violet like the web card: cyan is the active/selection treatment there, and
  // the handoff motif stays one color across platforms.
  assignedPingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginLeft: 14,
    marginBottom: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Theme.violet + '22',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '55',
  },
  assignedPingTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.violet,
    lineHeight: 16,
  },
  assignedPingNote: {
    fontSize: 11,
    color: Theme.textMuted,
    lineHeight: 15,
  },
  assignedPingAck: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: Theme.violet + '33',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '66',
  },
  assignedPingAckText: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.violet,
  },
  stateText: {
    fontSize: 13,
    color: Theme.textSecondary,
    lineHeight: 18,
    marginLeft: 14,
    marginBottom: 2,
  },
  stateTextStale: {
    color: Theme.textMuted,
  },
  conversationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 14,
    marginTop: 4,
    gap: 10,
  },
  projectTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  projectDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  authorText: {
    fontSize: 12,
    color: Theme.cyan,
    fontWeight: '600',
  },
  agentBadge: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  metaText: {
    fontSize: 12,
    color: Theme.textMuted,
  },
  projectText: {
    fontSize: 12,
    color: Theme.textMuted0,
    maxWidth: 160,
  },
  metaSeparator: {
    color: Theme.textMuted0,
    marginHorizontal: 4,
    fontSize: 12,
  },
}));
