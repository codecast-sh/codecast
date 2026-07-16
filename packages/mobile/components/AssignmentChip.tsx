import { useCallback, useMemo, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOwners } from '@codecast/web/hooks/useOwners';
import { Theme, Spacing, chipText, CHROME_FONT_CAP, CHIP_HEIGHT } from '@/constants/Theme';
import {
  useDevices,
  deviceDisplayName,
  deviceColor,
  deviceIcon,
  relativeSeen,
  type Device,
} from './DevicesSection';

/**
 * The unified assignment control for a session — mobile twin of the web's
 * AssignmentBadge. ONE chip in the session header, ONE bottom sheet, both
 * movable ownership axes: which machine RUNS it (device) and whose inboxes it
 * lives in (owners). The axes stay independent — moving the device never
 * changes owners and vice versa — they just share a surface.
 *
 * Device rows are one-shot (tap moves the session and closes the sheet);
 * owner rows are a multi-select (tap toggles, the sheet stays open).
 */

function OwnerAvatar({ name, image, size = 18 }: { name: string; image?: string; size?: number }) {
  if (image) {
    return <Image source={{ uri: image }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: Theme.bgAlt,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: Theme.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: size * 0.42, fontWeight: '600', color: Theme.textMuted }}>{initials || '?'}</Text>
    </View>
  );
}

