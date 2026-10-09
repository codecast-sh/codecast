import {
  useState,
  useCallback,
  useMemo,
  useRef } from "react";
import {
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  View as RNView,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Text as RNText, TextInput } from '@/components/Themed';
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing, themedStyles, useTheme } from "@/constants/Theme";
import { Serif, pageCountLook, pageTitleFace } from "@/constants/fonts";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useInboxStore, type TaskItem, type PlanItem, type DocItem } from "@codecast/web/store/inboxStore";
import { createTaskAndAdopt } from "@codecast/web/lib/taskActions";
import { buildTaskTree, isAssistantTask, isOnHumanBoard, taskFamilyIndex } from "@codecast/shared/tasks";
import { isOnHumanShelf, isOnNotesShelf } from "@codecast/shared/docs";
import { isAssistantDoc } from "@codecast/web/lib/assistantScope";
import { filterToWorkspace } from "@codecast/web/lib/workspaceScope";
import { useFeedLoading } from "@/hooks/useSyncWorkspaceData";
import { useActiveTeam, useSwitchActiveTeam } from "@/hooks/useWorkspaceArgs";
import { useOrgRoles } from "@codecast/web/hooks/useOrgRoles";
import { resolveAssigneeInfo } from "@codecast/web/lib/liveEntities";
import { sameAssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import { TaskItemRow, STATUS_CONFIG, PRIORITY_CONFIG, PRIORITY_ORDER, showTaskActions } from "@/components/TaskItem";
import { PlanItemRow, PLAN_STATUS_CONFIG, PLAN_STATUS_ORDER } from "@/components/PlanItem";
import { DocItemRow, DOC_TYPE_CONFIG, DOC_TYPES } from "@/components/DocItem";
import { showActionSheet } from "@/lib/actionSheet";
import { modePageLabel, useAssistantConversationIds, useAssistantScope, useHostedMode, useModeWords, useSurfaceMode } from "@codecast/web/lib/surfaces";
import { RoutineList } from "@/components/hosted/Routines";
import { sentenceCase } from "@codecast/web/lib/sessionCard";

const ICON_EMOJI: Record<string, string> = {
  rocket: "🚀", flame: "🔥", zap: "⚡", star: "⭐", diamond: "💎", crown: "👑",
  shield: "🛡️", sword: "⚔️", anchor: "⚓", compass: "🧭", mountain: "⛰️", tree: "🌲",
  sun: "☀️", moon: "🌙", cloud: "☁️", bolt: "🔩", atom: "⚛️", dna: "🧬",
};

type Segment = "tasks" | "plans" | "docs" | "routines";
/** Each segment is the phone's view of a web page, so the surface registry's
 *  page rule (lib/surfaceRules PAGE_SURFACES) decides which ones a mode shows:
 *  hosted mode has no Plans, as the web has no /plans there. */
const SEGMENT_PAGES: Record<Segment, string> = { tasks: "/tasks", plans: "/plans", docs: "/docs", routines: "/triggers" };
const SEGMENTS = Object.keys(SEGMENT_PAGES) as Segment[];
/** What an empty hosted To-dos list offers: both ways a to-do arrives. */
const HOSTED_TODOS_HINT = "Ask the assistant to add one, or tap +.";
type SourceFilter = "" | "human" | "bot";
type TaskStatus = "backlog" | "open" | "in_progress" | "in_review" | "done" | "dropped";
type GroupBy = "status" | "assignee" | "priority" | "plan";
type SortBy = "priority" | "updated" | "created";

const ACTIVE_STATUSES: TaskStatus[] = ["open", "in_progress", "in_review"];
const TERMINAL_STATUSES: TaskStatus[] = ["done", "dropped"];

const GROUP_BY_OPTIONS: { key: GroupBy; label: string; icon: React.ComponentProps<typeof FontAwesome>["name"] }[] = [
  { key: "status", label: "Status", icon: "circle-o" },
  { key: "assignee", label: "Assignee", icon: "user" },
  { key: "priority", label: "Priority", icon: "arrow-up" },
  { key: "plan", label: "Plan", icon: "map-o" },
];

const SOURCE_OPTIONS: { key: SourceFilter; label: string }[] = [
  { key: "", label: "Everything" },
  { key: "human", label: "Human" },
  { key: "bot", label: "Bot" },
];

const FILTER_STATUSES: TaskStatus[] = ["open", "in_progress", "in_review", "backlog", "done", "dropped"];
const FILTER_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

const SORT_OPTIONS: { key: SortBy; label: string }[] = [
  { key: "priority", label: "Priority" },
  { key: "updated", label: "Recently Updated" },
  { key: "created", label: "Recently Created" },
];

function CreateTaskModal({
  visible,
  onClose,
  onCreate,
}: {
  visible: boolean;
  onClose: () => void;
  onCreate: (title: string, priority: string, description?: string) => void;
}) {
  const Theme = useTheme();
  // Hosted mode's new to-do is the web's quick add made a sheet: what to do
  // and any notes, under the compose sheet's own header (the reading face,
  // a thin close). Priority stays a later change from the row.
  const hosted = useHostedMode();
  const words = useModeWords();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");

  const handleSubmit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onCreate(trimmed, priority, description.trim() || undefined);
    setTitle("");
    setDescription("");
    setPriority("medium");
    onClose();
  };

  const priorities = (["urgent", "high", "medium", "low"] as const).map((key) => ({
    key,
    label: PRIORITY_CONFIG[key].label,
    color: PRIORITY_CONFIG[key].color,
  }));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={modalStyles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <RNView style={modalStyles.header}>
          <RNText style={[modalStyles.title, hosted && modalStyles.hostedTitle]}>{hosted ? words.newTask : "New Task"}</RNText>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel="Close">
            {hosted
              ? <Ionicons name="close" size={24} color={Theme.textMuted} />
              : <FontAwesome name="times" size={20} color={Theme.textMuted} />}
          </TouchableOpacity>
        </RNView>

        <ScrollView style={modalStyles.body} keyboardShouldPersistTaps="handled">
          {hosted ? null : <RNText style={modalStyles.label}>Title</RNText>}
          <TextInput
            style={modalStyles.input}
            value={title}
            onChangeText={setTitle}
            placeholder={hosted ? "What needs doing?" : "What needs to be done?"}
            placeholderTextColor={Theme.textMuted0}
            autoFocus
            autoCorrect={false}
            returnKeyType="next"
          />

          <RNText style={[modalStyles.label, hosted && { marginTop: 14 }]}>{hosted ? "Notes" : "Description"}</RNText>
          <TextInput
            style={[modalStyles.input, { minHeight: 80, textAlignVertical: "top" }]}
            value={description}
            onChangeText={setDescription}
            placeholder={hosted ? "Anything to remember (optional)" : "Add details..."}
            placeholderTextColor={Theme.textMuted0}
            multiline
            autoCorrect={false}
          />

          {hosted ? null : <RNText style={modalStyles.label}>Priority</RNText>}
          {hosted ? null : <RNView style={modalStyles.priorityRow}>
            {priorities.map((p) => (
              <TouchableOpacity
                key={p.key}
                style={[
                  modalStyles.priorityBtn,
                  priority === p.key && { borderColor: p.color, backgroundColor: p.color + "18" },
                ]}
                onPress={() => setPriority(p.key)}
                activeOpacity={0.7}
              >
                <RNText
                  style={[
                    modalStyles.priorityBtnText,
                    priority === p.key && { color: p.color },
                  ]}
                >
                  {p.label}
                </RNText>
              </TouchableOpacity>
            ))}
          </RNView>}
        </ScrollView>

        <RNView style={modalStyles.footer}>
          {/* The header's close already cancels in hosted mode. */}
          {hosted ? null : (
            <TouchableOpacity style={modalStyles.cancelBtn} onPress={onClose} activeOpacity={0.7}>
              <RNText style={modalStyles.cancelBtnText}>Cancel</RNText>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[modalStyles.submitBtn, !title.trim() && { opacity: 0.4 }]}
            onPress={handleSubmit}
            disabled={!title.trim()}
            activeOpacity={0.7}
          >
            <RNText style={modalStyles.submitBtnText}>{hosted ? "Add" : "Create"}</RNText>
          </TouchableOpacity>
        </RNView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function TasksScreen() {
  const Theme = useTheme();
  // A link can name the segment (`?segment=routines`, lib/linkRoutes): it sets
  // the starting segment, and again when a new link arrives while the tab is
  // mounted. Tapping a segment afterwards is the person's own choice, and
  // drops the link's name from the address so the same link works again.
  const linked = useLocalSearchParams<{ segment?: string }>().segment;
  const mode = useSurfaceMode();
  const segments = useMemo(() => SEGMENTS.filter((s) => mode.showsPage(SEGMENT_PAGES[s])), [mode]);
  const linkedSegment = segments.find((s) => s === linked) ?? null;
  const [chosen, setSegment] = useState<Segment>(linkedSegment ?? "tasks");
  // A segment the mode hides (a switch to assistant mode while on Plans)
  // falls back to Tasks rather than showing a page the mode has no door to.
  const segment = segments.includes(chosen) ? chosen : "tasks";
  const [appliedLink, setAppliedLink] = useState(linkedSegment);
  if (linkedSegment !== appliedLink) {
    setAppliedLink(linkedSegment);
    if (linkedSegment) setSegment(linkedSegment);
  }
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("");
  const [refreshing, setRefreshing] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [sortBy, setSortBy] = useState<SortBy>("priority");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  // Search folds behind its header icon; it stays open while it holds text.
  const [searchOpen, setSearchOpen] = useState(false);
  const router = useRouter();
  // Routines are the triggers, named by mode (lib/surfaces MODE_WORDS).
  const words = useModeWords();
  // Each segment is named as the web names its page in this mode
  // (modePageLabel): To-dos and Notes in hosted mode.
  const hosted = useHostedMode();
  const segmentLabel = (s: Segment) =>
    s === "routines" ? words.triggers : modePageLabel(SEGMENT_PAGES[s], hosted) ?? (s === "tasks" ? "Tasks" : s === "plans" ? "Plans" : "Docs");

  const { teamId, activeTeam, validTeams } = useActiveTeam();
  const switchTeam = useSwitchActiveTeam();

  const showWorkspacePicker = useCallback(() => {
    showActionSheet("Switch Workspace", [
      { label: "Personal", selected: !teamId, onPress: () => switchTeam(null) },
      ...validTeams.map((t) => ({
        label: `${ICON_EMOJI[t.icon || ""] || ""} ${t.name}`.trim(),
        selected: String(t._id) === String(teamId),
        onPress: () => switchTeam(t._id),
      })),
    ]);
  }, [validTeams, switchTeam, teamId]);

  // Fed app-wide (useSyncWorkspaceData); this tab only reads the store.
  const tasksReady = !useFeedLoading("tasks");
  const plansReady = !useFeedLoading("plans");
  const docsReady = !useFeedLoading("docs");

  const tasks = useInboxStore((s) => s.tasks);
  const plans = useInboxStore((s) => s.plans);
  const docs = useInboxStore((s) => s.docs);
  const updateTask = useInboxStore((s) => s.updateTask);

  // Strict workspace boundary at read time: the store caches rows from every
  // workspace (sync never prunes on team switch), so each list re-asserts the
  // active workspace — team view shows only that team's rows, personal shows
  // only teamless rows. Same rule as web (lib/workspaceScope).
  // A role can hold a task (org-roles-run-work.md R5). The server leaves a
  // role's `assignee_info` empty (reading a role row from the list query would
  // re-ship the list on every message its sessions sync), so the phone derives
  // it from the org tree the same way the web board does; without this a role
  // held task groups and filters as "Unassigned". The roles are fed app-wide
  // (useSyncWorkspaceData), so they are in the store before this tab opens.
  const { roles: orgRoles } = useOrgRoles();
  // The Assistant scope (lib/assistantScope), as the web's To-dos and Notes
  // read it: the person's own errands and notes, and what the assistant made
  // for them, not what coding work filed. Hosted Notes are the notes shelf.
  const { only: assistantOnly } = useAssistantScope();
  const assistantConversations = useAssistantConversationIds();
  const tasksList = useMemo(() => filterToWorkspace(Object.values(tasks), teamId)
    .filter((t) => !assistantOnly || isAssistantTask(t as any))
    .map((t) => {
      const info = resolveAssigneeInfo(t.assignee, t.assignee_info, null, null, orgRoles);
      return sameAssigneeInfo(info, t.assignee_info) ? t : ({ ...t, assignee_info: info } as TaskItem);
    }), [tasks, teamId, orgRoles, assistantOnly]);
  const plansList = useMemo(() => filterToWorkspace(Object.values(plans), teamId), [plans, teamId]);
  const docsList = useMemo(() => filterToWorkspace(Object.values(docs), teamId)
    .filter((d) => !assistantOnly || (isOnNotesShelf(d as any) && isAssistantDoc(d as any, assistantConversations))),
  [docs, teamId, assistantOnly, assistantConversations]);

  // "human" = the human's board (isOnHumanBoard, shared with web): human or
  // meeting origin, promoted (cast task create --human, triage accept), or
  // assigned to a person. "bot" = machine-created tasks that stay internal to
  // agent work. Plans have no promoted/assignee field or meeting source, so
  // for them this degrades to a plain source split.
  const onBoard = isOnHumanBoard;
  // Ephemeral bookkeeping (task-graph.md TG9) stays out of every view but "bot".
  const applySourceFilter = useCallback(<T extends { source?: string; promoted?: boolean; assignee?: string | null; ephemeral?: boolean | null }>(list: T[]): T[] => {
    if (sourceFilter === "human") return list.filter(onBoard);
    if (sourceFilter === "bot") return list.filter((i) => !onBoard(i));
    return list.filter((i) => !i.ephemeral);
  }, [sourceFilter]);
  // Docs have their own shared shelf rule (human origin or pinned), so the
  // split can't drift from the web docs list.
  const applyDocSourceFilter = useCallback(<T extends { source?: string; pinned?: boolean }>(list: T[]): T[] => {
    if (sourceFilter === "human") return list.filter(isOnHumanShelf);
    if (sourceFilter === "bot") return list.filter((d) => !isOnHumanShelf(d));
    return list;
  }, [sourceFilter]);

  const filteredTasks = useMemo(() => {
    let list = applySourceFilter(tasksList);
    if (statusFilter) list = list.filter((t) => t.status === statusFilter);
    if (priorityFilter) list = list.filter((t) => t.priority === priorityFilter);
    if (assigneeFilter) {
      if (assigneeFilter === "_unassigned") list = list.filter((t) => !t.assignee);
      else list = list.filter((t) => t.assignee === assigneeFilter || t.assignee_info?.name === assigneeFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.short_id.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.labels?.some((l) => l.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [tasksList, searchQuery, applySourceFilter, statusFilter, priorityFilter, assigneeFilter]);

  // Sort, then nest: buildTaskTree reorders so each subtask follows its parent
  // while the sort order holds within every level. Every group runs through
  // here, so this one call nests them all. Same helper as web — one rule for
  // what nests under what. It only reorders: a subtask whose parent was
  // filtered out is promoted to the top level, never dropped.
  const sortTasks = useCallback((list: TaskItem[]) => {
    const sorted = [...list].sort((a, b) => {
      if (sortBy === "priority") return (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3) || b.updated_at - a.updated_at;
      if (sortBy === "created") return b.created_at - a.created_at;
      return b.updated_at - a.updated_at;
    });
    return buildTaskTree(sorted).map((r) => r.task);
  }, [sortBy]);

  const groupedTasks = useMemo(() => {
    const groups: Record<string, TaskItem[]> = {};
    for (const t of filteredTasks) {
      let key: string;
      if (groupBy === "assignee") key = t.assignee_info?.name || "Unassigned";
      else if (groupBy === "priority") key = t.priority || "none";
      else if (groupBy === "plan") key = t.plan?.title || "No Plan";
      else key = t.status;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const key of Object.keys(groups)) {
      groups[key] = sortTasks(groups[key]);
    }
    return groups;
  }, [filteredTasks, groupBy, sortTasks]);

  // View-scope pass, one tree walk per group: indent per row (nesting stays
  // inside each group, so a parent under one header never adopts a child filed
  // under another) plus the on-screen descendant count from the same rows.
  const viewNesting = useMemo(() => {
    const byId = new Map<string, { indent: number; depth: number; visibleDescendants: number }>();
    for (const rows of Object.values(groupedTasks)) {
      for (const row of buildTaskTree(rows)) {
        byId.set(row.task._id, { indent: row.indent, depth: row.depth, visibleDescendants: row.descendantCount });
      }
    }
    return byId;
  }, [groupedTasks]);

  // Workspace-scope pass (same shared helper and predicate as web, so the two
  // surfaces can never disagree): TRUE deep subtask counts and direct-children
  // progress over the whole live set, not what survived this view's filters.
  const familyIndex = useMemo(() => taskFamilyIndex(tasksList), [tasksList]);

  const uniqueAssignees = useMemo(() => {
    const names = new Set<string>();
    for (const t of tasksList) {
      if (t.assignee_info?.name) names.add(t.assignee_info.name);
    }
    return Array.from(names).sort();
  }, [tasksList]);

  // Every filter and view option sits behind the one Filter button: a sheet
  // naming each setting with its current value, each opening its own picker.
  const pickGroupBy = useCallback(() => showActionSheet("Group By", GROUP_BY_OPTIONS.map((o) => ({
    label: o.label, selected: o.key === groupBy, onPress: () => setGroupBy(o.key),
  }))), [groupBy]);

  const pickSort = useCallback(() => showActionSheet("Sort By", SORT_OPTIONS.map((o) => ({
    label: o.label, selected: o.key === sortBy, onPress: () => setSortBy(o.key),
  }))), [sortBy]);

  const pickSource = useCallback(() => showActionSheet("Show", SOURCE_OPTIONS.map((o) => ({
    label: o.label, selected: o.key === sourceFilter, onPress: () => setSourceFilter(o.key),
  }))), [sourceFilter]);

  const pickStatus = useCallback(() => showActionSheet("Filter by Status", [
    { label: "All Statuses", selected: !statusFilter, onPress: () => setStatusFilter("") },
    ...FILTER_STATUSES.map((st) => ({ label: STATUS_CONFIG[st].label, selected: st === statusFilter, onPress: () => setStatusFilter(st) })),
  ]), [statusFilter]);

  const pickPriority = useCallback(() => showActionSheet("Filter by Priority", [
    { label: "All Priorities", selected: !priorityFilter, onPress: () => setPriorityFilter("") },
    ...FILTER_PRIORITIES.map((pr) => ({ label: PRIORITY_CONFIG[pr].label, selected: pr === priorityFilter, onPress: () => setPriorityFilter(pr) })),
  ]), [priorityFilter]);

  const pickAssignee = useCallback(() => showActionSheet("Filter by Assignee", [
    { label: "All Assignees", selected: !assigneeFilter, onPress: () => setAssigneeFilter("") },
    { label: "Unassigned", selected: assigneeFilter === "_unassigned", onPress: () => setAssigneeFilter("_unassigned") },
    ...uniqueAssignees.map((name) => ({ label: name, selected: name === assigneeFilter, onPress: () => setAssigneeFilter(name) })),
  ]), [assigneeFilter, uniqueAssignees]);

  // The active filters, one entry each: the chips under the header and the
  // count on the Filter button both read this list. Status, priority and
  // assignee only narrow the task list.
  const activeFilters = useMemo(() => {
    const list: { key: string; label: string; clear: () => void }[] = [];
    if (sourceFilter) list.push({ key: "source", label: sourceFilter === "human" ? "Human" : "Bot", clear: () => setSourceFilter("") });
    if (segment !== "tasks") return list;
    if (statusFilter) list.push({ key: "status", label: STATUS_CONFIG[statusFilter]?.label, clear: () => setStatusFilter("") });
    if (priorityFilter) list.push({ key: "priority", label: PRIORITY_CONFIG[priorityFilter as keyof typeof PRIORITY_CONFIG]?.label, clear: () => setPriorityFilter("") });
    if (assigneeFilter) list.push({ key: "assignee", label: assigneeFilter === "_unassigned" ? "Unassigned" : assigneeFilter, clear: () => setAssigneeFilter("") });
    return list;
  }, [segment, sourceFilter, statusFilter, priorityFilter, assigneeFilter]);

  const openFilterMenu = useCallback(() => {
    const valueOf = <T,>(opts: { key: T; label: string }[], key: T) => opts.find((o) => o.key === key)?.label ?? "";
    showActionSheet(segment === "tasks" ? "Filter & Sort" : "Filter", [
      { label: `Show: ${valueOf(SOURCE_OPTIONS, sourceFilter)}`, onPress: pickSource },
      ...(segment === "tasks" ? [
        { label: `Status: ${statusFilter ? STATUS_CONFIG[statusFilter].label : "All"}`, onPress: pickStatus },
        { label: `Priority: ${priorityFilter ? PRIORITY_CONFIG[priorityFilter as keyof typeof PRIORITY_CONFIG].label : "All"}`, onPress: pickPriority },
        { label: `Assignee: ${assigneeFilter ? (assigneeFilter === "_unassigned" ? "Unassigned" : assigneeFilter) : "All"}`, onPress: pickAssignee },
        { label: `Group by: ${valueOf(GROUP_BY_OPTIONS, groupBy)}`, onPress: pickGroupBy },
        { label: `Sort by: ${valueOf(SORT_OPTIONS, sortBy)}`, onPress: pickSort },
      ] : []),
      ...(activeFilters.length > 0 ? [{ label: "Clear filters", destructive: true, onPress: () => activeFilters.forEach((f) => f.clear()) }] : []),
    ]);
  }, [segment, sourceFilter, statusFilter, priorityFilter, assigneeFilter, groupBy, sortBy, activeFilters, pickSource, pickStatus, pickPriority, pickAssignee, pickGroupBy, pickSort]);

  const filteredPlans = useMemo(() => applySourceFilter(plansList), [plansList, applySourceFilter]);

  const groupedPlans = useMemo(() => {
    const groups: Record<string, PlanItem[]> = {};
    for (const p of filteredPlans) {
      if (!groups[p.status]) groups[p.status] = [];
      groups[p.status].push(p);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => b.updated_at - a.updated_at);
    }
    return groups;
  }, [filteredPlans]);

  const filteredDocs = useMemo(() => {
    let list = applyDocSourceFilter(docsList);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (d) =>
          d.title?.toLowerCase().includes(q) ||
          d.doc_type?.toLowerCase().includes(q) ||
          d.labels?.some((l: string) => l.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [docsList, searchQuery, applyDocSourceFilter]);

  const groupedDocs = useMemo(() => {
    const groups: Record<string, DocItem[]> = {};
    for (const d of filteredDocs) {
      const key = d.doc_type || "note";
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => b.updated_at - a.updated_at);
    }
    return groups;
  }, [filteredDocs]);

  const activeTaskCount = useMemo(
    () => filteredTasks.filter((t) => ACTIVE_STATUSES.includes(t.status as TaskStatus)).length,
    [filteredTasks],
  );

  const activePlanCount = useMemo(
    () => filteredPlans.filter((p) => p.status === "active" || p.status === "draft").length,
    [filteredPlans],
  );

  const docCount = useMemo(() => filteredDocs.length, [filteredDocs]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const handleCreateTask = useCallback(
    (title: string, priority: string, description?: string) => {
      // Stamp the active workspace so the task lives where it was created.
      // createTaskAndAdopt paints the row now and drops it again if the server
      // refuses, so a refusal can't leave a ghost row behind.
      void createTaskAndAdopt({
        title,
        priority,
        description,
        status: "open",
        ...(teamId ? { workspace: "team", team_id: teamId } : { workspace: "personal" }),
      });
    },
    [teamId],
  );

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((text: string) => {
    setSearchInput(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchQuery(text.trim()), 200);
  }, []);

  const renderTaskGroup = useCallback(
    (groupKey: string) => {
      const items = groupedTasks[groupKey];
      if (!items?.length) return null;
      let icon: React.ComponentProps<typeof FontAwesome>["name"] = "circle-o";
      let color = Theme.textMuted0;
      let label = groupKey;
      if (groupBy === "status") {
        const cfg = STATUS_CONFIG[groupKey as TaskStatus];
        if (cfg) { icon = cfg.icon; color = cfg.color; label = cfg.label; }
      } else if (groupBy === "priority") {
        const cfg = PRIORITY_CONFIG[groupKey as keyof typeof PRIORITY_CONFIG];
        if (cfg) { icon = cfg.icon; color = cfg.color; label = cfg.label; }
      } else if (groupBy === "assignee") {
        icon = groupKey === "Unassigned" ? "user-o" : "user";
        color = groupKey === "Unassigned" ? Theme.textMuted0 : Theme.accent;
        label = groupKey;
      } else if (groupBy === "plan") {
        icon = groupKey === "No Plan" ? "file-o" : "map-o";
        color = groupKey === "No Plan" ? Theme.textMuted0 : Theme.cyan;
        label = groupKey;
      }
      return (
        <RNView key={groupKey}>
          {hosted ? (
            // Hosted headings are the inbox's: sentence case in quiet ink
            // with the count beside them, no status icon or colour.
            <RNView style={styles.hostedSectionHeader}>
              <RNText style={styles.hostedSectionTitle}>{sentenceCase(label.toLowerCase())}</RNText>
              <RNText style={styles.hostedSectionCount}>{items.length}</RNText>
            </RNView>
          ) : (
          <RNView style={styles.sectionHeader}>
            <FontAwesome name={icon} size={11} color={color} />
            <RNText style={[styles.sectionTitle, { color }]}>
              {label} ({items.length})
            </RNText>
          </RNView>
          )}
          {items.map((t) => {
            const nest = viewNesting.get(t._id);
            const total = familyIndex.descendants.get(t._id) ?? 0;
            // Floated subtask: parent_id set but the tree kept it at depth 0
            // (parent filtered out), so name the parent.
            const parent = t.parent_id && (nest?.depth ?? 0) === 0
              ? (tasks[String(t.parent_id)] as TaskItem | undefined)
              : undefined;
            return (
              <TaskItemRow
                key={t._id}
                task={t}
                onPress={() => router.push(`/task/${t.short_id}` as any)}
                onLongPress={() => showTaskActions(t, updateTask)}
                indent={nest?.indent ?? 0}
                progress={familyIndex.progress.get(t._id)}
                hiddenDescendantCount={Math.max(0, total - (nest?.visibleDescendants ?? 0))}
                parentChip={parent ? { short_id: parent.short_id } : null}
              />
            );
          })}
        </RNView>
      );
    },
    [groupedTasks, groupBy, router, updateTask, viewNesting, familyIndex, tasks, hosted],
  );

  const taskGroupOrder = useMemo(() => {
    if (groupBy === "status") return [...ACTIVE_STATUSES, "backlog"];
    if (groupBy === "priority") return ["urgent", "high", "medium", "low", "none"];
    return Object.keys(groupedTasks).sort((a, b) => {
      if (a === "Unassigned" || a === "No Plan") return 1;
      if (b === "Unassigned" || b === "No Plan") return -1;
      return a.localeCompare(b);
    });
  }, [groupBy, groupedTasks]);

  const renderPlanSection = useCallback(
    (status: string) => {
      const items = groupedPlans[status];
      if (!items?.length) return null;
      const cfg = PLAN_STATUS_CONFIG[status as keyof typeof PLAN_STATUS_CONFIG] ?? PLAN_STATUS_CONFIG.draft;
      return (
        <RNView key={status}>
          <RNView style={styles.sectionHeader}>
            <FontAwesome name={cfg.icon} size={11} color={cfg.color} />
            <RNText style={[styles.sectionTitle, { color: cfg.color }]}>
              {cfg.label} ({items.length})
            </RNText>
          </RNView>
          {items.map((p) => (
            <PlanItemRow
              key={p._id}
              plan={p}
              onPress={() => router.push(`/plan/${p.short_id}` as any)}
            />
          ))}
        </RNView>
      );
    },
    [groupedPlans, router],
  );

  const renderDocSection = useCallback(
    (docType: string) => {
      const items = groupedDocs[docType];
      if (!items?.length) return null;
      const cfg = DOC_TYPE_CONFIG[docType] ?? DOC_TYPE_CONFIG.note;
      return (
        <RNView key={docType}>
          {/* Every hosted note is a note: no type heading over the list. */}
          {!hosted && (
          <RNView style={styles.sectionHeader}>
            <FontAwesome name={cfg.icon} size={11} color={cfg.color} />
            <RNText style={[styles.sectionTitle, { color: cfg.color }]}>
              {cfg.label} ({items.length})
            </RNText>
          </RNView>
          )}
          {items.map((d) => (
            <DocItemRow
              key={d._id}
              doc={d}
              onPress={() => router.push(`/doc/${d._id}` as any)}
            />
          ))}
        </RNView>
      );
    },
    [groupedDocs, router, hosted],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <RNView style={styles.header}>
        <RNView style={styles.headerLeft}>
          <RNText style={styles.headerTitle}>
            {segmentLabel(segment)}
          </RNText>
          {(() => {
            const count = segment === "tasks" ? activeTaskCount : segment === "plans" ? activePlanCount : segment === "docs" ? docCount : 0;
            return count > 0 ? (
              <RNView style={styles.countBadge}>
                <RNText style={styles.countBadgeText}>{count}</RNText>
              </RNView>
            ) : null;
          })()}
        </RNView>
        <RNView style={styles.headerRight}>
          {(segment === "tasks" || segment === "docs") && !searchOpen && !searchInput && (
            <TouchableOpacity
              style={styles.headerIconBtn}
              onPress={() => setSearchOpen(true)}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              accessibilityLabel={`Search ${segmentLabel(segment).toLowerCase()}`}
            >
              <FontAwesome name="search" size={15} color={Theme.textMuted} />
            </TouchableOpacity>
          )}
          {/* Hosted lists show their filter from six items, or while one is
              in use, as the web's hosted list header does. */}
          {segment !== "routines" && (!hosted || activeFilters.length > 0 || (segment === "tasks" ? tasksList.length : segment === "docs" ? docsList.length : 6) >= 6) && (
          <TouchableOpacity
            style={[styles.filterBtn, activeFilters.length > 0 && styles.filterBtnActive]}
            onPress={openFilterMenu}
            activeOpacity={0.7}
            accessibilityLabel={activeFilters.length > 0 ? `Filters, ${activeFilters.length} active` : "Filters"}
          >
            <FontAwesome name="sliders" size={13} color={activeFilters.length > 0 ? Theme.accent : Theme.textMuted} />
            {activeFilters.length > 0 && (
              <RNText style={styles.filterBtnCount}>{activeFilters.length}</RNText>
            )}
          </TouchableOpacity>
          )}
          {/* A hosted person with no team has one workspace, so there is
              nothing to switch (the web's switcher renders nothing too). */}
          {!(hosted && validTeams.length === 0) && (
          <TouchableOpacity style={styles.workspaceBtn} onPress={showWorkspacePicker} activeOpacity={0.7}>
            {teamId && activeTeam ? (
              <>
                <RNText style={styles.workspaceIcon}>
                  {ICON_EMOJI[activeTeam.icon || ""] || ""}
                </RNText>
                <RNText style={styles.workspaceName} numberOfLines={1}>{activeTeam.name}</RNText>
              </>
            ) : (
              <>
                <FontAwesome name="user" size={11} color={Theme.textMuted} />
                <RNText style={styles.workspaceName}>Personal</RNText>
              </>
            )}
            <FontAwesome name="chevron-down" size={8} color={Theme.textMuted0} />
          </TouchableOpacity>
          )}
        </RNView>
      </RNView>

      <RNView style={styles.segmentBar}>
        <RNView style={styles.segmentContainer}>
          {segments.map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.segmentBtn, segment === s && styles.segmentBtnActive]}
              onPress={() => { setSegment(s); if (linked) router.setParams({ segment: undefined }); setSearchInput(""); setSearchQuery(""); setSearchOpen(false); }}
              activeOpacity={0.7}
            >
              <RNText style={[styles.segmentText, segment === s && styles.segmentTextActive]}>
                {segmentLabel(s)}
              </RNText>
            </TouchableOpacity>
          ))}
        </RNView>
      </RNView>

      {(activeFilters.length > 0 || ((segment === "tasks" || segment === "docs") && (searchOpen || searchInput))) && (
        <RNView style={styles.filterBar}>
          {activeFilters.length > 0 && (
            <RNView style={styles.activeFiltersRow}>
              {activeFilters.map((f) => (
                <TouchableOpacity key={f.key} style={styles.activeFilterChip} onPress={f.clear} activeOpacity={0.7}>
                  <RNText style={styles.activeFilterText}>{f.label}</RNText>
                  <FontAwesome name="times" size={9} color={Theme.textMuted} />
                </TouchableOpacity>
              ))}
            </RNView>
          )}

          {(segment === "tasks" || segment === "docs") && (searchOpen || searchInput) && (
            <RNView style={styles.searchBarRow}>
              <RNView style={styles.searchInputRow}>
                <FontAwesome name="search" size={13} color={Theme.textMuted0} style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.searchInput}
                  value={searchInput}
                  onChangeText={handleSearchChange}
                  placeholder={segment === "tasks" ? "Filter tasks..." : "Filter docs..."}
                  placeholderTextColor={Theme.textMuted0}
                  autoCorrect={false}
                  autoCapitalize="none"
                  autoFocus={!searchInput}
                />
              </RNView>
              <TouchableOpacity
                onPress={() => { handleSearchChange(""); setSearchOpen(false); }}
                hitSlop={{ top: 10, bottom: 10, left: 6, right: 10 }}
              >
                <RNText style={styles.searchCancel}>Cancel</RNText>
              </TouchableOpacity>
            </RNView>
          )}
        </RNView>
      )}

      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Theme.textMuted} />
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {segment === "tasks" ? (
          <>
            {!tasksReady && tasksList.length === 0 ? (
              <RNView style={styles.emptyState}>
                <ActivityIndicator size="small" color={Theme.textMuted} />
              </RNView>
            ) : filteredTasks.length === 0 ? (
              <RNView style={styles.emptyState}>
                <FontAwesome name="check-square-o" size={32} color={Theme.textMuted0} />
                <RNText style={styles.emptyText}>{hosted ? `No ${words.tasksPage.toLowerCase()}` : "No tasks"}</RNText>
                <RNText style={styles.emptySubtext}>
                  {searchQuery || sourceFilter ? "Try a different filter" : hosted ? HOSTED_TODOS_HINT : "Create a task to get started"}
                </RNText>
              </RNView>
            ) : (
              <>
                {/* Only finished to-dos: hosted mode says the list is clear
                    above the fold that holds them, rather than a bare toggle. */}
                {hosted && activeTaskCount === 0 && !searchQuery ? (
                  <RNView style={styles.emptyState}>
                    <RNText style={styles.emptyText}>{words.noActive}</RNText>
                    <RNText style={styles.emptySubtext}>{HOSTED_TODOS_HINT}</RNText>
                  </RNView>
                ) : null}
                {taskGroupOrder.map((key) => renderTaskGroup(key))}

                {groupBy === "status" && TERMINAL_STATUSES.some((s) => groupedTasks[s]?.length) && (
                  <>
                    <TouchableOpacity
                      style={styles.doneToggle}
                      onPress={() => setShowDone((v) => !v)}
                      activeOpacity={0.7}
                    >
                      <FontAwesome
                        name={showDone ? "chevron-up" : "chevron-down"}
                        size={11}
                        color={Theme.textMuted0}
                      />
                      <RNText style={styles.doneToggleText}>
                        {showDone ? "Hide completed" : "Show completed"}
                      </RNText>
                    </TouchableOpacity>
                    {showDone && TERMINAL_STATUSES.map((s) => renderTaskGroup(s))}
                  </>
                )}
              </>
            )}
          </>
        ) : segment === "plans" ? (
          <>
            {!plansReady && plansList.length === 0 ? (
              <RNView style={styles.emptyState}>
                <ActivityIndicator size="small" color={Theme.textMuted} />
              </RNView>
            ) : filteredPlans.length === 0 ? (
              <RNView style={styles.emptyState}>
                <FontAwesome name="map-o" size={32} color={Theme.textMuted0} />
                <RNText style={styles.emptyText}>No plans</RNText>
                <RNText style={styles.emptySubtext}>
                  {sourceFilter ? "Try a different filter" : "Plans group tasks toward a goal"}
                </RNText>
              </RNView>
            ) : (
              PLAN_STATUS_ORDER.map((s) => renderPlanSection(s))
            )}
          </>
        ) : segment === "routines" ? (
          <RNView style={styles.routines}>
            <RoutineList />
          </RNView>
        ) : (
          <>
            {!docsReady && docsList.length === 0 ? (
              <RNView style={styles.emptyState}>
                <ActivityIndicator size="small" color={Theme.textMuted} />
              </RNView>
            ) : filteredDocs.length === 0 ? (
              <RNView style={styles.emptyState}>
                <FontAwesome name="file-text-o" size={32} color={Theme.textMuted0} />
                <RNText style={styles.emptyText}>{hosted ? `No ${words.docsPage.toLowerCase()} yet` : "No docs"}</RNText>
                <RNText style={styles.emptySubtext}>
                  {searchQuery || sourceFilter ? "Try a different filter" : hosted ? "Notes you or the assistant write land here." : "Documents created by you or your agents"}
                </RNText>
              </RNView>
            ) : (
              DOC_TYPES.filter((t) => groupedDocs[t]?.length).map((t) => renderDocSection(t))
            )}
          </>
        )}
        <RNView style={{ height: 80 }} />
      </ScrollView>

      {segment === "tasks" && (
        <>
          <CreateTaskModal
            visible={showCreate}
            onClose={() => setShowCreate(false)}
            onCreate={handleCreateTask}
          />
          <RNView style={styles.fabContainer} pointerEvents="box-none">
            {/* Hosted mode's + is the inbox's ink disc, so adding reads the
                same on every tab; developer mode keeps the quiet one. */}
            <TouchableOpacity
              style={[styles.fab, hosted && styles.fabHosted]}
              onPress={() => setShowCreate(true)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={hosted ? words.newTask : "New task"}
            >
              <FontAwesome name="plus" size={hosted ? 18 : 16} color={hosted ? Theme.bg : Theme.textMuted} />
            </TouchableOpacity>
          </RNView>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = themedStyles((Theme, look) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Theme.bgAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
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
    alignItems: "center",
  },
  countBadgeText: {
    fontSize: 12,
    ...pageCountLook(look, Theme.accent, Theme.textMuted, Theme.bg).text,
  },
  // The controls' height, held when a segment has none (Routines), so the
  // title and segments sit at the same place on every segment.
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 30,
  },
  headerIconBtn: {
    width: 32,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
  },
  filterBtnActive: {
    borderColor: Theme.accent + "80",
    backgroundColor: Theme.accent + "14",
  },
  filterBtnCount: {
    fontSize: 12,
    fontWeight: "700",
    color: Theme.accent,
    fontVariant: ["tabular-nums"],
  },
  searchBarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchCancel: {
    fontSize: 14,
    color: Theme.blue,
  },
  workspaceBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
  },
  workspaceIcon: {
    fontSize: 13,
  },
  workspaceName: {
    fontSize: 13,
    fontWeight: "500",
    color: Theme.textMuted,
    maxWidth: 100,
  },
  segmentBar: {
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  segmentContainer: {
    flexDirection: "row",
    backgroundColor: Theme.bgHighlight,
    borderRadius: 8,
    padding: 2,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: "center",
  },
  segmentBtnActive: {
    backgroundColor: Theme.bg,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: "600",
    color: Theme.textMuted0,
  },
  segmentTextActive: {
    color: Theme.text,
  },
  filterBar: {
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    gap: 6,
  },
  activeFiltersRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingBottom: 4,
  },
  activeFilterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: Theme.accent + "18",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.accent + "40",
  },
  activeFilterText: {
    fontSize: 11,
    fontWeight: "600",
    color: Theme.accent,
  },
  searchInputRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
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
  // Room under the last row for the floating + (48pt, 24pt up), so the
  // last row's time can scroll clear of it.
  listContent: {
    paddingBottom: 88,
  },
  routines: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Theme.bgAlt,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  hostedSectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingTop: 18,
    paddingBottom: 6,
  },
  hostedSectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: Theme.textMuted,
  },
  hostedSectionCount: {
    fontSize: 12,
    color: Theme.textMuted0,
    fontVariant: ["tabular-nums"],
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 60,
    gap: 8,
  },
  emptyText: {
    fontSize: 17,
    fontWeight: "600",
    color: Theme.textMuted,
  },
  emptySubtext: {
    fontSize: 14,
    color: Theme.textMuted0,
  },
  doneToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: Theme.bgHighlight,
    marginTop: Spacing.sm,
  },
  doneToggleText: {
    fontSize: 13,
    color: Theme.textMuted0,
    fontWeight: "500",
  },
  fabContainer: {
    position: "absolute",
    bottom: 24,
    right: 20,
    zIndex: 100,
    elevation: 100,
  },
  fabHosted: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 0,
    backgroundColor: Theme.text,
    shadowOpacity: 0.12,
    shadowRadius: 10,
  },
  fab: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Theme.bgAlt,
    borderWidth: 1,
    borderColor: Theme.border,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
}));

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
  hostedTitle: { fontFamily: Serif.regular, fontSize: 22, fontWeight: "500" },
  body: { flex: 1, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: Theme.textMuted,
    marginBottom: 6,
    marginTop: Spacing.md,
  },
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
  priorityRow: {
    flexDirection: "row",
    gap: 8,
  },
  priorityBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: Theme.borderLight,
    alignItems: "center",
  },
  priorityBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: Theme.textMuted,
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
    backgroundColor: Theme.accent,
  },
  submitBtnText: { fontSize: 15, fontWeight: "600", color: Theme.bg },
}));
