import {
  useCallback,
  useMemo,
  useState } from 'react';
import { Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text, TextInput } from '@/components/Themed';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOwners, useOwnerCandidates, pickRoster, type OwnersApi } from '@codecast/web/hooks/useOwners';
import { useStoreOwnersEnv, useSessionRoleFacts } from '@codecast/web/hooks/useOwnersStoreEnv';
import { useSyncOrgTreeFeeder } from '@codecast/web/hooks/useSyncOrgTree';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { Theme, Spacing, chipText, CHROME_FONT_CAP, CHIP_HEIGHT, themedStyles, useTheme } from '@/constants/Theme';
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
 * Device rows are one-shot (tap moves the session and closes the sheet), and
 * so are "Take ownership" and a role under "Move to a role"; owner rows are a
 * multi-select (tap toggles, the sheet stays open).
 */

function OwnerAvatar({ name, image, size = 18 }: { name: string; image?: string; size?: number }) {
  const Theme = useTheme();
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
  const Theme = useTheme();
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
  // The store binding web uses: every owner change and role move rides the one
  // reparent path, so the inbox refiles and open questions follow the owners.
  const owners = useOwners(conversationId ?? '', useStoreOwnersEnv(conversationId ?? '', {
    teamMembers: teamMembers as any[] | undefined,
    currentUser,
    notify: (msg) => showToast(msg),
  }));
  const { ownerList, displayFor } = owners;
  const { height: windowHeight } = useWindowDimensions();

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
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={() => setSheetVisible(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16, maxHeight: windowHeight * 0.85 }]} onPress={() => {}}>
            <View style={styles.grabber} />
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

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

            <OwnerSheetRows
              owners={owners}
              conversationId={conversationId}
              activeTeamId={currentUser ? (currentUser.active_team_id ?? null) : undefined}
              onDone={() => setSheetVisible(false)}
            />
            </ScrollView>
          </Pressable>
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

/**
 * Feeds the roles slice while the sheet is open, so "Move to a role" can list
 * the workspace's roles. Its own component because the team pointer arrives
 * with the current user: mounting it only once that is known keeps the mirror
 * pointer, which mobile never writes, out of the subscription.
 */
function OrgRolesFeeder({ teamId }: { teamId: string | null }) {
  useSyncOrgTreeFeeder(teamId);
  return null;
}

/**
 * The owners half of the sheet, mobile twin of the web OwnerMenuItems: the
 * role the session reports to, "Move to a role", "Take ownership", the roster
 * as a multi-select with an optional note, and clear-all. Mounted only while
 * the sheet is open, which bounds the roster and role subscriptions to it.
 */
