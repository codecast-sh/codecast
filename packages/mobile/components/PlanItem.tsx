import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing, themedStyles, useTheme } from "@/constants/Theme";
import { codeFont } from '@/constants/fonts';
import type { PlanItem as PlanItemType } from "@codecast/web/store/inboxStore";
import { formatRelativeTime } from "./SessionItem";
import { PlanStatusMark, ROW_MARK, webLook } from "@/components/marks";
import { PLAN_STATUS_CONFIG as WEB_PLAN_STATUS } from "@codecast/web/lib/planStatus";

type PlanStatus = "draft" | "active" | "paused" | "done" | "abandoned";

/** Web's PLAN_STATUS_CONFIG (drawn by PlanStatusMark). */
export const PLAN_STATUS_CONFIG = webLook(WEB_PLAN_STATUS as Record<PlanStatus, { label: string; color: string }>);

export const PLAN_STATUS_ORDER: PlanStatus[] = ["active", "draft", "paused", "done", "abandoned"];

export function PlanItemRow({
  plan,
  onPress,
}: {
  plan: PlanItemType;
  onPress: () => void;
}) {
  const Theme = useTheme();
  const progress = plan.progress;
  const donePct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  const ipPct = progress && progress.total > 0 ? (progress.in_progress / progress.total) * 100 : 0;

  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.6}>
      <RNView style={styles.topLine}>
        <RNView style={styles.leftGroup}>
          <RNView style={styles.statusIcon}><PlanStatusMark status={plan.status} size={ROW_MARK} /></RNView>
          <RNText style={styles.title} numberOfLines={1}>{plan.title}</RNText>
        </RNView>
        <RNText style={styles.age}>{formatRelativeTime(plan.updated_at)}</RNText>
      </RNView>

      {plan.goal && (
        <RNText style={styles.goal} numberOfLines={1}>{plan.goal}</RNText>
      )}

      <RNView style={styles.metaLine}>
        <RNText style={[styles.shortId, codeFont]}>{plan.short_id}</RNText>

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

const styles = themedStyles((Theme) => StyleSheet.create({
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
}));
