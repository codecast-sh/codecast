import { StyleSheet, TouchableOpacity, View, Text, Alert } from 'react-native';
import { useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';

type Permission = {
  _id: Id<"pending_permissions">;
  tool_name: string;
  arguments_preview?: string;
  status: "pending" | "approved" | "denied";
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
          <Text style={styles.title}>Permission Required</Text>
        </View>

        <Text style={styles.toolName}>{permission.tool_name}</Text>

        {permission.arguments_preview && (
          <View style={styles.argsContainer}>
            <Text style={styles.argsText} numberOfLines={3}>
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
            {isProcessing ? '...' : 'Approve'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.denyButton, isProcessing && styles.buttonDisabled]}
          onPress={handleDeny}
          disabled={isProcessing}
        >
          <Text style={styles.denyButtonText}>
            {isProcessing ? '...' : 'Deny'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 2,
    borderColor: 'rgba(251, 191, 36, 0.5)',
    borderRadius: 8,
    padding: 12,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    marginBottom: 12,
  },
  content: {
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fbbf24',
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#e0e0e0',
  },
  toolName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fbbf24',
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  argsContainer: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 4,
    padding: 8,
    marginTop: 8,
  },
  argsText: {
    fontSize: 11,
    color: '#999',
    fontFamily: 'monospace',
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignItems: 'center',
  },
  approveButton: {
    backgroundColor: '#4ade80',
  },
  approveButtonText: {
    color: '#0d1117',
    fontSize: 14,
    fontWeight: '600',
  },
  denyButton: {
    backgroundColor: '#ff6b6b',
  },
  denyButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
