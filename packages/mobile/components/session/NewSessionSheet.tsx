// The new session sheet, one per app (ComposeHost mounts it at the root, and
// lib/compose opens it from any screen). It is prompt first for every agent:
// the box is the session screen's own composer (MessageComposer), so the first
// message can carry images as a reply can, and send starts the session with it.
// The sheet opens with the keyboard down so every choice is in view; agent,
// machine, folder, model and the rest are pre-filled and only need a tap when
// the default is wrong.
import { StyleSheet, TouchableOpacity, View as RNView, Modal, Alert, ScrollView, KeyboardAvoidingView, Platform, ActionSheetIOS } from 'react-native';
import { TextInput, Text as RNText } from '@/components/Themed';
import { Component, useState, useRef, useMemo, type ReactNode } from 'react';
import { router as appRouter, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Ionicons } from '@expo/vector-icons';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore, type BucketItem, sortLabels } from '@codecast/web/store/inboxStore';
import {
  AGENT_MODEL_CONFIG, AGENT_PICKER_OPTIONS, compareMachineChips, featuredModelOptions, fromConvexAgentType, isHostedAgentType, launchRailOptions, toConvexAgentType,
  type AgentClientId, type DeviceModelInventory,
} from '@codecast/shared/contracts';
import { defaultMachineId, listedMachines } from '@codecast/web/lib/machinePicker';
import { ModelEffortSheet } from '@/components/ModelEffortSheet';
import { OptionSheet } from '@/components/OptionSheet';
import { SettingsSwitch } from '@/components/settings/SettingsUI';
import { useAgentsByUse, useDefaultAgentType, useOnlyHostedAgent, usePinnedPickerOptions } from '@codecast/web/hooks/usePinnedAgents';
import { useHostedMode, useSurface } from '@codecast/web/lib/surfaces';
import { startHostedConversation } from '@codecast/web/lib/startHostedConversation';
import { AssistantStart } from '@/components/hosted/AssistantStart';
import { RecentScreenshots } from '@/components/session/RecentScreenshots';
import { checkoutMatches, displayPath, expandHome, newFolderPath } from '@/lib/folderSearch';
import { MessageComposer, dispatchComposerSend, useComposerImages, IMAGE_ONLY_CONTENT } from '@/components/session/MessageComposer';
import { useComposerField, nativeComposerText } from '@/lib/composerField';
import { GestureHandlerRootView } from '@/lib/gestureHandler';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { Serif } from '@/constants/fonts';
import { useScopedRecentProjects } from '@codecast/web/hooks/useScopedRecentProjects';
import { labelHexColor } from '@/lib/labelColors';
import { type Device, deviceDisplayName } from '@/components/DevicesSection';
import { AgentGlyph } from '@/components/AgentLogo';
import { mobileCreateErrorMessage, mobileCreateFailureDisposition } from '@/lib/durableCreatePolicy';
import { awaitSessionLanding, closeCompose, useCompose } from '@/lib/compose';

// A sheet that throws closes itself rather than taking the app down with it
// (it sits at the root); the next opening mounts a fresh one.
class SheetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    console.warn('[compose] new session sheet failed', error);
    closeCompose();
  }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Mounted once at the root: the sheet, and where a started session opens.
 *  The session is pushed without a transition while the sheet slides away,
 *  so it is already in place when the sheet clears it. Each opening starts
 *  from the defaults. */
export function ComposeHost() {
  const open = useCompose((s) => s.open);
  const seed = useCompose((s) => s.seed);
  const opens = useCompose((s) => s.opens);
  const router = useRouter();
  return (
    <SheetBoundary key={opens}>
      <NewSessionSheet
        visible={open}
        seed={seed}
        onClose={closeCompose}
        onSessionCreated={(conversationId, focus) => {
          // reveal=1: no push animation (app/_layout). focus=1: an empty start
          // opens ready to type.
          awaitSessionLanding();
          router.push(`/session/${conversationId}?reveal=1${focus ? '&focus=1' : ''}` as never);
        }}
      />
    </SheetBoundary>
  );
}

