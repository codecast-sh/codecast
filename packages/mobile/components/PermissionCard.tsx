import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { SESSION_STATUS } from '@codecast/web/lib/sessionStatus';
import { formatToolName } from '@codecast/shared/render';
import { PERMISSION_CARD_COPY, permissionSourceTags, removalCountLabel, type PermissionRemoval } from '@codecast/shared/render/permissionCardStyle';
import { SessionStatusMark, useWebColor } from '@/components/marks';

type Permission = {
  _id: Id<"pending_permissions">;
  tool_name: string;
  arguments_preview?: string;
  status: "pending" | "cancelled" | "approved" | "denied";
  created_at: number;
  subagent_type?: string;
  subagent_conversation_id?: string;
  safety_check?: boolean;
  intent?: string;
  removals?: PermissionRemoval[];
};

type PermissionCardProps = {
  permission: Permission;
};

/** A permission prompt as web's Modern ask card draws it (ModernPermissionStack):
 *  the needs-you edge and mark, "Allow <tool>?", what the agent said it is for,
 *  the call in mono on the tinted panel, then Approve (filled) and Deny. */
export function PermissionCard({ permission }: PermissionCardProps) {
  const Theme = useTheme();
  const resolvePermission = useInboxStore((s) => s.resolvePermission);
  const needsYou = SESSION_STATUS.needs_you;
  const edge = useWebColor(needsYou.color);

  // Local-first (store resolvePermission): the row leaves the store on the
  // press, so the card disappears without waiting on the server.
  const resolve = (status: "approved" | "denied") => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    resolvePermission(permission._id, status);
  };

  if (permission.status !== "pending") {
    return null;
  }

  return (
    <View style={[styles.card, { borderLeftColor: edge }]}>
      <View style={styles.kicker}>
        <SessionStatusMark status="needs_you" />
        <Text style={[styles.word, { color: edge }]}>{needsYou.word}</Text>
        <Text style={styles.tool} numberOfLines={1}>{permission.tool_name}</Text>
        {permissionSourceTags(permission).map((t) => {
          const conv = t.kind === "subagent" ? permission.subagent_conversation_id : undefined;
          // The subagent's own conversation holds what it did before asking.
          return conv ? (
            <TouchableOpacity key={t.kind} onPress={() => router.push(`/session/${conv}` as never)} hitSlop={8}>
              <Text style={styles.tag}>{t.label + " ›"}</Text>
            </TouchableOpacity>
          ) : (
            <Text key={t.kind} style={[styles.tag, t.kind === "safety" && { color: Theme.orange }]}>{t.label}</Text>
          );
        })}
      </View>

      <Text style={styles.question}>{`Allow ${formatToolName(permission.tool_name) || permission.tool_name}?`}</Text>

      {permission.intent ? <Text style={styles.intent}>{permission.intent}</Text> : null}
      {(permission.removals ?? []).map((r, i) => (
        <Text key={i} style={styles.removal} numberOfLines={2}>
          <Text style={{ color: Theme.red }}>rm </Text>
          {r.target}
          <Text style={{ color: r.note ? Theme.textMuted : Theme.red }}>{"  " + removalCountLabel(r)}</Text>
        </Text>
      ))}

      {permission.arguments_preview ? (
        <View style={styles.preview}>
          <Text style={styles.previewText} numberOfLines={PERMISSION_CARD_COPY.argsMaxLines}>
            {permission.arguments_preview}
          </Text>
        </View>
      ) : null}

      <View style={styles.answers}>
        <TouchableOpacity accessibilityRole="button" style={[styles.button, styles.approve]} onPress={() => resolve("approved")} activeOpacity={0.7}>
          <Text style={styles.approveText}>{PERMISSION_CARD_COPY.approve}</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" style={[styles.button, styles.deny]} onPress={() => resolve("denied")} activeOpacity={0.7}>
          <Text style={styles.denyText}>{PERMISSION_CARD_COPY.deny}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = themedStyles((Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: Theme.card,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: Theme.borderLight,
      borderLeftWidth: 2,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 12,
    },
    kicker: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    word: { fontSize: 12.5, fontWeight: '500' },
    tool: { fontSize: 12.5, fontFamily: Mono.regular, color: Theme.textMuted, flexShrink: 1 },
    tag: { fontSize: 12, color: Theme.violet },
    question: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: Theme.text, marginTop: 6 },
    intent: { fontSize: 14, lineHeight: 20, color: Theme.textSecondary, marginTop: 4 },
    removal: { fontSize: 12, fontFamily: Mono.regular, color: Theme.text, marginTop: 4 },
    preview: {
      marginTop: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: Theme.borderLight,
      backgroundColor: Theme.bgInset,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    previewText: { fontSize: 12, lineHeight: 18, fontFamily: Mono.regular, color: Theme.textSecondary },
    answers: { flexDirection: 'row', gap: 8, marginTop: 12 },
    button: { minHeight: 44, paddingHorizontal: 18, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    approve: { backgroundColor: Theme.accent },
    approveText: { fontSize: 14, fontWeight: '600', color: '#fff' },
    deny: { borderWidth: 1, borderColor: Theme.borderLight, backgroundColor: Theme.card },
    denyText: { fontSize: 14, fontWeight: '500', color: Theme.text },
  }),
);
