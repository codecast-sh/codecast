// A confirmation another of the person's devices is waiting on (a laptop with
// no passkey of its own, the desktop app before its Touch ID is set up), shown
// on the phone with what it confirms and which device asked; Face ID answers
// it (lib/presence.confirmForOtherDevice). The laptop's push
// (passkeys.askPhone) opens the app here. Mounted once at the root.
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useConvexAuth, useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { PRESENCE_PHRASE } from '@codecast/shared/contracts/secrets';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { Text } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { confirmForOtherDevice } from '@/lib/presence';
import { pickPresenceRequest } from '@/lib/presenceRequests';

export function PresenceRequests() {
  const Theme = useTheme();
  const { isAuthenticated } = useConvexAuth();
  // A two-minute challenge with no other home: read live, never stored.
  const rows = useQuery(api.passkeys.waiting, isAuthenticated ? {} : 'skip');
  const now = useCoarseNow(5_000);
  const [setAside, setSetAside] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const request = pickPresenceRequest(rows, setAside, now);
  if (!request) return null;

  const dismiss = () => setSetAside((s) => new Set(s).add(request.challenge_id));
  const confirm = async () => {
    setBusy(true);
    try {
      if (await confirmForOtherDevice(request.challenge_id, request.action, request.label)) dismiss();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal transparent animationType="slide" visible onRequestClose={dismiss}>
      <View style={styles.scrim}>
        <View style={styles.card} testID="presence-request">
          <Feather name="shield" size={22} color={Theme.cyan} />
          <Text style={styles.title}>Confirm to {PRESENCE_PHRASE[request.action]}</Text>
          {request.label ? <Text style={styles.label}>{request.label}</Text> : null}
          {request.from ? <Text style={styles.from}>from {request.from}</Text> : null}
          <Pressable style={[styles.primary, busy && styles.dim]} disabled={busy} onPress={() => void confirm()}>
            <Text style={styles.primaryText}>{busy ? 'Confirming…' : 'Confirm with Face ID'}</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={dismiss}>
            <Text style={styles.secondaryText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = themedStyles((t) =>
  StyleSheet.create({
    scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
    card: { backgroundColor: t.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: Spacing.lg, paddingBottom: Spacing.xl * 2, alignItems: 'center', gap: Spacing.sm },
    title: { fontSize: 17, fontWeight: '600', color: t.text, textAlign: 'center', marginTop: Spacing.sm },
    label: { fontSize: 14, color: t.textSecondary, textAlign: 'center' },
    from: { fontSize: 12, color: t.textMuted },
    primary: { alignSelf: 'stretch', marginTop: Spacing.md, backgroundColor: t.accent, borderRadius: 10, paddingVertical: Spacing.md, alignItems: 'center' },
    primaryText: { color: t.bg, fontWeight: '600', fontSize: 15 },
    dim: { opacity: 0.6 },
    secondary: { alignSelf: 'stretch', paddingVertical: Spacing.sm, alignItems: 'center' },
    secondaryText: { color: t.textMuted, fontSize: 14 },
  }),
);
