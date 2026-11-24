// The owners sheet's body on the phone, under the session_owners model: the
// web owners menu's model (web hooks/useOwnersMenu) drawn for touch. Owner
// rows with ×, the search, suggested roles with a reason, the rest of the
// roles, teammates and Select all, the staged changes as chips, Cancel and
// Save. Save sends the whole change in the one store action
// (applySessionOwners), which paints it at once. A viewer who may not edit
// reads the owners and may only add themselves.
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { Text, TextInput } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import type { SessionOwnersChange } from '@codecast/web/store/sessionOwnersSlice';
import { useOwnersMenu, type OwnerMenuRow } from '@codecast/web/hooks/useOwnersMenu';
import { roleOwnerOf, type SessionOwnersView } from '@codecast/web/hooks/useSessionOwners';
import { OwnerFace, ParentSessionFace, PersonFace } from './OwnerFace';
import { applyOwnersWithUndo } from '@/lib/ownersGestures';

const tap = () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

export function OwnersSheetBody({ conversationId, view, onClose }: {
  conversationId: string;
  view: SessionOwnersView;
  onClose: () => void;
}) {
  const Theme = useTheme();
  const m = useOwnersMenu(conversationId, view, { open: true });
  const apply = (change: SessionOwnersChange, inverse: SessionOwnersChange | null, words: string) => {
    applyOwnersWithUndo(conversationId, change, inverse, words);
  };
  const save = () => {
    const words = m.chips.map((c) => (c.label === 'You leave' ? 'You left' : c.gone ? `${c.label} removed` : `${c.label.replace(/^\+ /, '')} added`)).join(' · ');
    tap();
    if (m.save((change, inverse) => apply(change, inverse, words))) onClose();
  };
  const addMe = () => {
    if (!m.meId) return;
    tap();
    apply({ add: [m.meId] }, { remove: [m.meId] }, 'In your inbox');
    onClose();
  };

  const ownerRow = (r: OwnerMenuRow) => (
    <View key={r.key} style={styles.row} testID={`owner-row-${r.key}`}>
      {r.kind === 'session' ? <ParentSessionFace sessionId={r.key.slice(2)} size={22} /> : <OwnerFace person={r.person} role={r.role} size={22} />}
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1}>{r.name}</Text>
        <Text style={styles.rowHint} numberOfLines={1}>{r.sub}</Text>
      </View>
      {!m.readOnly && (
        <TouchableOpacity
          style={[styles.iconButton, !r.onRemove && { opacity: 0.3 }]}
          disabled={!r.onRemove}
          onPress={() => { tap(); r.onRemove?.(); }}
          accessibilityRole="button"
          accessibilityLabel={r.removeLabel}
          testID={`owner-remove-${r.key}`}
        >
          <FontAwesome name="times" size={14} color={Theme.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );

  const moreRoles = !m.q && m.restRoles.length > 0 ? (
    <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => { tap(); m.setMoreRoles(!m.moreRoles); }} accessibilityRole="button">
      <FontAwesome name={m.moreRoles ? 'chevron-down' : 'chevron-right'} size={11} color={Theme.textMuted} style={styles.lead} />
      <Text style={[styles.rowLabel, { color: Theme.textMuted }]}>{m.moreRoles ? 'Only suggested roles' : `${m.restRoles.length} more ${m.restRoles.length === 1 ? 'role' : 'roles'}`}</Text>
    </TouchableOpacity>
  ) : null;

  return (
    <View testID="owners-sheet">
      <Text style={styles.sectionLabel}>Owners · whose inbox</Text>
      {m.rows.map(ownerRow)}
      {m.notice ? <Text style={styles.notice} accessibilityRole="alert">{m.notice}</Text> : null}
      {m.readOnly ? (
        !view.mine && m.meId ? (
          <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={addMe} accessibilityRole="button" testID="owners-add-me">
            <FontAwesome name="plus" size={13} color={Theme.cyan} style={styles.lead} />
            <Text style={[styles.rowLabel, { color: Theme.cyan }]}>Add me</Text>
          </TouchableOpacity>
        ) : null
      ) : (
        <>
          <View style={styles.divider} />
          <View style={styles.search}>
            <FontAwesome name="search" size={12} color={Theme.textMuted} />
            <TextInput
              value={m.query}
              onChangeText={m.setQuery}
              placeholder={m.isStandingThread ? 'Add a teammate' : 'Add a role or teammate'}
              placeholderTextColor={Theme.textMuted0}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel="Add a role or teammate"
            />
          </View>
          {m.shownRoles.length > 0 && <Text style={styles.sectionLabel}>{m.q || m.moreRoles ? 'Roles' : 'Suggested roles'}</Text>}
          {m.candidates.map((c, i) => {
            const isRole = c.kind === 'role';
            const name = isRole ? c.role.name : c.person.name;
            const reason = isRole ? (!m.q && !m.moreRoles ? m.reasonOf(c.role) : null) ?? charterLine(c.role.charter) : null;
            const firstTeammate = !isRole && (i === 0 || m.candidates[i - 1].kind === 'role');
            return (
              <View key={c.key}>
                {firstTeammate && (
                  <>
                    {moreRoles}
                    <Text style={styles.sectionLabel}>Teammates</Text>
                    {!m.q && m.unselected.length > 1 && (
                      <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => { tap(); m.selectAllTeammates(); }} accessibilityRole="button" accessibilityLabel={`Select all teammates, ${m.unselected.length}`} testID="owners-select-all">
                        <FontAwesome name="users" size={12} color={Theme.textMuted} style={styles.lead} />
                        <Text style={[styles.rowLabel, { flex: 1, color: Theme.textMuted }]}>Select all teammates</Text>
                        <Text style={styles.rowHint}>{m.unselected.length}</Text>
                      </TouchableOpacity>
                    )}
                  </>
                )}
                <TouchableOpacity
                  style={styles.row}
                  activeOpacity={0.6}
                  onPress={() => { tap(); m.add(c); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${name}${isRole ? `, @${c.role.handle}` : ''}${reason ? `, ${reason}` : ''}`}
                  testID={`owner-candidate-${c.key}`}
                >
                  {isRole ? <OwnerFace role={roleOwnerOf(c.role)} size={22} /> : <PersonFace name={c.person.name} image={c.person.image} size={22} />}
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel} numberOfLines={1}>
                      {name}{isRole ? <Text style={styles.handle}>  @{c.role.handle}</Text> : null}
                    </Text>
                    {reason ? <Text style={styles.rowHint} numberOfLines={1}>{reason}</Text> : null}
                  </View>
                  <FontAwesome name="plus" size={13} color={Theme.textMuted} />
                </TouchableOpacity>
              </View>
            );
          })}
          {!m.candidates.some((c) => c.kind === 'person') && moreRoles}
          {m.candidates.length === 0 && <Text style={styles.empty}>{m.q ? `Nobody called “${m.query.trim()}”` : 'Nobody else to add'}</Text>}
          <View style={styles.divider} />
          <View style={styles.foot}>
            <View style={styles.chips}>
              {m.chips.length ? m.chips.map((c) => (
                <View key={c.key} style={styles.chip}>
                  {c.face.session ? null : <OwnerFace person={c.face.person} role={c.face.role} size={14} />}
                  <Text style={[styles.chipText, c.gone && styles.chipGone]}>{c.label}</Text>
                </View>
              )) : <Text style={styles.rowHint}>No changes</Text>}
            </View>
            <TouchableOpacity style={styles.button} onPress={() => { tap(); onClose(); }} accessibilityRole="button">
              <Text style={styles.buttonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primary, !m.dirty && { opacity: 0.4 }]}
              disabled={!m.dirty}
              onPress={save}
              accessibilityRole="button"
              accessibilityState={{ disabled: !m.dirty }}
              testID="owners-save"
            >
              <Text style={[styles.buttonText, { color: Theme.bg }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

/** What a role does, for a role with no reason to be suggested: its charter's first line. */
function charterLine(charter?: string): string | null {
  return charter?.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? null;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  sectionLabel: { fontSize: 12, color: Theme.textMuted, paddingHorizontal: 4, paddingTop: 10, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 4 },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 15, color: Theme.text },
  rowHint: { fontSize: 12, color: Theme.textMuted },
  handle: { fontSize: 12, color: Theme.textMuted },
  lead: { width: 22, textAlign: 'center' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  notice: { fontSize: 12, color: Theme.yellow, paddingHorizontal: 4, paddingVertical: 4 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Theme.border, marginVertical: 6 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 4 },
  searchInput: { flex: 1, fontSize: 16, color: Theme.text, paddingVertical: 8 },
  empty: { fontSize: 13, color: Theme.textMuted, padding: 8 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 },
  chips: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 4, minWidth: 0 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, backgroundColor: Theme.bgAlt },
  chipText: { fontSize: 12, color: Theme.textMuted },
  chipGone: { textDecorationLine: 'line-through' },
  button: { minHeight: 44, minWidth: 64, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border },
  primary: { backgroundColor: Theme.text, borderColor: Theme.text },
  buttonText: { fontSize: 14, fontWeight: '600', color: Theme.text },
}));
