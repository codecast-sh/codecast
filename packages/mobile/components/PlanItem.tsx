import { StyleSheet, TouchableOpacity, View as RNView, Text as RNText } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing } from "@/constants/Theme";
import type { PlanItem as PlanItemType } from "@codecast/web/store/inboxStore";
import { formatRelativeTime } from "./SessionItem";

type PlanStatus = "draft" | "active" | "paused" | "done" | "abandoned";
type IconName = React.ComponentProps<typeof FontAwesome>["name"];

export const PLAN_STATUS_CONFIG: Record<PlanStatus, { icon: IconName; label: string; color: string }> = {
  draft: { icon: "circle-o", label: "Draft", color: Theme.textMuted0 },
  active: { icon: "dot-circle-o", label: "Active", color: Theme.cyan },
  paused: { icon: "pause-circle", label: "Paused", color: Theme.accent },
  done: { icon: "check-circle", label: "Done", color: Theme.green },
  abandoned: { icon: "times-circle", label: "Abandoned", color: Theme.textMuted0 },
};

export const PLAN_STATUS_ORDER: PlanStatus[] = ["active", "draft", "paused", "done", "abandoned"];

export function PlanItemRow({
  plan,
  onPress,
}: {
  plan: PlanItemType;
  onPress: () => void;
}) {
  const status = PLAN_STATUS_CONFIG[plan.status as PlanStatus] ?? PLAN_STATUS_CONFIG.draft;
  const progress = plan.progress;
  const donePct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  const ipPct = progress && progress.total > 0 ? (progress.in_progress / progress.total) * 100 : 0;

  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.6}>
      <RNView style={styles.topLine}>
        <RNView style={styles.leftGroup}>
          <FontAwesome name={status.icon} size={14} color={status.color} style={styles.statusIcon} />
          <RNText style={styles.title} numberOfLines={1}>{plan.title}</RNText>
        </RNView>
        <RNText style={styles.age}>{formatRelativeTime(plan.updated_at)}</RNText>
      </RNView>

      {plan.goal && (
        <RNText style={styles.goal} numberOfLines={1}>{plan.goal}</RNText>
      )}

      <RNView style={styles.metaLine}>
        <RNText style={styles.shortId}>{plan.short_id}</RNText>

        {progress && progress.total > 0 && (
          <>
            <RNText style={styles.sep}>·</RNText>
            <RNView style={styles.progressBar}>
              <RNView style={[styles.progressDone, { width: `${donePct}%` as any }]} />
              <RNView style={[styles.progressIp, { width: `${ipPct}%` as any }]} />
            </RNView>
            <RNText style={styles.progressText}>
              {progress.done}/{progress.total}
            </RNText>
          </>
        )}

        {(plan.session_count ?? 0) > 0 && (
          <>
            <RNText style={styles.sep}>·</RNText>
            <FontAwesome name="terminal" size={9} color={Theme.textMuted0} style={{ marginRight: 3 }} />
            <RNText style={styles.sessionCount}>{plan.session_count}</RNText>
          </>
        )}
      </RNView>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  topLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 3,
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
    fontWeight: "600",
    color: Theme.text,
    flex: 1,
    letterSpacing: -0.2,
  },
  age: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontVariant: ["tabular-nums"],
  },
  goal: {
    fontSize: 12,
    color: Theme.textMuted,
    marginLeft: 24,
    marginBottom: 4,
    lineHeight: 17,
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
  progressBar: {
    width: 48,
    height: 3,
    backgroundColor: Theme.borderLight,
    borderRadius: 2,
    flexDirection: "row",
    overflow: "hidden",
    marginRight: 4,
  },
  progressDone: {
    height: 3,
    backgroundColor: Theme.green,
  },
  progressIp: {
    height: 3,
    backgroundColor: Theme.accent,
  },
  progressText: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontVariant: ["tabular-nums"],
    fontWeight: "500",
  },
  sessionCount: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontVariant: ["tabular-nums"],
  },
});
