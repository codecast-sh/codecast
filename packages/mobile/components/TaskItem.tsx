import { StyleSheet, TouchableOpacity, View as RNView, ActionSheetIOS } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing } from "@/constants/Theme";
import type { TaskItem as TaskItemType } from "@codecast/web/store/inboxStore";
import { formatRelativeTime } from "./SessionItem";

type TaskStatus = "backlog" | "open" | "in_progress" | "in_review" | "done" | "dropped";
type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

type IconName = React.ComponentProps<typeof FontAwesome>["name"];

export const STATUS_CONFIG: Record<TaskStatus, { icon: IconName; label: string; color: string }> = {
  backlog: { icon: "circle-thin", label: "Backlog", color: Theme.textMuted0 },
  open: { icon: "circle-o", label: "Open", color: Theme.blue },
  in_progress: { icon: "dot-circle-o", label: "In Progress", color: Theme.accent },
  in_review: { icon: "dot-circle-o", label: "In Review", color: Theme.violet },
  done: { icon: "check-circle", label: "Done", color: Theme.green },
  dropped: { icon: "times-circle", label: "Dropped", color: Theme.textMuted0 },
};

export const PRIORITY_CONFIG: Record<TaskPriority, { icon: IconName; label: string; color: string }> = {
  urgent: { icon: "exclamation-triangle", label: "Urgent", color: Theme.red },
  high: { icon: "arrow-up", label: "High", color: Theme.orange },
  medium: { icon: "minus", label: "Medium", color: Theme.textMuted },
  low: { icon: "arrow-down", label: "Low", color: Theme.textDim },
  none: { icon: "minus", label: "None", color: Theme.textMuted0 },
};

export const STATUS_ORDER: TaskStatus[] = ["backlog", "open", "in_progress", "in_review", "done", "dropped"];
export const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

const LABEL_COLORS: Record<string, string> = {
  bug: Theme.red,
  feature: Theme.blue,
  chore: Theme.textMuted,
  refactor: Theme.violet,
  docs: Theme.cyan,
  test: Theme.green,
  perf: Theme.orange,
};

export function TaskItemRow({
  task,
  onPress,
  onLongPress,
  indent = 0,
  descendantCount = 0,
  hiddenDescendantCount = 0,
}: {
  task: TaskItemType;
  onPress: () => void;
  onLongPress?: () => void;
  /** Nesting depth, already clamped to the emphasised top levels by buildTaskTree. */
  indent?: number;
  /** Live subtasks below this one across the workspace, not just this view. */
  descendantCount?: number;
  /** How many of those this view isn't rendering (agent-internal ones, usually). */
  hiddenDescendantCount?: number;
}) {
  const status = STATUS_CONFIG[task.status as TaskStatus] ?? STATUS_CONFIG.open;
  const priority = PRIORITY_CONFIG[task.priority as TaskPriority] ?? PRIORITY_CONFIG.medium;
  const labels = task.labels?.slice(0, 2) ?? [];
  const extraLabels = (task.labels?.length ?? 0) - 2;

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      // Indent a subtask and hang a rail off its left edge, matching web.
      style={[
        styles.row,
        indent > 0 && {
          paddingLeft: Spacing.lg + indent * 14,
          borderLeftWidth: StyleSheet.hairlineWidth,
          borderLeftColor: Theme.bgHighlight,
        },
      ]}
      activeOpacity={0.6}
    >
      <RNView style={styles.topLine}>
        <RNView style={styles.leftGroup}>
          <FontAwesome name={status.icon} size={14} color={status.color} style={styles.statusIcon} />
          <RNText style={styles.title} numberOfLines={1}>
            {task.title}
          </RNText>
        </RNView>
        <RNView style={styles.rightGroup}>
          {descendantCount > 0 && (
            // The count comes from the whole workspace, so a parent still
            // reports agent work filed under it even when the board hides
            // those rows. The robot marks that some of them are hidden here.
            <RNView style={styles.subtaskChip}>
              {hiddenDescendantCount > 0 && (
                <FontAwesome name="android" size={8} color={Theme.cyan} style={{ marginRight: 3 }} />
              )}
              <RNText style={styles.subtaskCount}>{descendantCount}</RNText>
            </RNView>
          )}
          <FontAwesome name={priority.icon} size={10} color={priority.color} />
          <RNText style={styles.age}>{formatRelativeTime(task.updated_at)}</RNText>
        </RNView>
      </RNView>

      <RNView style={styles.metaLine}>
        <RNText style={styles.shortId}>{task.short_id}</RNText>

        {task.plan && (
          <>
            <RNText style={styles.sep}>·</RNText>
            <FontAwesome name="map" size={9} color={Theme.cyan} style={{ marginRight: 3 }} />
            <RNText style={styles.planRef} numberOfLines={1}>{task.plan.title}</RNText>
          </>
        )}

        {labels.length > 0 && (
          <>
            <RNText style={styles.sep}>·</RNText>
            {labels.map((l) => (
              <RNView
                key={l}
                style={[styles.label, { borderColor: LABEL_COLORS[l] ?? Theme.textMuted0 }]}
              >
                <RNText style={[styles.labelText, { color: LABEL_COLORS[l] ?? Theme.textMuted0 }]}>
                  {l}
                </RNText>
              </RNView>
            ))}
            {extraLabels > 0 && (
              <RNText style={styles.extraLabels}>+{extraLabels}</RNText>
            )}
          </>
        )}

        {task.activeSession && (
          <>
            <RNText style={styles.sep}>·</RNText>
            <RNView style={styles.activeDot} />
          </>
        )}
      </RNView>
    </TouchableOpacity>
  );
}

