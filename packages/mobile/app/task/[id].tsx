import { useState, useCallback, useMemo } from "react";
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View as RNView,
  Text as RNText,
  TextInput,
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing } from "@/constants/Theme";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useSyncTasks } from "@/hooks/useSyncTasks";
import {
  STATUS_CONFIG,
  STATUS_ORDER,
  PRIORITY_CONFIG,
} from "@/components/TaskItem";

type TaskStatus = keyof typeof STATUS_CONFIG;
type TaskPriority = keyof typeof PRIORITY_CONFIG;

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const tasks = useInboxStore((s) => s.tasks);
  const updateTask = useInboxStore((s) => s.updateTask);
  const { ready: tasksReady } = useSyncTasks();

  const task = useMemo(() => {
    return Object.values(tasks).find((t) => t.short_id === id);
  }, [tasks, id]);

  const [commentText, setCommentText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const webAddComment = useMutation(api.tasks.webAddComment);

  const status = task ? (STATUS_CONFIG[task.status as TaskStatus] ?? STATUS_CONFIG.open) : STATUS_CONFIG.open;
  const priority = task ? (PRIORITY_CONFIG[task.priority as TaskPriority] ?? PRIORITY_CONFIG.medium) : PRIORITY_CONFIG.medium;

  const handleStatusPress = useCallback(() => {
    if (!task) return;
    const available = STATUS_ORDER.filter((s) => s !== task.status);
    const options = available.map((s) => STATUS_CONFIG[s].label);
    options.push("Cancel");
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: "Change Status" },
      (idx) => {
        if (idx < available.length) {
          updateTask(task.short_id, { status: available[idx] });
        }
      },
    );
  }, [task, updateTask]);

  const handlePriorityPress = useCallback(() => {
    if (!task) return;
    const prios = (Object.keys(PRIORITY_CONFIG) as TaskPriority[]).filter((p) => p !== task.priority);
    const options = prios.map((p) => PRIORITY_CONFIG[p].label);
    options.push("Cancel");
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: "Change Priority" },
      (idx) => {
        if (idx < prios.length) {
          updateTask(task.short_id, { priority: prios[idx] });
        }
      },
    );
  }, [task, updateTask]);

  const handleAddComment = useCallback(async () => {
    if (!task || !commentText.trim()) return;
    setSubmitting(true);
    try {
      await webAddComment({ short_id: task.short_id, text: commentText.trim() });
      setCommentText("");
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to add comment");
    } finally {
      setSubmitting(false);
    }
  }, [task, commentText, webAddComment]);

  const hasSynced = tasksReady;

  if (!task) {
    return (
      <>
        <Stack.Screen options={{ title: id ?? "Task" }} />
        <RNView style={styles.loading}>
          {hasSynced ? (
            <>
              <FontAwesome name="exclamation-circle" size={28} color={Theme.textMuted0} />
              <RNText style={styles.loadingText}>Task not found</RNText>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                <RNText style={styles.backBtnText}>Go back</RNText>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <ActivityIndicator size="small" color={Theme.textMuted} />
              <RNText style={styles.loadingText}>Loading task...</RNText>
            </>
          )}
        </RNView>
      </>
    );
  }

  const steps = task.steps ?? [];
  const criteria = task.acceptance_criteria ?? [];
  const labels = task.labels ?? [];

  return (
    <>
      <Stack.Screen
        options={{
          title: task.short_id,
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { fontSize: 15, fontWeight: "600", color: Theme.textMuted },
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <RNText style={styles.title}>{task.title}</RNText>

        <RNView style={styles.badgeRow}>
          <TouchableOpacity style={[styles.badge, { borderColor: status.color + "40" }]} onPress={handleStatusPress}>
            <FontAwesome name={status.icon} size={12} color={status.color} />
            <RNText style={[styles.badgeText, { color: status.color }]}>{status.label}</RNText>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.badge, { borderColor: priority.color + "40" }]} onPress={handlePriorityPress}>
            <FontAwesome name={priority.icon} size={10} color={priority.color} />
            <RNText style={[styles.badgeText, { color: priority.color }]}>{priority.label}</RNText>
          </TouchableOpacity>

          {task.source && (
            <RNView style={[styles.badge, { borderColor: Theme.borderLight }]}>
              <FontAwesome
                name={task.source === "human" ? "user" : "bolt"}
                size={10}
                color={Theme.textMuted0}
              />
              <RNText style={[styles.badgeText, { color: Theme.textMuted0 }]}>{task.source}</RNText>
            </RNView>
          )}
        </RNView>

        {task.description && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Description</RNText>
            <RNText style={styles.description}>{task.description}</RNText>
          </RNView>
        )}

        {task.plan && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Plan</RNText>
            <TouchableOpacity
              style={styles.planLink}
              onPress={() => router.push(`/plan/${task.plan!.short_id}` as any)}
              activeOpacity={0.6}
            >
              <FontAwesome name="map" size={12} color={Theme.cyan} />
              <RNText style={styles.planLinkText}>{task.plan.title}</RNText>
              <FontAwesome name="chevron-right" size={10} color={Theme.textMuted0} />
            </TouchableOpacity>
          </RNView>
        )}

        {labels.length > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Labels</RNText>
            <RNView style={styles.labelRow}>
              {labels.map((l) => (
                <RNView key={l} style={styles.labelChip}>
                  <RNText style={styles.labelChipText}>{l}</RNText>
                </RNView>
              ))}
            </RNView>
          </RNView>
        )}

        {criteria.length > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Acceptance Criteria</RNText>
            {criteria.map((c, i) => (
              <RNView key={i} style={styles.criteriaRow}>
                <FontAwesome name="circle-o" size={10} color={Theme.textMuted0} style={{ marginTop: 4 }} />
                <RNText style={styles.criteriaText}>{c}</RNText>
              </RNView>
            ))}
          </RNView>
        )}

        {steps.length > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Steps</RNText>
            {steps.map((s, i) => (
              <RNView key={i} style={styles.criteriaRow}>
                <FontAwesome
                  name={s.done ? "check-square-o" : "square-o"}
                  size={13}
                  color={s.done ? Theme.green : Theme.textMuted0}
                  style={{ marginTop: 2 }}
                />
                <RNText style={[styles.criteriaText, s.done && styles.stepDone]}>{s.title}</RNText>
              </RNView>
            ))}
          </RNView>
        )}

        {task.execution_status && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Execution</RNText>
            <RNView style={[styles.executionBadge, executionColor(task.execution_status)]}>
              <RNText style={styles.executionText}>{task.execution_status.replace(/_/g, " ")}</RNText>
            </RNView>
            {task.execution_concerns && (
              <RNText style={styles.concernsText}>{task.execution_concerns}</RNText>
            )}
          </RNView>
        )}

        {task.files_changed && task.files_changed.length > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Files Changed ({task.files_changed.length})</RNText>
            {task.files_changed.slice(0, 10).map((f, i) => (
              <RNText key={i} style={styles.fileText}>{f}</RNText>
            ))}
            {task.files_changed.length > 10 && (
              <RNText style={styles.moreText}>+{task.files_changed.length - 10} more</RNText>
            )}
          </RNView>
        )}

        <RNView style={styles.section}>
          <RNText style={styles.sectionLabel}>Comment</RNText>
          <RNView style={styles.commentInputRow}>
            <TextInput
              style={styles.commentInput}
              value={commentText}
              onChangeText={setCommentText}
              placeholder="Add a comment..."
              placeholderTextColor={Theme.textMuted0}
              multiline
            />
            <TouchableOpacity
              style={[styles.commentSend, (!commentText.trim() || submitting) && { opacity: 0.3 }]}
              onPress={handleAddComment}
              disabled={!commentText.trim() || submitting}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={Theme.accent} />
              ) : (
                <FontAwesome name="arrow-up" size={14} color={Theme.accent} />
              )}
            </TouchableOpacity>
          </RNView>
        </RNView>

        <RNView style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

