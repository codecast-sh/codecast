import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from '@/components/Themed';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import * as Haptics from 'expo-haptics';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { PERMISSION_CARD_COPY, PERMISSION_CARD_STYLE } from '@codecast/shared/render/permissionCardStyle';

type Permission = {
  _id: Id<"pending_permissions">;
  tool_name: string;
  arguments_preview?: string;
  status: "pending" | "cancelled" | "approved" | "denied";
  created_at: number;
};

type PermissionCardProps = {
  permission: Permission;
};

export function PermissionCard({ permission }: PermissionCardProps) {
  const resolvePermission = useInboxStore((s) => s.resolvePermission);

  // Local-first (store resolvePermission): the row leaves the store on the
  // press, so the card disappears without waiting on the server.
  const resolve = (status: "approved" | "denied") => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    resolvePermission(permission._id, status);
  };
  const handleApprove = () => resolve("approved");
  const handleDeny = () => resolve("denied");

  if (permission.status !== "pending") {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.indicator} />
          <Text style={styles.title}>{PERMISSION_CARD_COPY.title}</Text>
        </View>

        <Text style={styles.toolName}>{permission.tool_name}</Text>

        {permission.arguments_preview && (
          <View style={styles.argsContainer}>
            <Text style={styles.argsText} numberOfLines={PERMISSION_CARD_COPY.argsMaxLines}>
              {permission.arguments_preview}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, styles.approveButton]}
          onPress={handleApprove}
        >
          <Text style={styles.approveButtonText}>
            {PERMISSION_CARD_COPY.approve}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.denyButton]}
          onPress={handleDeny}
        >
          <Text style={styles.denyButtonText}>
            {PERMISSION_CARD_COPY.deny}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(PERMISSION_CARD_STYLE);
