import { useCallback, useMemo } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, View as RNView, Text as RNText, StyleSheet } from 'react-native';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';

/**
 * Device awareness for the phone. A session runs on exactly one device; these
 * surface which one and whether it's online. The remote Mac is only ever an owner
 * via an explicit move — auto-routing lands on the most-recently-active local
 * laptop/desktop (see convex/deviceRouting).
 */

export type Device = {
  device_id: string;
  label: string;
  platform: string;
  last_seen: number;
  is_remote: boolean;
  local_project_roots: string[];
  online: boolean;
};

export function deviceDisplayName(d: Device | undefined | null): string {
  if (!d) return 'Unknown device';
  if (d.is_remote) return 'Remote Mac';
  return d.label.replace(/^(macOS|Linux|Windows)\s*-\s*/i, '').replace(/\.local$/i, '') || d.label;
}

function deviceColor(d: Device): string {
  if (d.is_remote) return Theme.violet;
  if (/linux/i.test(d.platform)) return Theme.orange;
  return Theme.cyan;
}

function deviceIcon(d: Device): React.ComponentProps<typeof FontAwesome>['name'] {
  if (d.is_remote) return 'server';
  if (/linux/i.test(d.platform)) return 'terminal';
  return 'laptop';
}

function relativeSeen(lastSeen: number): string {
  const s = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function useDevices() {
  const devices = (useQuery(api.devices.listDevices, {}) ?? []) as Device[];
  return useMemo(() => {
    const byId = new Map(devices.map((d) => [d.device_id, d]));
    return { devices, byId, loaded: devices.length > 0 };
  }, [devices]);
}

/**
 * Device picker for a session (mobile twin of the web's RunOnDeviceItems).
 * Returns a callback that opens an action sheet listing every ONLINE device
 * other than the current owner: locals offer "Run on <name>" (ownership
 * reassign — the daemon there picks the session up), the remote Mac offers
 * "Move to Remote Mac" (full worktree transfer performed by the source Mac).
 */
export function useRunOnDevice(
  conversationId: string | null | undefined,
  ownerDeviceId?: string | null,
  opts?: { notify?: (msg: string) => void },
): () => void {
  const { devices, byId } = useDevices();
  const reassign = useMutation(api.devices.reassignToDevice);
  const moveToRemote = useMutation(api.devices.moveToRemote);
  const notify = opts?.notify;

  return useCallback(() => {
    if (!conversationId) return;
    const owner = ownerDeviceId ? byId.get(ownerDeviceId) : undefined;
    const targets = devices
      .filter((d) => d.online && d.device_id !== ownerDeviceId)
      .sort((a, b) => Number(a.is_remote) - Number(b.is_remote) || b.last_seen - a.last_seen);

    const currently = owner
      ? `Currently on ${deviceDisplayName(owner)}${owner.online ? '' : ' (offline)'}.`
      : 'Not assigned to a device yet.';

    if (targets.length === 0) {
      Alert.alert('Run on Device', `${currently} No other device is online to move it to.`);
      return;
    }

    const labels = targets.map((d) =>
      d.is_remote ? `Move to ${deviceDisplayName(d)}` : `Run on ${deviceDisplayName(d)}`,
    );

    const act = (d: Device) => {
      const name = deviceDisplayName(d);
      const fail = (e: unknown) =>
        Alert.alert('Move failed', e instanceof Error ? e.message : String(e));
      if (d.is_remote) {
        moveToRemote({
          conversation_id: conversationId as Id<'conversations'>,
          to_device_id: d.device_id,
        })
          .then(() => notify?.(`Moving to ${name} — transferring the worktree…`))
          .catch(fail);
      } else {
        // Ownership flips immediately; the header chip updates live.
        reassign({
          conversation_id: conversationId as Id<'conversations'>,
          device_id: d.device_id,
        })
          .then(() => notify?.(`Now running on ${name}`))
          .catch(fail);
      }
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Run on Device',
          message: currently,
          options: [...labels, 'Cancel'],
          cancelButtonIndex: labels.length,
        },
        (idx) => {
          if (idx < targets.length) act(targets[idx]);
        },
      );
      return;
    }
    Alert.alert('Run on Device', currently, [
      ...targets.map((d, i) => ({ text: labels[i], onPress: () => act(d) })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }, [conversationId, ownerDeviceId, devices, byId, reassign, moveToRemote, notify]);
}

/**
 * Compact pill for the conversation header: which device runs this session.
 * With `onPress` it doubles as the move affordance (opens the device picker)
 * and stays visible as "Unassigned" when no device owns the session yet.
 */
export function DeviceChip({ ownerDeviceId, onPress }: { ownerDeviceId?: string | null; onPress?: () => void }) {
  const { byId, loaded } = useDevices();
  if (!loaded) return null;
  const d = ownerDeviceId ? byId.get(ownerDeviceId) : undefined;
  if (!d && !onPress) return null;
  const color = d ? deviceColor(d) : Theme.textMuted0;
  const chip = (
    <RNView style={[styles.chip, { borderColor: color + '55', backgroundColor: color + '14' }]}>
      <FontAwesome name={d ? deviceIcon(d) : 'laptop'} size={9} color={color} />
      <RNText style={[styles.chipText, { color }]} numberOfLines={1}>
        {d ? deviceDisplayName(d) : 'Unassigned'}
      </RNText>
      <RNView style={[styles.dot, { backgroundColor: d?.online ? Theme.green : Theme.textMuted0 }]} />
      {onPress && <FontAwesome name="angle-down" size={10} color={color} />}
    </RNView>
  );
  if (!onPress) return chip;
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      {chip}
    </Pressable>
  );
}

/** Full devices list for the Settings screen. */
export function DevicesSection() {
  const { devices } = useDevices();
  const sorted = useMemo(
    () =>
      [...devices].sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          Number(a.is_remote) - Number(b.is_remote) ||
          b.last_seen - a.last_seen,
      ),
    [devices],
  );

  return (
    <RNView style={styles.section}>
      <RNText style={styles.sectionTitle}>Devices</RNText>
      <RNView style={styles.card}>
        {sorted.length === 0 ? (
          <RNView style={styles.setting}>
            <RNText style={styles.empty}>No devices yet. Run the codecast daemon on a machine.</RNText>
          </RNView>
        ) : (
          sorted.map((d, i) => {
            const color = deviceColor(d);
            return (
              <RNView key={d.device_id}>
                {i > 0 && <RNView style={styles.divider} />}
                <RNView style={styles.row}>
                  <FontAwesome name={deviceIcon(d)} size={18} color={color} style={{ width: 24 }} />
                  <RNView style={{ flex: 1, minWidth: 0 }}>
                    <RNView style={styles.rowTop}>
                      <RNText style={styles.name} numberOfLines={1}>
                        {deviceDisplayName(d)}
                      </RNText>
                      {d.is_remote && (
                        <RNView style={[styles.tag, { borderColor: Theme.violet + '55' }]}>
                          <RNText style={[styles.tagText, { color: Theme.violet }]}>Remote</RNText>
                        </RNView>
                      )}
                    </RNView>
                    <RNText style={styles.sub} numberOfLines={1}>
                      {d.online ? 'Online' : `Last seen ${relativeSeen(d.last_seen)}`}
                      {d.local_project_roots.length > 0 ? ` · ${d.local_project_roots.length} checkouts` : ''}
                    </RNText>
                  </RNView>
                  <RNView style={[styles.dot, { backgroundColor: d.online ? Theme.green : Theme.textMuted0 }]} />
                </RNView>
              </RNView>
            );
          })
        )}
      </RNView>
      <RNText style={styles.footnote}>
        New sessions and messages from your phone run on your most-recently-active local machine. The remote Mac
        only runs a session you explicitly move there.
      </RNText>
    </RNView>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    maxWidth: 160,
  },
  chipText: { fontSize: 11, fontWeight: '600' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  section: { marginBottom: Spacing.xl },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
    marginLeft: Spacing.sm,
  },
  card: {
    backgroundColor: Theme.bgAlt,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    overflow: 'hidden',
  },
  setting: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 16, fontWeight: '500', color: Theme.text, flexShrink: 1 },
  sub: { fontSize: 13, color: Theme.textMuted, marginTop: 2 },
  tag: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  tagText: { fontSize: 10, fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Theme.borderLight, marginLeft: Spacing.lg },
  empty: { fontSize: 14, color: Theme.textMuted },
  footnote: { fontSize: 12, color: Theme.textMuted, marginTop: Spacing.sm, marginHorizontal: Spacing.sm, lineHeight: 17 },
});
