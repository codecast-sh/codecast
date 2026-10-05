import { useEffect, useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text, TextInput } from '@/components/Themed';
import { BottomSheet } from '@/components/BottomSheet';
import { themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';

// Tap the session title to rename it. Same store action as web's inline title
// edit: the new title paints at once and rides the conversation patch rail.
export function RenameSessionSheet({
  conversationId,
  title,
  visible,
  onClose,
}: {
  conversationId: string;
  title: string;
  visible: boolean;
  onClose: () => void;
}) {
  const Theme = useTheme();
  const [value, setValue] = useState(title);
  useEffect(() => { if (visible) setValue(title); }, [visible, title]);

  const trimmed = value.trim();
  const canSave = !!trimmed && trimmed !== title;
  const save = () => {
    if (canSave) {
      useInboxStore.getState().renameSession(conversationId, trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={styles.label}>Rename session</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setValue}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={save}
        placeholder="Session title"
        placeholderTextColor={Theme.textMuted0}
        maxLength={200}
      />
      <View style={styles.actions}>
        <TouchableOpacity onPress={onClose} style={styles.button} activeOpacity={0.6}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={save}
          style={[styles.button, styles.saveButton, !canSave && styles.saveDisabled]}
          activeOpacity={0.7}
          accessibilityLabel="Save title"
        >
          <Text style={styles.saveText}>Save</Text>
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.textMuted,
    marginBottom: 10,
  },
  input: {
    fontSize: 16,
    color: Theme.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Theme.border + '80',
    backgroundColor: Theme.bg,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 14,
  },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 9,
  },
  cancelText: {
    fontSize: 15,
    color: Theme.textMuted,
  },
  saveButton: {
    backgroundColor: Theme.cyan,
  },
  saveDisabled: {
    opacity: 0.4,
  },
  saveText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
}));
