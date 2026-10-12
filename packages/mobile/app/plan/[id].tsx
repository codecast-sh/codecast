import { useMemo, useState } from "react";
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View as RNView,
  ActivityIndicator,
} from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { api } from "@codecast/convex/convex/_generated/api";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing, themedStyles, useTheme } from "@/constants/Theme";
import { Mono, uiFace } from "@/constants/fonts";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { computePlanProgress } from "@codecast/web/lib/liveEntities";
import { useQueryNoThrow } from "@codecast/web/hooks/useQueryNoThrow";
import { useConvexSync } from "@codecast/web/hooks/useConvexSync";
import { ingestPlanDetail } from "@codecast/web/hooks/useSyncPlans";
import { inActiveWorkspace } from "@codecast/web/lib/workspaceScope";
import { useFeedLoading } from "@/hooks/useSyncWorkspaceData";
import { PLAN_STATUS_CONFIG } from "@/components/PlanItem";
import { TaskItemRow, showTaskActions } from "@/components/TaskItem";
import { MarkdownContent } from "@/components/MarkdownRenderer";
import { CollapsibleBody } from "@/components/CollapsibleBody";

type PlanStatus = keyof typeof PLAN_STATUS_CONFIG;

export default function PlanDetailScreen() {
  const Theme = useTheme();
  const { id, share } = useLocalSearchParams<{ id: string; share?: string }>();
  const router = useRouter();
  const plans = useInboxStore((s) => s.plans);
  const tasks = useInboxStore((s) => s.tasks);
  const updateTask = useInboxStore((s) => s.updateTask);
  const plansLoading = useFeedLoading("plans");

  const storePlan = useMemo(() => {
    return (id ? plans[id] : undefined) ?? Object.values(plans).find((p) => p.short_id === id);
  }, [plans, id]);

  // The detail enriches (joined tasks, sessions, body) and seeds the plans row,
  // so a plan outside the synced window lands in the store and stays cached.
  const planDetail = useQueryNoThrow(api.plans.webGet, id ? { short_id: id } : "skip").data;
  useConvexSync(planDetail, ingestPlanDetail);
  // The plan's body is its doc: a cached doc body paints before webGet answers.
  const docId = (storePlan as any)?.doc_id as string | undefined;
  const cachedBody = useInboxStore((s) => (docId ? s.docDetails[docId]?.content : undefined));

  // A share link carries the token along (?share=). For a viewer without
  // access of their own (webGet answers null), the public token query renders
  // the same screen from the shared snapshot.
  const sharedPlan = useQueryNoThrow(
    (api as any).plans.getShared,
    !storePlan && share ? { share_token: share } : "skip",
  ).data as any;

  // Fall back to the fetched server record when the plan isn't in the local
  // store yet (cold deep-link from a push/universal link, or a plan outside the
  // synced window). The store row is preferred so optimistic edits show live.
  const plan = storePlan ?? planDetail ?? (sharedPlan || undefined);

  const planTasks = useMemo(() => {
    // Store-derived (live) tasks when the plan is in the store, so a task status
    // flip moves the progress bar instantly. Otherwise use the server snapshot.
    // Plan membership AND the plan's own workspace: a cached row from another
    // team must not ride in on a stale plan pointer. The server snapshot adds
    // members the store has never cached, overlaid with any live fields.
    const live = storePlan
      ? Object.values(tasks).filter(
        (t) => t.plan?._id === storePlan._id && inActiveWorkspace(t, (storePlan as any).team_id),
      )
      : [];
    const snapshot = ((planDetail as any)?.tasks ?? sharedPlan?.tasks ?? []) as any[];
    const extra = snapshot.filter((t) => !tasks[t._id]);
    return [...live, ...extra];
  }, [tasks, storePlan, planDetail, sharedPlan]);

  const activeTasks = useMemo(
    () => planTasks.filter((t) => t.status !== "done" && t.status !== "dropped"),
    [planTasks],
  );
  const completedTasks = useMemo(
    () => planTasks.filter((t) => t.status === "done" || t.status === "dropped"),
    [planTasks],
  );

  // Only declare "not found" once the server queries have actually resolved
  // (null = no access / missing). While still loading (undefined) keep the
  // spinner so a cold deep-link doesn't flash "not found" before the fetch
  // lands. With a share token, its query must settle too.
  const [showCompleted, setShowCompleted] = useState(false);
  const hasSynced = !plansLoading && planDetail !== undefined && (!share || storePlan || sharedPlan !== undefined);

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
  // Derive live from the (store-live) task list so a status flip on this screen
  // moves the bar/counts before the server round-trips. Mirrors web.
  const progress = computePlanProgress(planTasks);

  // session_count is a server-only enrichment present on both the store row and
  // the webGet snapshot at runtime, but the generated webGet type doesn't declare
  // it — read it defensively so the union (storePlan ?? planDetail) typechecks.
  const sessionCount = (plan as { session_count?: number }).session_count;
  const body: string | undefined = ((planDetail ?? sharedPlan) as any)?.doc_content ?? cachedBody;

  return (
    <>
      <Stack.Screen
        options={{
          title: plan.short_id,
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { fontSize: 14, fontFamily: uiFace(Mono.semiBold), color: Theme.textMuted },
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <RNText style={styles.title}>{plan.title}</RNText>

        <RNView style={styles.badgeRow}>
          <RNView style={[styles.badge, { borderColor: status.color + "40" }]}>
            <FontAwesome name={status.icon} size={12} color={status.color} />
            <RNText style={[styles.badgeText, { color: status.color }]}>{status.label}</RNText>
          </RNView>

          {sessionCount != null && sessionCount > 0 && (
            <RNView style={[styles.badge, { borderColor: Theme.borderLight }]}>
              <FontAwesome name="terminal" size={10} color={Theme.textMuted0} />
              <RNText style={[styles.badgeText, { color: Theme.textMuted0 }]}>
                {sessionCount} session{sessionCount !== 1 ? "s" : ""}
              </RNText>
            </RNView>
          )}
        </RNView>

        {plan.goal && (
          <RNText style={[styles.goalText, styles.section]}>{plan.goal}</RNText>
        )}

        {body && (
          <RNView style={styles.section}>
            <CollapsibleBody fadeColor={Theme.bg} height={160}>
              <MarkdownContent text={body} baseStyle={styles.bodyText} />
            </CollapsibleBody>
          </RNView>
        )}

        {progress && progress.total > 0 && (
          <RNView style={styles.section}>
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
              <RNText style={styles.progressStatText}>
                {progress.done} of {progress.total} done{progress.in_progress ? ` · ${progress.in_progress} in progress` : ""}
              </RNText>
            </RNView>
          </RNView>
        )}

        {activeTasks.length > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Tasks</RNText>
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
            <TouchableOpacity style={styles.foldRow} onPress={() => setShowCompleted((v) => !v)} activeOpacity={0.6}>
              <RNText style={styles.sectionLabel}>{completedTasks.length} completed</RNText>
              <FontAwesome name={showCompleted ? "angle-up" : "angle-down"} size={14} color={Theme.textMuted0} />
            </TouchableOpacity>
            {showCompleted && <RNView style={styles.taskList}>
              {completedTasks.map((t) => (
                <TaskItemRow
                  key={t._id}
                  task={t}
                  onPress={() => router.push(`/task/${t.short_id}` as any)}
                  onLongPress={() => showTaskActions(t, updateTask)}
                />
              ))}
            </RNView>}
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

const styles = themedStyles((Theme) => StyleSheet.create({
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
  bodyText: {
    fontSize: 14,
    color: Theme.text,
    lineHeight: 21,
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
  foldRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
}));