function OwnerSheetRows({
  owners,
  conversationId,
  activeTeamId,
  onDone,
}: {
  owners: OwnersApi;
  conversationId: string;
  // undefined while the current user loads; null is the personal workspace.
  activeTeamId: string | null | undefined;
  onDone: () => void;
}) {
  const Theme = useTheme();
  const { ownerIds, ownerList, toggle, moveToRole, clearAll, currentUser } = owners;
  const serverRoster = useOwnerCandidates(conversationId, currentUser);
  const selectable = pickRoster(serverRoster, owners.selectable).filter((m: any) => m && !m.is_bot);
  const { liveRoles, orgRoleId, currentRole, isStandingThread } = useSessionRoleFacts(conversationId);
  const [rolesOpen, setRolesOpen] = useState(false);
  // Optional note, sent along with the NEXT assignment made from this sheet.
  // It rides the notification and the assignee's "assigned to you" banner,
  // then clears once used.
  const [note, setNote] = useState('');
  const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  return (
    <>
      {activeTeamId !== undefined && <OrgRolesFeeder teamId={activeTeamId} />}
      {currentRole && (
        <>
          <Text style={styles.sectionLabel}>Reports to a role</Text>
          <View style={styles.row}>
            <FontAwesome name="sitemap" size={13} color={Theme.violet} style={{ width: 20 }} />
            <Text style={[styles.rowLabel, { flex: 1 }]} numberOfLines={1}>{currentRole.name}</Text>
            <Text style={styles.rowHint}>@{currentRole.handle}</Text>
          </View>
        </>
      )}
      {!isStandingThread && liveRoles.length > 0 && (
        <>
          <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => { tap(); setRolesOpen((o) => !o); }}>
            <FontAwesome name="sitemap" size={13} color={Theme.text} style={{ width: 20 }} />
            <Text style={[styles.rowLabel, { flex: 1 }]}>Move to a role</Text>
            <FontAwesome name={rolesOpen ? 'chevron-up' : 'chevron-down'} size={11} color={Theme.textMuted} />
          </TouchableOpacity>
          {rolesOpen && liveRoles.map((r) => {
            const isCurrent = r._id === orgRoleId;
            return (
              <TouchableOpacity
                key={r._id}
                style={[styles.row, styles.nestedRow]}
                activeOpacity={0.6}
                disabled={isCurrent}
                onPress={() => { tap(); onDone(); void moveToRole(r._id, r.name); }}
              >
                <Text style={[styles.rowLabel, { flex: 1 }, isCurrent && { color: Theme.violet }]} numberOfLines={1}>{r.name}</Text>
                <Text style={styles.rowHint}>@{r.handle}</Text>
                {isCurrent && <FontAwesome name="check" size={13} color={Theme.violet} />}
              </TouchableOpacity>
            );
          })}
          <View style={styles.divider} />
        </>
      )}

      <Text style={styles.sectionLabel}>Owners · whose inbox</Text>
      {currentUser && !currentUser.is_bot && !ownerIds.has(currentUser._id) && (
        <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => { tap(); onDone(); void toggle(currentUser._id); }}>
          <FontAwesome name="user-plus" size={13} color={Theme.cyan} style={{ width: 20 }} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.rowLabel, { color: Theme.cyan }]}>Take ownership</Text>
            <Text style={styles.rowHint}>Add to your inbox; keep existing owners</Text>
          </View>
        </TouchableOpacity>
      )}
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
              tap();
              void toggle(m._id, checked ? undefined : note);
              if (!checked) setNote('');
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
      {selectable.some((m: any) => !currentUser || m._id !== currentUser._id) && (
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Add a note with the assignment…"
          style={styles.noteInput}
          returnKeyType="done"
        />
      )}
      {ownerList.length > 0 && (
        <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => { tap(); void clearAll(); }}>
          <FontAwesome name="times" size={13} color={Theme.textMuted} style={{ width: 20 }} />
          <Text style={[styles.rowLabel, { color: Theme.textMuted }]}>Clear all owners</Text>
        </TouchableOpacity>
      )}
    </>
  );
}

/**
 * The can't-miss handoff strip pinned above the message list when the current
 * user was assigned this session by someone ELSE and hasn't acknowledged.
 * Mobile twin of the web AssignedToYouBanner: shows the assigner + their
 * optional note; "Got it" acks (server) and clears the inbox row's assigned
 * ping (local-first), so both surfaces retire together. Replying in the
 * thread also acks server-side (ackAssignmentOnEngage), which retires this
 * banner through the live listOwners query.
 */
export function AssignedToYouBanner({ conversationId }: { conversationId: string | null | undefined }) {
  const Theme = useTheme();
  // The banner only reads the viewer's own row off listOwners, so the roster
  // isn't needed — skip the team members query the chip pays for.
  const currentUser = useQuery(api.users.getCurrentUser);
  const owners = useOwners(conversationId ?? '', { teamMembers: undefined, currentUser });
  const a = owners.myAssignment;
  if (!a || !conversationId) return null;
  const by = a.added_by_name || 'A teammate';
  return (
    // Solid base under the tint: the banner floats over the message list, so a
    // translucent-only background would let text bleed through it.
    <View style={bannerStyles.base}>
    <View style={bannerStyles.wrap}>
      <FontAwesome name="user-plus" size={12} color={Theme.violet} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={bannerStyles.title}>{by} assigned this thread to you</Text>
        {a.note ? <Text style={bannerStyles.note}>“{a.note}”</Text> : null}
      </View>
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          owners.ack();
          useInboxStore.getState().clearAssignedPing(conversationId);
        }}
        hitSlop={8}
        style={bannerStyles.ack}
      >
        <Text style={bannerStyles.ackText}>Got it</Text>
      </Pressable>
    </View>
    </View>
  );
}

const bannerStyles = themedStyles((Theme) => StyleSheet.create({
  base: {
    marginHorizontal: Spacing.md,
    marginTop: 6,
    borderRadius: 10,
    backgroundColor: Theme.bgAlt,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  // Violet like the web banner: the handoff motif stays one color everywhere,
  // and on web cyan already means "the active session".
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Theme.violet + '22',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '66',
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.text,
    lineHeight: 17,
  },
  note: {
    fontSize: 12,
    color: Theme.textMuted,
    lineHeight: 16,
    marginTop: 1,
  },
  ack: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Theme.violet + '33',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '66',
  },
  ackText: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.violet,
  },
}));

const styles = themedStyles((Theme) => StyleSheet.create({
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
  nestedRow: { paddingLeft: 30 },
  noteInput: {
    fontSize: 13,
    marginTop: 4,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
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
}));
