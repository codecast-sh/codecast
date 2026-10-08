import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, View as RNView, Modal, Alert, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, ActionSheetIOS, Switch } from 'react-native';
import { TextInput, Text as RNText } from '@/components/Themed';
import { useActiveTeamFeature, useWorkspaceFeatureState } from '@/lib/teamFeatures';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@codecast/convex/convex/_generated/api';
import { Component, type ReactNode, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { router as appRouter, useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Ionicons } from '@expo/vector-icons';
import { Theme, Spacing, themedStyles, useTheme, useActiveScheme } from '@/constants/Theme';
import {
  SessionData, SwipeableSessionItem, sessionTitle, agentLabel, agentColor,
  formatRelativeTime, projectName, styles as sessionStyles,
} from '@/components/SessionItem';
import {
  useInboxStore, isConvexId, type InboxSession, type InboxViewMode, type BucketItem, placeInboxRows,
  chipMatchesSession, getProjectName, resolveInboxViewMode, resolveShowOld, flatViewSessions, convBucketMap,
  groupSessionsForLabelView, groupSessionsByPlan, sortLabels, computeChipCounts,
  sessionsWakeSig, pendingSendWakeSig, sessionUnreadMap, sessionUnreadWakeSig, sectionHeaderCount,
  hostedOnlyInbox, hostedStatusSections, pendingSendIdsOf, HOSTED_UNFOLDABLE_SECTIONS,
} from '@codecast/web/store/inboxStore';
import { awaitingOkIds } from '@codecast/web/lib/decisionQueue';
import { hostedRowTitle } from '@codecast/web/lib/hostedRowTitle';
import { hostedStopsSig, splitHostedStops } from '@codecast/web/lib/hostedNotice';
import { sameNameSuffixes } from '@codecast/web/lib/sameNameSuffix';
import {
  AGENT_MODEL_CONFIG, AGENT_PICKER_OPTIONS, compareMachineChips, featuredModelOptions, fromConvexAgentType, isHostedAgentType, launchRailOptions, toConvexAgentType,
  type AgentClientId, type DeviceModelInventory,
} from '@codecast/shared/contracts';
import { defaultMachineId } from '@codecast/web/lib/machinePicker';
import { ModelEffortSheet } from '@/components/ModelEffortSheet';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useDefaultAgentType, useOnlyHostedAgent, usePinnedPickerOptions } from '@codecast/web/hooks/usePinnedAgents';
import { useHostedMode, useModeWords, useSurface } from '@codecast/web/lib/surfaces';
import { startHostedConversation } from '@codecast/web/lib/startHostedConversation';
import { AssistantIntro, AssistantStart } from '@/components/hosted/AssistantStart';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { Serif, pageCountLook, pageTitleFace } from '@/constants/fonts';
import { useScopedRecentProjects } from '@codecast/web/hooks/useScopedRecentProjects';
import { partitionTriggerInbox, type TaskRow } from '@codecast/web/components/triggerTasks';
import { DecisionsBadge } from '@/components/decisions/DecisionsBadge';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';
import { useTriggers } from '@codecast/web/hooks/useSyncTriggers';
import { useInstantSessionRows, mergeSearchRows, type SessionSearchRow } from '@codecast/web/lib/instantSessionSearch';
import { useRemoteSearch } from '@codecast/web/hooks/useRemoteSearch';
import { ObjectSearchSections } from '@/components/search/ObjectSearchSections';
import { labelHexColor } from '@/lib/labelColors';
import { type Device, deviceDisplayName } from '@/components/DevicesSection';
import { SessionListSkeleton } from '@/components/SkeletonLoader';
import { TriggerDock } from '@/components/TriggerDock';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { MobileIdentityFace, MobileSessionIdentityLine, useSessionIdentityRow } from '@/components/identity';
import { useQuery } from 'convex/react';
import { mobileCreateFailureDisposition } from '@/lib/durableCreatePolicy';
import { bootMark } from '@/lib/bootProfile';
import { showActionSheet } from '@/lib/actionSheet';

/** How a hosted inbox section draws: its same-name suffixes, whether it
 *  waits on the person (the accent dot), and whether it never folds. */
type HostedSectionOpts = { suffixes?: ReadonlyMap<string, string>; attention?: boolean; fixed?: boolean };

// Stashed/Killed bucket row — the web SessionCard's hidden variants. Tap opens
// the session; explicit buttons restore (both) and kill (stashed only — a
// killed session's agent is already torn down).
function HiddenSessionRow({ session, variant, onPress, onRestore, onKill }: {
  session: SessionData;
  variant: "stashed" | "killed";
  onPress: () => void;
  onRestore: () => void;
  onKill?: () => void;
}) {
  const Theme = useTheme();
  // Hosted mode keeps the row to its title and time (lib/surfaces).
  const internals = useSurface('inbox.rowInternals');
  const project = useSurface('gitChips') ? projectName(session) : null;
  const agent = internals ? agentLabel(session.agent_type ?? "") : "";

  return (
    <TouchableOpacity onPress={onPress} style={styles.dismissedItem} activeOpacity={0.6}>
      <RNView style={sessionStyles.conversationHeader}>
        <RNView style={sessionStyles.titleRow}>
          <FontAwesome
            name={variant === "stashed" ? "archive" : "times-circle"}
            size={10}
            color={Theme.textMuted0}
            style={{ marginRight: 6 }}
          />
          {variant === "stashed" && session.inbox_stashed_at && session.inbox_stash_hidden ? (
            // Stash and hide: trigger wakes don't bring it back (web's EyeOff mark).
            <FontAwesome name="eye-slash" size={10} color={Theme.textMuted0} style={{ marginRight: 6 }} />
          ) : null}
          <RNText style={styles.dismissedTitle} numberOfLines={1}>
            {sessionTitle(session)}
          </RNText>
        </RNView>
        <RNView style={styles.hiddenRowActions}>
          <TouchableOpacity onPress={onRestore} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.6}>
            <FontAwesome name="level-up" size={13} color={Theme.cyan} />
          </TouchableOpacity>
          {onKill && (
            <TouchableOpacity onPress={onKill} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.6}>
              <FontAwesome name="times" size={13} color={Theme.red} />
            </TouchableOpacity>
          )}
        </RNView>
      </RNView>
      <RNView style={sessionStyles.conversationMeta}>
        {agent ? (
          <>
            <RNText style={[sessionStyles.agentBadge, { color: agentColor(session.agent_type ?? "") }]}>
              {agent}
            </RNText>
            <RNText style={sessionStyles.metaSeparator}>·</RNText>
          </>
        ) : null}
        <RNText style={sessionStyles.metaText}>{formatRelativeTime(session.updated_at)}</RNText>
        {project && (
          <>
            <RNText style={sessionStyles.metaSeparator}>·</RNText>
            <RNText style={sessionStyles.projectText} numberOfLines={1}>{project}</RNText>
          </>
        )}
        {internals && (
          <>
            <RNText style={sessionStyles.metaSeparator}>·</RNText>
            <RNText style={sessionStyles.metaText}>{session.message_count} msgs</RNText>
          </>
        )}
      </RNView>
    </TouchableOpacity>
  );
}

// Per-client accents, matching web's AGENT_COLORS (CommandPalette) where it
// has one. Tints the selected pill's border/background/label; the logo tile
// itself is the shared AgentLogoSvg (same marks as web's AgentTypeIcon).
const agentAccents: Record<AgentClientId, string> = {
  claude: Theme.orange,
  codex: Theme.green,
  cursor: Theme.violet,
  gemini: Theme.blue,
  opencode: Theme.accentAmber,
  pi: Theme.cyan,
  grok: Theme.text,
  muse: Theme.greenBright,
  codecast: Theme.cyan,
};

// Web's MODE_ITEMS (StableContextCards), verbatim: same four stops, same
// wording, so the phone and desktop describe the injection identically. "auto"
// stamps nothing — the machine's own `cast stable` setting decides.
const STABLE_MODES = [
  { key: "auto", label: "Auto", title: "Use this machine's default (cast stable)" },
  { key: "team", label: "Team", title: "Team's recent sessions (14d)" },
  { key: "solo", label: "Solo", title: "Your recent sessions (7d)" },
  { key: "off", label: "Off", title: "Don't inject session history" },
] as const;
type StableModePick = (typeof STABLE_MODES)[number]["key"];

// listDevices reports each machine's model inventory; the shared mobile Device
// shape (DevicesSection) predates the field.
type MachineDevice = Device & { model_inventory?: DeviceModelInventory };

// Display-only "~" collapse for the folder browser. web/lib/utils' inferHomeDir
// sits beside window/document helpers, so the one-line version lives here
// rather than dragging that module into the Hermes bundle.
const displayPath = (p: string) => p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, "~");

function mobileCreateErrorMessage(subject: string, error: unknown): string {
  const message = String((error as { message?: unknown })?.message ?? error ?? "");
  if (/dispatch not wired|dropped|no outbox/i.test(message)) {
    return `The ${subject} request was not saved. Your choices are still here—retry when the connection is ready.`;
  }
  return `CodeCast could not confirm the ${subject} request. Your choices are still here, and retrying is safe.`;
}

// The sheet has already closed and the stub is on screen by the time a create
// can fail, so a failure is raised over whatever is showing. A parked create is
// durable and delivers on its own; anything else offers a retry under the same
// session_id (idempotent server side). Left alone, the stub still self-heals on
// its first send (awaitConvexId → ensureSessionCreated).
function watchSessionCreate(stubId: string, ready: Promise<string>, create: (stubId: string) => Promise<string>) {
  ready.catch((error) => {
    const store = useInboxStore.getState();
    if (store.getConvexId(stubId) || mobileCreateFailureDisposition(error) === "accepted-pending") return;
    console.warn("[session] create refused", error);
    Alert.alert("Session didn't start", "The server didn't confirm the new session. Retrying is safe.", [
      { text: "Not now", style: "cancel" },
      {
        text: "Retry",
        onPress: () => {
          const retry = create(stubId).then((convexId) => {
            if (convexId) store.resolveSessionId(stubId, convexId);
            return convexId;
          });
          store.trackSessionCreate(stubId, retry);
          watchSessionCreate(stubId, retry, create);
        },
      },
    ]);
  });
}