export function showTaskActions(
  task: TaskItemType,
  onUpdate: (shortId: string, fields: Record<string, any>) => void,
) {
  const currentStatusIdx = STATUS_ORDER.indexOf(task.status as TaskStatus);
  const statusOptions = STATUS_ORDER.filter((_, i) => i !== currentStatusIdx);
  const priorityOptions: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];
  const currentPriority = task.priority;

  ActionSheetIOS.showActionSheetWithOptions(
    {
      options: [
        ...statusOptions.map((s) => `→ ${STATUS_CONFIG[s].label}`),
        ...priorityOptions
          .filter((p) => p !== currentPriority)
          .map((p) => `▲ ${PRIORITY_CONFIG[p].label}`),
        "Cancel",
      ],
      cancelButtonIndex: statusOptions.length + priorityOptions.filter((p) => p !== currentPriority).length,
      title: task.short_id,
      message: task.title,
    },
    (idx) => {
      if (idx < statusOptions.length) {
        onUpdate(task.short_id, { status: statusOptions[idx] });
      } else {
        const prioIdx = idx - statusOptions.length;
        const prioFiltered = priorityOptions.filter((p) => p !== currentPriority);
        if (prioIdx < prioFiltered.length) {
          onUpdate(task.short_id, { priority: prioFiltered[prioIdx] });
        }
      }
    },
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  topLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  leftGroup: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginRight: Spacing.sm,
  },
  statusIcon: {
    marginRight: 8,
    width: 16,
    textAlign: "center",
  },
  title: {
    fontSize: 15,
    fontWeight: "500",
    color: Theme.text,
    flex: 1,
    letterSpacing: -0.2,
  },
  rightGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  age: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontVariant: ["tabular-nums"],
  },
  subtaskChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.bgHighlight,
  },
  subtaskCount: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontVariant: ["tabular-nums"],
  },
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 24,
  },
  shortId: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
  sep: {
    color: Theme.textMuted0,
    marginHorizontal: 4,
    fontSize: 11,
  },
  planRef: {
    fontSize: 11,
    color: Theme.cyan,
    fontWeight: "500",
    maxWidth: 100,
  },
  label: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginRight: 4,
  },
  labelText: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  extraLabels: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontWeight: "500",
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.greenBright,
  },
});
