// The owner's line on a role's page when the failover sweep moved its
// standing session off a dead host, or found nowhere to move it (convex
// roleFailover.ts). The phone twin of web's RoleFailoverNote: the same words,
// and Move back through the same store action, asking first when the move
// back changes the account the role runs and bills under.
import { Pressable, StyleSheet, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { windowOrgTree } from '@codecast/web/store/orgSlice';
import type { OrgTree } from '@codecast/web/components/org/orgTypes';
import { canEditRole } from '@codecast/web/lib/scopePage';
import { ledgerLines, moveRoleBackLedger } from '@codecast/web/components/consequential/roleOnline';
import { moveBackRefusal, roleFailoverBillsUnder, roleFailoverReasonWords } from '@codecast/shared/contracts/roleFailover';
import { useRoleMoveBack } from '@codecast/web/hooks/useRoleMoveBack';
import { appAlert } from '@/lib/popups';

export function RoleFailoverBanner({ roleShortId }: { roleShortId: string | null | undefined }) {
  const Theme = useTheme();
  const role = useInboxStore((s) => (roleShortId ? (windowOrgTree(s) as OrgTree | null)?.roles.find((r) => r.short_id === roleShortId) ?? null : null));
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const f = role?.failover;
  // Same rule as the server: a host the viewer may start sessions on, and back online.
  const back = useRoleMoveBack(f);
  if (!role || !f) return null;
  const tree = windowOrgTree(useInboxStore.getState()) as OrgTree | null;
  const nameOf = (id: string) => tree?.people.find((p) => p.user_id === id)?.name || 'a teammate';
  const stuck = !f.to;
  const tone = stuck ? Theme.red : Theme.orange;
  const under = roleFailoverBillsUnder(f, meId, nameOf);
  // A role admin, or the account that ran it there (the server's same rule).
  const canMove = !!f.to && (canEditRole(tree, role, meId) || f.from.user_id === meId);
  const refusal = back && back !== 'ok' ? moveBackRefusal(f, back, nameOf) : null;
  const facts = [roleFailoverReasonWords(f.reason), stuck ? 'no always-on machine' : null, under ? `bills under ${under}` : null, canMove ? refusal : null].filter(Boolean).join(' · ');
  const moveBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const go = () => useInboxStore.getState().moveOrgRoleBack(role._id);
    if (!f.cross_user || !f.to) { go(); return; }
    const l = moveRoleBackLedger({ handle: role.handle, name: role.name, here: f.to.label, there: f.from.label, runner: f.from.user_id === meId ? 'you' : nameOf(f.from.user_id) });
    appAlert(l.name, ledgerLines(l).join('\n'), [{ text: l.keep ?? 'Leave it', style: 'cancel' }, { text: l.confirm, style: 'destructive', onPress: go }]);
  };
  return (
    <View style={styles.base} testID="role-failover">
      <View style={[styles.wrap, { backgroundColor: tone + '22', borderColor: tone + '66' }]}>
        <FontAwesome name="exchange" size={12} color={tone} style={{ marginTop: 3 }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            <Text style={{ color: tone }}>{stuck ? 'Stuck ' : 'Moved '}</Text>
            {f.from.label}{f.to ? ` → ${f.to.label}` : ''}
          </Text>
          <Text style={styles.note} numberOfLines={2}>{facts}</Text>
        </View>
        {canMove && back !== 'not_yours' && (
          <Pressable onPress={moveBack} disabled={back !== 'ok'} hitSlop={8} style={[styles.act, { borderColor: tone + '66' }, back !== 'ok' && { opacity: 0.45 }]} testID="role-failover-back">
            <Text style={styles.actText}>Move back</Text>
          </Pressable>
        )}
        {canMove && (
          <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); useInboxStore.getState().keepOrgRoleHere(role._id); }} hitSlop={8} style={[styles.act, { borderColor: tone + '66' }]} testID="role-failover-keep">
            <Text style={styles.actText}>Keep here</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  base: { marginHorizontal: Spacing.md, marginTop: 6, borderRadius: 10, backgroundColor: Theme.bgAlt, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  wrap: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 13, fontWeight: '600', color: Theme.text, lineHeight: 17 },
  note: { fontSize: 12, color: Theme.textMuted, lineHeight: 16, marginTop: 1 },
  act: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  actText: { fontSize: 12, fontWeight: '600', color: Theme.text },
}));