// A sheet section that folds to "LABEL   value ›" until tapped. The header is
// the same micro-label as the always-open sections, so closed and open rows
// read as one list; only the trailing summary + chevron mark it as foldable.
function CollapsibleSection({ label, summary, open, onToggle, disabled, children }: {
  label: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const Theme = useTheme();
  return (
    <>
      <TouchableOpacity
        style={modalStyles.collapseHeader}
        onPress={onToggle}
        disabled={disabled}
        activeOpacity={0.6}
        hitSlop={{ top: 12, bottom: 12 }}
      >
        <RNText style={modalStyles.collapseLabel}>{label}</RNText>
        {/* Summary fills the row when closed; an empty spacer keeps the
            chevron pinned to the right edge when open so the row doesn't jump. */}
        {open
          ? <RNView style={{ flex: 1 }} />
          : <RNText style={modalStyles.collapseSummary} numberOfLines={1}>{summary}</RNText>}
        <FontAwesome name={open ? "angle-down" : "angle-right"} size={15} color={Theme.textMuted0} />
      </TouchableOpacity>
      {open && children}
    </>
  );
}

function NewSessionModal({ visible, seed, onClose, onSessionCreated }: { visible: boolean; seed?: string | null; onClose: () => void; onSessionCreated: (conversationId: string) => void }) {
  const Theme = useTheme();
  const words = useModeWords();
  // The agent is the viewer's default (lib/defaultAgent: the hosted assistant
  // in hosted mode or with no machine) until they pick one here. Where only
  // the hosted assistant can answer, the agent row is not offered at all.
  const defaultAgent = fromConvexAgentType(useDefaultAgentType());
  const onlyHosted = useOnlyHostedAgent();
  const [agentPick, setAgentId] = useState<AgentClientId | null>(null);
  const agentId: AgentClientId = onlyHosted ? defaultAgent : agentPick ?? defaultAgent;
  const hosted = isHostedAgentType(agentId);
  // Hosted mode's sheet is one question, the web's compose heading, and
  // files no label (surface inbox.labelStrip).
  const hostedSheet = useHostedMode() && hosted;
  const labelStrip = useSurface('inbox.labelStrip');
  // The pinned agents, and always the hosted assistant: the phone has no
  // palette to reach it from, and it is the one agent that needs no machine.
  const pinnedOptions = usePinnedPickerOptions(agentId);
  const agentOptions = useMemo(
    () => (pinnedOptions.some((o) => o.hosted) ? pinnedOptions : [...pinnedOptions, ...AGENT_PICKER_OPTIONS.filter((o) => o.hosted)]),
    [pinnedOptions],
  );
  // An explicit folder pick only; null = untouched, so the field shows the
  // top recent folder from the store on the very first frame.
  const [pathPick, setProjectPath] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Launch options. Each holds an EXPLICIT pick only — "default"/"auto"/false
  // mean "say nothing and let the agent's or machine's own default win".
  const [model, setModel] = useState("default");
  const [effort, setEffort] = useState("default");
  const [stableMode, setStableMode] = useState<StableModePick>("auto");
  const [isolated, setIsolated] = useState(false);
  // Tri-state label pick: undefined = untouched (inherit the focused chip's
  // bucket, which beginOptimisticSession stamps on its own); null = explicitly
  // "no label" (defeats the inheritance); string = an explicit bucket.
  const [bucketPick, setBucketPick] = useState<string | null | undefined>(undefined);
  const buckets = useInboxStore((s) => s.buckets);
  const activeBucketFilter = useInboxStore((s) => s.activeBucketFilter);
  const effectiveBucketId = bucketPick === undefined ? (activeBucketFilter ?? null) : bucketPick;
  const [modelSheetVisible, setModelSheetVisible] = useState(false);
  const [showAllRecents, setShowAllRecents] = useState(false);
  // Pre-filled controls fold away by default (the common launch is agent +
  // go): projectOpen gates only the free-text path input (the recent pills
  // stay visible), contextOpen gates the stable-mode segments.
  const [projectOpen, setProjectOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  // Machine picker. `deviceId` holds an EXPLICIT pick only: left null, routing
  // picks the machine (deviceRouting) and the folder list stays the union across
  // online devices — the behaviour before this row existed.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  // Store-fed (StoreSyncBridge mounts useSyncDevices), so the row paints at open.
  const rawDevices = useInboxStore((s) => s.machineRoster) as MachineDevice[];
  // listDevices is last_seen-sorted; chips hold still instead.
  const devices = useMemo(() => [...rawDevices].sort(compareMachineChips), [rawDevices]);
  // The row scrolls sideways, so the selected chip can open past the edge:
  // its first layout scrolls the row to it.
  const machineRowRef = useRef<ScrollView>(null);
  // What auto-routing would choose, so the highlighted chip matches where the
  // session actually lands. One ladder with the web picker (machinePicker), fed
  // the folder being typed so a machine holding that checkout wins — the same
  // rung routing uses. The ladder is deterministic (stable tie-breaks), so no
  // feedback loop is needed to pin the highlight against heartbeats.
  // The folder list for the picked machine (or the union with no pick), from
  // the store: the same ladder web's ProjectSwitcher uses.
  const pickedDevice = useMemo(() => (deviceId ? devices.find((d) => d.device_id === deviceId) ?? null : null), [devices, deviceId]);
  const recentProjects = useScopedRecentProjects({ scopedDeviceId: deviceId, routedDevice: pickedDevice, active: visible });
  const projectPath = pathPick ?? recentProjects[0]?.path ?? "";
  const defaultDeviceId = defaultMachineId(rawDevices, {
    ownerDeviceId: null,
    projectPath: projectPath.trim() || null,
  });
  const selectedDeviceId = deviceId ?? defaultDeviceId;

  // Deliver every launch choice to the session the sheet creates. They must ride
  // the CREATE itself, never a follow-up reconfigure: the create's server side
  // already enqueues a start_session at whatever routing chose, so retargeting
  // afterwards races a second spawn against the first — two machines can each
  // claim the same conversation (review finding, pl-224).
  // Only picks that DIFFER from the default are stamped. Undefined lets the
  // default win, which is not the same as pinning it: stamping the machine
  // routing would have chosen anyway short-circuits at rung 1, skipping the rung
  // that prefers whichever online machine actually holds the checkout, and
  // stamping stable_mode "auto" would override the machine's `cast stable`
  // setting. Read at submit time because heartbeats can reorder the devices
  // between the pick and the send.
  const launchStampsForCreate = () => ({
    target_device_id: deviceId && deviceId !== defaultDeviceId ? deviceId : undefined,
    model: model !== "default" ? model : undefined,
    effort: effort !== "default" ? effort : undefined,
    stable_mode: stableMode !== "auto" ? stableMode : undefined,
    isolated: isolated || undefined,
  });

  // The label rides the store's post-create marker: _postCreateBucketId is in
  // the sessions/conversations preserveFields whitelist, survives the stub→real
  // rekey, and resumePostCreateBucketIntentFor replays it once the id lands —
  // including for a create that parks offline and resolves much later. (Awaiting
  // the tracked create promise here instead is a race lost by design:
  // trackSessionCreate reaps pendingSessionCreates before any later
  // continuation could read it.) An untouched pill writes nothing — the store
  // already stamped the focused chip's bucket at beginOptimisticSession.
  const stampLabelIntent = (stubId: string) => {
    if (bucketPick === undefined) return;
    const store = useInboxStore.getState();
    for (const table of ["sessions", "conversations"] as const) {
      const row = (store as any)[table][stubId];
      if (!row) continue;
      const next = { ...row };
      if (bucketPick) next._postCreateBucketId = bucketPick;
      else delete next._postCreateBucketId;
      store.syncRecord(table, stubId, next);
    }
  };

  const finishSessionCreate = (conversationId: string) => {
    setSubmitError(null);
    setAgentId(null);
    setProjectPath("");
    setDeviceId(null);
    setModel("default");
    setEffort("default");
    setStableMode("auto");
    setIsolated(false);
    setBucketPick(undefined);
    setShowAllRecents(false);
    setProjectOpen(false);
    setContextOpen(false);
    onClose();
    onSessionCreated(conversationId);
  };

  // Instant start, the same shape as web's compose popup: seed the local stub,
  // fire the create, then close the sheet and open the stub in the same tick.
  // The create's native outbox row is written synchronously before the network
  // call, so nothing here waits on the server. The session screen renders the
  // stub, a first message typed meanwhile queues locally, and the store rekeys
  // stub → real id when the create lands. A create the server refuses surfaces
  // through watchSessionCreate with a retry under the same session_id.
  // The hosted assistant's start: its first message rides the create
  // (startHostedConversation), so the sheet sends the words with it.
  const startHosted = (text: string) => {
    const stubId = startHostedConversation(text);
    stampLabelIntent(stubId);
    finishSessionCreate(stubId);
  };

  const handleSubmit = () => {
    setSubmitError(null);
    const store = useInboxStore.getState();
    const agent_type = toConvexAgentType(agentId);
    const path = projectPath.trim() || undefined;
    // Bound to this render's picks, so a retry after the sheet has reset still
    // re-sends exactly what the user launched with.
    const create = (stubId: string) =>
      store.createSession({
        agent_type,
        project_path: path,
        git_root: path,
        session_id: stubId,
        ...launchStampsForCreate(),
      });
    let stubId: string;
    try {
      const started = store.beginOptimisticSession({
        agentType: agent_type,
        projectPath: path,
        gitRoot: path,
        deferCreate: true,
        create,
      });
      stubId = started.stubId;
      // Before materialize, so the marker is on the stub rows before any rekey.
      stampLabelIntent(stubId);
      watchSessionCreate(stubId, started.materialize(), create);
    } catch (error) {
      setSubmitError(mobileCreateErrorMessage("session", error));
      return;
    }
    finishSessionCreate(stubId);
  };

  // The launch model/effort rail for the selected agent — absent for clients
  // with no model UI (cursor, gemini), which hides the chip entirely.
  const modelCfg = hosted ? undefined : AGENT_MODEL_CONFIG[agentId];
  const selectedDevice = devices.find((d) => d.device_id === selectedDeviceId);
  // model_inventory is the {hash, collected_at, clients} record the daemon
  // heartbeats (DeviceModelInventory), keyed by client id inside `clients` —
  // never a flat id list. The literal narrowing matches the keys the contract
  // declares; a future dynamic client extends both together.
  const inventoryIds = agentId === "opencode" || agentId === "pi"
    ? selectedDevice?.model_inventory?.clients?.[agentId]
    : undefined;
  const rail = useMemo(() => {
    if (!modelCfg) return null;
    const base = launchRailOptions(modelCfg);
    if (!modelCfg.dynamic) return base;
    // Dynamic clients (opencode, pi) address an open provider/model namespace,
    // so the picked machine's heartbeat-reported inventory is the only list that
    // reflects what will actually launch. Default + the live featured head,
    // mirroring web's ModelEffortMenu — the curated aliases are dropped so the
    // same model can't appear twice under two keys.
    const featured = featuredModelOptions(inventoryIds ?? []);
    if (featured.length === 0) return base;
    return {
      models: [...base.models.filter((m) => m.key === "default"), ...featured],
      efforts: base.efforts,
    };
  }, [modelCfg, inventoryIds]);
  const modelLabel = rail?.models.find((m) => m.key === model)?.label ?? "Default";

  // Pre-create filing. The pill shows where the session will actually land —
  // the explicit pick when there is one, else the focused chip's bucket the
  // store inherits on its own — so it never reads "+ label" while the create
  // quietly files elsewhere.
  const labels = useMemo(() => sortLabels(buckets), [buckets]);
  const chosenLabel = effectiveBucketId ? buckets[effectiveBucketId] : null;
  const openBucketPicker = () => {
    const clear = () => setBucketPick(null);
    const pick = (b: BucketItem) => setBucketPick(b._id === effectiveBucketId ? null : b._id);
    if (Platform.OS === 'ios') {
      const names = labels.map((b) => (b._id === effectiveBucketId ? `✓ ${b.name}` : b.name));
      const options = [...names, 'No label', 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title: 'Label' },
        (index) => {
          if (index < labels.length) pick(labels[index]);
          else if (index === labels.length) clear();
        },
      );
    } else {
      Alert.alert('Label', undefined, [
        ...labels.map((b) => ({ text: b._id === effectiveBucketId ? `✓ ${b.name}` : b.name, onPress: () => pick(b) })),
        { text: 'No label', onPress: clear },
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  };

  // The expanded folder list narrows to what the user is TYPING. A path that
  // came from the list (or the seeding effect) is a selection, not a query, so
  // it must not collapse the browser to a single row.
  const allRecents = recentProjects;
  const typed = projectPath.trim().toLowerCase();
  // The rows render ~-collapsed (displayPath), so a query typed from what the
  // list shows — or from the input's own "~/src/my-project" placeholder — must
  // match too, not just the raw absolute spelling.
  const matchesTyped = (p: string) =>
    p.toLowerCase().includes(typed) || displayPath(p).toLowerCase().includes(typed);
  const browseRecents = typed && !allRecents.some((p) => p.path.toLowerCase() === typed)
    ? allRecents.filter((p) => matchesTyped(p.path))
    : allRecents;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={modalStyles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <RNView style={modalStyles.header}>
          <RNText style={[modalStyles.title, hostedSheet && modalStyles.hostedSheetTitle]}>{hostedSheet ? LANE_COPY.intro.sheetTitle : words.newConversation}</RNText>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
            accessibilityLabel="Close"
          >
            {/* The hosted sheet's close is a thin stroke, as its starters' arrows are. */}
            {hostedSheet
              ? <Ionicons name="close" size={24} color={Theme.textMuted} />
              : <FontAwesome name="times" size={20} color={Theme.textMuted} />}
          </TouchableOpacity>
        </RNView>

        <ScrollView style={modalStyles.body} contentContainerStyle={modalStyles.bodyContent} keyboardShouldPersistTaps="handled">
          {onlyHosted ? null : (<>
          <RNText style={modalStyles.label}>Agent</RNText>
          {/* The viewer's pinned agents (users.pinned_agents, registry order), the
              hosted assistant among them. A 3-up grid of tiles: the mark above the
              name, tinted with the client's accent when active. */}
          <RNView style={modalStyles.agentGrid}>
            {agentOptions.map((a) => {
              const active = agentId === a.id;
              const accent = agentAccents[a.id];
              return (
                <TouchableOpacity
                  key={a.id}
                  style={[modalStyles.agentTile, active && { borderColor: accent + "80", backgroundColor: accent + "16" }]}
                  onPress={() => {
                    setSubmitError(null);
                    // Re-tapping the active agent must not wipe a model/effort
                    // pick; the reset below is for actual switches only (the
                    // rails differ per client, so a pick can't carry over).
                    if (a.id === agentId) return;
                    setAgentId(a.id);
                    setModel("default");
                    setEffort("default");
                  }}
                  activeOpacity={0.7}
                >
                  <RNView style={{ opacity: active ? 1 : 0.4 }}>
                    <AgentLogoSvg agentType={a.id} size={30} />
                  </RNView>
                  <RNText style={[modalStyles.agentTileText, active && { color: accent, fontWeight: "700" }]} numberOfLines={2}>
                    {a.label}
                  </RNText>
                </TouchableOpacity>
              );
            })}
          </RNView>
          </>)}

          {/* The hosted assistant needs no machine, folder, model or context:
              its sheet is the first ask. */}
          {hosted ? (
            <RNView style={{ marginTop: onlyHosted ? Spacing.sm : Spacing.lg }}>
              <AssistantStart
                key={seed ?? ''}
                seed={seed}
                onStart={startHosted}
                // The sheet is a native modal: close it first, so the Plan
                // page opens in front rather than under it.
                onOpenPlan={() => { onClose(); appRouter.push('/settings/plan' as never); }}
              />
            </RNView>
          ) : (<>
          {/* Machine row. One machine is no choice at all, so it only appears
              once there are two — a single-device account sees the old sheet. */}
          {devices.length > 1 && (
            <>
              <RNText style={modalStyles.label}>Machine</RNText>
              <ScrollView
                ref={machineRowRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={modalStyles.machineRow}
                keyboardShouldPersistTaps="handled"
              >
                {devices.map((d) => {
                  const active = selectedDeviceId === d.device_id;
                  return (
                    <TouchableOpacity
                      key={d.device_id}
                      onLayout={(e) => {
                        if (active) machineRowRef.current?.scrollTo({ x: Math.max(0, e.nativeEvent.layout.x - Spacing.lg), animated: false });
                      }}
                      style={[
                        modalStyles.machineChip,
                        !d.online && !active && modalStyles.machineChipOffline,
                        active && modalStyles.machineChipActive,
                      ]}
                      onPress={() => {
                        // Scoping the folder list to another machine can drop the
                        // current path (it may have no such checkout), so clear it
                        // and let the field fall back to the new list's top folder.
                        setDeviceId(d.device_id === defaultDeviceId ? null : d.device_id);
                        setProjectPath(null);
                        setSubmitError(null);
                      }}
                      activeOpacity={0.7}
                    >
                      <RNView style={[modalStyles.machineDot, { backgroundColor: d.online ? Theme.green : Theme.textMuted0 }]} />
                      <RNText style={[modalStyles.machineChipText, active && modalStyles.machineChipTextActive]} numberOfLines={1}>
                        {deviceDisplayName(d)}
                      </RNText>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          )}

          {/* Only the free-text path editor folds away; the recent-project
              pills below stay visible so the common pick is one tap. The
              summary names the path only when no visible pill shows it (a
              custom path, or a recent past the first six). */}
          <CollapsibleSection
            label="Project directory"
            summary={
              projectPath.trim() && !allRecents.slice(0, 6).some((p) => p.path === projectPath)
                ? displayPath(projectPath.trim()).split("/").pop() || displayPath(projectPath.trim())
                : ""
            }
            open={projectOpen}
            onToggle={() => setProjectOpen((v) => !v)}
          >
          <TextInput
            style={modalStyles.input}
            value={projectPath}
            onChangeText={(value) => {
              setProjectPath(value);
              setSubmitError(null);
            }}
            placeholder="~/src/my-project"
            placeholderTextColor={Theme.textMuted0}
            autoCorrect={false}
            autoCapitalize="none"
          />
          </CollapsibleSection>
          {allRecents.length > 0 && (
            <RNView style={modalStyles.recentRow}>
              {allRecents.slice(0, 6).map((p) => (
                <TouchableOpacity
                  key={p.path}
                  // `suggested` entries are padding — roots the picked machine
                  // has but this account has no recent session in. Still pickable,
                  // just visibly weaker than real recents.
                  style={[
                    modalStyles.recentChip,
                    p.suggested && modalStyles.recentChipSuggested,
                    projectPath === p.path && { borderColor: Theme.cyan, backgroundColor: Theme.cyan + "18" },
                  ]}
                  onPress={() => {
                    setProjectPath(p.path);
                    setSubmitError(null);
                  }}
                  activeOpacity={0.7}
                >
                  <RNText style={[modalStyles.recentChipText, projectPath === p.path && { color: Theme.cyan }]} numberOfLines={1}>
                    {p.path.split("/").pop()}
                  </RNText>
                </TouchableOpacity>
              ))}
              {allRecents.length > 6 && (
                <TouchableOpacity
                  style={modalStyles.recentChip}
                  onPress={() => setShowAllRecents((v) => !v)}
                  activeOpacity={0.7}
                >
                  <RNText style={[modalStyles.recentChipText, showAllRecents && { color: Theme.cyan }]}>
                    {showAllRecents ? "Less" : `More… (${allRecents.length - 6})`}
                  </RNText>
                </TouchableOpacity>
              )}
            </RNView>
          )}
          {showAllRecents && (
            <RNView style={modalStyles.recentList}>
              {browseRecents.length === 0 ? (
                <RNText style={modalStyles.hintText}>No folders match "{projectPath.trim()}"</RNText>
              ) : browseRecents.map((p) => (
                <TouchableOpacity
                  key={p.path}
                  style={[modalStyles.recentListRow, p.suggested && modalStyles.recentChipSuggested]}
                  onPress={() => {
                    setProjectPath(p.path);
                    setSubmitError(null);
                  }}
                  activeOpacity={0.7}
                >
                  <RNText style={[modalStyles.recentListText, projectPath === p.path && { color: Theme.cyan }]} numberOfLines={1}>
                    {displayPath(p.path)}
                  </RNText>
                </TouchableOpacity>
              ))}
            </RNView>
          )}

          {rail && (
            <>
              <RNText style={modalStyles.label}>Model</RNText>
              <TouchableOpacity
                style={modalStyles.selectChip}
                onPress={() => setModelSheetVisible(true)}
                activeOpacity={0.7}
              >
                <RNText style={modalStyles.selectChipText} numberOfLines={1}>
                  {effort === "default" ? modelLabel : `${modelLabel} · ${effort}`}
                </RNText>
                <FontAwesome name="angle-down" size={13} color={Theme.textMuted0} />
              </TouchableOpacity>
            </>
          )}

          <CollapsibleSection
            label="Context"
            summary={STABLE_MODES.find((m) => m.key === stableMode)?.label ?? "Auto"}
            open={contextOpen}
            onToggle={() => setContextOpen((v) => !v)}
          >
          <RNView style={modalStyles.segmentRow}>
            {STABLE_MODES.map((m) => {
              const active = stableMode === m.key;
              return (
                <TouchableOpacity
                  key={m.key}
                  style={[modalStyles.segment, active && { borderColor: Theme.cyan, backgroundColor: Theme.cyan + "18" }]}
                  onPress={() => setStableMode(m.key)}
                  activeOpacity={0.7}
                >
                  <RNText style={[modalStyles.segmentText, active && { color: Theme.cyan, fontWeight: "600" }]}>{m.label}</RNText>
                </TouchableOpacity>
              );
            })}
          </RNView>
          <RNText style={modalStyles.hintText}>
            {STABLE_MODES.find((m) => m.key === stableMode)?.title}
          </RNText>
          </CollapsibleSection>

          <RNView style={modalStyles.switchRow}>
            <RNText style={modalStyles.switchLabel}>Isolated worktree</RNText>
            <Switch
              value={isolated}
              onValueChange={setIsolated}
              trackColor={{ true: Theme.cyan, false: Theme.borderLight }}
            />
          </RNView>
          </>)}

          {labels.length > 0 && labelStrip && (
            <RNView style={modalStyles.labelPillRow}>
              <TouchableOpacity
                style={[modalStyles.labelPill, !chosenLabel && modalStyles.labelPillEmpty]}
                onPress={openBucketPicker}
                activeOpacity={0.7}
              >
                {chosenLabel ? (
                  <>
                    <RNView style={[modalStyles.labelPillDot, { backgroundColor: labelHexColor(chosenLabel.name) }]} />
                    <RNText style={[modalStyles.labelPillText, { color: labelHexColor(chosenLabel.name) }]} numberOfLines={1}>
                      {chosenLabel.name}
                    </RNText>
                  </>
                ) : (
                  <RNText style={modalStyles.labelPillText}>{hosted ? 'Add a label' : '+ label'}</RNText>
                )}
              </TouchableOpacity>
            </RNView>
          )}

          {submitError ? (
            <RNText style={modalStyles.errorText}>{submitError}</RNText>
          ) : null}
        </ScrollView>

        {hosted ? null : (
        <RNView style={modalStyles.footer}>
          <TouchableOpacity
            style={modalStyles.cancelBtn}
            onPress={onClose}
            activeOpacity={0.7}
          >
            <RNText style={modalStyles.cancelBtnText}>Cancel</RNText>
          </TouchableOpacity>
          <TouchableOpacity
            style={modalStyles.submitBtn}
            onPress={handleSubmit}
            activeOpacity={0.7}
          >
            <RNView style={modalStyles.submitContent}>
              <RNText style={modalStyles.submitBtnText}>Start Session</RNText>
            </RNView>
          </TouchableOpacity>
        </RNView>
        )}

        {rail && (
          <ModelEffortSheet
            visible={modelSheetVisible}
            onClose={() => setModelSheetVisible(false)}
            models={rail.models}
            efforts={rail.efforts}
            modelKey={model}
            effortKey={effort === "default" ? null : effort}
            onSelect={(sel) => {
              if (sel.model !== undefined) setModel(sel.model);
              if (sel.effort !== undefined) setEffort(sel.effort);
            }}
          />
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const modalStyles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  title: { fontSize: 18, fontWeight: "600", color: Theme.text },
  // The hosted sheet's question, in the reading face.
  hostedSheetTitle: { fontFamily: Serif.regular, fontSize: 22, fontWeight: "500" },
  body: { flex: 1, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  bodyContent: { paddingBottom: Spacing.lg },
  // Web's muted micro-headers: small caps, letterspaced, quiet.
  label: {
    fontSize: 11,
    fontWeight: "700",
    color: Theme.textMuted0,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: Spacing.lg,
  },
  agentGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  agentTile: {
    // 3 per row: (100% - 2 gaps of 10) / 3. flexGrow keeps a short last row
    // from stretching a lone tile to full width.
    flexBasis: "30%",
    flexGrow: 1,
    maxWidth: "32%",
    alignItems: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt + "55",
  },
  agentTileText: { fontSize: 13, fontWeight: "500", color: Theme.textMuted, textAlign: "center" },
  collapseHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: Spacing.lg,
    marginBottom: 8,
  },
  collapseLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: Theme.textMuted0,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  collapseSummary: { flex: 1, fontSize: 13, color: Theme.text, fontWeight: "500", textAlign: "right" },
  input: {
    backgroundColor: Theme.bgAlt,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: Theme.text,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  machineRow: { flexDirection: "row", gap: 8, paddingRight: Spacing.lg },
  machineChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: Theme.bgAlt,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    maxWidth: 180,
  },
  machineChipOffline: { opacity: 0.5 },
  machineChipActive: { borderColor: Theme.cyan, backgroundColor: Theme.cyan + "18" },
  machineChipText: { fontSize: 12, color: Theme.textMuted, fontWeight: "500", flexShrink: 1 },
  machineChipTextActive: { color: Theme.cyan, fontWeight: "700" },
  machineDot: { width: 6, height: 6, borderRadius: 3 },
  recentRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  recentChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    maxWidth: 140,
  },
  recentChipSuggested: { opacity: 0.55 },
  recentChipText: { fontSize: 12, color: Theme.textMuted, fontWeight: "500" },
  recentList: { marginTop: 8, borderRadius: 10, backgroundColor: Theme.bgAlt, overflow: "hidden" },
  recentListRow: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  recentListText: { fontSize: 13, color: Theme.textMuted },
  selectChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    maxWidth: "100%",
  },
  selectChipText: { fontSize: 13, color: Theme.text, fontWeight: "500", flexShrink: 1 },
  segmentRow: { flexDirection: "row", gap: 8 },
  segment: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Theme.bgAlt,
    borderWidth: 1,
    borderColor: Theme.borderLight,
  },
  segmentText: { fontSize: 13, color: Theme.textMuted, fontWeight: "500" },
  hintText: { fontSize: 11, color: Theme.textMuted0, marginTop: 6, lineHeight: 15 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: Spacing.lg,
  },
  switchLabel: { fontSize: 14, color: Theme.text, fontWeight: "500" },
  labelPillRow: { flexDirection: "row", marginTop: Spacing.md },
  labelPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Theme.borderLight,
  },
  labelPillEmpty: { borderStyle: "dashed" },
  labelPillDot: { width: 6, height: 6, borderRadius: 2 },
  labelPillText: { fontSize: 12, color: Theme.textMuted0, fontWeight: "500" },
  errorText: {
    color: Theme.red,
    fontSize: 13,
    lineHeight: 18,
    marginTop: Spacing.md,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10 },
  cancelBtnText: { fontSize: 15, color: Theme.textMuted },
  submitBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Theme.blue,
  },
  submitContent: { flexDirection: "row", alignItems: "center", gap: 8 },
  submitBtnText: { fontSize: 15, fontWeight: "600", color: "#fff" },
}));

function SearchResultItem({ result, onPress }: { result: SessionSearchRow; onPress: () => void }) {
  const Theme = useTheme();
  // A cached row has no message matches yet; its preview is the text the
  // local match landed in until the server row supersedes it.
  const snippet = result.matches[0]?.content ?? result.instantSnippet;
  // A found session reads as the same character its inbox row wears.
  const identityRow = useSessionIdentityRow(result.conversationId);
  return (
    <TouchableOpacity onPress={onPress} style={styles.searchResultItem} activeOpacity={0.6}>
      <RNView style={styles.searchResultHeader}>
        <MobileIdentityFace row={identityRow} size={18} style={{ marginRight: 6 }} />
        <MobileSessionIdentityLine row={identityRow} title={result.title} style={styles.searchResultTitle} />
        {result.matches.length > 0 && (
          <RNText style={styles.searchResultCount}>{result.matches.length} match{result.matches.length !== 1 ? 'es' : ''}</RNText>
        )}
      </RNView>
      {snippet ? (
        <RNText style={styles.searchResultSnippet} numberOfLines={2}>
          {snippet}
        </RNText>
      ) : null}
      <RNView style={styles.conversationMeta}>
        <RNText style={styles.metaText}>{formatRelativeTime(result.updatedAt)}</RNText>
        <RNText style={styles.metaSeparator}>·</RNText>
        <RNText style={styles.metaText}>{result.messageCount} msgs</RNText>
        {!result.isOwn && (
          <>
            <RNText style={styles.metaSeparator}>·</RNText>
            <RNText style={styles.metaText}>{result.authorName}</RNText>
          </>
        )}
      </RNView>
    </TouchableOpacity>
  );
}

// A thrown Convex query error (e.g. searchConversations timing out on a
// multi-word query) must cost the user the RESULTS LIST, not the whole inbox —
// web survives this, so the phone must too. The boundary re-arms whenever the
// query changes so the next keystroke retries cleanly.
class SearchErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <RNView style={styles.emptyInbox}>
          <FontAwesome name="exclamation-triangle" size={22} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>Search failed</RNText>
          <RNText style={styles.emptySubtext}>Try a shorter or simpler query</RNText>
        </RNView>
      );
    }
    return this.props.children;
  }
}

// Owns the search subscription so a server error surfaces inside the boundary
// above instead of unmounting InboxScreen. The cached sessions answer on the
// first keystroke (the same instant tier web's search uses); the server's
// message-content matches land on top when the debounced query returns.
function SearchResultsList({ query, userOnly, onOpen }: { query: string; userOnly: boolean; onOpen: (conversationId: string) => void }) {
  const Theme = useTheme();
  // Cmd-K's two tiers: the store answers on the first keystroke, the server's
  // matches (session content and titles, chat) land on top after a pause.
  const instantRows = useInstantSessionRows(query, 12, { mineOnly: userOnly });
  const chatOn = useActiveTeamFeature('chat');
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? null);
  const remote = useRemoteSearch(query, { enabled: true, limit: 30, userOnly, chatTeamId: chatOn ? activeTeamId : null });
  const searchResultsList = useMemo(() => mergeSearchRows(remote.searchRows as SessionSearchRow[], instantRows), [remote.searchRows, instantRows]);
  return (
    <FlatList
      data={searchResultsList}
      renderItem={({ item }) => (
        <SearchResultItem result={item} onPress={() => onOpen(item.conversationId)} />
      )}
      keyExtractor={(item) => item.conversationId}
      contentContainerStyle={styles.listContent}
      ListEmptyComponent={
        remote.searchAwaiting ? (
          <RNView style={styles.emptyInbox}>
            <ActivityIndicator size="small" color={Theme.textMuted} />
          </RNView>
        ) : (
          <RNView style={styles.emptyInbox}>
            <RNText style={styles.emptyText}>No sessions match "{query.trim()}"</RNText>
          </RNView>
        )
      }
      ListFooterComponent={<ObjectSearchSections query={query} chatHits={remote.chatHits} />}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    />
  );
}

