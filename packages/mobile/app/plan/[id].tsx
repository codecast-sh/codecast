import { useMemo } from "react";
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View as RNView,
  Text as RNText,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing } from "@/constants/Theme";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { PLAN_STATUS_CONFIG } from "@/components/PlanItem";
import { TaskItemRow, showTaskActions } from "@/components/TaskItem";

type PlanStatus = keyof typeof PLAN_STATUS_CONFIG;

export default function PlanDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const plans = useInboxStore((s) => s.plans);
  const tasks = useInboxStore((s) => s.tasks);
  const updateTask = useInboxStore((s) => s.updateTask);

  const plan = useMemo(() => {
    return Object.values(plans).find((p) => p.short_id === id);
  }, [plans, id]);

  const planTasks = useMemo(() => {
    if (!plan) return [];
    return Object.values(tasks).filter((t) => t.plan?._id === plan._id);
  }, [tasks, plan]);

  const activeTasks = useMemo(
    () => planTasks.filter((t) => t.status !== "done" && t.status !== "dropped"),
    [planTasks],
  );
  const completedTasks = useMemo(
    () => planTasks.filter((t) => t.status === "done" || t.status === "dropped"),
    [planTasks],
  );

  const hasSynced = Object.keys(plans).length > 0;

  if (!plan) {
    return (
      <>
        <Stack.Screen options={{ title: id ?? "Plan" }} />
        <RNView style={styles.loading}>
          {hasSynced ? (
            <>
              <FontAwesome name="exclamation-circle" size={28} color={Theme.textMuted0} />
              <RNText style={styles.loadingText}>Plan not found</RNText>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                <RNText style={styles.backBtnText}>Go back</RNText>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <ActivityIndicator size="small" color={Theme.textMuted} />
              <RNText style={styles.loadingText}>Loading plan...</RNText>
            </>
          )}
        </RNView>
      </>
    );
  }

  const status = PLAN_STATUS_CONFIG[plan.status as PlanStatus] ?? PLAN_STATUS_CONFIG.draft;
  const progress = plan.progress;

  return (
    <>
      <Stack.Screen
        options={{
          title: plan.short_id,
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { fontSize: 15, fontWeight: "600", color: Theme.textMuted },
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <RNText style={styles.title}>{plan.title}</RNText>

        <RNView style={styles.badgeRow}>
          <RNView style={[styles.badge, { borderColor: status.color + "40" }]}>
            <FontAwesome name={status.icon} size={12} color={status.color} />
            <RNText style={[styles.badgeText, { color: status.color }]}>{status.label}</RNText>
          </RNView>

          {plan.session_count != null && plan.session_count > 0 && (
            <RNView style={[styles.badge, { borderColor: Theme.borderLight }]}>
              <FontAwesome name="terminal" size={10} color={Theme.textMuted0} />
              <RNText style={[styles.badgeText, { color: Theme.textMuted0 }]}>
                {plan.session_count} session{plan.session_count !== 1 ? "s" : ""}
              </RNText>
            </RNView>
          )}
        </RNView>

        {plan.goal && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Goal</RNText>
            <RNText style={styles.goalText}>{plan.goal}</RNText>
          </RNView>
        )}

        {progress && progress.total > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Progress</RNText>
            <RNView style={styles.progressContainer}>
              <RNView style={styles.progressBar}>
                <RNView
                  style={[
                    styles.progressDone,
                    { width: `${(progress.done / progress.total) * 100}%` as any },
                  ]}
                />
                <RNView
                  style={[
                    styles.progressIp,
                    { width: `${(progress.in_progress / progress.total) * 100}%` as any },
                  ]}
                />
              </RNView>
              <RNView style={styles.progressStats}>
                <RNText style={styles.progressStatText}>
                  <RNText style={{ color: Theme.green, fontWeight: "700" }}>{progress.done}</RNText> done
                </RNText>
                <RNText style={styles.progressStatText}>
                  <RNText style={{ color: Theme.accent, fontWeight: "700" }}>{progress.in_progress}</RNText> in progress
                </RNText>
                <RNText style={styles.progressStatText}>
                  <RNText style={{ fontWeight: "700" }}>{progress.total}</RNText> total
                </RNText>
              </RNView>
            </RNView>
          </RNView>
        )}

        {activeTasks.length > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Active Tasks ({activeTasks.length})</RNText>
            <RNView style={styles.taskList}>
              {activeTasks.map((t) => (
                <TaskItemRow
                  key={t._id}
                  task={t}
                  onPress={() => router.push(`/task/${t.short_id}` as any)}
                  onLongPress={() => showTaskActions(t, updateTask)}
                />
              ))}
            </RNView>
          </RNView>
        )}

        {completedTasks.length > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Completed ({completedTasks.length})</RNText>
            <RNView style={styles.taskList}>
              {completedTasks.map((t) => (
                <TaskItemRow
                  key={t._id}
                  task={t}
                  onPress={() => router.push(`/task/${t.short_id}` as any)}
                  onLongPress={() => showTaskActions(t, updateTask)}
                />
              ))}
            </RNView>
          </RNView>
        )}

        {planTasks.length === 0 && (
          <RNView style={styles.emptyTasks}>
            <FontAwesome name="tasks" size={24} color={Theme.textMuted0} />
            <RNText style={styles.emptyText}>No tasks linked to this plan</RNText>
          </RNView>
        )}

        <RNView style={{ height: 40 }} />
      </ScrollView>
    </>
  );
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
  goalText: {
    fontSize: 15,
    color: Theme.text,
    lineHeight: 22,
  },
  progressContainer: {
    gap: 8,
  },
  progressBar: {
    height: 6,
    backgroundColor: Theme.borderLight,
    borderRadius: 3,
    flexDirection: "row",
    overflow: "hidden",
  },
  progressDone: {
    height: 6,
    backgroundColor: Theme.green,
  },
  progressIp: {
    height: 6,
    backgroundColor: Theme.accent,
  },
  progressStats: {
    flexDirection: "row",
    gap: 16,
  },
  progressStatText: {
    fontSize: 12,
    color: Theme.textMuted,
  },
  taskList: {
    backgroundColor: Theme.bg,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    overflow: "hidden",
  },
  emptyTasks: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    color: Theme.textMuted0,
  },
});
