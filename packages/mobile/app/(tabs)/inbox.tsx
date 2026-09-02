import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, View as RNView, Modal, Alert, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, ActionSheetIOS, Switch } from 'react-native';
import { TextInput, Text as RNText } from '@/components/Themed';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@codecast/convex/convex/_generated/api';
import { Component, type ReactNode, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import {
  SessionData, SwipeableSessionItem, cleanTitle, agentLabel, agentColor,
  formatRelativeTime, projectName, styles as sessionStyles,
} from '@/components/SessionItem';
import {
  useInboxStore, isConvexId, type InboxSession, type InboxViewMode, type BucketItem, placeInboxRows,
  chipMatchesSession, getProjectName, resolveInboxViewMode, resolveShowOld, flatViewSessions, convBucketMap,
  groupSessionsForLabelView, groupSessionsByPlan, sortLabels, computeChipCounts,
  sessionsWakeSig, pendingSendWakeSig,
} from '@codecast/web/store/inboxStore';
import {
  AGENT_LAUNCH_OPTIONS, AGENT_MODEL_CONFIG, featuredModelOptions, launchRailOptions, toConvexAgentType,
  type AgentClientId, type DeviceModelInventory,
} from '@codecast/shared/contracts';
import { defaultMachineId } from '@codecast/web/lib/machinePicker';
import { ModelEffortSheet } from '@/components/ModelEffortSheet';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { partitionTriggerInbox, type TaskRow } from '@codecast/web/components/triggerTasks';
import { labelHexColor } from '@/lib/labelColors';
import { type Device, deviceColor, deviceDisplayName } from '@/components/DevicesSection';
import { SessionListSkeleton } from '@/components/SkeletonLoader';
import { TriggerDock } from '@/components/TriggerDock';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { useQuery } from 'convex/react';
import { mobileCreateFailureDisposition } from '@/lib/durableCreatePolicy';

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
  const project = projectName(session);
  const agent = agentLabel(session.agent_type ?? "");

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
            {cleanTitle(session.title)}
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
        <RNText style={sessionStyles.metaSeparator}>·</RNText>
        <RNText style={sessionStyles.metaText}>{session.message_count} msgs</RNText>
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

function NewSessionModal({ visible, onClose, onSessionCreated }: { visible: boolean; onClose: () => void; onSessionCreated: (conversationId: string) => void }) {
  const [agentId, setAgentId] = useState<AgentClientId>("claude");
  const [projectPath, setProjectPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const retryStubId = useRef<string | null>(null);
  const submitAttempt = useRef(0);
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
  const rawDevices = (useQuery(api.devices.listDevices, visible ? {} : "skip") ?? []) as MachineDevice[];
  // listDevices is last_seen-sorted, so heartbeats would reshuffle the chips
  // under the user's thumb. Hold them still: locals first, then by name.
  const devices = useMemo(
    () => [...rawDevices].sort((a, b) =>
      Number(a.is_remote) - Number(b.is_remote) || deviceDisplayName(a).localeCompare(deviceDisplayName(b))),
    [rawDevices],
  );
  // What auto-routing would choose, so the highlighted chip matches where the
  // session actually lands. One ladder with the web picker (machinePicker), fed
  // the folder being typed so a machine holding that checkout wins — the same
  // rung routing uses. The ladder is deterministic (stable tie-breaks), so no
  // feedback loop is needed to pin the highlight against heartbeats.
  const defaultDeviceId = defaultMachineId(rawDevices, {
    ownerDeviceId: null,
    projectPath: projectPath.trim() || null,
  });
  const selectedDeviceId = deviceId ?? defaultDeviceId;
  const recentProjects = useQuery(
    api.users.getRecentProjectPaths,
    visible ? { limit: 50, ...(deviceId ? { device_id: deviceId } : {}) } : "skip",
  );

  useEffect(() => {
    if (visible && !projectPath && recentProjects?.length) {
      setProjectPath(recentProjects[0].path);
    }
  }, [visible, recentProjects]);

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
    // Filing doesn't affect the spawn. The stub path is covered by the marker
    // stamped at submit; a create that resolved in-line (retry of an already
    // landed create) has no stub rows left to carry it, so assign directly —
    // guarded, because the marker replay may have filed it already.
    if (effectiveBucketId && isConvexId(conversationId)) {
      const st = useInboxStore.getState();
      if (convBucketMap(st.bucketAssignments)[conversationId] !== effectiveBucketId) {
        st.assignSessionToBucket(conversationId, effectiveBucketId);
      }
    }
    retryStubId.current = null;
    setSubmitError(null);
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

  const handleClose = () => {
    // A Convex mutation may wait across an offline window. Closing the sheet
    // must not cause a late acknowledgement to navigate unexpectedly; the
    // retained stub lets a later reopen resolve or retry the same intent.
    submitAttempt.current++;
    setSubmitting(false);
    onClose();
  };

  // Seed the optimistic stub immediately, but do not close or navigate until
  // the create is either server-confirmed or synchronously persisted in the
  // native outbox. A dropped parked:false call keeps this modal and all input.
  // Retry reuses the same session_id, which is idempotent on the server.
  const handleSubmit = async () => {
    if (submitting) return;
    const attempt = ++submitAttempt.current;
    setSubmitting(true);
    setSubmitError(null);
    const store = useInboxStore.getState();
    const agent_type = toConvexAgentType(agentId);
    const path = projectPath.trim() || undefined;
    let stubId = retryStubId.current ?? "";

    try {
      let ready: Promise<string>;
      if (stubId) {
        const alreadyResolved = store.getConvexId(stubId);
        if (alreadyResolved) {
          ready = Promise.resolve(alreadyResolved);
        } else {
          ready = store.createSession({
            agent_type,
            project_path: path,
            git_root: path,
            session_id: stubId,
            ...launchStampsForCreate(),
          }).then((convexId: string) => {
            if (convexId) store.resolveSessionId(stubId, convexId);
            return convexId || stubId;
          });
          store.trackSessionCreate(stubId, ready);
          ready.catch(() => {});
        }
      } else {
        // Capture the stub before materializing. Native persistence is
        // deliberately synchronous, so a full/damaged database can throw
        // during createSession; deferCreate lets the catch below retain the
        // exact stub and present a safe retry instead of losing the intent.
        const started = store.beginOptimisticSession({
          agentType: agent_type,
          projectPath: path,
          gitRoot: path,
          deferCreate: true,
          create: (createdStubId) =>
            store.createSession({
              agent_type,
              project_path: path,
              git_root: path,
              session_id: createdStubId,
              ...launchStampsForCreate(),
            }),
        });
        stubId = started.stubId;
        retryStubId.current = stubId;
        ready = started.materialize();
      }

      // Synchronous with the branches above — the stub rows (when any) still
      // exist and the rekey continuation can't have run yet, so the marker is
      // in place before the id resolves. The already-resolved retry has no stub
      // rows; finishSessionCreate's direct assign covers it.
      stampLabelIntent(stubId);

      const conversationId = await ready;
      if (submitAttempt.current !== attempt) return;
      finishSessionCreate(conversationId || store.getConvexId(stubId) || stubId);
    } catch (error) {
      if (submitAttempt.current !== attempt) return;
      if (mobileCreateFailureDisposition(error) === "accepted-pending") {
        // The create is durably queued, not lost — and it carries the pick.
        finishSessionCreate(stubId);
      } else {
        setSubmitError(mobileCreateErrorMessage("session", error));
      }
    } finally {
      if (submitAttempt.current === attempt) setSubmitting(false);
    }
  };

  // The launch model/effort rail for the selected agent — absent for clients
  // with no model UI (cursor, gemini), which hides the chip entirely.
  const modelCfg = AGENT_MODEL_CONFIG[agentId];
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
  const allRecents = recentProjects ?? [];
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
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <KeyboardAvoidingView style={modalStyles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <RNView style={modalStyles.header}>
          <RNText style={modalStyles.title}>New Session</RNText>
          <TouchableOpacity
            onPress={handleClose}
            hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          >
            <FontAwesome name="times" size={20} color={Theme.textMuted} />
          </TouchableOpacity>
        </RNView>

        <ScrollView style={modalStyles.body} contentContainerStyle={modalStyles.bodyContent} keyboardShouldPersistTaps="handled">
          <RNText style={modalStyles.label}>Agent</RNText>
          {/* Registry-derived (AGENT_LAUNCH_OPTIONS): adding a client descriptor
              is all it takes to appear here. A 3-up grid of tiles — the mark
              above the name, tinted with the client's accent when active. */}
          <RNView style={modalStyles.agentGrid}>
            {AGENT_LAUNCH_OPTIONS.map((a) => {
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
                  disabled={submitting}
                  activeOpacity={0.7}
                >
                  <RNView style={{ opacity: active ? 1 : 0.4 }}>
                    <AgentLogoSvg agentType={a.id} size={30} />
                  </RNView>
                  <RNText style={[modalStyles.agentTileText, active && { color: accent, fontWeight: "700" }]} numberOfLines={1}>
                    {a.label}
                  </RNText>
                </TouchableOpacity>
              );
            })}
          </RNView>

          {/* Machine row. One machine is no choice at all, so it only appears
              once there are two — a single-device account sees the old sheet. */}
          {devices.length > 1 && (
            <>
              <RNText style={modalStyles.label}>Machine</RNText>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={modalStyles.machineRow}
                keyboardShouldPersistTaps="handled"
              >
                {devices.map((d) => {
                  const active = selectedDeviceId === d.device_id;
                  const color = deviceColor(d);
                  return (
                    <TouchableOpacity
                      key={d.device_id}
                      style={[
                        modalStyles.machineChip,
                        !d.online && modalStyles.machineChipOffline,
                        active && { borderColor: color, backgroundColor: color + "20" },
                      ]}
                      onPress={() => {
                        // Scoping the folder list to another machine can drop the
                        // current path (it may have no such checkout), so clear it
                        // and let the seeding effect refill from the new list.
                        setDeviceId(d.device_id === defaultDeviceId ? null : d.device_id);
                        setProjectPath("");
                        setSubmitError(null);
                      }}
                      disabled={submitting}
                      activeOpacity={0.7}
                    >
                      <RNView style={[modalStyles.machineDot, { backgroundColor: d.online ? Theme.green : Theme.textMuted0 }]} />
                      <RNText style={[modalStyles.machineChipText, active && { color }]} numberOfLines={1}>
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
            disabled={submitting}
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
            editable={!submitting}
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
                  disabled={submitting}
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
                  disabled={submitting}
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
                  disabled={submitting}
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
                disabled={submitting}
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
            disabled={submitting}
          >
          <RNView style={modalStyles.segmentRow}>
            {STABLE_MODES.map((m) => {
              const active = stableMode === m.key;
              return (
                <TouchableOpacity
                  key={m.key}
                  style={[modalStyles.segment, active && { borderColor: Theme.cyan, backgroundColor: Theme.cyan + "18" }]}
                  onPress={() => setStableMode(m.key)}
                  disabled={submitting}
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
              disabled={submitting}
              trackColor={{ true: Theme.cyan, false: Theme.borderLight }}
            />
          </RNView>

          {labels.length > 0 && (
            <RNView style={modalStyles.labelPillRow}>
              <TouchableOpacity
                style={[modalStyles.labelPill, !chosenLabel && modalStyles.labelPillEmpty]}
                onPress={openBucketPicker}
                disabled={submitting}
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
                  <RNText style={modalStyles.labelPillText}>+ label</RNText>
                )}
              </TouchableOpacity>
            </RNView>
          )}

          {submitError ? (
            <RNText style={modalStyles.errorText}>{submitError}</RNText>
          ) : null}
        </ScrollView>

        <RNView style={modalStyles.footer}>
          <TouchableOpacity
            style={modalStyles.cancelBtn}
            onPress={handleClose}
            activeOpacity={0.7}
          >
            <RNText style={modalStyles.cancelBtnText}>{submitting ? "Close" : "Cancel"}</RNText>
          </TouchableOpacity>
          <TouchableOpacity
            style={[modalStyles.submitBtn, submitting && modalStyles.disabledBtn]}
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.7}
          >
            <RNView style={modalStyles.submitContent}>
              {submitting ? <ActivityIndicator size="small" color="#fff" /> : null}
              <RNText style={modalStyles.submitBtnText}>
                {submitting ? "Saving…" : retryStubId.current ? "Retry" : "Start Session"}
              </RNText>
            </RNView>
          </TouchableOpacity>
        </RNView>

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

const modalStyles = StyleSheet.create({
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
  agentTileText: { fontSize: 13, fontWeight: "500", color: Theme.textMuted },
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
  machineChipText: { fontSize: 12, color: Theme.textMuted, fontWeight: "500", flexShrink: 1 },
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
  disabledBtn: { opacity: 0.55 },
});

type SearchResult = {
  conversationId: string;
  title: string;
  matches: Array<{
    messageId: string;
    content: string;
    role: string;
    timestamp: number;
  }>;
  updatedAt: number;
  authorName: string;
  isOwn: boolean;
  messageCount: number;
};

function SearchResultItem({ result, onPress }: { result: SearchResult; onPress: () => void }) {
  const firstMatch = result.matches[0];
  return (
    <TouchableOpacity onPress={onPress} style={styles.searchResultItem} activeOpacity={0.6}>
      <RNView style={styles.searchResultHeader}>
        <RNText style={styles.searchResultTitle} numberOfLines={1}>{result.title}</RNText>
        <RNText style={styles.searchResultCount}>{result.matches.length} match{result.matches.length !== 1 ? 'es' : ''}</RNText>
      </RNView>
      {firstMatch && (
        <RNText style={styles.searchResultSnippet} numberOfLines={2}>
          {firstMatch.content}
        </RNText>
      )}
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
// above instead of unmounting InboxScreen.
function SearchResultsList({ query, userOnly, onOpen }: { query: string; userOnly: boolean; onOpen: (conversationId: string) => void }) {
  const searchResults = useQuery(api.conversations.searchConversations, { query, limit: 30, userOnly });
  const searchResultsList = useMemo(() => {
    if (!searchResults) return [];
    return 'results' in searchResults ? searchResults.results : (searchResults as SearchResult[]);
  }, [searchResults]);
  return (
    <FlatList
      data={searchResultsList}
      renderItem={({ item }) => (
        <SearchResultItem result={item} onPress={() => onOpen(item.conversationId)} />
      )}
      keyExtractor={(item) => item.conversationId}
      contentContainerStyle={searchResultsList.length === 0 ? styles.emptyList : styles.listContent}
      ListEmptyComponent={
        searchResults === undefined ? (
          <RNView style={styles.emptyInbox}>
            <ActivityIndicator size="small" color={Theme.textMuted} />
          </RNView>
        ) : (
          <RNView style={styles.emptyInbox}>
            <RNText style={styles.emptyText}>No results for "{query}"</RNText>
          </RNView>
        )
      }
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    />
  );
}

export default function InboxScreen() {
  const [showNewSession, setShowNewSession] = useState(false);
  const [showStashed, setShowStashed] = useState(false);
  const [showKilled, setShowKilled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [userOnly, setUserOnly] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const isSearching = debouncedQuery.length >= 2;

  // Wake-signature gates (see web store/wakeSig.ts). The raw s.sessions and
  // s.pendingMessages refs flip on every liveness tick and send-lifecycle
  // write — subscribing to them kept this always-mounted screen re-rendering
  // (and re-laying-out the whole list) about once a second, pegging a core on
  // an idle phone. Subscribe to the structural signatures instead; the body
  // reads the raw maps off the store at render, same as web's Sidebar. The
  // sync hooks themselves live in StoreSyncBridge (tabs layout) so server
  // pushes don't re-render this screen at all.
  const sessionsSig = useInboxStore((s) => sessionsWakeSig(s.sessions));
  const pendingSendSig = useInboxStore((s) => pendingSendWakeSig(s.pendingMessages));
  const sessions = useInboxStore.getState().sessions;
  // placeInboxRows' trust-TTL adaptation (stale "working" → needs-input) and
  // the rows' relative times are time-driven, not field-driven — a signature
  // never wakes them, so a coarse clock does.
  const coarseNow = useCoarseNow(15_000);
  // First-payload state of the live sessions subscription (set by
  // useSyncInboxSessions). Distinguishes "still loading" from "account has no
  // sessions" — a brand-new account (e.g. App Review's demo login) otherwise
  // sits on the skeleton list forever.
  const sessionsFirstLoad = useInboxStore((s) => s.liveLoading.sessions);
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
  const { visibleSessions, sorted: sortedAll, subsByParent, questions, pinned, newSessions, needsInput, done, dormant, working, stashed: stashedSessions, dismissed: dismissedOnly } = placed;
  const activeSessions = useMemo(() => sortedAll.filter((s) => !s.is_deferred), [sortedAll]);

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
    }),
    [activeProjectFilter, activeBucketFilter, bucketByConv]);
  const chipFilter = useCallback((items: InboxSession[]) => {
    if (!activeProjectFilter && !activeBucketFilter) return items;
    return items.filter(chipMatches);
  }, [activeProjectFilter, activeBucketFilter, chipMatches]);

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
    Alert.alert('Kill Session', 'Stop the agent and move this session to Killed?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Kill', style: 'destructive', onPress: () => killSession(conversationId) },
    ]);
  }, [killSession]);

  const confirmKillAllStashed = useCallback((ids: string[]) => {
    Alert.alert('Kill All Stashed', `Stop ${ids.length} stashed session${ids.length === 1 ? '' : 's'}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Kill All', style: 'destructive', onPress: () => killSessions(ids) },
    ]);
  }, [killSessions]);

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
    const options = [
      session.is_pinned ? 'Unpin' : 'Pin',
      favoriteLabel,
      'Label…',
      'Stash',
      'Kill Session',
      'Cancel',
    ];
    const destructiveButtonIndex = 4;
    const cancelButtonIndex = 5;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex, destructiveButtonIndex, title: cleanTitle(session.title) },
        (index) => {
          if (index === 0) handlePin(session._id);
          else if (index === 1) toggleFavorite();
          else if (index === 2) openLabelPicker(session);
          else if (index === 3) handleStash(session._id);
          else if (index === 4) confirmKill(session._id);
        },
      );
    } else {
      Alert.alert(cleanTitle(session.title), undefined, [
        { text: session.is_pinned ? 'Unpin' : 'Pin', onPress: () => handlePin(session._id) },
        { text: favoriteLabel, onPress: toggleFavorite },
        { text: 'Label…', onPress: () => openLabelPicker(session) },
        { text: 'Stash', onPress: () => handleStash(session._id) },
        { text: 'Kill Session', style: 'destructive', onPress: () => confirmKill(session._id) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [handlePin, handleStash, confirmKill, openLabelPicker]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const renderSessionItem = useCallback((s: InboxSession) => (
    <SwipeableSessionItem
      key={s._id}
      session={s as SessionData}
      onPress={() => router.push(`/session/${s._id}`)}
      onDismiss={() => handleStash(s._id)}
      onPin={() => handlePin(s._id)}
      onLongPress={() => handleSessionLongPress(s)}
    />
  ), [router, handleStash, handlePin, handleSessionLongPress]);

  // Collapsible section — collapse state lives in the shared store's
  // collapsedSections. Grouped-view sections keep their historical label keys;
  // the label/plan/flat views pass web's keys (bucket_<id>, plan_<key>, all) so
  // collapse state round-trips with desktop.
  // `count` is the chokepoint's section count (flat cards plus members nested
  // under a same-bucket lead) — the header number web, the tally and the CLI
  // agree on; items.length is only the flat cards.
  const renderSection = useCallback((label: string, items: InboxSession[], color?: string, collapseKey?: string, count?: number) => {
    if (items.length === 0) return null;
    const key = collapseKey ?? label;
    const collapsed = !!collapsedSections?.[key];
    return (
      <RNView key={key}>
        <TouchableOpacity style={styles.sectionHeader} onPress={() => toggleCollapsedSection(key)} activeOpacity={0.7}>
          <FontAwesome name={collapsed ? "chevron-right" : "chevron-down"} size={9} color={Theme.textMuted0} />
          <RNText style={[styles.sectionTitle, color ? { color } : undefined]}>{label} ({count ?? items.length})</RNText>
        </TouchableOpacity>
        {!collapsed && items.map(renderSessionItem)}
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
  const scheduleTasks = useQuery(api.agentTasks.webList, {}) as TaskRow[] | undefined;
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
      // Skeletons only while the live subscription hasn't delivered its first
      // payload (undefined = sync hook not mounted yet). Once it has, an empty
      // collection means a genuinely session-less account — show a real empty
      // state, not an eternal skeleton.
      if (sessionsFirstLoad !== false) {
        return [<SessionListSkeleton key="skeleton" />];
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
      return [(
        <RNView key="empty" style={styles.emptyInbox}>
          <FontAwesome name="inbox" size={32} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>Inbox zero</RNText>
          <RNText style={styles.emptySubtext}>All sessions stashed, killed, or idle</RNText>
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
    // Questions lead: a session that asked you something is your move before
    // anything else, pinned or not — same order as the web panel.
    sections.push(renderSection("Questions", filteredQuestions, Theme.violet, "questions"));
    // The header number is the section COUNT while no chip narrows the list
    // (a filter that removed nothing leaves the full count in force).
    const countOf = (shown: InboxSession[], full: InboxSession[], n: number) => (shown.length === full.length ? n : undefined);
    sections.push(renderSection("Pinned", filteredPinned, Theme.magenta, undefined, countOf(filteredPinned, pinned, placed.counts.pinned)));
    sections.push(renderSection("New", filteredNew, Theme.blue, undefined, countOf(filteredNew, newSessions, placed.counts.newSessions)));
    // Top-down "who acts next": you (Needs Input, Done to review), the agent
    // (Working), a machine (Dormant) — same order as the web panel.
    sections.push(renderSection("Needs Input", statusNeedsInput, Theme.accent, undefined, countOf(statusNeedsInput, needsInput, placed.counts.needsInput)));
    sections.push(renderSection("Done", statusDone, Theme.cyan, undefined, countOf(statusDone, done, placed.counts.done)));
    sections.push(renderSection("Working", statusWorking, Theme.greenBright, undefined, countOf(statusWorking, working, placed.counts.working)));
    sections.push(renderSection("Dormant", statusDormant, Theme.blue, undefined, countOf(statusDormant, dormant, placed.counts.dormant)));
    return sections.filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionsSig gates the sessions map; manualOrderKey gates the getState() manual-order read
  }, [activeSessions, sessionsSig, sessionsFirstLoad, filteredQuestions, filteredPinned, statusWorking, statusNeedsInput, statusDone, statusDormant, filteredNew, renderSection, viewMode, sortedAll, subsByParent, showSubagents, manualOrderKey, currentSessionId, chipMatches, buckets, bucketByConv, placed.counts, pinned, newSessions, needsInput, done, dormant, working]);

  // Stashed (agent alive, kill-all) and Killed buckets — the web panel's two
  // hidden sections, collapsed by default behind count toggles.
  const ListFooter = useMemo(() => (
    <RNView>
      <TriggerDock
        rows={schedulePartition.rows}
        unreadCount={schedulePartition.unreadCount}
        nextRunAt={schedulePartition.nextRunAt}
      />
      <RNView style={styles.hiddenToggleRow}>
        <TouchableOpacity
          style={styles.hiddenToggle}
          onPress={() => setShowStashed(prev => !prev)}
          activeOpacity={0.7}
        >
          <FontAwesome name={showStashed ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
          <RNText style={styles.dismissedToggleText}>Stashed ({filteredStashed.length})</RNText>
        </TouchableOpacity>
        {showStashed && filteredStashed.length > 0 && (
          <TouchableOpacity
            onPress={() => confirmKillAllStashed(filteredStashed.map(s => s._id))}
            style={styles.killAllBtn}
            activeOpacity={0.7}
          >
            <RNText style={styles.killAllText}>Kill all</RNText>
          </TouchableOpacity>
        )}
      </RNView>
      {showStashed && (
        <RNView style={styles.dismissedSection}>
          {filteredStashed.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>No stashed sessions</RNText>
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

      <TouchableOpacity
        style={styles.hiddenToggle}
        onPress={() => setShowKilled(prev => !prev)}
        activeOpacity={0.7}
      >
        <FontAwesome name={showKilled ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
        <RNText style={styles.dismissedToggleText}>Killed ({filteredKilled.length})</RNText>
      </TouchableOpacity>
      {showKilled && (
        <RNView style={styles.dismissedSection}>
          {filteredKilled.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>No killed sessions</RNText>
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
  ), [schedulePartition, showStashed, showKilled, filteredStashed, filteredKilled, router, handleRestore, confirmKill, confirmKillAllStashed]);

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
  const currentViewOption = viewModeOptions.find((o) => o.key === viewMode) ?? viewModeOptions[0];

  const openViewModePicker = useCallback(() => {
    if (Platform.OS === 'ios') {
      const options = [...viewModeOptions.map((o) => (o.key === viewMode ? `✓ ${o.label}` : o.label)), 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title: 'Sort inbox' },
        (index) => {
          if (index < viewModeOptions.length) setInboxViewMode(viewModeOptions[index].key);
        },
      );
    } else {
      Alert.alert('Sort inbox', undefined, [
        ...viewModeOptions.map((o) => ({ text: o.key === viewMode ? `✓ ${o.label}` : o.label, onPress: () => setInboxViewMode(o.key) })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }, [viewModeOptions, viewMode, setInboxViewMode]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <RNText style={styles.headerTitle}>Inbox</RNText>
        {activeSessions.length > 0 && !isSearching && (
          <RNView style={styles.countBadge}>
            <RNText style={styles.countBadgeText}>{activeSessions.length}</RNText>
          </RNView>
        )}
        <RNView style={{ flex: 1 }} />
        {/* The recorder lives here rather than on a tab of its own: the bar
            already carries five and a sixth squeezes every label (the same
            reason chat sits inside Team). The inbox is the landing screen, so
            this is still one tap from opening the app. The route is cast for
            the same reason the chat pushes are: expo's typed-route union only
            regenerates when Metro runs, so a new route is unknown to tsc. */}
        {!isSearching && (
          <TouchableOpacity
            style={styles.recordBtn}
            onPress={() => router.push({ pathname: '/record' } as never)}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Record a meeting"
          >
            <FontAwesome name="microphone" size={15} color={Theme.textMuted} />
          </TouchableOpacity>
        )}
        {!isSearching && (
          <TouchableOpacity style={styles.viewModeBtn} onPress={openViewModePicker} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <FontAwesome name={currentViewOption.icon} size={11} color={Theme.textMuted} />
            <RNText style={styles.viewModeBtnText}>{currentViewOption.label}</RNText>
            <FontAwesome name="angle-down" size={11} color={Theme.textMuted0} />
          </TouchableOpacity>
        )}
      </RNView>

      <RNView style={styles.searchContainer}>
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
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}>
              <FontAwesome name="times-circle" size={16} color={Theme.textMuted0} />
            </TouchableOpacity>
          )}
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

      {!isSearching && (labelChips.length > 0 || projectCounts.length > 1) && (
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
            {projectCounts.map(([name, count]) => {
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
            query={debouncedQuery}
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
          showsVerticalScrollIndicator={false}
        >
          {listData}
          {ListFooter}
        </ScrollView>
      )}

      <NewSessionModal
        visible={showNewSession}
        onClose={() => setShowNewSession(false)}
        onSessionCreated={(conversationId) => {
          // focus=1: a just-created session opens ready to type (composer focused).
          router.push(`/session/${conversationId}?focus=1`);
        }}
      />

      <RNView style={styles.fabContainer} pointerEvents="box-none">
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setShowNewSession(true)}
          activeOpacity={0.8}
        >
          <FontAwesome name="plus" size={18} color="#fff" />
        </TouchableOpacity>
      </RNView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
    fontSize: 20,
    fontWeight: '700',
    color: Theme.text,
  },
  countBadge: {
    backgroundColor: Theme.accent,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  countBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: Theme.bg,
  },
  recordBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 4,
  },
  viewModeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
  },
  viewModeBtnText: {
    fontSize: 12,
    fontWeight: '500',
    color: Theme.textMuted,
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
  listContent: {
    paddingBottom: Spacing.xl,
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
  killAllBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginRight: Spacing.lg,
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
});
