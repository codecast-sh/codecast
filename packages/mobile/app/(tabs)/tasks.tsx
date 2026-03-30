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
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing } from "@/constants/Theme";
import { useInboxStore, type TaskItem, type PlanItem } from "@codecast/web/store/inboxStore";
import { useSyncTasks } from "@/hooks/useSyncTasks";
import { useSyncPlans } from "@/hooks/useSyncPlans";
import { TaskItemRow, STATUS_CONFIG, PRIORITY_CONFIG, PRIORITY_ORDER, showTaskActions } from "@/components/TaskItem";
import { PlanItemRow, PLAN_STATUS_CONFIG, PLAN_STATUS_ORDER } from "@/components/PlanItem";

type Segment = "tasks" | "plans";
type TaskStatus = "backlog" | "open" | "in_progress" | "in_review" | "done" | "dropped";

const ACTIVE_STATUSES: TaskStatus[] = ["open", "in_progress", "in_review"];
const TERMINAL_STATUSES: TaskStatus[] = ["done", "dropped"];

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
  const [refreshing, setRefreshing] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const router = useRouter();

  const { ready: tasksReady } = useSyncTasks();
  const { ready: plansReady } = useSyncPlans();

  const tasks = useInboxStore((s) => s.tasks);
  const plans = useInboxStore((s) => s.plans);
  const updateTask = useInboxStore((s) => s.updateTask);
  const createTask = useInboxStore((s) => s.createTask);

  const tasksList = useMemo(() => Object.values(tasks), [tasks]);
  const plansList = useMemo(() => Object.values(plans), [plans]);

  const filteredTasks = useMemo(() => {
    let list = tasksList;
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
  }, [tasksList, searchQuery]);

  const groupedTasks = useMemo(() => {
    const groups: Record<string, TaskItem[]> = {};
    for (const t of filteredTasks) {
      const s = t.status;
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort(
        (a, b) =>
          (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3) ||
          b.updated_at - a.updated_at,
      );
    }
    return groups;
  }, [filteredTasks]);

  const groupedPlans = useMemo(() => {
    const groups: Record<string, PlanItem[]> = {};
    for (const p of plansList) {
      if (!groups[p.status]) groups[p.status] = [];
      groups[p.status].push(p);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => b.updated_at - a.updated_at);
    }
    return groups;
  }, [plansList]);

  const activeTaskCount = useMemo(
    () => tasksList.filter((t) => ACTIVE_STATUSES.includes(t.status as TaskStatus)).length,
    [tasksList],
  );

  const activePlanCount = useMemo(
    () => plansList.filter((p) => p.status === "active" || p.status === "draft").length,
    [plansList],
  );

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

  const renderTaskSection = useCallback(
    (status: TaskStatus) => {
      const items = groupedTasks[status];
      if (!items?.length) return null;
      const cfg = STATUS_CONFIG[status];
      return (
        <RNView key={status}>
          <RNView style={styles.sectionHeader}>
            <FontAwesome name={cfg.icon} size={11} color={cfg.color} />
            <RNText style={[styles.sectionTitle, { color: cfg.color }]}>
              {cfg.label} ({items.length})
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
    [groupedTasks, router, updateTask],
  );

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

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <RNView style={styles.header}>
        <RNText style={styles.headerTitle}>
          {segment === "tasks" ? "Tasks" : "Plans"}
        </RNText>
        {(segment === "tasks" ? activeTaskCount : activePlanCount) > 0 && (
          <RNView style={styles.countBadge}>
            <RNText style={styles.countBadgeText}>
              {segment === "tasks" ? activeTaskCount : activePlanCount}
            </RNText>
          </RNView>
        )}
      </RNView>

      <RNView style={styles.segmentBar}>
        <RNView style={styles.segmentContainer}>
          {(["tasks", "plans"] as Segment[]).map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.segmentBtn, segment === s && styles.segmentBtnActive]}
              onPress={() => { setSegment(s); setSearchInput(""); setSearchQuery(""); }}
              activeOpacity={0.7}
            >
              <RNText style={[styles.segmentText, segment === s && styles.segmentTextActive]}>
                {s === "tasks" ? "Tasks" : "Plans"}
              </RNText>
            </TouchableOpacity>
          ))}
        </RNView>
      </RNView>

      {segment === "tasks" && (
        <RNView style={styles.searchContainer}>
          <RNView style={styles.searchInputRow}>
            <FontAwesome name="search" size={13} color={Theme.textMuted0} style={{ marginRight: 8 }} />
            <TextInput
              style={styles.searchInput}
              value={searchInput}
              onChangeText={handleSearchChange}
              placeholder="Filter tasks..."
              placeholderTextColor={Theme.textMuted0}
              autoCorrect={false}
              autoCapitalize="none"
            />
          </RNView>
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
            {!tasksReady ? (
              <RNView style={styles.emptyState}>
                <ActivityIndicator size="small" color={Theme.textMuted} />
              </RNView>
            ) : filteredTasks.length === 0 ? (
              <RNView style={styles.emptyState}>
                <FontAwesome name="check-square-o" size={32} color={Theme.textMuted0} />
                <RNText style={styles.emptyText}>No tasks</RNText>
                <RNText style={styles.emptySubtext}>
                  {searchQuery ? "Try a different search" : "Create a task to get started"}
                </RNText>
              </RNView>
            ) : (
              <>
                {ACTIVE_STATUSES.map((s) => renderTaskSection(s))}
                {renderTaskSection("backlog")}

                {TERMINAL_STATUSES.some((s) => groupedTasks[s]?.length) && (
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
                    {showDone && TERMINAL_STATUSES.map((s) => renderTaskSection(s))}
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {!plansReady ? (
              <RNView style={styles.emptyState}>
                <ActivityIndicator size="small" color={Theme.textMuted} />
              </RNView>
            ) : plansList.length === 0 ? (
              <RNView style={styles.emptyState}>
                <FontAwesome name="map-o" size={32} color={Theme.textMuted0} />
                <RNText style={styles.emptyText}>No plans</RNText>
                <RNText style={styles.emptySubtext}>Plans group tasks toward a goal</RNText>
              </RNView>
            ) : (
              PLAN_STATUS_ORDER.map((s) => renderPlanSection(s))
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
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Theme.bgAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
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
  searchContainer: {
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
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