export function AssignmentChip({
  conversationId,
  ownerDeviceId,
  showToast,
}: {
  conversationId: string | null | undefined;
  ownerDeviceId?: string | null;
  showToast: (msg: string) => void;
}) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const { devices, byId, loaded } = useDevices();
  const reassign = useMutation(api.devices.reassignToDevice);
  const moveToRemote = useMutation(api.devices.moveToRemote);

  // Mobile doesn't hydrate the shared store's roster — query it per screen,
  // like the settings screen does, and inject it into the shared owners hook.
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = (currentUser?.active_team_id || currentUser?.team_id) as Id<'teams'> | undefined;
  const teamMembers = useQuery(api.teams.getTeamMembers, activeTeamId ? { team_id: activeTeamId } : 'skip');
  const owners = useOwners(conversationId ?? '', {
    teamMembers: teamMembers as any[] | undefined,
    currentUser,
    notify: (msg) => showToast(msg),
  });
  const { ownerIds, ownerList, displayFor, toggle, clearAll, selectable } = owners;

  const d = ownerDeviceId ? byId.get(ownerDeviceId) : undefined;

  const sortedDevices = useMemo(
    () =>
      [...devices].sort(
        (a, b) =>
          Number(a.is_remote) - Number(b.is_remote) ||
          Number(b.online) - Number(a.online) ||
          b.last_seen - a.last_seen,
      ),
    [devices],
  );

  const moveTo = useCallback(
    (target: Device) => {
      if (!conversationId) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setSheetVisible(false);
      const name = deviceDisplayName(target);
      const fail = (e: unknown) => showToast(e instanceof Error ? e.message : String(e));
      if (target.is_remote) {
        moveToRemote({
          conversation_id: conversationId as Id<'conversations'>,
          to_device_id: target.device_id,
        })
          .then(() => showToast(`Moving to ${name} — transferring the worktree…`))
          .catch(fail);
      } else {
        // Ownership flips immediately; the header chip updates live. A session
        // run by a teammate takes the cross-user pull path server-side.
        reassign({
          conversation_id: conversationId as Id<'conversations'>,
          device_id: target.device_id,
        })
          .then(() => showToast(`Now running on ${name}`))
          .catch(fail);
      }
    },
    [conversationId, moveToRemote, reassign, showToast],
  );

  if (!conversationId) return null;

  const devColor = d ? deviceColor(d) : Theme.textMuted0;

  return (
    <>
      <Pressable onPress={() => setSheetVisible(true)} hitSlop={8}>
        <View style={styles.chipShell}>
          {loaded && (
            <View style={[styles.lobe, { backgroundColor: devColor + '14' }]}>
              <FontAwesome name={d ? deviceIcon(d) : 'laptop'} size={10} color={devColor} />
              <Text style={[styles.lobeText, { color: devColor }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                {d ? deviceDisplayName(d) : 'Unassigned'}
              </Text>
              <View style={[styles.dot, { backgroundColor: d?.online ? Theme.green : Theme.textMuted0 }]} />
            </View>
          )}
          <View style={[styles.lobe, ownerList.length ? { backgroundColor: Theme.cyan + '14' } : null]}>
            {ownerList.length ? (
              <>
                <OwnerAvatar name={displayFor(ownerList[0]).name} image={displayFor(ownerList[0]).image} size={14} />
                <Text style={[styles.lobeText, { color: Theme.cyan }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                  {ownerList.length === 1 ? displayFor(ownerList[0]).name : `${ownerList.length} owners`}
                </Text>
              </>
            ) : (
              <>
                <FontAwesome name="user-o" size={10} color={Theme.textMuted} />
                <Text style={[styles.lobeText, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                  Assign
                </Text>
              </>
            )}
          </View>
        </View>
      </Pressable>

      <Modal
        visible={sheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetVisible(false)}
        supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
      >
        <Pressable style={styles.backdrop} onPress={() => setSheetVisible(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <View style={styles.grabber} />

            <Text style={styles.sectionLabel}>Run on device · which machine</Text>
            {sortedDevices.length === 0 && (
              <Text style={styles.emptyText}>No devices yet. Run the codecast daemon on a machine.</Text>
            )}
            {sortedDevices.map((dev) => {
              const isCurrent = dev.device_id === ownerDeviceId;
              const disabled = isCurrent || !dev.online;
              const color = deviceColor(dev);
              return (
                <TouchableOpacity
                  key={dev.device_id}
                  style={[styles.row, disabled && !isCurrent && { opacity: 0.4 }]}
                  activeOpacity={0.6}
                  disabled={disabled}
                  onPress={() => moveTo(dev)}
                >
                  <FontAwesome name={deviceIcon(dev)} size={14} color={color} style={{ width: 20 }} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.rowLabel, isCurrent && { color }]} numberOfLines={1}>
                      {dev.is_remote && !isCurrent ? `Move to ${deviceDisplayName(dev)}` : deviceDisplayName(dev)}
                    </Text>
                    <Text style={styles.rowHint} numberOfLines={1}>
                      {isCurrent
                        ? 'Running here'
                        : dev.online
                          ? dev.is_remote
                            ? 'Transfers the worktree'
                            : 'Run here'
                          : `Offline · last seen ${relativeSeen(dev.last_seen)}`}
                    </Text>
                  </View>
                  {isCurrent ? (
                    <FontAwesome name="check" size={13} color={color} />
                  ) : (
                    <View style={[styles.dot, { backgroundColor: dev.online ? Theme.green : Theme.textMuted0 }]} />
                  )}
                </TouchableOpacity>
              );
            })}

            <View style={styles.divider} />

            <Text style={styles.sectionLabel}>Owners · whose inbox</Text>
            {selectable.length === 0 && <Text style={styles.emptyText}>No teammates</Text>}
            {selectable.map((m: any) => {
              const isYou = currentUser && m._id === currentUser._id;
              const checked = ownerIds.has(m._id);
              return (
                <TouchableOpacity
                  key={m._id}
                  style={styles.row}
                  activeOpacity={0.6}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    toggle(m._id);
                  }}
                >
                  <OwnerAvatar name={m.name || m.email || '?'} image={m.image || m.github_avatar_url} />
                  <Text style={[styles.rowLabel, { flex: 1 }, checked && { color: Theme.cyan }]} numberOfLines={1}>
                    {m.name || m.email?.split('@')[0]}
                    {isYou ? ' (you)' : ''}
                  </Text>
                  {checked && <FontAwesome name="check" size={13} color={Theme.cyan} />}
                </TouchableOpacity>
              );
            })}
            {ownerList.length > 0 && (
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.6}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  clearAll();
                }}
              >
                <FontAwesome name="times" size={13} color={Theme.textMuted} style={{ width: 20 }} />
                <Text style={[styles.rowLabel, { color: Theme.textMuted }]}>Clear all owners</Text>
              </TouchableOpacity>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // Segmented twin of the shared chipShell: same height/radius/border, but the
  // horizontal padding lives in the lobes so their tints meet edge to edge.
  chipShell: {
    flexDirection: 'row',
    alignItems: 'stretch',
    height: CHIP_HEIGHT,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    borderColor: Theme.border,
    overflow: 'hidden',
    maxWidth: 210,
  },
  lobe: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
  },
  lobeText: chipText,
  dot: { width: 6, height: 6, borderRadius: 3 },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  sheet: {
    backgroundColor: Theme.cardBg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Theme.border,
    opacity: 0.5,
    marginBottom: 10,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: Theme.textDim,
    marginTop: 6,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.text,
    flexShrink: 1,
  },
  rowHint: {
    fontSize: 12,
    color: Theme.textMuted,
    marginTop: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.border,
    opacity: 0.5,
    marginVertical: 8,
  },
  emptyText: {
    fontSize: 13,
    color: Theme.textMuted,
    paddingVertical: 6,
  },
});
