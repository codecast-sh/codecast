import { useMemo } from 'react';
import { View as RNView, Text as RNText, StyleSheet } from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
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

export function deviceColor(d: Device): string {
  if (d.is_remote) return Theme.violet;
  if (/linux/i.test(d.platform)) return Theme.orange;
  return Theme.cyan;
}

export function deviceIcon(d: Device): React.ComponentProps<typeof FontAwesome>['name'] {
  if (d.is_remote) return 'server';
  if (/linux/i.test(d.platform)) return 'terminal';
  return 'laptop';
}

export function relativeSeen(lastSeen: number): string {
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