// Per-client accents, matching web's agentAccent chip colors (lib/agentColors) where it
// has one. Tints the selected pill's border/background/label; the logo
// itself is the shared AgentGlyph (web AgentTypeIcon marks and colors).
const agentAccents: Record<AgentClientId, string> = {
  claude: Theme.yellow,
  codex: Theme.green,
  cursor: Theme.violet,
  gemini: Theme.blue,
  opencode: Theme.orange,
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

// One launch choice in the sheet's settings card: label left, the current
// value right, tapping opens its picker.
function SettingRow({ label, value, dot, onPress }: {
  label: string;
  value: string;
  dot?: string;
  onPress: () => void;
}) {
  const Theme = useTheme();
  return (
    <TouchableOpacity style={modalStyles.settingRow} onPress={onPress} activeOpacity={0.6}>
      <RNText style={modalStyles.settingLabel}>{label}</RNText>
      <RNView style={modalStyles.settingValueWrap}>
        {dot ? <RNView style={[modalStyles.machineDot, { backgroundColor: dot }]} /> : null}
        <RNText style={modalStyles.settingValue} numberOfLines={1}>{value}</RNText>
      </RNView>
      <FontAwesome name="angle-right" size={16} color={Theme.textMuted0} />
    </TouchableOpacity>
  );
}

function NewSessionSheet({ visible, seed, onClose, onSessionCreated }: { visible: boolean; seed?: string | null; onClose: () => void; onSessionCreated: (conversationId: string, focus: boolean) => void }) {
  const Theme = useTheme();
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
  const pickerOptions = useMemo(
    () => (pinnedOptions.some((o) => o.hosted) ? pinnedOptions : [...pinnedOptions, ...AGENT_PICKER_OPTIONS.filter((o) => o.hosted)]),
    [pinnedOptions],
  );
  // One row, the agents the viewer runs most first, so the usual pick is in
  // view without scrolling.
  const agentOptions = useAgentsByUse(pickerOptions, visible);
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
  // Every pre-filled choice is one row that opens its own picker sheet, so the
  // common launch (agent + go) fits on one screen.
  const [openSheet, setOpenSheet] = useState<"machine" | "context" | null>(null);
  // The folder search: filters the chip row as it is typed, and a path that
  // names no listed folder is offered as a chip of its own.
  const [folderQuery, setFolderQuery] = useState("");
  // The search is an icon at the head of the chip row until tapped.
  const [folderSearching, setFolderSearching] = useState(false);
  const folderRowRef = useRef<ScrollView>(null);
  const agentRowRef = useRef<ScrollView>(null);
  // The first message. The sheet remounts on every opening (ComposeHost), so
  // the seed is the box's starting text.
  const field = useComposerField(seed ?? '');
  const images = useComposerImages(field.setValue);
  // Machine picker. `deviceId` holds an EXPLICIT pick only: left null, routing
  // picks the machine (deviceRouting) and the folder list stays the union across
  // online devices — the behaviour before this row existed.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  // Store-fed (StoreSyncBridge mounts useSyncDevices), so the row paints at open.
  const rawDevices = useInboxStore((s) => s.machineRoster) as MachineDevice[];
  // listDevices is last_seen-sorted; chips hold still instead. Dead machines
  // stay out of the list (listedMachines) unless one is the explicit pick.
  const devices = useMemo(() => listedMachines(rawDevices, deviceId).sort(compareMachineChips), [rawDevices, deviceId]);
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

  // The session opens under the sheet, and the session screen closes the
  // sheet once it has drawn (lib/compose sessionLanded). `focus` asks the session's composer for the
  // keyboard: only an empty start wants it, a sent first message is there to
  // watch.
  const finishSessionCreate = (conversationId: string, focus: boolean) => {
    setSubmitError(null);
    setAgentId(null);
    setProjectPath("");
    setDeviceId(null);
    setModel("default");
    setEffort("default");
    setStableMode("auto");
    setIsolated(false);
    setBucketPick(undefined);
    setOpenSheet(null);
    setFolderQuery("");
    setFolderSearching(false);
    onSessionCreated(conversationId, focus);
  };

  // Instant start, the same shape as web's compose popup: seed the local stub,
  // fire the create, then open the stub and close the sheet in the same tick.
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
    finishSessionCreate(stubId, false);
  };

  // The words and images, when there are any, are the session's first
  // message: queued on the stub now and sent once the create has a real id
  // (sendMessageWhenReady), as a message typed into the stub's own composer
  // would be.
  const handleSubmit = () => {
    const text = nativeComposerText(field.inputRef.current as { _lastNativeText?: unknown } | null, field.value).trim();
    const firstImages = images.optimisticImages();
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
    const empty = !text && firstImages.length === 0;
    if (!empty) dispatchComposerSend(stubId, text || IMAGE_ONLY_CONTENT, firstImages);
    finishSessionCreate(stubId, empty);
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

  // The folder chips, web's ProjectSwitcher on a phone: the picked folder
  // first so it is always in view, then the recents. A query narrows them
  // (rows match on the ~-collapsed spelling too, and a name that starts with
  // the query ranks first), then adds the machine's checkouts no session ran
  // in yet; a typed path no chip names becomes an "open" chip, and a name
  // nothing matches exactly becomes a "create" chip (the daemon makes it).
  const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
  const query = folderQuery.trim().toLowerCase();
  const machineRoots = useMemo(
    () => devices.find((d) => d.device_id === selectedDeviceId)?.local_project_roots ?? [],
    [devices, selectedDeviceId],
  );
  const folderChips = useMemo(() => {
    type Chip = { path: string; label: string; custom?: boolean; dim?: boolean };
    const typedPath = folderQuery.trim();
    if (query) {
      const recentPaths = recentProjects.map((p) => p.path);
      const chips: Chip[] = recentProjects
        .filter((p) => p.path.toLowerCase().includes(query) || displayPath(p.path).toLowerCase().includes(query))
        .sort((x, y) => Number(!folderName(x.path).toLowerCase().startsWith(query)) - Number(!folderName(y.path).toLowerCase().startsWith(query)))
        .map((p) => ({ path: p.path, label: folderName(p.path), dim: p.suggested }));
      for (const root of checkoutMatches(machineRoots, query, new Set(recentPaths))) chips.push({ path: root, label: folderName(root) });
      if (/^[~/]/.test(typedPath)) {
        const full = expandHome(typedPath, [...machineRoots, ...recentPaths]);
        if (!chips.some((c) => c.path === full)) chips.unshift({ path: full, label: `open ${displayPath(full)}`, custom: true });
      } else if (!chips.some((c) => folderName(c.path).toLowerCase() === query)) {
        const created = newFolderPath(typedPath, machineRoots, recentPaths);
        if (created) chips.push({ path: created, label: `create ${displayPath(created)}`, custom: true });
      }
      return chips;
    }
    const current = projectPath.trim();
    const rest: Chip[] = recentProjects
      .filter((p) => p.path !== current)
      .map((p) => ({ path: p.path, label: folderName(p.path), dim: p.suggested }));
    return current ? [{ path: current, label: folderName(current) }, ...rest] : rest;
  }, [recentProjects, machineRoots, query, folderQuery, projectPath]);
  const pickFolder = (path: string) => {
    setProjectPath(path);
    setFolderQuery("");
    setFolderSearching(false);
    setSubmitError(null);
    folderRowRef.current?.scrollTo({ x: 0, animated: false });
  };

  const stableModeItem = STABLE_MODES.find((m) => m.key === stableMode) ?? STABLE_MODES[0];

  const agentChipsEl = (
    <ScrollView
      ref={agentRowRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[modalStyles.chipScroller, modalStyles.agentRow]}
      contentContainerStyle={modalStyles.chipRow}
      keyboardShouldPersistTaps="handled"
    >
      {agentOptions.map((a) => {
        const active = agentId === a.id;
        const accent = agentAccents[a.id];
        return (
          <TouchableOpacity
            key={a.id}
            // A less used pick can sit past the edge: its first layout
            // scrolls the row to it.
            onLayout={(e) => { if (active) agentRowRef.current?.scrollTo({ x: Math.max(0, e.nativeEvent.layout.x - Spacing.lg), animated: false }); }}
            style={[modalStyles.agentChip, active && { borderColor: accent + "90", backgroundColor: accent + "1c" }]}
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
            <AgentGlyph agentType={a.id} size={16} />
            <RNText style={[modalStyles.agentChipText, active && { color: accent, fontWeight: "700" }]} numberOfLines={1}>
              {a.label}
            </RNText>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {/* An Android Modal renders outside the app's root view, so the
          composer's gesture-handler send button needs a root of its own. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardAvoidingView style={modalStyles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {/* The sheet closes by swiping down; only the hosted sheet carries a
            title, because its question is the prompt. */}
        {hostedSheet ? (
          <RNView style={modalStyles.header}>
            <RNText style={[modalStyles.title, modalStyles.hostedSheetTitle]}>{LANE_COPY.intro.sheetTitle}</RNText>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={24} color={Theme.textMuted} />
            </TouchableOpacity>
          </RNView>
        ) : <RNView style={modalStyles.grabber} />}

        <ScrollView style={modalStyles.body} contentContainerStyle={modalStyles.bodyContent} keyboardShouldPersistTaps="handled">
          {/* The hosted assistant needs no machine, folder, model or context:
              its sheet is the first ask. */}
          {hosted ? (
            <RNView style={{ marginTop: onlyHosted ? Spacing.sm : Spacing.lg }}>
              {onlyHosted ? null : agentChipsEl}
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
          <RNView style={modalStyles.prompt}>
            {/* Starting an agent session needs no words, so send is always live. */}
            <MessageComposer
              field={field}
              images={images}
              placeholder={`Ask ${agentOptions.find((a) => a.id === agentId)?.label ?? 'the agent'}`}
              canSend
              onSend={handleSubmit}
              cardStyle={modalStyles.promptCard}
              inputStyle={modalStyles.promptInput}
            />
            <RecentScreenshots
              attachedUris={images.selectedImages.map((img) => img.uri)}
              onAttach={(shot) => images.attachImages([shot])}
            />
          </RNView>
          {/* The viewer's pinned agents (users.pinned_agents, registry order)
              with the hosted assistant among them, wrapped so every one is in
              view. It stays when the assistant is picked, so the pick can be
              undone. */}
          {onlyHosted ? null : agentChipsEl}
          {folderSearching ? (
            <RNView style={modalStyles.folderSearch}>
              <FontAwesome name="search" size={13} color={Theme.textMuted0} />
              <TextInput
                style={modalStyles.folderInput}
                value={folderQuery}
                onChangeText={setFolderQuery}
                placeholder="Search folders or paste a path"
                placeholderTextColor={Theme.textMuted0}
                autoFocus
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={() => { if (folderChips[0]) pickFolder(folderChips[0].path); }}
              />
              <TouchableOpacity
                onPress={() => { setFolderQuery(""); setFolderSearching(false); }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityLabel="Close folder search"
              >
                <FontAwesome name="times-circle" size={15} color={Theme.textMuted0} />
              </TouchableOpacity>
            </RNView>
          ) : null}
          {folderChips.length > 0 || !folderSearching ? (
            <ScrollView
              ref={folderRowRef}
              horizontal
              style={modalStyles.chipScroller}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={modalStyles.chipRow}
              keyboardShouldPersistTaps="handled"
            >
              {folderSearching ? null : (
                <TouchableOpacity
                  style={modalStyles.folderChip}
                  onPress={() => setFolderSearching(true)}
                  activeOpacity={0.7}
                  accessibilityLabel="Search folders or paste a path"
                >
                  <FontAwesome name="search" size={12} color={Theme.textMuted0} />
                </TouchableOpacity>
              )}
              {folderChips.map((c) => {
                const active = !c.custom && c.path === projectPath;
                return (
                  <TouchableOpacity
                    key={c.path}
                    style={[
                      modalStyles.folderChip,
                      c.custom && modalStyles.folderChipCustom,
                      c.dim && !active && modalStyles.dim,
                      active && modalStyles.folderChipActive,
                    ]}
                    onPress={() => pickFolder(c.path)}
                    activeOpacity={0.7}
                  >
                    <FontAwesome name={c.custom ? "folder-open-o" : "folder-o"} size={12} color={active || c.custom ? Theme.cyan : Theme.textMuted0} />
                    <RNText style={[modalStyles.folderChipText, (active || c.custom) && { color: Theme.cyan }, active && { fontWeight: "700" }]} numberOfLines={1}>
                      {c.label}
                    </RNText>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : (
            <RNText style={modalStyles.hintText}>
              {query ? `No folders match "${folderQuery.trim()}"` : "No recent folders. Paste a path to start in one."}
            </RNText>
          )}

          {/* The rest folds into one card: a row per choice, each opening its
              own picker. The machine row shows even with one machine, so where
              the session runs is always in view. */}
          <RNView style={modalStyles.card}>
            {devices.length > 0 && (
              <SettingRow
                label="Machine"
                value={selectedDevice ? deviceDisplayName(selectedDevice) : "Auto"}
                dot={selectedDevice ? (selectedDevice.online ? Theme.green : Theme.textMuted0) : undefined}
                onPress={() => setOpenSheet("machine")}
              />
            )}
            {rail && (
              <SettingRow
                label="Model"
                value={effort === "default" ? modelLabel : `${modelLabel} · ${effort}`}
                onPress={() => setModelSheetVisible(true)}
              />
            )}
            <SettingRow label="Context" value={stableModeItem.label} onPress={() => setOpenSheet("context")} />
            <RNView style={[modalStyles.settingRow, modalStyles.settingRowLast]}>
              <RNText style={modalStyles.settingLabel}>Isolated worktree</RNText>
              <RNView style={modalStyles.switchSlot}>
                <SettingsSwitch value={isolated} onValueChange={setIsolated} />
              </RNView>
            </RNView>
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
        <OptionSheet
          visible={openSheet === "machine"}
          onClose={() => setOpenSheet(null)}
          title="Machine"
          options={devices.map((d) => ({
            key: d.device_id,
            label: deviceDisplayName(d),
            hint: d.online ? undefined : "Offline",
            dim: !d.online,
            leading: <RNView style={[modalStyles.machineDot, { backgroundColor: d.online ? Theme.green : Theme.textMuted0 }]} />,
          }))}
          selectedKey={selectedDeviceId ?? null}
          onSelect={(id) => {
            // Scoping the folder list to another machine can drop the current
            // path (it may have no such checkout), so clear it and let the
            // field fall back to the new list's top folder.
            setDeviceId(id === defaultDeviceId ? null : id);
            setProjectPath(null);
            setSubmitError(null);
          }}
        />
        <OptionSheet
          visible={openSheet === "context"}
          onClose={() => setOpenSheet(null)}
          title="Context"
          options={STABLE_MODES.map((m) => ({ key: m.key, label: m.label, hint: m.title }))}
          selectedKey={stableMode}
          onSelect={(k) => setStableMode(k as StableModePick)}
        />
      </KeyboardAvoidingView>
      </GestureHandlerRootView>
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
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, marginTop: 8, marginBottom: Spacing.sm, backgroundColor: Theme.borderLight },
  // The hosted sheet's question, in the reading face.
  hostedSheetTitle: { fontFamily: Serif.regular, fontSize: 22, fontWeight: "500" },
  body: { flex: 1, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  bodyContent: { paddingBottom: Spacing.lg },
  prompt: { marginTop: Spacing.sm, marginBottom: Spacing.md },
  promptCard: { marginLeft: 0, marginRight: 0, marginTop: 0 },
  promptInput: { minHeight: 72 },
  agentRow: { marginBottom: Spacing.md },
  // Chip rows scroll edge to edge, past the sheet's side padding.
  chipScroller: { marginHorizontal: -Spacing.lg, flexGrow: 0 },
  chipRow: { flexDirection: "row", gap: 8, paddingHorizontal: Spacing.lg },
  folderSearch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  folderInput: { flex: 1, fontSize: 14, paddingVertical: 10, color: Theme.text },
  folderChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    maxWidth: 220,
  },
  folderChipActive: { borderColor: Theme.cyan + "99", backgroundColor: Theme.cyan + "18" },
  folderChipCustom: { borderStyle: "dashed", borderColor: Theme.cyan + "66" },
  folderChipText: { fontSize: 13, color: Theme.textMuted, fontWeight: "500", flexShrink: 1 },
  dim: { opacity: 0.55 },
  hintText: { fontSize: 12, color: Theme.textMuted0, lineHeight: 16 },
  agentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt + "55",
  },
  agentChipText: { fontSize: 13, fontWeight: "500", color: Theme.textMuted },
  // The launch choices as one grouped card, iOS-settings style.
  card: {
    marginTop: Spacing.lg,
    borderRadius: 12,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    overflow: "hidden",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    paddingHorizontal: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  settingRowLast: { borderBottomWidth: 0, justifyContent: "space-between" },
  switchSlot: { height: 48, justifyContent: "center" },
  settingLabel: { fontSize: 14, color: Theme.textMuted, fontWeight: "500" },
  settingValueWrap: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6, minWidth: 0 },
  settingValue: { fontSize: 14, color: Theme.text, fontWeight: "600", flexShrink: 1 },
  machineDot: { width: 7, height: 7, borderRadius: 4 },
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
}));