import {
  useCallback,
  useMemo,
  useState,
  type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, TextInput } from '@/components/Themed';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { showUndoToast } from '@platform/engine';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOwners, type OwnersApi } from '@codecast/web/hooks/useOwners';
import { useStoreOwnersEnv, useSessionRoleFacts } from '@codecast/web/hooks/useOwnersStoreEnv';
import { isDriverKey, roleOwnerOf, useOwnersMenu, useOwnersView } from '@codecast/web/hooks/useOwnersMenu';
import { useSettingsData } from '@codecast/web/hooks/useSyncSettings';
import { teamMoveTargets } from '@codecast/web/lib/ownersDraft';
import { useSyncOrgTreeFeeder } from '@codecast/web/hooks/useSyncOrgTree';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { requestSessionMove } from '@codecast/web/lib/sessionCommands';
import { Theme, Spacing, chipText, CHROME_FONT_CAP, CHIP_HEIGHT, themedStyles, useTheme } from '@/constants/Theme';
import {
  useDevices,
  deviceDisplayName,
  deviceColor,
  deviceIcon,
  relativeSeen,
  type Device,
} from './DevicesSection';
import { teamMembersOf } from '@codecast/web/lib/activeTeam';
import { OwnerFace } from './owners/OwnerFace';

/**
 * The unified assignment control for a session — mobile twin of the web's
 * AssignmentBadge. ONE chip in the session header, ONE bottom sheet, both
 * movable ownership axes: which machine RUNS it (device) and whose inboxes it
 * lives in (owners: its people and at most one role, one of which drives).
 * The axes stay independent — moving the device never changes owners and
 * vice versa — they just share a surface.
 *
 * Device rows are one-shot (tap moves the session and closes the sheet).
 * Owner changes are staged and land together on Save, as on the web.
 */

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
  const { byId, loaded } = useDevices();

  // The viewer and the roster from the persisted store (the roster is fed
  // app-wide for the active team by useSyncWorkspaceData), injected into the
  // shared owners hook so the sheet opens with every name already drawn.
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  const teamMembers = useInboxStore(teamMembersOf) as any[];
  const activeTeamId = useInboxStore((s) => (s.clientState.ui?.active_team_id ?? null)) as string | null;
  // The store binding web uses: every owner change is one applySessionOwners.
  const owners = useOwners(conversationId ?? '', useStoreOwnersEnv(conversationId ?? '', {
    teamMembers: teamMembers as any[] | undefined,
    currentUser,
    notify: (msg) => showToast(msg),
  }));
  const { people, role, driver } = useOwnersView(owners);
  const paused = !!role && driver?.kind === 'user';

  const d = ownerDeviceId ? byId.get(ownerDeviceId) : undefined;
  if (!conversationId) return null;
  const devColor = d ? deviceColor(d) : Theme.textMuted0;
  const ownerNames = [
    ...people.map((p) => `${p.name}${isDriverKey(driver, `p:${p._id}`) ? ' (driver)' : ''}`),
    ...(role ? [`${role.name}${paused ? ' (paused)' : driver?.kind === 'role' ? ' (driver)' : ''}`] : []),
  ];

  return (
    <>
      <Pressable
        onPress={() => setSheetVisible(true)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${d ? `Runs on ${deviceDisplayName(d)}` : 'No device'}; ${ownerNames.length ? `owners: ${ownerNames.join(', ')}` : 'no owners'}`}
      >
        <View style={styles.chipShell}>
          {loaded && (
            <View style={[styles.lobe, { backgroundColor: devColor + '14' }]}>
              <FontAwesome name={d ? deviceIcon(d) : 'laptop'} size={10} color={devColor} />
              <Text style={[styles.lobeText, { color: devColor }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                {d ? deviceDisplayName(d) : 'No device'}
              </Text>
              <View style={[styles.dot, { backgroundColor: d?.online ? Theme.green : Theme.textMuted0 }]} />
            </View>
          )}
          <View style={[styles.lobe, styles.facesLobe, (people.length || role) ? { backgroundColor: Theme.cyan + '14' } : null]}>
            {people.length || role ? (
              // Faces in a fixed order (people as added, then the role), the
              // driver ringed and a paused role faded; names are in the sheet.
              <View style={styles.faces}>
                {people.slice(0, 3).map((p) => (
                  <OwnerFace key={p._id} person={p} size={13} driver={isDriverKey(driver, `p:${p._id}`)} />
                ))}
                {people.length > 3 && (
                  <Text style={[styles.lobeText, { color: Theme.cyan }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>+{people.length - 3}</Text>
                )}
                {role && <OwnerFace role={role} size={13} driver={driver?.kind === 'role'} paused={paused} />}
              </View>
            ) : (
              <>
                <FontAwesome name="user-plus" size={10} color={Theme.textMuted} />
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
        {/* accessible={false} on both: a Pressable defaults to accessible, which
            would flatten the whole sheet into one VoiceOver element. */}
        <Pressable style={styles.backdrop} onPress={() => setSheetVisible(false)} accessible={false}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]} onPress={() => {}} accessible={false}>
            <View style={styles.grabber} />
            {sheetVisible && (
              <AssignmentSheetBody
                owners={owners}
                conversationId={conversationId}
                ownerDeviceId={ownerDeviceId}
                activeTeamId={activeTeamId}
                showToast={showToast}
                onDone={() => setSheetVisible(false)}
              />
            )}
          </Pressable>
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

/**
 * Feeds the roles slice while the sheet is open, so the owners half can list
 * the workspace's roles. Its own component because the team pointer arrives
 * with the current user: mounting it only once that is known keeps the mirror
 * pointer, which mobile never writes, out of the subscription.
 */
function OrgRolesFeeder({ teamId }: { teamId: string | null }) {
  useSyncOrgTreeFeeder(teamId);
  return null;
}

/**
 * The sheet's contents, mounted only while it is open (which bounds the
 * roster, role and machine subscriptions to it): the machine that runs the
 * session, one-shot, then its owners, staged and saved together. The owners
 * half is the web OwnersMenu's model (hooks/useOwnersMenu) drawn for touch:
 * every control is a visible button, nothing waits on hover.
 */
function AssignmentSheetBody({
  owners,
  conversationId,
  ownerDeviceId,
  activeTeamId,
  showToast,
  onDone,
}: {
  owners: OwnersApi;
  conversationId: string;
  ownerDeviceId?: string | null;
  // undefined while the current user loads; null is the personal workspace.
  activeTeamId: string | null | undefined;
  showToast: (msg: string) => void;
  onDone: () => void;
}) {
  const Theme = useTheme();
  const { devices } = useDevices();
  const m = useOwnersMenu(conversationId, owners);
  // A role's own session reports to someone: its owners change by moving the
  // role on the org chart, so the sheet only lists them here.
  const { seatRoleId } = useSessionRoleFacts(conversationId);
  const readOnly = m.readOnly || !!seatRoleId;
  // A leave from your own account moves the session first, to a team machine.
  const { data: boxes } = useSettingsData('agentBoxes');
  const leaveTargets = useMemo(() => teamMoveTargets(devices, (boxes ?? []) as unknown as Device[]), [devices, boxes]);
  const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

  const sortedDevices = useMemo(
    () => [...devices].sort((a, b) => Number(a.is_remote) - Number(b.is_remote) || Number(b.online) - Number(a.online) || b.last_seen - a.last_seen),
    [devices],
  );

  // The shared store's move action: it paints the move's sessionCommands row
  // (the header reads it) and dispatches it; a refusal comes back here.
  const moveTo = useCallback(
    (target: Device) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onDone();
      const name = deviceDisplayName(target);
      showToast(target.is_remote ? `Moving to ${name} — transferring the worktree…` : `Moving to ${name}…`);
      requestSessionMove(conversationId, { device_id: target.device_id, is_remote: target.is_remote, label: name })
        .catch((e: unknown) => showToast(e instanceof Error ? e.message : String(e)));
    },
    [conversationId, showToast, onDone],
  );

  const save = () => {
    tap();
    if (!m.save()) return;
    onDone();
    // The phone has no ⌘Z: the Save's undo rides the bar (a leave has none).
    if (m.diff.inverse) showUndoToast('Changed the owners');
  };

  return (
    <>
      {activeTeamId !== undefined && <OrgRolesFeeder teamId={activeTeamId} />}
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionLabel}>Device</Text>
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
                <Text style={[styles.rowLabel, isCurrent && { color }]} numberOfLines={1}>{deviceDisplayName(dev)}</Text>
                <Text style={styles.rowHint} numberOfLines={1}>
                  {isCurrent ? 'Running here' : dev.online ? (dev.is_remote ? 'Online · moves the worktree' : 'Online') : `Offline · ${relativeSeen(dev.last_seen)}`}
                </Text>
              </View>
              {isCurrent ? <FontAwesome name="check" size={13} color={color} /> : <View style={[styles.dot, { backgroundColor: dev.online ? Theme.green : Theme.textMuted0 }]} />}
            </TouchableOpacity>
          );
        })}

        <View style={styles.divider} />

        <Text style={styles.sectionLabel}>Owners · whose inbox</Text>
        {m.leaving && (
          <View style={styles.leaveBox}>
            <Text style={styles.rowHint}>Runs on your account. Move it to leave:</Text>
            {leaveTargets.length === 0 ? (
              <Text style={styles.emptyText}>No team machine to move it to</Text>
            ) : leaveTargets.map((dev: any) => (
              <TouchableOpacity
                key={dev.device_id}
                style={[styles.row, !dev.online && { opacity: 0.4 }]}
                disabled={!dev.online}
                activeOpacity={0.6}
                onPress={() => { tap(); m.leaveTo({ device_id: dev.device_id, is_remote: !!dev.is_remote, label: deviceDisplayName(dev), runner_id: String(dev.owner_user_id ?? ''), runner_is_bot: !!dev.is_bot }); }}
              >
                <FontAwesome name={deviceIcon(dev)} size={14} color={Theme.text} style={{ width: 20 }} />
                <Text style={[styles.rowLabel, { flex: 1 }]} numberOfLines={1}>{deviceDisplayName(dev)}</Text>
                <Text style={styles.rowHint}>{dev.online ? 'Move and leave' : 'offline'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {m.rows.length === 0 && <Text style={styles.emptyText}>Nobody yet</Text>}
        {m.rows.map((r) => (
          <View key={r.key} style={styles.row} testID={`owner-row-${r.key}`}>
            <OwnerFace person={r.person} role={r.role} size={22} driver={r.drives} paused={r.paused} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.rowLabel, r.paused && { color: Theme.textMuted }]} numberOfLines={1}>{r.name}</Text>
              <Text style={styles.rowHint} numberOfLines={1}>{r.sub}</Text>
            </View>
            {!readOnly && r.makeDriver && (
              <SmallButton label="Make driver" onPress={() => { tap(); m.makeDriver(r.makeDriver!); }} />
            )}
            {!readOnly && (
              <IconButton
                icon="times"
                label={r.removeLabel}
                disabled={!r.onRemove}
                onPress={() => { tap(); r.onRemove?.(); }}
              />
            )}
          </View>
        ))}
        {m.canTakeOwnership && (
          <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => { tap(); if (m.takeOwnership()) onDone(); }}>
            <FontAwesome name="user-plus" size={13} color={Theme.cyan} style={{ width: 22, textAlign: 'center' }} />
            <Text style={[styles.rowLabel, { color: Theme.cyan }]}>Take ownership</Text>
          </TouchableOpacity>
        )}

        {!readOnly && (
          <>
            <View style={styles.divider} />
            <View style={styles.search}>
              <FontAwesome name="search" size={13} color={Theme.textMuted} />
              <TextInput
                value={m.query}
                onChangeText={m.setQuery}
                placeholder={m.isStandingThread ? 'Add a teammate' : 'Add a role or teammate'}
                accessibilityLabel="Add a role or teammate"
                autoCorrect={false}
                autoCapitalize="none"
                style={styles.searchInput}
              />
            </View>
            {m.shownRoles.length > 0 && <Text style={styles.sectionLabel}>{m.q ? 'Roles' : 'Suggested roles'}</Text>}
            {m.candidates.filter((c) => c.kind === 'role').map((c) => c.kind === 'role' && (
              <CandidateRow
                key={c.key}
                face={<OwnerFace role={roleOwnerOf(c.role)} size={22} />}
                name={c.role.name}
                handle={c.role.handle}
                reason={m.reasonOf(c.role)}
                onAdd={() => { tap(); m.add(c); }}
              />
            ))}
            {!m.q && !m.moreRoles && m.restRoles.length > 0 && (
              <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => { tap(); m.setMoreRoles(true); }}>
                <FontAwesome name="chevron-down" size={11} color={Theme.textMuted} style={{ width: 22, textAlign: 'center' }} />
                <Text style={[styles.rowLabel, { color: Theme.textMuted }]}>{m.restRoles.length} more {m.restRoles.length === 1 ? 'role' : 'roles'}</Text>
              </TouchableOpacity>
            )}
            <Text style={styles.sectionLabel}>Teammates</Text>
            {m.unselected.length > 0 && (
              <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => { tap(); m.selectAllTeammates(); }}>
                <FontAwesome name="plus" size={12} color={Theme.textMuted} style={{ width: 22, textAlign: 'center' }} />
                <Text style={[styles.rowLabel, { flex: 1, color: Theme.textMuted }]}>Select all teammates</Text>
                <Text style={styles.rowHint}>{m.unselected.length}</Text>
              </TouchableOpacity>
            )}
            {m.candidates.filter((c) => c.kind === 'person').map((c) => c.kind === 'person' && (
              <CandidateRow
                key={c.key}
                face={<OwnerFace person={c.person} size={22} />}
                name={c.person.name}
                onAdd={() => { tap(); m.add(c); }}
                onDrive={() => { tap(); m.add(c, true); }}
              />
            ))}
            {m.candidates.length === 0 && <Text style={styles.emptyText}>{m.q ? 'Nobody matches' : 'Nobody else to add'}</Text>}
          </>
        )}
      </ScrollView>
      {!readOnly && (
        <View style={styles.footer}>
          <View style={styles.chips}>
            {m.chips.length
              ? m.chips.map((c) => <Text key={c} style={styles.chip} numberOfLines={1}>{c}</Text>)
              : <Text style={styles.rowHint}>No changes</Text>}
          </View>
          <View style={styles.footerButtons}>
            <TouchableOpacity style={styles.footerButton} activeOpacity={0.6} onPress={onDone} accessibilityRole="button">
              <Text style={styles.footerButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.footerButton, styles.saveButton, !m.dirty && { opacity: 0.4 }]}
              activeOpacity={0.6}
              disabled={!m.dirty}
              onPress={save}
              accessibilityRole="button"
              accessibilityState={{ disabled: !m.dirty }}
            >
              <Text style={[styles.footerButtonText, styles.saveButtonText]}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </>
  );
}

/** A role or teammate who could own it: tap the row (or +) to stage the add;
 *  a teammate's Make driver stages them as the driver too. */
function CandidateRow({ face, name, handle, reason, onAdd, onDrive }: {
  face: ReactNode;
  name: string;
  handle?: string;
  reason?: string | null;
  onAdd: () => void;
  onDrive?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={onAdd}>
      {face}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {name}{handle ? <Text style={styles.rowHint}>  @{handle}</Text> : null}
        </Text>
        {reason ? <Text style={styles.rowHint} numberOfLines={1}>{reason}</Text> : null}
      </View>
      {onDrive && <SmallButton label="Make driver" onPress={onDrive} />}
      <IconButton icon="plus" label={`Add ${name}`} onPress={onAdd} />
    </TouchableOpacity>
  );
}

function SmallButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.smallButton} activeOpacity={0.6} onPress={onPress} hitSlop={{ top: 8, bottom: 8 }} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.smallButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function IconButton({ icon, label, onPress, disabled = false }: { icon: 'times' | 'plus'; label: string; onPress: () => void; disabled?: boolean }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity
      style={[styles.iconButton, disabled && { opacity: 0.35 }]}
      activeOpacity={0.6}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
    >
      <FontAwesome name={icon} size={14} color={Theme.textMuted} />
    </TouchableOpacity>
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
  // isn't needed.
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  const owners = useOwners(conversationId ?? '', useStoreOwnersEnv(conversationId ?? '', { teamMembers: undefined, currentUser, notify: () => {} }));
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
  facesLobe: { paddingHorizontal: 4 },
  faces: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  // Same pair as MessageNavigatorSheet: the sheet caps at a share of the
  // screen and the list shrinks to fit it, so long rosters scroll.
  sheet: {
    maxHeight: '85%',
    backgroundColor: Theme.cardBg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  list: { flexGrow: 0, flexShrink: 1 },
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
    paddingVertical: 6,
    minHeight: 44,
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
  leaveBox: {
    borderRadius: 8,
    backgroundColor: Theme.bgHighlight,
    paddingHorizontal: 10,
    paddingTop: 8,
    marginBottom: 4,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
    marginBottom: 4,
  },
  // 16pt: iOS zooms the page into any smaller focused input.
  searchInput: { flex: 1, fontSize: 16, color: Theme.text, paddingVertical: 8 },
  smallButton: {
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: { fontSize: 12, fontWeight: '600', color: Theme.text },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -12 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.border,
    paddingTop: 8,
    gap: 8,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: {
    fontSize: 12,
    color: Theme.textMuted,
    backgroundColor: Theme.bgAlt,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  footerButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  footerButton: {
    minWidth: 88,
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
  },
  footerButtonText: { fontSize: 15, fontWeight: '600', color: Theme.text },
  saveButton: { backgroundColor: Theme.text, borderColor: Theme.text },
  saveButtonText: { color: Theme.bg },
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
