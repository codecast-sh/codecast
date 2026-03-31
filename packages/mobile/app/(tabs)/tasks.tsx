import { useState, useCallback, useMemo, useRef } from "react";
import {
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  View as RNView,
  Text as RNText,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActionSheetIOS,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing } from "@/constants/Theme";
import { useInboxStore, type TaskItem, type PlanItem, type DocItem } from "@codecast/web/store/inboxStore";
import { useSyncTasks } from "@/hooks/useSyncTasks";
import { useSyncPlans } from "@/hooks/useSyncPlans";
import { useSyncDocs } from "@/hooks/useSyncDocs";
import { useActiveTeam } from "@/hooks/useWorkspaceArgs";
import { TaskItemRow, STATUS_CONFIG, PRIORITY_CONFIG, PRIORITY_ORDER, showTaskActions } from "@/components/TaskItem";
import { PlanItemRow, PLAN_STATUS_CONFIG, PLAN_STATUS_ORDER } from "@/components/PlanItem";
import { DocItemRow, DOC_TYPE_CONFIG, DOC_TYPES } from "@/components/DocItem";

const ICON_EMOJI: Record<string, string> = {
  rocket: "🚀", flame: "🔥", zap: "⚡", star: "⭐", diamond: "💎", crown: "👑",
  shield: "🛡️", sword: "⚔️", anchor: "⚓", compass: "🧭", mountain: "⛰️", tree: "🌲",
  sun: "☀️", moon: "🌙", cloud: "☁️", bolt: "🔩", atom: "⚛️", dna: "🧬",
};

