import { useMemo } from "react";
import { stripTitleHeading } from "@codecast/shared/docs";
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
import { Mono } from "@/constants/fonts";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useFeedLoading } from "@/hooks/useSyncWorkspaceData";
import { useSyncDocDetail } from "@codecast/web/hooks/useSyncDocs";
import { useQueryNoThrow } from "@codecast/web/hooks/useQueryNoThrow";
import { isConvexId } from "@codecast/web/store/inboxStore";
import { DOC_TYPE_CONFIG } from "@/components/DocItem";
import { MarkdownContent } from "@/components/MarkdownRenderer";
import { describeDates } from "@codecast/shared/time";

export default function DocDetailScreen() {
  const Theme = useTheme();
  const { id, share } = useLocalSearchParams<{ id: string; share?: string }>();
  const router = useRouter();
  const docs = useInboxStore((s) => s.docs);
  const docsLoading = useFeedLoading("docs");
  // The persisted body cache (docDetails): prefetched for recent docs and kept
  // by every open, so the body paints on the first frame; the live detail
  // query refreshes it.
  const docKey = id && isConvexId(id) ? id : undefined;
  const liveDetail = useSyncDocDetail(docKey);
  const cachedDetail = useInboxStore((s) => (docKey ? s.docDetails[docKey] : undefined)) as any;

  const storeDoc = useMemo(() => {
    if (!id) return undefined;
    return docs[id] ?? Object.values(docs).find((d) => d._id === id);
  }, [docs, id]);

  // A share link carries the token along (?share=). When the doc isn't in the
  // viewer's store — a guest, or a teammate before docs sync — the public
  // token query renders the same screen from the shared snapshot.
  const sharedDoc = useQueryNoThrow(
    (api as any).docs.getShared,
    !storeDoc && !cachedDetail && share ? { share_token: share } : "skip",
  ).data as any;
  const doc = storeDoc ?? cachedDetail ?? (sharedDoc || undefined);
  const docDetail = cachedDetail;

  // With a token present, "not found" is only true once ITS query settled.
  const resolved = share ? sharedDoc !== undefined : !docsLoading && liveDetail !== undefined;

  if (!doc) {
    return (
      <>
        <Stack.Screen options={{ title: "Doc" }} />
        <RNView style={styles.loading}>
          {resolved ? (
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
  // The stored body opens with the title heading; this screen prints the
  // title in its own header, so the body renders without it.
  const content = stripTitleHeading(docDetail?.content ?? doc.content ?? "");

  return (
    <>
      <Stack.Screen
        options={{
          title: cfg.label,
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { fontSize: 14, fontFamily: Mono.semiBold, color: Theme.textMuted },
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <RNText style={styles.title}>{doc.title || "Untitled"}</RNText>

        {(doc.created_at || doc.pinned) && (
          <RNView style={styles.metaRow}>
            {doc.pinned && <FontAwesome name="star" size={11} color={Theme.accent} />}
            {doc.created_at && <RNText style={styles.dates}>{describeDates(doc)}</RNText>}
          </RNView>
        )}

        {doc.labels && doc.labels.length > 0 && (
          <RNView style={styles.labelRow}>
            {doc.labels.map((l: string) => (
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
              Sessions
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
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: Spacing.md,
  },
  dates: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontVariant: ["tabular-nums"],
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
}));
