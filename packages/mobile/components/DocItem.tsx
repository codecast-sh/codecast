import { StyleSheet, TouchableOpacity, View as RNView, Text as RNText } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing } from "@/constants/Theme";
import type { DocItem as DocItemType } from "@codecast/web/store/inboxStore";
import { formatRelativeTime } from "./SessionItem";

type IconName = React.ComponentProps<typeof FontAwesome>["name"];

export const DOC_TYPE_CONFIG: Record<string, { icon: IconName; label: string; color: string }> = {
  note: { icon: "file-text-o", label: "Note", color: Theme.textMuted0 },
  plan: { icon: "map-o", label: "Plan", color: Theme.blue },
  design: { icon: "paint-brush", label: "Design", color: Theme.violet },
  spec: { icon: "file-code-o", label: "Spec", color: Theme.cyan },
  investigation: { icon: "search", label: "Investigation", color: Theme.accent },
  handoff: { icon: "exchange", label: "Handoff", color: Theme.orange },
};

export const DOC_TYPES = ["note", "plan", "design", "spec", "investigation", "handoff"];

export function DocItemRow({
  doc,
  onPress,
}: {
  doc: DocItemType;
  onPress: () => void;
}) {
  const cfg = DOC_TYPE_CONFIG[doc.doc_type] ?? DOC_TYPE_CONFIG.note;

  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.6}>
      <RNView style={styles.topLine}>
        <RNView style={styles.leftGroup}>
          <FontAwesome name={cfg.icon} size={13} color={cfg.color} style={styles.typeIcon} />
          <RNText style={styles.title} numberOfLines={1}>{doc.title || "Untitled"}</RNText>
          {doc.pinned && (
            <FontAwesome name="thumb-tack" size={10} color={Theme.accent} style={{ marginLeft: 4 }} />
          )}
        </RNView>
        <RNText style={styles.age}>{formatRelativeTime(doc.updated_at)}</RNText>
      </RNView>

      <RNView style={styles.metaLine}>
        <RNView style={[styles.typeBadge, { borderColor: cfg.color + "40" }]}>
          <RNText style={[styles.typeText, { color: cfg.color }]}>{cfg.label}</RNText>
        </RNView>

        {doc.source !== "human" && (
          <>
            <RNText style={styles.sep}>·</RNText>
            <FontAwesome name="bolt" size={9} color={Theme.cyan} />
          </>
        )}

        {doc.plan_short_id && (
          <>
            <RNText style={styles.sep}>·</RNText>
            <RNText style={styles.planLink}>{doc.plan_short_id}</RNText>
          </>
        )}

        {doc.labels && doc.labels.length > 0 && (
          <>
            <RNText style={styles.sep}>·</RNText>
            {doc.labels.slice(0, 2).map((l) => (
              <RNView key={l} style={styles.labelBadge}>
                <RNText style={styles.labelText}>{l}</RNText>
              </RNView>
            ))}
            {doc.labels.length > 2 && (
              <RNText style={styles.moreLabels}>+{doc.labels.length - 2}</RNText>
            )}
          </>
        )}
      </RNView>
    </TouchableOpacity>
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
  typeIcon: {
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
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 24,
    gap: 4,
  },
  typeBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  typeText: {
    fontSize: 10,
    fontWeight: "600",
  },
  sep: {
    color: Theme.textMuted0,
    fontSize: 11,
  },
  planLink: {
    fontSize: 10,
    color: Theme.cyan,
    fontWeight: "500",
  },
  labelBadge: {
    backgroundColor: Theme.bgHighlight,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  labelText: {
    fontSize: 10,
    color: Theme.textMuted,
    fontWeight: "500",
  },
  moreLabels: {
    fontSize: 10,
    color: Theme.textMuted0,
  },
});