export default function InboxScreen() {
  const Theme = useTheme();
  // Both list memos below bake palette values into React nodes.
  const scheme = useActiveScheme();
  const [showNewSession, setShowNewSession] = useState(false);
  // A starter tapped in the empty inbox opens the sheet with its words typed in.
  const [newSeed, setNewSeed] = useState<string | null>(null);
  const openNewSession = useCallback((seed: string | null = null) => {
    setNewSeed(seed);
    setShowNewSession(true);
  }, []);
  const words = useModeWords();
  const hostedMode = useHostedMode();
  // Hosted mode: no CLI to install, and no project chips.
  const installCli = useSurface('empty.installCli');
  const gitChips = useSurface('gitChips');
  const [showStashed, setShowStashed] = useState(false);
  const [showKilled, setShowKilled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [userOnly, setUserOnly] = useState(false);
  // Search and the label/project chips stay folded away until asked for: the
  // header is the title and one menu. Search opens from its icon or by
  // pulling the list down past its first row; chips open from the filter icon
  // and stay open on their own while a filter is narrowing the list.
  const [searchOpen, setSearchOpen] = useState(false);
  const [chipsOpen, setChipsOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  // Another tab can open the sheet with words typed in (`?ask=`): the empty
  // Routines list's examples do. The param is dropped once read, so the same
  // example works again.
  const ask = useLocalSearchParams<{ ask?: string }>().ask;
  useEffect(() => {
    if (!ask) return;
    openNewSession(ask);
    router.setParams({ ask: undefined });
  }, [ask, openNewSession, router]);
  const isSearching = searchQuery.trim().length >= 2;
  // The org feature is per team, default off: the org button exists only
  // once the workspace is known to have it on.
  const orgOn = useWorkspaceFeatureState('org');

  // Wake-signature gates (see web store/wakeSig.ts). The raw s.sessions and
  // s.pendingMessages refs flip on every liveness tick and send-lifecycle
  // write — subscribing to them kept this always-mounted screen re-rendering
  // (and re-laying-out the whole list) about once a second, pegging a core on
  // an idle phone. Subscribe to the structural signatures instead; the body
  // reads the raw maps off the store at render, same as web's Sidebar. The
  // sync hooks themselves live in StoreSyncBridge (root layout) so server
  // pushes don't re-render this screen at all.
  const sessionsSig = useInboxStore((s) => sessionsWakeSig(s.sessions));
  const pendingSendSig = useInboxStore((s) => pendingSendWakeSig(s.pendingMessages));
  const inboxPainted = useRef(false);
  useEffect(() => {
    if (inboxPainted.current) return;
    const n = Object.keys(useInboxStore.getState().sessions).length;
    if (n === 0) return;
    inboxPainted.current = true;
    bootMark("inbox-rows", { n });
  }, [sessionsSig]);
  // Unread has its own signature: sessionsWakeSig deliberately omits
  // updated_at, which is exactly the number the read model compares against.
  const unreadSig = useInboxStore((s) => sessionUnreadWakeSig(s));
  // The Assistant scope (lib/assistantScope): in hosted mode the inbox holds
  // the assistant's conversations and folds them into the web rail's words
  // (hostedStatusSections), stops in their own "Couldn't finish".
  const hostedOnly = useInboxStore((s) => hostedOnlyInbox(s.clientState?.ui ?? {}));
  const awaitingSig = useInboxStore((s) => (hostedOnly ? [...awaitingOkIds(s.sessionDecisions)].sort().join(',') : ''));
  const stopsSig = useInboxStore((s) => (hostedOnly ? hostedStopsSig(s.sessions, s.messages) : ''));
  const sessions = useInboxStore.getState().sessions;
  // placeInboxRows' trust-TTL adaptation (stale "working" → needs-input) and
  // the rows' relative times are time-driven, not field-driven — a signature
  // never wakes them, so a coarse clock does.
  const coarseNow = useCoarseNow(15_000);
  // First-payload state of the live sessions subscription (set by
  // useSyncInboxSessions). Distinguishes "still loading" from "account has no
  // sessions" — a brand-new account (e.g. App Review's demo login) otherwise
  // sits on the skeleton list forever. Pair with clientStateInitialized so a
  // kill-and-reopen that still has the SQLite cache never looks like a cold
  // load: splash stays up until this is true, and the list then paints from
  // disk even if the live subscription hasn't connected yet.
  const sessionsFirstLoad = useInboxStore((s) => s.liveLoading.sessions);
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const stashSession = useInboxStore((s) => s.stashSession);
  const restoreSession = useInboxStore((s) => s.restoreSession);
  const pinSession = useInboxStore((s) => s.pinSession);
  // Store actions, not the raw convex mutation: the hide data-transition is
  // what triggers the server-side agent teardown, and the store's optimistic
  // move + reconcile keep the row's bucket honest (same path as web).
  const killSession = useInboxStore((s) => s.killSession);
  const killSessions = useInboxStore((s) => s.killSessions);
  const currentSessionId = useInboxStore((s) => s.currentSessionId);
  const pendingSessionCreates = useInboxStore((s) => s.pendingSessionCreates);
  const collapsedSections = useInboxStore((s) => s.collapsedSections);
  const toggleCollapsedSection = useInboxStore((s) => s.toggleCollapsedSection);
  const activeProjectFilter = useInboxStore((s) => s.activeProjectFilter);
  const setActiveProjectFilter = useInboxStore((s) => s.setActiveProjectFilter);
  // Labels ("buckets") + the view-mode preference — all shared web-store state,
  // so filing and filtering stay consistent across phone and desktop.
  const buckets = useInboxStore((s) => s.buckets);
  const bucketAssignments = useInboxStore((s) => s.bucketAssignments);
  const activeBucketFilter = useInboxStore((s) => s.activeBucketFilter);
  const setActiveBucketFilter = useInboxStore((s) => s.setActiveBucketFilter);
  const setInboxViewMode = useInboxStore((s) => s.setInboxViewMode);
  // Scalars off clientState, never the whole singleton — it churns on every
  // draft keystroke synced from any device. inbox_manual_order is an array, so
  // its wake rides a stringified key (ref may flip without content change).
  const viewMode = useInboxStore((s) => resolveInboxViewMode(s.clientState?.ui));
  const showSubagents = useInboxStore((s) => s.clientState?.ui?.show_subagents ?? true);
  const manualOrderKey = useInboxStore((s) => JSON.stringify(s.clientState?.ui?.inbox_manual_order ?? null));
  const bucketByConv = useMemo(() => convBucketMap(bucketAssignments), [bucketAssignments]);
  const visibleBuckets = useMemo(() => sortLabels(buckets), [buckets]);

  const sessionsWithQueuedMessages = useInboxStore((s) => s.sessionsWithQueuedMessages);
  // Hide "old" rows exactly like web (GlobalSessionPanel): the never-prune cache
  // holds every session ever synced (including teammates' threads opened from the
  // feed), but only rows the live inbox subscription still returns are actionable.
  // Same synced per-user flag web reads (clientState.ui.inbox_show_old, stamped
  // LWW, default hide) so the phone and desktop render one identical set.
  const showOld = useInboxStore((s) => resolveShowOld(s.clientState.ui));
  // Scope pre-filter BEFORE the old-session partition, exactly like web
  // (GlobalSessionPanel): the never-prune cache holds rows from other inbox
  // scopes/teams, and an unscoped partition renders them after a switch.
  const inboxScope = useInboxStore((s) => s.clientState.ui?.inbox_scope ?? "mine");
  const teamInboxIds = useInboxStore((s) => s.teamInboxIds);
  const meId = useInboxStore((s) => s.currentUser?._id?.toString?.() ?? null);
  // THE PLACEMENT CHOKEPOINT (store placeInboxRows, sync-convergence C5):
  // scope → shared working-set selection → fold → shared per-row placement →
  // sections — the exact computation web runs, so the phone and desktop can
  // never disagree about membership OR buckets. Reads the LATEST store state
  // on each recompute (coarseNow re-runs it via the chokepoint's deadline
  // signature), so the epoch tick never sweeps a frozen snapshot — and the
  // revive overlay, the questions bucket and the armed-trigger dormancy all
  // arrive with it (they were web-only passes before).
  const placed = useMemo(
    () => placeInboxRows(useInboxStore.getState(), { focusedId: currentSessionId, now: coarseNow }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionsSig/pendingSendSig stand in for the churny refs; coarseNow drives the deadline signature
    [sessionsSig, pendingSendSig, inboxScope, meId, teamInboxIds, showOld, currentSessionId, pendingSessionCreates, sessionsWithQueuedMessages, coarseNow],
  );
  const { visibleSessions, sorted: sortedAll, subsByParent, questions, pinned, newSessions, needsInput, done, dormant, working, stashed: stashedSessions, dismissed: dismissedOnly, roleSessionsByLead } = placed;
  const activeSessions = useMemo(() => sortedAll.filter((s) => !s.is_deferred), [sortedAll]);
  // The number beside the title, in the attention colour: how much is open.
  // Hosted mode shows no bare number there. Its one mark is the decisions
  // badge ("1 to answer"), and each section's own count says the rest, so
  // the header never shows two numbers for overlapping things.
  const headerCount = hostedMode ? 0 : activeSessions.length;
  // The rows with an open question, which a hosted row says in plain words.
  const questionIds = useMemo(() => new Set(questions.map((s) => String(s._id))), [questions]);
  // What each of those rows asks: the row's quiet line is the open question
  // itself (lane.ts conversationSubline), the oldest when it holds several.
  const decisionQueue = useDecisionQueue();
  const askedByConv = useMemo(() => {
    const asked = new Map<string, string>();
    for (const item of [...decisionQueue].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!asked.has(item.conversationId)) asked.set(item.conversationId, item.question);
    }
    return asked;
  }, [decisionQueue]);

  // Label + project chip counts — same source as web's LabelChipsRow / palette
  // view switcher (computeChipCounts), so the two clients can't disagree about
  // what each chip contains.
  const { bucketCounts, projectCounts } = useMemo(
    () => computeChipCounts(sortedAll, bucketByConv),
    [sortedAll, bucketByConv],
  );
  // Zero-count labels stay out of the row unless actively filtered — mirror of
  // web's rule (there they retreat to the +N popover; the phone just hides them).
  const labelChips = useMemo(
    () => visibleBuckets.filter((b) => (bucketCounts[b._id] || 0) > 0 || activeBucketFilter === b._id),
    [visibleBuckets, bucketCounts, activeBucketFilter],
  );

  const chipMatches = useCallback((s: InboxSession) =>
    chipMatchesSession(s, {
      projectFilters: activeProjectFilter ? [{ id: activeProjectFilter, path: null, exclude: false }] : undefined,
      bucketFilters: activeBucketFilter ? [{ id: activeBucketFilter, exclude: false }] : undefined,
      bucketByConv,
      hostedOnly,
    }),
    [activeProjectFilter, activeBucketFilter, bucketByConv, hostedOnly]);
  const chipFilter = useCallback((items: InboxSession[]) => {
    if (!activeProjectFilter && !activeBucketFilter && !hostedOnly) return items;
    return items.filter(chipMatches);
  }, [activeProjectFilter, activeBucketFilter, hostedOnly, chipMatches]);

  const handleSearchChange = useCallback((text: string) => {
    setSearchQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(text.trim());
    }, 300);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setDebouncedQuery('');
  }, []);

  const closeSearch = useCallback(() => {
    clearSearch();
    setSearchOpen(false);
  }, [clearSearch]);

  const handleStash = useCallback((conversationId: string) => {
    stashSession(conversationId);
  }, [stashSession]);

  const handleRestore = useCallback((conversationId: string) => {
    restoreSession(conversationId);
  }, [restoreSession]);

  const handlePin = useCallback((conversationId: string) => {
    pinSession(conversationId);
  }, [pinSession]);

  const confirmKill = useCallback((conversationId: string) => {
    Alert.alert(words.kill, words.killAsk, [
      { text: 'Cancel', style: 'cancel' },
      { text: words.killConfirm, style: 'destructive', onPress: () => killSession(conversationId) },
    ]);
  }, [killSession, words]);

  const confirmKillAllStashed = useCallback((ids: string[]) => {
    Alert.alert(words.killAllStashed, `${words.killAllAsk} (${ids.length})`, [
      { text: 'Cancel', style: 'cancel' },
      { text: words.killConfirm, style: 'destructive', onPress: () => killSessions(ids) },
    ]);
  }, [killSessions, words]);

  // Label filing — the web session-card context menu's "label" half. Picks from
  // existing labels (tap the current one to unfile), creates on the fly (iOS
  // Alert.prompt), all through the shared store's optimistic actions.
  const openLabelPicker = useCallback((session: InboxSession) => {
    const store = useInboxStore.getState();
    const labels = sortLabels(store.buckets);
    const current = convBucketMap(store.bucketAssignments)[session._id];
    const pick = (bucket: BucketItem) =>
      store.assignSessionToBucket(session._id, bucket._id === current ? null : bucket._id);
    const createAndAssign = () => {
      if (Platform.OS !== 'ios') return;
      Alert.prompt('New Label', undefined, (name) => {
        const trimmed = name?.trim();
        if (!trimmed) return;
        const attemptCreate = async () => {
          try {
            await useInboxStore.getState().createBucket(
              { name: trimmed },
              {
                version: 1,
                kind: "assignBucket",
                conversationIds: [session._id],
              },
            );
          } catch (error) {
            if (mobileCreateFailureDisposition(error) === "accepted-pending") {
              Alert.alert(
                'Label queued',
                'The label is saved for delivery and will appear when CodeCast reconnects.',
              );
              return;
            }
            Alert.alert(
              "Couldn't create label",
              mobileCreateErrorMessage("label", error),
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Retry', onPress: () => void attemptCreate() },
              ],
            );
          }
        };
        void attemptCreate();
      });
    };
    if (Platform.OS === 'ios') {
      const names = labels.map((b) => (b._id === current ? `✓ ${b.name}` : b.name));
      const options = [...names, 'New Label…', 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title: 'Label' },
        (index) => {
          if (index < labels.length) pick(labels[index]);
          else if (index === labels.length) createAndAssign();
        },
      );
    } else {
      Alert.alert('Label', undefined, [
        ...labels.map((b) => ({ text: b._id === current ? `✓ ${b.name}` : b.name, onPress: () => pick(b) })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }, []);

  const handleSessionLongPress = useCallback((session: InboxSession) => {
    const favoriteLabel = session.is_favorite ? 'Unfavorite' : 'Favorite';
    const toggleFavorite = () => useInboxStore.getState().toggleFavorite(session._id);
    // Same verb as the web card's right-click menu, same store action, so the
    // dot the phone lights is the dot the desktop shows.
    const markUnread = () => useInboxStore.getState().markSessionUnread(session._id);
    const options = [
      session.is_pinned ? 'Unpin' : 'Pin',
      favoriteLabel,
      'Mark unread',
      'Label…',
      words.stash,
      words.kill,
      'Cancel',
    ];
    const destructiveButtonIndex = 5;
    const cancelButtonIndex = 6;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex, destructiveButtonIndex, title: sessionTitle(session) },
        (index) => {
          if (index === 0) handlePin(session._id);
          else if (index === 1) toggleFavorite();
          else if (index === 2) markUnread();
          else if (index === 3) openLabelPicker(session);
          else if (index === 4) handleStash(session._id);
          else if (index === 5) confirmKill(session._id);
        },
      );
    } else {
      Alert.alert(sessionTitle(session), undefined, [
        { text: session.is_pinned ? 'Unpin' : 'Pin', onPress: () => handlePin(session._id) },
        { text: favoriteLabel, onPress: toggleFavorite },
        { text: 'Mark unread', onPress: markUnread },
        { text: 'Label…', onPress: () => openLabelPicker(session) },
        { text: words.stash, onPress: () => handleStash(session._id) },
        { text: words.kill, style: 'destructive', onPress: () => confirmKill(session._id) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [handlePin, handleStash, confirmKill, openLabelPicker, words]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  // Which rows are lit, derived once per list render from the same shared
  // predicate web uses — the phone and the desktop cannot disagree.
  const unreadByConv = useMemo(
    () => sessionUnreadMap(useInboxStore.getState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature IS the dep
    [unreadSig],
  );

  const renderSessionItem = useCallback((s: InboxSession, titleSuffix?: string) => (
    <SwipeableSessionItem
      key={s._id}
      titleSuffix={titleSuffix}
      session={s as SessionData}
      isUnread={!!unreadByConv[s._id]}
      onPress={() => router.push(`/session/${s._id}`)}
      onDismiss={() => handleStash(s._id)}
      onPin={() => handlePin(s._id)}
      onLongPress={() => handleSessionLongPress(s)}
      awaiting={questionIds.has(s._id)}
      asked={askedByConv.get(String(s._id))}
      roleSessions={roleSessionsByLead.get(s._id)}
      onOpenRole={s.role?.short_id ? () => router.push(`/org/${s.role!.short_id}`) : undefined}
    />
  ), [router, handleStash, handlePin, handleSessionLongPress, unreadByConv, roleSessionsByLead, questionIds, askedByConv]);

  // Collapsible section — collapse state lives in the shared store's
  // collapsedSections. Grouped-view sections keep their historical label keys;
  // the label/plan/flat views pass web's keys (bucket_<id>, plan_<key>, all) so
  // collapse state round-trips with desktop.
  // `count` is the chokepoint's section count (flat cards plus members nested
  // under a same-bucket lead) — the header number web, the tally and the CLI
  // agree on; items.length is only the flat cards.
  const renderSection = useCallback((label: string, items: InboxSession[], color?: string, collapseKey?: string, count?: number, hosted?: HostedSectionOpts) => {
    if (items.length === 0) return null;
    const key = collapseKey ?? label;
    // A hosted section that never folds (New) ignores a stored fold.
    const collapsed = !hosted?.fixed && !!collapsedSections?.[key];
    const rows = collapsed ? null : items.map((row) => renderSessionItem(row, hosted?.suffixes?.get(String(row._id))));
    if (hosted) {
      // The web rail's hosted headings: sentence case in the interface face,
      // muted ink, the count beside it, and one accent dot on what waits on
      // the person.
      return (
        <RNView key={key}>
          <TouchableOpacity
            style={[styles.sectionHeader, styles.hostedSectionHeader]}
            onPress={hosted.fixed ? undefined : () => toggleCollapsedSection(key)}
            disabled={hosted.fixed}
            activeOpacity={0.7}
            accessibilityRole="header"
          >
            {hosted.attention ? <RNView style={styles.hostedSectionDot} /> : null}
            <RNText style={styles.hostedSectionTitle}>{label}</RNText>
            <RNText style={styles.hostedSectionCount}>{count ?? items.length}</RNText>
            {hosted.fixed ? null : (
              <FontAwesome name={collapsed ? "chevron-right" : "chevron-down"} size={8} color={Theme.textMuted0} style={{ marginLeft: 'auto' }} />
            )}
          </TouchableOpacity>
          {rows}
        </RNView>
      );
    }
    return (
      <RNView key={key}>
        <TouchableOpacity style={styles.sectionHeader} onPress={() => toggleCollapsedSection(key)} activeOpacity={0.7}>
          <FontAwesome name={collapsed ? "chevron-right" : "chevron-down"} size={9} color={Theme.textMuted0} />
          <RNText style={[styles.sectionTitle, color ? { color } : undefined]}>{label} ({count ?? items.length})</RNText>
        </TouchableOpacity>
        {rows}
      </RNView>
    );
  }, [renderSessionItem, collapsedSections, toggleCollapsedSection]);

  const filteredPinned = useMemo(() => chipFilter(pinned), [chipFilter, pinned]);
  const filteredNew = useMemo(() => chipFilter(newSessions), [chipFilter, newSessions]);
  const filteredNeedsInput = useMemo(() => chipFilter(needsInput), [chipFilter, needsInput]);
  const filteredDone = useMemo(() => chipFilter(done), [chipFilter, done]);
  const filteredDormant = useMemo(() => chipFilter(dormant), [chipFilter, dormant]);
  const filteredWorking = useMemo(() => chipFilter(working), [chipFilter, working]);
  const filteredStashed = useMemo(() => chipFilter(stashedSessions), [chipFilter, stashedSessions]);
  const filteredKilled = useMemo(() => chipFilter(dismissedOnly), [chipFilter, dismissedOnly]);

  // Schedules in the inbox (mirrors GlobalSessionPanel). The same per-user
  // webList the badges/dock subscribe to (Convex dedupes), partitioned into one
  // row per armed schedule plus the set of sessions absorbed behind those rows
  // (resting loop homes + uneventful runs). All membership rules live in
  // partitionTriggerInbox. schedules_seen_at is read as a scalar off clientState
  // (never the whole singleton), same as showSubagents.
  // Store-fed (StoreSyncBridge mounts useSyncTriggers): the schedule rows
  // paint from the cached roster at boot instead of waiting a round-trip.
  const { tasks: scheduleTaskRows, ready: schedulesReady } = useTriggers();
  const scheduleTasks = (schedulesReady || scheduleTaskRows.length > 0 ? scheduleTaskRows : undefined) as TaskRow[] | undefined;
  const schedulesSeenAt = useInboxStore((s) => s.clientState?.ui?.schedules_seen_at ?? 0);
  const schedulePartition = useMemo(
    () => partitionTriggerInbox(scheduleTasks, visibleSessions, {
      sessionsWithQueuedMessages,
      seenAt: schedulesSeenAt,
      focusedId: currentSessionId,
    }),
    [scheduleTasks, visibleSessions, sessionsWithQueuedMessages, schedulesSeenAt, currentSessionId],
  );
  // Trigger absorption is no longer a client pass (sync-convergence C5): an
  // armed inject trigger or a live loop parks its home in DORMANT as data
  // (armed_trigger_kind / loop_state reach the shared classifier inside the
  // chokepoint), identically on web, mobile and the server. QUESTIONS renders
  // ahead of Needs Input — same lift web ships; it was missing here.
  const filteredQuestions = useMemo(() => chipFilter(questions), [chipFilter, questions]);
  const statusNeedsInput = filteredNeedsInput;
  const statusDone = filteredDone;
  const statusDormant = filteredDormant;
  const statusWorking = filteredWorking;

  const listData = useMemo(() => {
    const sections: React.ReactNode[] = [];
    if (Object.keys(sessions).length === 0) {
      // Skeletons only for a genuinely cold cache: hydration has landed with
      // no rows AND the live subscription hasn't delivered its first payload
      // (undefined = sync hook not mounted yet). Kill-and-reopen hydrates
      // sessions from SQLite before splash hides, so this branch is not
      // taken. Once the live payload has arrived, an empty collection is a
      // real empty account — not an eternal skeleton.
      if (!hydrated || sessionsFirstLoad !== false) {
        return [<SessionListSkeleton key="skeleton" />];
      }
      if (!installCli) {
        // Hosted mode's first run: nothing to install, so the empty inbox
        // offers the assistant (web HostedEmptyState).
        return [(
          <RNView key="empty" style={[styles.emptyInbox, { paddingHorizontal: Spacing.xl }]}>
            <AssistantIntro onStarter={(text) => openNewSession(text)} />
          </RNView>
        )];
      }
      return [(
        <RNView key="empty" style={styles.emptyInbox}>
          <FontAwesome name="inbox" size={32} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>No sessions yet</RNText>
          <RNText style={styles.emptySubtext}>Sessions you run with the codecast CLI will appear here</RNText>
        </RNView>
      )];
    }
    if (activeSessions.length === 0) {
      // Everything is handled. Hosted mode says so and offers the next thing
      // to ask (the same starters the first-run inbox shows).
      if (hostedMode) {
        return [(
          <RNView key="empty" style={[styles.emptyInbox, { paddingHorizontal: Spacing.xl }]}>
            <AssistantIntro title={words.inboxClearTitle} lede={words.inboxAllClear} onStarter={(text) => openNewSession(text)} />
          </RNView>
        )];
      }
      return [(
        <RNView key="empty" style={styles.emptyInbox}>
          <FontAwesome name="inbox" size={32} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>{words.inboxClearTitle}</RNText>
          <RNText style={styles.emptySubtext}>{words.inboxAllClear}</RNText>
        </RNView>
      )];
    }
    // Flat views: one "All" run ordered by the shared comparator — "recent"
    // reshuffles on activity, "time" is a stable creation chronology honoring
    // any manual order dragged on desktop.
    if (viewMode === "recent" || viewMode === "time") {
      const flat = flatViewSessions(sortedAll, subsByParent, {
        mode: viewMode,
        showSubagents,
        focusedId: currentSessionId,
        manualOrder: useInboxStore.getState().clientState?.ui?.inbox_manual_order,
        chipMatches,
      });
      return [renderSection("All", flat, Theme.cyan, "all")].filter(Boolean);
    }
    // Label / plan lenses: pinned stays its own top section (pin is urgency,
    // not theme); the active set regroups by label or plan, with unfiled
    // sessions falling to auto-derived project groups — exactly web's layout.
    if (viewMode === "bucket" || viewMode === "plan") {
      const active = [...filteredQuestions, ...filteredNew, ...statusNeedsInput, ...statusDone, ...filteredDormant, ...statusWorking];
      // The names are the mode's words; the collapse keys stay the developer
    // names, which is what the folded state is stored under on every device.
    sections.push(renderSection("Pinned", filteredPinned, Theme.magenta));
      if (viewMode === "bucket") {
        const { labelGroups, projectGroups } = groupSessionsForLabelView(active, buckets, bucketByConv);
        for (const { bucket, items } of labelGroups)
          sections.push(renderSection(bucket.name, items, labelHexColor(bucket.name), `bucket_${bucket._id}`));
        for (const { name, items } of projectGroups)
          sections.push(renderSection(name, items, name === "other" ? Theme.textMuted0 : labelHexColor(name), `bucketproj_${name}`));
      } else {
        const { planGroups, projectGroups } = groupSessionsByPlan(active);
        for (const { key, label, items } of planGroups)
          sections.push(renderSection(label, items, "#2dd4bf", `plan_${key}`));
        for (const { name, items } of projectGroups)
          sections.push(renderSection(name, items, name === "other" ? Theme.textMuted0 : labelHexColor(name), `planproj_${name}`));
      }
      return sections.filter(Boolean);
    }
    if (hostedOnly) {
      // The Assistant scope's sections, the web rail's (hostedStatusSections):
      // Your move, then Couldn't finish, Working on it, New, Earlier (or
      // Done), and Drafts. The collapse keys are the web's, so a fold
      // round-trips with the desktop.
      const st = useInboxStore.getState();
      const awaiting = awaitingOkIds(st.sessionDecisions);
      const sending = pendingSendIdsOf(st);
      const { asks, stopped } = splitHostedStops(statusNeedsInput, (id) => st.messages[id]);
      const hostedSections = hostedStatusSections(
        { pinned: filteredPinned, questions: filteredQuestions, needsInput: asks, newSessions: filteredNew, working: statusWorking, done: statusDone, dormant: statusDormant },
        (id) => awaiting.has(id), (id) => sending.has(id), (id) => !!unreadByConv[id],
      );
      // Same-name rows get a muted day or time after the title.
      const suffixes = sameNameSuffixes([...hostedSections.flatMap(([rows]) => rows), ...stopped], (row) => hostedRowTitle(st, row._id), coarseNow);
      const anyNew = hostedSections.some(([rows, k]) => k === 'new_results' && rows.length > 0);
      const opts = (key: string, attention = false): HostedSectionOpts => ({ suffixes, attention, fixed: HOSTED_UNFOLDABLE_SECTIONS.has(key) });
      for (const [rows, key] of hostedSections) {
        if (key === 'needs_input') {
          sections.push(renderSection(words.sectionNeedsInput, rows, undefined, 'Needs Input', undefined, opts(key, true)));
          sections.push(renderSection("Couldn't finish", stopped, undefined, 'hosted_stopped', undefined, opts('hosted_stopped')));
        } else if (key === 'pinned') sections.push(renderSection('Pinned', rows, undefined, 'Pinned', undefined, opts(key)));
        else if (key === 'working') sections.push(renderSection(words.sectionWorking, rows, undefined, 'working', undefined, opts(key)));
        else if (key === 'new_results') sections.push(renderSection('New', rows, undefined, 'new_results', undefined, opts(key)));
        else if (key === 'done') sections.push(renderSection(anyNew ? 'Earlier' : 'Done', rows, undefined, 'done', undefined, opts(key)));
        else sections.push(renderSection('Drafts', rows, undefined, 'drafts', undefined, opts(key)));
      }
      return sections.filter(Boolean);
    }
    // Questions lead: a session that asked you something is your move before
    // anything else, pinned or not — same order as the web panel.
    sections.push(renderSection(words.sectionQuestions, filteredQuestions, Theme.violet, "questions"));
    // The header number is the section COUNT while no chip narrows the list
    // and the nested rows are on screen; shared sectionHeaderCount, so this
    // inbox and the web panel can't drift.
    const countOf = (shown: InboxSession[], full: InboxSession[], n: number) =>
      sectionHeaderCount(shown, full, n, showSubagents);
    sections.push(renderSection("Pinned", filteredPinned, Theme.magenta, undefined, countOf(filteredPinned, pinned, placed.counts.pinned)));
    sections.push(renderSection(words.sectionNew, filteredNew, Theme.blue, "New", countOf(filteredNew, newSessions, placed.counts.newSessions)));
    // Top-down "who acts next": you (Needs Input, Done to review), the agent
    // (Working), a machine (Dormant) — same order as the web panel.
    sections.push(renderSection(words.sectionNeedsInput, statusNeedsInput, Theme.accent, "Needs Input", countOf(statusNeedsInput, needsInput, placed.counts.needsInput)));
    sections.push(renderSection("Done", statusDone, Theme.cyan, undefined, countOf(statusDone, done, placed.counts.done)));
    sections.push(renderSection("Working", statusWorking, Theme.greenBright, undefined, countOf(statusWorking, working, placed.counts.working)));
    sections.push(renderSection(words.sectionDormant, statusDormant, Theme.blue, "Dormant", countOf(statusDormant, dormant, placed.counts.dormant)));
    return sections.filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionsSig gates the sessions map; manualOrderKey gates the getState() manual-order read
  }, [activeSessions, sessionsSig, sessionsFirstLoad, hydrated, filteredQuestions, filteredPinned, statusWorking, statusNeedsInput, statusDone, statusDormant, filteredNew, renderSection, viewMode, sortedAll, subsByParent, showSubagents, manualOrderKey, currentSessionId, chipMatches, buckets, bucketByConv, placed.counts, pinned, newSessions, needsInput, done, dormant, working, scheme, installCli, openNewSession, words, hostedOnly, awaitingSig, stopsSig, pendingSendSig, unreadByConv, coarseNow]);

  // Stashed (agent alive, kill-all) and Killed buckets — the web panel's two
  // hidden sections, collapsed by default behind count toggles.
  const ListFooter = useMemo(() => (
    <RNView>
      <TriggerDock
        rows={schedulePartition.rows}
        unreadCount={schedulePartition.unreadCount}
        nextRunAt={schedulePartition.nextRunAt}
      />
      {/* Hosted mode shows the two folded lists only once something is in
          one, so a first run's intro stands alone. */}
      {(!hostedMode || filteredStashed.length + filteredKilled.length > 0) && (
      <RNView style={styles.hiddenToggleRow}>
        <TouchableOpacity
          style={styles.hiddenToggle}
          onPress={() => setShowStashed(prev => !prev)}
          activeOpacity={0.7}
        >
          <FontAwesome name={showStashed ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
          <RNText style={styles.dismissedToggleText}>{words.stashed} ({filteredStashed.length})</RNText>
        </TouchableOpacity>
        <RNView style={styles.hiddenToggleDivider} />
        <TouchableOpacity
          style={styles.hiddenToggle}
          onPress={() => setShowKilled(prev => !prev)}
          activeOpacity={0.7}
        >
          <FontAwesome name={showKilled ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
          <RNText style={styles.dismissedToggleText}>{words.killed} ({filteredKilled.length})</RNText>
        </TouchableOpacity>
      </RNView>
      )}
      {showStashed && filteredStashed.length > 0 && (
        <TouchableOpacity
          onPress={() => confirmKillAllStashed(filteredStashed.map(s => s._id))}
          style={styles.killAllBtn}
          activeOpacity={0.7}
        >
          <RNText style={styles.killAllText}>{words.killAllStashed}</RNText>
        </TouchableOpacity>
      )}
      {showStashed && (
        <RNView style={styles.dismissedSection}>
          {filteredStashed.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>{words.noStashed}</RNText>
          ) : (
            filteredStashed.map(s => (
              <HiddenSessionRow
                key={s._id}
                session={s as SessionData}
                variant="stashed"
                onPress={() => router.push(`/session/${s._id}`)}
                onRestore={() => handleRestore(s._id)}
                onKill={() => confirmKill(s._id)}
              />
            ))
          )}
        </RNView>
      )}
      {showKilled && (
        <RNView style={styles.dismissedSection}>
          {filteredKilled.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>{words.noKilled}</RNText>
          ) : (
            filteredKilled.slice(0, 100).map(s => (
              <HiddenSessionRow
                key={s._id}
                session={s as SessionData}
                variant="killed"
                onPress={() => router.push(`/session/${s._id}`)}
                onRestore={() => handleRestore(s._id)}
              />
            ))
          )}
          {filteredKilled.length > 100 && (
            <RNText style={styles.dismissedEmpty}>+{filteredKilled.length - 100} more</RNText>
          )}
        </RNView>
      )}
      <RNView style={{ height: 80 }} />
    </RNView>
  ), [schedulePartition, showStashed, showKilled, filteredStashed, filteredKilled, router, handleRestore, confirmKill, confirmKillAllStashed, scheme, words, hostedMode]);

  // View switcher — same options, names, and availability rules as web's
  // GlobalSessionPanel dropdown: label view appears once a label exists, plan
  // view once any session carries a plan. The choice writes the shared
  // inbox_view_mode client pref, so phone and desktop stay on the same lens.
  const hasPlanSessions = useMemo(() => activeSessions.some((x) => !!(x as any).active_plan), [activeSessions]);
  const viewModeOptions = useMemo(() => ([
    { key: "grouped", label: "By status", icon: "list-ul" },
    { key: "recent", label: "By updated", icon: "flash" },
    { key: "time", label: "By created", icon: "clock-o" },
    ...(visibleBuckets.length > 0 ? [{ key: "bucket", label: "By label", icon: "tag" }] : []),
    ...(hasPlanSessions ? [{ key: "plan", label: "By plan", icon: "sitemap" }] : []),
  ] as Array<{ key: InboxViewMode; label: string; icon: any }>), [visibleBuckets.length, hasPlanSessions]);

  const projectChips = gitChips ? projectCounts : [];
  const hasChips = labelChips.length > 0 || projectChips.length > 1;
  const filterActive = !!(activeBucketFilter || activeProjectFilter);
  const showChips = !isSearching && hasChips && (chipsOpen || filterActive);

  // The header's one menu: the view lens first (the current one checked),
  // then the places that used to be their own header buttons. Routes are cast
  // because expo's typed-route union only regenerates when Metro runs.
  const openInboxMenu = useCallback(() => {
    showActionSheet('Inbox', [
      ...viewModeOptions.map((o) => ({ label: o.label, selected: o.key === viewMode, onPress: () => setInboxViewMode(o.key) })),
      ...(orgOn === true ? [{ label: 'Open the org', onPress: () => router.push({ pathname: '/org' } as never) }] : []),
      { label: 'Record a meeting', onPress: () => router.push({ pathname: '/record' } as never) },
    ]);
  }, [viewModeOptions, viewMode, setInboxViewMode, orgOn, router]);

  // Pull-to-reveal: the list opens scrolled past a search row that sits above
  // its first section, so a short pull shows it and a longer one refreshes.
  const SEARCH_REVEAL_HEIGHT = 44;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <RNText style={styles.headerTitle}>Inbox</RNText>
        {headerCount > 0 && !isSearching && (
          <RNView style={styles.countBadge}>
            <RNText style={styles.countBadgeText}>{headerCount}</RNText>
          </RNView>
        )}
        {/* Title-side badges (counts that link elsewhere) sit here. */}
        {!isSearching && <DecisionsBadge />}
        <RNView style={{ flex: 1 }} />
        {/* Hosted mode has one way into search, the field over the list (as
            the web rail has one under the wordmark). */}
        {!searchOpen && !hostedMode && (
          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={() => setSearchOpen(true)}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            accessibilityLabel="Search conversations"
          >
            <FontAwesome name="search" size={15} color={Theme.textMuted} />
          </TouchableOpacity>
        )}
        {hasChips && !isSearching && (
          <TouchableOpacity
            style={[styles.headerIconBtn, (chipsOpen || filterActive) && styles.headerIconBtnActive]}
            onPress={() => {
              // Closing the row while a chip narrows the list clears it, so a
              // hidden filter never silently hides sessions.
              if (showChips) { setChipsOpen(false); setActiveBucketFilter(null); setActiveProjectFilter(null); }
              else setChipsOpen(true);
            }}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            accessibilityLabel={showChips ? "Hide filters" : "Filter by label or project"}
          >
            <FontAwesome name="filter" size={15} color={filterActive ? Theme.cyan : Theme.textMuted} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.headerIconBtn}
          onPress={openInboxMenu}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 8 }}
          accessibilityLabel="Inbox options"
        >
          <FontAwesome name="ellipsis-h" size={16} color={Theme.textMuted} />
        </TouchableOpacity>
      </RNView>

      {(searchOpen || searchQuery.length > 0) && (
        <RNView style={styles.searchContainer}>
          <RNView style={styles.searchBarRow}>
            <RNView style={styles.searchInputRow}>
              <FontAwesome name="search" size={14} color={Theme.textMuted0} style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={handleSearchChange}
                placeholder="Search all conversations..."
                placeholderTextColor={Theme.textMuted0}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
                autoFocus
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}>
                  <FontAwesome name="times-circle" size={16} color={Theme.textMuted0} />
                </TouchableOpacity>
              )}
            </RNView>
            <TouchableOpacity onPress={closeSearch} hitSlop={{ top: 10, bottom: 10, left: 6, right: 10 }}>
              <RNText style={styles.searchCancel}>Cancel</RNText>
            </TouchableOpacity>
          </RNView>
          {isSearching && (
            <TouchableOpacity
              style={[styles.userOnlyToggle, userOnly && styles.userOnlyToggleActive]}
              onPress={() => setUserOnly(prev => !prev)}
              activeOpacity={0.7}
            >
              <RNText style={[styles.userOnlyText, userOnly && styles.userOnlyTextActive]}>
                User messages only
              </RNText>
            </TouchableOpacity>
          )}
        </RNView>
      )}

      {showChips && (
        <RNView style={styles.chipRowContainer}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {/* Manual labels lead, auto-derived project chips follow — web's
                LabelChipsRow order. The row is ONE filter: the store clears the
                other axis when either chip kind activates. */}
            {labelChips.map((bucket) => {
              const active = activeBucketFilter === bucket._id;
              const color = labelHexColor(bucket.name);
              return (
                <TouchableOpacity
                  key={bucket._id}
                  style={[styles.projectChip, active && { borderColor: color, backgroundColor: color + '18' }]}
                  onPress={() => setActiveBucketFilter(active ? null : bucket._id)}
                  activeOpacity={0.7}
                >
                  <RNView style={styles.labelChipInner}>
                    <RNView style={[styles.labelChipDot, { backgroundColor: color }]} />
                    <RNText style={[styles.projectChipText, active && { color, fontWeight: '600' }]} numberOfLines={1}>
                      {bucket.name} <RNText style={styles.projectChipCount}>{bucketCounts[bucket._id] || 0}</RNText>
                    </RNText>
                  </RNView>
                </TouchableOpacity>
              );
            })}
            {projectChips.map(([name, count]) => {
              const active = activeProjectFilter === name;
              return (
                <TouchableOpacity
                  key={name}
                  style={[styles.projectChip, active && styles.projectChipActive]}
                  onPress={() => setActiveProjectFilter(active ? null : name)}
                  activeOpacity={0.7}
                >
                  <RNText style={[styles.projectChipText, active && styles.projectChipTextActive]} numberOfLines={1}>
                    {name} <RNText style={styles.projectChipCount}>{count}</RNText>
                  </RNText>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </RNView>
      )}

      {isSearching ? (
        <SearchErrorBoundary resetKey={`${debouncedQuery}|${userOnly}`}>
          <SearchResultsList
            query={searchQuery}
            userOnly={userOnly}
            onOpen={(conversationId) => router.push(`/session/${conversationId}`)}
          />
        </SearchErrorBoundary>
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Theme.textMuted}
            />
          }
          contentContainerStyle={activeSessions.length === 0 ? styles.emptyList : styles.listContent}
          contentOffset={searchOpen ? undefined : { x: 0, y: SEARCH_REVEAL_HEIGHT }}
          showsVerticalScrollIndicator={false}
        >
          {!searchOpen && (
            <TouchableOpacity style={styles.searchReveal} onPress={() => setSearchOpen(true)} activeOpacity={0.7}>
              <FontAwesome name="search" size={13} color={Theme.textMuted0} />
              <RNText style={styles.searchRevealText}>Search all conversations</RNText>
            </TouchableOpacity>
          )}
          {listData}
          {ListFooter}
        </ScrollView>
      )}

      <NewSessionModal
        visible={showNewSession}
        seed={newSeed}
        onClose={() => setShowNewSession(false)}
        onSessionCreated={(conversationId) => {
          // focus=1: a just-created session opens ready to type (composer focused).
          router.push(`/session/${conversationId}?focus=1`);
        }}
      />

      <RNView style={styles.fabContainer} pointerEvents="box-none">
        {/* Hosted mode's new conversation is the family's ink disc, as send
            is; developer mode keeps the action blue. */}
        <TouchableOpacity
          style={[styles.fab, hostedMode && styles.fabHosted]}
          onPress={() => openNewSession()}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={words.newConversation}
        >
          <FontAwesome name="plus" size={18} color={hostedMode ? Theme.bg : '#fff'} />
        </TouchableOpacity>
      </RNView>
    </SafeAreaView>
  );
}

const styles = themedStyles((Theme, look) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
    backgroundColor: Theme.bgAlt,
    gap: 8,
  },
  headerTitle: {
    ...pageTitleFace(look),
    color: Theme.text,
  },
  countBadge: {
    ...pageCountLook(look, Theme.accent, Theme.textMuted, Theme.bg).badge,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  countBadgeText: {
    fontSize: 12,
    ...pageCountLook(look, Theme.accent, Theme.textMuted, Theme.bg).text,
  },
  headerIconBtn: {
    width: 34,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconBtnActive: {
    backgroundColor: Theme.bg,
  },
  searchBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchCancel: {
    fontSize: 14,
    color: Theme.blue,
  },
  // The family look draws it as the web rail's search field: a bordered
  // field, left-aligned, in the same 44pt the pull-down reveal hides.
  searchReveal: look === 'family' ? {
    height: 34,
    marginVertical: 5,
    marginHorizontal: Spacing.md,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  } : {
    height: 44,
    marginHorizontal: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  searchRevealText: {
    fontSize: 14,
    color: Theme.textMuted0,
  },
  labelChipInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  labelChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  // Room under the last row for the floating + (48pt, 24pt up), so the
  // last row's time can scroll clear of it.
  listContent: {
    paddingBottom: 88,
  },
  emptyList: {
    flexGrow: 1,
  },
  emptyInbox: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 8,
  },
  emptyText: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.textMuted,
  },
  emptySubtext: {
    fontSize: 14,
    color: Theme.textMuted0,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Theme.bgAlt,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.textMuted0,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  hostedSectionHeader: {
    gap: 7,
    paddingTop: 14,
    paddingBottom: 6,
    backgroundColor: Theme.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
  hostedSectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.accent,
  },
  hostedSectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.textMuted,
  },
  hostedSectionCount: {
    fontSize: 12,
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
  },
  hiddenToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: Theme.bgHighlight,
    marginTop: Spacing.sm,
  },
  hiddenToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    flexGrow: 1,
  },
  hiddenToggleDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    backgroundColor: Theme.borderLight,
  },
  killAllBtn: {
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: Spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.red + '60',
  },
  killAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.red,
  },
  hiddenRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingLeft: 8,
  },
  chipRowContainer: {
    backgroundColor: Theme.bgAlt,
    paddingBottom: Spacing.xs,
  },
  chipRow: {
    paddingHorizontal: Spacing.md,
    gap: 6,
    flexDirection: 'row',
  },
  projectChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
    maxWidth: 160,
  },
  projectChipActive: {
    borderColor: Theme.cyan,
    backgroundColor: Theme.cyan + '18',
  },
  projectChipText: {
    fontSize: 12,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  projectChipTextActive: {
    color: Theme.cyan,
    fontWeight: '600',
  },
  projectChipCount: {
    fontSize: 11,
    color: Theme.textMuted0,
  },
  dismissedToggleText: {
    fontSize: 13,
    color: Theme.textMuted0,
    fontWeight: '500',
  },
  dismissedSection: {
    backgroundColor: Theme.bgAlt,
  },
  dismissedEmpty: {
    fontSize: 13,
    color: Theme.textMuted0,
    textAlign: 'center',
    paddingVertical: 20,
  },
  dismissedItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    opacity: 0.7,
  },
  dismissedTitle: {
    fontSize: 14,
    fontWeight: '400',
    color: Theme.textMuted,
    flex: 1,
  },
  searchContainer: {
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
  },
  searchInputRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Theme.bg,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    height: 34,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: Theme.text,
    paddingVertical: 0,
  },
  userOnlyToggle: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.borderLight,
  },
  userOnlyToggleActive: {
    backgroundColor: Theme.accent + '20',
    borderColor: Theme.accent,
  },
  userOnlyText: {
    fontSize: 12,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  userOnlyTextActive: {
    color: Theme.accent,
  },
  searchResultItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
    backgroundColor: Theme.bg,
  },
  searchResultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  searchResultTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.text,
    flex: 1,
    marginRight: Spacing.sm,
  },
  searchResultCount: {
    fontSize: 11,
    color: Theme.accent,
    fontWeight: '600',
  },
  searchResultSnippet: {
    fontSize: 13,
    color: Theme.textMuted,
    lineHeight: 18,
    marginBottom: 4,
  },
  conversationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaText: {
    fontSize: 12,
    color: Theme.textMuted,
  },
  metaSeparator: {
    color: Theme.textMuted0,
    marginHorizontal: 4,
    fontSize: 12,
  },
  fabContainer: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    zIndex: 100,
    elevation: 100,
  },
  fab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Theme.blue,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 6,
  },
  fabHosted: {
    backgroundColor: Theme.text,
    shadowOpacity: 0.12,
    shadowRadius: 10,
  },
}));
