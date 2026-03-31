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
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Theme, Spacing } from "@/constants/Theme";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useSyncDocs } from "@/hooks/useSyncDocs";
import { DOC_TYPE_CONFIG } from "@/components/DocItem";
import { MarkdownContent } from "@/components/MarkdownRenderer";

export default function DocDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const docs = useInboxStore((s) => s.docs);
  const { ready: docsReady } = useSyncDocs();

  const doc = useMemo(() => {
    if (!id) return undefined;
    return docs[id] ?? Object.values(docs).find((d) => d._id === id);
  }, [docs, id]);

  const docDetail = useQuery(api.docs.webGet as any, doc?._id ? { id: doc._id } : "skip");

  if (!doc) {
    return (
      <>
        <Stack.Screen options={{ title: "Doc" }} />
        <RNView style={styles.loading}>
          {docsReady ? (
            <>
              <FontAwesome name="exclamation-circle" size={28} color={Theme.textMuted0} />
              <RNText style={styles.loadingText}>Document not found</RNText>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                <RNText style={styles.backBtnText}>Go back</RNText>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <ActivityIndicator size="small" color={Theme.textMuted} />
              <RNText style={styles.loadingText}>Loading...</RNText>
            </>
          )}
        </RNView>
      </>
    );
  }

  const cfg = DOC_TYPE_CONFIG[doc.doc_type] ?? DOC_TYPE_CONFIG.note;
  const content = docDetail?.content ?? doc.content ?? "";

  return (
    <>
      <Stack.Screen
        options={{
          title: cfg.label,
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { fontSize: 15, fontWeight: "600", color: Theme.textMuted },
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <RNText style={styles.title}>{doc.title || "Untitled"}</RNText>

        <RNView style={styles.badgeRow}>
          <RNView style={[styles.badge, { borderColor: cfg.color + "40" }]}>
            <FontAwesome name={cfg.icon} size={12} color={cfg.color} />
            <RNText style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</RNText>
          </RNView>

          <RNView style={[styles.badge, { borderColor: Theme.borderLight }]}>
            <FontAwesome
              name={doc.source === "human" ? "user" : "bolt"}
              size={10}
              color={doc.source === "human" ? Theme.textMuted0 : Theme.cyan}
            />
            <RNText style={[styles.badgeText, { color: Theme.textMuted0 }]}>
              {doc.source === "human" ? "Human" : doc.source || "Agent"}
            </RNText>
          </RNView>

          {doc.pinned && (
            <RNView style={[styles.badge, { borderColor: Theme.accent + "40" }]}>
              <FontAwesome name="thumb-tack" size={10} color={Theme.accent} />
              <RNText style={[styles.badgeText, { color: Theme.accent }]}>Pinned</RNText>
            </RNView>
          )}
        </RNView>

        {doc.labels && doc.labels.length > 0 && (
          <RNView style={styles.labelRow}>
            {doc.labels.map((l) => (
              <RNView key={l} style={styles.labelBadge}>
                <RNText style={styles.labelText}>{l}</RNText>
              </RNView>
            ))}
          </RNView>
        )}

        {doc.plan_short_id && (
          <TouchableOpacity
            style={styles.planLink}
            onPress={() => router.push(`/plan/${doc.plan_short_id}` as any)}
            activeOpacity={0.7}
          >
            <FontAwesome name="map-o" size={11} color={Theme.cyan} />
            <RNText style={styles.planLinkText}>Plan: {doc.plan_short_id}</RNText>
            <FontAwesome name="chevron-right" size={10} color={Theme.textMuted0} />
          </TouchableOpacity>
        )}

        {content ? (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>Content</RNText>
            <MarkdownContent text={content} baseStyle={styles.bodyText} />
          </RNView>
        ) : (
          <RNView style={styles.emptyContent}>
            <FontAwesome name="file-text-o" size={24} color={Theme.textMuted0} />
            <RNText style={styles.emptyText}>No content</RNText>
          </RNView>
        )}

        {docDetail?.related_conversations?.length > 0 && (
          <RNView style={styles.section}>
            <RNText style={styles.sectionLabel}>
              Related Sessions ({docDetail.related_conversations.length})
            </RNText>
            {docDetail.related_conversations.map((conv: any) => (
              <TouchableOpacity
                key={conv._id}
                style={styles.convRow}
                onPress={() => router.push(`/session/${conv.short_id || conv.session_id}` as any)}
                activeOpacity={0.7}
              >
                <FontAwesome name="terminal" size={11} color={Theme.textMuted0} />
                <RNText style={styles.convTitle} numberOfLines={1}>
                  {conv.title || conv.short_id || "Session"}
                </RNText>
                <FontAwesome name="chevron-right" size={10} color={Theme.textMuted0} />
              </TouchableOpacity>
            ))}
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
    marginBottom: Spacing.md,
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
  labelRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: Spacing.lg,
  },
  labelBadge: {
    backgroundColor: Theme.bgHighlight,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  labelText: {
    fontSize: 12,
    color: Theme.textMuted,
    fontWeight: "500",
  },
  planLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: Theme.bgAlt,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    marginBottom: Spacing.lg,
  },
  planLinkText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: Theme.cyan,
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
  bodyText: {
    fontSize: 14,
    color: Theme.text,
    lineHeight: 21,
  },
  emptyContent: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    color: Theme.textMuted0,
  },
  convRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  convTitle: {
    flex: 1,
    fontSize: 14,
    color: Theme.text,
  },
});
