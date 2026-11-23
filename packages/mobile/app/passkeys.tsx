// Passkeys on the phone: the web's Settings > Accounts > Touch ID. Each of the
// person's passkeys with when it was added and last used; a tap renames or
// removes it. Remove and a second Add take Touch ID (lib/presence), which the
// server requires (convex/passkeys.ts). A "Touch ID added" notification opens
// here, so a passkey the person did not add is one tap from gone.
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack } from 'expo-router';
import { useMutation } from 'convex/react';
import * as Haptics from 'expo-haptics';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { api } from '@codecast/convex/convex/_generated/api';
import { isPresenceRequired, type PasskeyMeta } from '@codecast/shared/contracts/secrets';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { Text as RNText } from '@/components/Themed';
import { formatRelativeTime } from '@/components/sessionFormat';
import { SettingsGroup, SettingsScroll, settingsStyles } from '@/components/settings/SettingsUI';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { appAlert, appPrompt, showActionSheet } from '@/lib/popups';
import { showNotice } from '@/lib/undoBar';
import { addPasskey, confirmPresence } from '@/lib/presence';

const MAX_NAME = 60;

export default function PasskeysScreen() {
  const Theme = useTheme();
  const { data: passkeys, error } = useQueryNoThrow(api.passkeys.list, {});
  const [adding, setAdding] = useState(false);

  const add = async () => {
    if (adding || passkeys === undefined) return;
    setAdding(true);
    try {
      if (await addPasskey(passkeys.length > 0)) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        showNotice('Touch ID added');
      }
    } catch (e) {
      appAlert('Touch ID', (e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Touch ID', headerBackTitle: 'Back' }} />
      <SettingsScroll>
        {passkeys === undefined ? (
          error ? (
            <SettingsGroup>
              <RNView style={settingsStyles.row}>
                <RNText style={[styles.meta, { color: Theme.red }]}>Could not load Touch ID</RNText>
              </RNView>
            </SettingsGroup>
          ) : (
            <ActivityIndicator style={{ marginTop: Spacing.xl }} color={Theme.textMuted} />
          )
        ) : (
          <>
            <SettingsGroup title={passkeys.length ? `Passkeys · ${passkeys.length}` : 'Passkeys'}>
              {passkeys.length === 0 ? (
                <RNView style={settingsStyles.row}>
                  <Glyph />
                  <RNText style={settingsStyles.muted}>Not set up</RNText>
                </RNView>
              ) : (
                passkeys.map((p) => <PasskeyRow key={p._id} passkey={p} />)
              )}
            </SettingsGroup>
            <SettingsGroup>
              <TouchableOpacity style={settingsStyles.row} onPress={() => void add()} disabled={adding} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel="Add Touch ID">
                <RNView style={settingsStyles.iconSlot}>
                  {adding ? <ActivityIndicator size="small" color={Theme.accent} /> : <MaterialCommunityIcons name="plus" size={18} color={Theme.accent} />}
                </RNView>
                <RNText style={[settingsStyles.label, { color: Theme.accent }]}>Add Touch ID</RNText>
              </TouchableOpacity>
            </SettingsGroup>
          </>
        )}
      </SettingsScroll>
    </>
  );
}

function Glyph() {
  const Theme = useTheme();
  return (
    <RNView style={settingsStyles.iconSlot}>
      <MaterialCommunityIcons name="fingerprint" size={18} color={Theme.textMuted} />
    </RNView>
  );
}

function PasskeyRow({ passkey }: { passkey: PasskeyMeta }) {
  const Theme = useTheme();
  const rename = useMutation(api.passkeys.rename);
  const remove = useMutation(api.passkeys.remove);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const drop = async () => {
    setRemoving(true);
    setError(null);
    try {
      // The server lets a removal through once per grant; a grant that lapsed on its way asks once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        const grant = await confirmPresence('remove_passkey', passkey._id);
        if (!grant) return;
        const res: any = await remove({ id: passkey._id, grant });
        if (isPresenceRequired(res)) continue;
        if (res?.error) setError(res.error);
        else {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          showNotice(`Removed ${passkey.name}`);
        }
        return;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemoving(false);
    }
  };

  const askRemove = () =>
    appAlert(`Remove ${passkey.name}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void drop() },
    ]);

  const askRename = () =>
    appPrompt('Rename', {
      defaultValue: passkey.name,
      confirm: 'Save',
      accepts: (t) => !!t.trim() && t.trim().length <= MAX_NAME,
      onSubmit: async (text) => {
        const next = text.trim();
        if (next === passkey.name) return;
        const res: any = await rename({ id: passkey._id, name: next });
        setError(res?.error ?? null);
      },
    });

  const open = () =>
    showActionSheet(passkey.name, [
      { label: 'Rename', icon: 'edit-2', onPress: askRename },
      { label: 'Remove', icon: 'trash-2', destructive: true, onPress: askRemove },
    ]);

  return (
    <TouchableOpacity style={settingsStyles.row} onPress={open} disabled={removing} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={passkey.name}>
      <Glyph />
      <RNView style={settingsStyles.rowText}>
        <RNText style={settingsStyles.label} numberOfLines={1}>{passkey.name}</RNText>
        <RNView style={styles.metaLine}>
          <RNText style={styles.meta}>added {formatRelativeTime(passkey.created_at)}</RNText>
          <RNText style={[styles.meta, !passkey.last_used_at && { color: Theme.textMuted0 }]}>
            {passkey.last_used_at ? `used ${formatRelativeTime(passkey.last_used_at)}` : 'never used'}
          </RNText>
        </RNView>
        {error ? <RNText style={[styles.meta, { color: Theme.red, marginTop: 2 }]}>{error}</RNText> : null}
      </RNView>
      {removing ? (
        <ActivityIndicator size="small" color={Theme.red} />
      ) : (
        <TouchableOpacity onPress={askRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${passkey.name}`}>
          <MaterialCommunityIcons name="trash-can-outline" size={18} color={Theme.textMuted} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  metaLine: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: 2,
  },
  meta: {
    fontSize: 13,
    color: Theme.textMuted,
  },
}));