type Segment = "tasks" | "plans" | "docs";
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
          <RNText style={modalStyles.title}>New Task</RNText>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <FontAwesome name="times" size={20} color={Theme.textMuted} />
          </TouchableOpacity>
        </RNView>

        <ScrollView style={modalStyles.body} keyboardShouldPersistTaps="handled">
          <RNText style={modalStyles.label}>Title</RNText>
          <TextInput
            style={modalStyles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="What needs to be done?"
            placeholderTextColor={Theme.textMuted0}
            autoFocus
            autoCorrect={false}
            returnKeyType="next"
          />

          <RNText style={modalStyles.label}>Description</RNText>
          <TextInput
            style={[modalStyles.input, { minHeight: 80, textAlignVertical: "top" }]}
            value={description}
            onChangeText={setDescription}
            placeholder="Add details..."
            placeholderTextColor={Theme.textMuted0}
            multiline
            autoCorrect={false}
          />

          <RNText style={modalStyles.label}>Priority</RNText>
          <RNView style={modalStyles.priorityRow}>
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
          </RNView>
        </ScrollView>

        <RNView style={modalStyles.footer}>
          <TouchableOpacity style={modalStyles.cancelBtn} onPress={onClose} activeOpacity={0.7}>
            <RNText style={modalStyles.cancelBtnText}>Cancel</RNText>
          </TouchableOpacity>
          <TouchableOpacity
            style={[modalStyles.submitBtn, !title.trim() && { opacity: 0.4 }]}
            onPress={handleSubmit}
            disabled={!title.trim()}
            activeOpacity={0.7}
          >
            <RNText style={modalStyles.submitBtnText}>Create</RNText>
          </TouchableOpacity>
        </RNView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function TasksScreen() {
  const [segment, setSegment] = useState<Segment>("tasks");
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
  const router = useRouter();

  const { teamId, activeTeam, validTeams } = useActiveTeam();
  const saveActiveTeam = useMutation(api.teams.setActiveTeam);

  const showWorkspacePicker = useCallback(() => {
    const options = [
      "Personal",
      ...validTeams.map((t) => `${ICON_EMOJI[t.icon || ""] || ""} ${t.name}`.trim()),
      "Cancel",
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: "Switch Workspace" },
      (idx) => {
        if (idx === 0) saveActiveTeam({ team_id: undefined as any });
        else if (idx > 0 && idx <= validTeams.length) saveActiveTeam({ team_id: validTeams[idx - 1]._id });
      },
    );
  }, [validTeams, saveActiveTeam]);

  const { ready: tasksReady } = useSyncTasks();
  const { ready: plansReady } = useSyncPlans();
  const { ready: docsReady } = useSyncDocs();

  const tasks = useInboxStore((s) => s.tasks);
  const plans = useInboxStore((s) => s.plans);
  const docs = useInboxStore((s) => s.docs);
  const updateTask = useInboxStore((s) => s.updateTask);
  const createTask = useInboxStore((s) => s.createTask);

  const tasksList = useMemo(() => Object.values(tasks), [tasks]);
  const plansList = useMemo(() => Object.values(plans), [plans]);
  const docsList = useMemo(() => Object.values(docs), [docs]);

  const applySourceFilter = useCallback(<T extends { source?: string }>(list: T[]): T[] => {
    if (sourceFilter === "human") return list.filter((i) => i.source === "human");
    if (sourceFilter === "bot") return list.filter((i) => i.source !== "human");
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

  const sortTasks = useCallback((list: TaskItem[]) => {
    return [...list].sort((a, b) => {
      if (sortBy === "priority") return (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3) || b.updated_at - a.updated_at;
      if (sortBy === "created") return b.created_at - a.created_at;
      return b.updated_at - a.updated_at;
    });
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

  const uniqueAssignees = useMemo(() => {
    const names = new Set<string>();
    for (const t of tasksList) {
      if (t.assignee_info?.name) names.add(t.assignee_info.name);
    }
    return Array.from(names).sort();
  }, [tasksList]);

  const showGroupByPicker = useCallback(() => {
    const options = [...GROUP_BY_OPTIONS.map((o) => o.label), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: "Group By" },
      (idx) => { if (idx < GROUP_BY_OPTIONS.length) setGroupBy(GROUP_BY_OPTIONS[idx].key); },
    );
  }, []);

  const showSortPicker = useCallback(() => {
    const options = [...SORT_OPTIONS.map((o) => o.label), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: "Sort By" },
      (idx) => { if (idx < SORT_OPTIONS.length) setSortBy(SORT_OPTIONS[idx].key); },
    );
  }, []);

  const showStatusFilterPicker = useCallback(() => {
    const statuses: TaskStatus[] = ["open", "in_progress", "in_review", "backlog", "done", "dropped"];
    const options = ["All Statuses", ...statuses.map((s) => STATUS_CONFIG[s].label), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: "Filter by Status" },
      (idx) => { setStatusFilter(idx === 0 ? "" : idx <= statuses.length ? statuses[idx - 1] : statusFilter); },
    );
  }, [statusFilter]);

  const showPriorityFilterPicker = useCallback(() => {
    const priorities = ["urgent", "high", "medium", "low"];
    const options = ["All Priorities", ...priorities.map((p) => PRIORITY_CONFIG[p as keyof typeof PRIORITY_CONFIG].label), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: "Filter by Priority" },
      (idx) => { setPriorityFilter(idx === 0 ? "" : idx <= priorities.length ? priorities[idx - 1] : priorityFilter); },
    );
  }, [priorityFilter]);

  const showAssigneeFilterPicker = useCallback(() => {
    const options = ["All Assignees", "Unassigned", ...uniqueAssignees, "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: "Filter by Assignee" },
      (idx) => {
        if (idx === 0) setAssigneeFilter("");
        else if (idx === 1) setAssigneeFilter("_unassigned");
        else if (idx > 1 && idx <= uniqueAssignees.length + 1) setAssigneeFilter(uniqueAssignees[idx - 2]);
      },
    );
  }, [uniqueAssignees]);

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
    let list = applySourceFilter(docsList);
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
  }, [docsList, searchQuery, applySourceFilter]);

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
      createTask({ title, priority, description, status: "open" }).catch((err: Error) =>
        Alert.alert("Error", err.message),
      );
    },
    [createTask],
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
          <RNView style={styles.sectionHeader}>
            <FontAwesome name={icon} size={11} color={color} />
            <RNText style={[styles.sectionTitle, { color }]}>
              {label} ({items.length})
            </RNText>
          </RNView>
          {items.map((t) => (
            <TaskItemRow
              key={t._id}
              task={t}
              onPress={() => router.push(`/task/${t.short_id}` as any)}
              onLongPress={() => showTaskActions(t, updateTask)}
            />
          ))}
        </RNView>
      );
    },
    [groupedTasks, groupBy, router, updateTask],
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
          <RNView style={styles.sectionHeader}>
            <FontAwesome name={cfg.icon} size={11} color={cfg.color} />
            <RNText style={[styles.sectionTitle, { color: cfg.color }]}>
              {cfg.label} ({items.length})
            </RNText>
          </RNView>
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
    [groupedDocs, router],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <RNView style={styles.header}>
        <RNView style={styles.headerLeft}>
          <RNText style={styles.headerTitle}>
            {segment === "tasks" ? "Tasks" : segment === "plans" ? "Plans" : "Docs"}
          </RNText>
          {(() => {
            const count = segment === "tasks" ? activeTaskCount : segment === "plans" ? activePlanCount : docCount;
            return count > 0 ? (
              <RNView style={styles.countBadge}>
                <RNText style={styles.countBadgeText}>{count}</RNText>
              </RNView>
            ) : null;
          })()}
        </RNView>
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
      </RNView>

      <RNView style={styles.segmentBar}>
        <RNView style={styles.segmentContainer}>
          {(["tasks", "plans", "docs"] as Segment[]).map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.segmentBtn, segment === s && styles.segmentBtnActive]}
              onPress={() => { setSegment(s); setSearchInput(""); setSearchQuery(""); }}
              activeOpacity={0.7}
            >
              <RNText style={[styles.segmentText, segment === s && styles.segmentTextActive]}>
                {s === "tasks" ? "Tasks" : s === "plans" ? "Plans" : "Docs"}
              </RNText>
            </TouchableOpacity>
          ))}
        </RNView>
      </RNView>

      <RNView style={styles.filterBar}>
        <RNView style={styles.sourceFilterRow}>
          {([["", "All"], ["human", "Human"], ["bot", "Bot"]] as const).map(([key, label]) => (
            <TouchableOpacity
              key={key}
              style={[styles.sourceBtn, sourceFilter === key && styles.sourceBtnActive]}
              onPress={() => setSourceFilter(key as SourceFilter)}
              activeOpacity={0.7}
            >
              {key === "human" ? (
                <FontAwesome name="user" size={11} color={sourceFilter === key ? Theme.text : Theme.textMuted0} />
              ) : key === "bot" ? (
                <FontAwesome name="bolt" size={11} color={sourceFilter === key ? Theme.cyan : Theme.textMuted0} />
              ) : (
                <RNText style={[styles.sourceText, sourceFilter === key && styles.sourceTextActive]}>
                  {label}
                </RNText>
              )}
            </TouchableOpacity>
          ))}
          {segment === "tasks" && (
            <RNView style={styles.filterActions}>
              <TouchableOpacity style={styles.filterActionBtn} onPress={showGroupByPicker} activeOpacity={0.7}>
                <FontAwesome name="th-list" size={12} color={groupBy !== "status" ? Theme.accent : Theme.textMuted0} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.filterActionBtn} onPress={showSortPicker} activeOpacity={0.7}>
                <FontAwesome name="sort-amount-desc" size={12} color={sortBy !== "priority" ? Theme.accent : Theme.textMuted0} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.filterActionBtn} onPress={showStatusFilterPicker} activeOpacity={0.7}>
                <FontAwesome name="circle-o" size={12} color={statusFilter ? Theme.accent : Theme.textMuted0} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.filterActionBtn} onPress={showPriorityFilterPicker} activeOpacity={0.7}>
                <FontAwesome name="arrow-up" size={12} color={priorityFilter ? Theme.accent : Theme.textMuted0} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.filterActionBtn} onPress={showAssigneeFilterPicker} activeOpacity={0.7}>
                <FontAwesome name="user-o" size={12} color={assigneeFilter ? Theme.accent : Theme.textMuted0} />
              </TouchableOpacity>
            </RNView>
          )}
        </RNView>

        {segment === "tasks" && (statusFilter || priorityFilter || assigneeFilter) && (
          <RNView style={styles.activeFiltersRow}>
            {statusFilter ? (
              <TouchableOpacity style={styles.activeFilterChip} onPress={() => setStatusFilter("")} activeOpacity={0.7}>
                <RNText style={styles.activeFilterText}>{STATUS_CONFIG[statusFilter]?.label}</RNText>
                <FontAwesome name="times" size={9} color={Theme.textMuted} />
              </TouchableOpacity>
            ) : null}
            {priorityFilter ? (
              <TouchableOpacity style={styles.activeFilterChip} onPress={() => setPriorityFilter("")} activeOpacity={0.7}>
                <RNText style={styles.activeFilterText}>{PRIORITY_CONFIG[priorityFilter as keyof typeof PRIORITY_CONFIG]?.label}</RNText>
                <FontAwesome name="times" size={9} color={Theme.textMuted} />
              </TouchableOpacity>
            ) : null}
            {assigneeFilter ? (
              <TouchableOpacity style={styles.activeFilterChip} onPress={() => setAssigneeFilter("")} activeOpacity={0.7}>
                <RNText style={styles.activeFilterText}>{assigneeFilter === "_unassigned" ? "Unassigned" : assigneeFilter}</RNText>
                <FontAwesome name="times" size={9} color={Theme.textMuted} />
              </TouchableOpacity>
            ) : null}
          </RNView>
        )}

        {(segment === "tasks" || segment === "docs") && (
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
            />
          </RNView>
        )}
      </RNView>

      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Theme.textMuted} />
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {segment === "tasks" ? (
          <>
            {!tasksReady ? (
              <RNView style={styles.emptyState}>
                <ActivityIndicator size="small" color={Theme.textMuted} />
              </RNView>
            ) : filteredTasks.length === 0 ? (
              <RNView style={styles.emptyState}>
                <FontAwesome name="check-square-o" size={32} color={Theme.textMuted0} />
                <RNText style={styles.emptyText}>No tasks</RNText>
                <RNText style={styles.emptySubtext}>
                  {searchQuery || sourceFilter ? "Try a different filter" : "Create a task to get started"}
                </RNText>
              </RNView>
            ) : (
              <>
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
            {!plansReady ? (
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
        ) : (
          <>
            {!docsReady ? (
              <RNView style={styles.emptyState}>
                <ActivityIndicator size="small" color={Theme.textMuted} />
              </RNView>
            ) : filteredDocs.length === 0 ? (
              <RNView style={styles.emptyState}>
                <FontAwesome name="file-text-o" size={32} color={Theme.textMuted0} />
                <RNText style={styles.emptyText}>No docs</RNText>
                <RNText style={styles.emptySubtext}>
                  {searchQuery || sourceFilter ? "Try a different filter" : "Documents created by you or your agents"}
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
            <TouchableOpacity
              style={styles.fab}
              onPress={() => setShowCreate(true)}
              activeOpacity={0.8}
            >
              <FontAwesome name="plus" size={16} color={Theme.textMuted} />
            </TouchableOpacity>
          </RNView>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
    fontSize: 20,
    fontWeight: "700",
    color: Theme.text,
  },
  countBadge: {
    backgroundColor: Theme.accent,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: "center",
  },
  countBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: Theme.bg,
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
  sourceFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    overflow: "hidden",
    alignSelf: "flex-start",
  },
  sourceBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Theme.borderLight,
  },
  sourceBtnActive: {
    backgroundColor: Theme.bgHighlight,
  },
  sourceText: {
    fontSize: 12,
    fontWeight: "500",
    color: Theme.textMuted0,
  },
  sourceTextActive: {
    color: Theme.text,
  },
  filterActions: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: "auto",
    gap: 2,
  },
  filterActionBtn: {
    padding: 6,
    borderRadius: 6,
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
  listContent: {
    paddingBottom: Spacing.xl,
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
});

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
});
