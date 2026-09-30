import { StyleSheet, TouchableOpacity, View, Alert } from 'react-native';
import { Text } from '@/components/Themed';
import { useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
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
  const [isProcessing, setIsProcessing] = useState(false);
  const updatePermissionStatus = useMutation(api.permissions.updatePermissionStatus);

  const handleApprove = async () => {
    if (isProcessing) return;

    setIsProcessing(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await updatePermissionStatus({
        permission_id: permission._id,
        status: "approved",
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Alert.alert("Error", `Failed to approve: ${errMsg}`);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeny = async () => {
    if (isProcessing) return;

    setIsProcessing(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await updatePermissionStatus({
        permission_id: permission._id,
        status: "denied",
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      Alert.alert("Error", `Failed to deny: ${errMsg}`);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsProcessing(false);
    }
  };

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
          style={[styles.button, styles.approveButton, isProcessing && styles.buttonDisabled]}
          onPress={handleApprove}
          disabled={isProcessing}
        >
          <Text style={styles.approveButtonText}>
            {isProcessing ? PERMISSION_CARD_COPY.processing : PERMISSION_CARD_COPY.approve}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.denyButton, isProcessing && styles.buttonDisabled]}
          onPress={handleDeny}
          disabled={isProcessing}
        >
          <Text style={styles.denyButtonText}>
            {isProcessing ? PERMISSION_CARD_COPY.processing : PERMISSION_CARD_COPY.deny}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(PERMISSION_CARD_STYLE);