function executionColor(status: string): { backgroundColor: string; borderColor: string } {
  switch (status) {
    case "done":
      return { backgroundColor: Theme.green + "15", borderColor: Theme.green + "40" };
    case "done_with_concerns":
      return { backgroundColor: Theme.orange + "15", borderColor: Theme.orange + "40" };
    case "blocked":
      return { backgroundColor: Theme.red + "15", borderColor: Theme.red + "40" };
    case "needs_context":
      return { backgroundColor: Theme.accent + "15", borderColor: Theme.accent + "40" };
    default:
      return { backgroundColor: Theme.bgHighlight, borderColor: Theme.borderLight };
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  content: { padding: Spacing.lg },
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    backgroundColor: Theme.bg,
  },
  loadingText: { fontSize: 14, color: Theme.textMuted },
  backBtn: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  backBtnText: { fontSize: 14, fontWeight: "500", color: Theme.accent },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: Theme.text,
    lineHeight: 26,
    marginBottom: Spacing.md,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: Spacing.lg,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  section: {
    marginBottom: Spacing.lg,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: Theme.textMuted0,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: Theme.text,
    lineHeight: 20,
  },
  planLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: Theme.bgAlt,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  planLinkText: {
    fontSize: 14,
    fontWeight: "500",
    color: Theme.cyan,
    flex: 1,
  },
  labelRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  labelChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: Theme.bgHighlight,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  labelChipText: {
    fontSize: 12,
    fontWeight: "500",
    color: Theme.textMuted,
  },
  criteriaRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 6,
  },
  criteriaText: {
    fontSize: 14,
    color: Theme.text,
    lineHeight: 20,
    flex: 1,
  },
  stepDone: {
    textDecorationLine: "line-through",
    color: Theme.textMuted,
  },
  executionBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    alignSelf: "flex-start",
    marginBottom: 6,
  },
  executionText: {
    fontSize: 12,
    fontWeight: "600",
    color: Theme.text,
    textTransform: "capitalize",
  },
  concernsText: {
    fontSize: 13,
    color: Theme.orange,
    lineHeight: 18,
  },
  fileText: {
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: Theme.textMuted,
    lineHeight: 20,
  },
  moreText: {
    fontSize: 12,
    color: Theme.textMuted0,
    marginTop: 4,
  },
  commentInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  commentInput: {
    flex: 1,
    backgroundColor: Theme.bgAlt,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: 14,
    color: Theme.text,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    minHeight: 40,
    maxHeight: 100,
  },
  commentSend: {
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
});
