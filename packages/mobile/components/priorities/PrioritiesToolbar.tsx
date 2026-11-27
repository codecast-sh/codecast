// The phone Priorities list's one row of view controls (web's
// PrioritiesToolbar): a chip per workspace (filled when shown, dashed and dim
// when turned off) scrolling sideways under edge fades, then Group by (a
// picker sheet) and Compact as 44pt icons. Which of them show is web's
// lib/prioritySections pageControls; the choices ride
// clientState.ui.priorities_view (hooks/usePriorityList), so they follow the
// person to every device. Also the marks the list's headings and rows share:
// a workspace's icon and a person's face.
import { useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import type { PriorityRow } from '@codecast/shared/contracts/priorities';
import { GROUP_BY_LABEL, type GroupBy, type PageControls } from '@codecast/web/lib/prioritySections';
import { sameEdges, scrollEdges, type ScrollEdges } from '@codecast/web/lib/scrollEdges';
import { workspaceMarkOf } from '@codecast/web/store/priorityOrder';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import type { PrioritiesViewPatch, PrioritiesViewPrefs } from '@/hooks/usePriorityList';
import { TEAM_ICON_EMOJI } from '@/lib/teamIconEmoji';
import { groupBySheet, toggleHidden } from '@/lib/prioritiesList';
import { showActionSheet } from '@/lib/popups';

/** A workspace's mark: the person icon for the viewer's own, else its team's emoji, else the team glyph. */
export function WorkspaceMark({ workspace, size = 13, dim }: { workspace: string; size?: number; dim?: boolean }) {
  const Theme = useTheme();
  const teams = useInboxStore((s) => s.teams);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const mark = workspaceMarkOf(workspace, teams, viewerId);
  const opacity = dim ? 0.5 : 1;
  if (!mark || mark.personal) return <Feather name="user" size={size} color={Theme.textMuted} style={{ opacity }} />;
  const emoji = mark.icon ? TEAM_ICON_EMOJI[mark.icon] : undefined;
  if (emoji) return <RNText style={{ fontSize: size - 1, opacity }}>{emoji}</RNText>;
  return <Feather name="users" size={size} color={Theme.textMuted} style={{ opacity }} />;
}

/** A priority's owner's face (their image, else their initial); the viewer's reads "You". */
export function OwnerFace({ row, size = 18 }: { row: Pick<PriorityRow, 'owner' | 'owner_image' | 'mine'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: size / 2 };
  const label = row.mine ? 'You' : row.owner;
  if (row.owner_image && !failed) {
    return <Image source={{ uri: row.owner_image }} style={box} accessibilityLabel={label} onError={() => setFailed(true)} />;
  }
  return (
    <RNView style={[styles.initial, box]} accessible accessibilityLabel={label}>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.initialText, { fontSize: Math.round(size * 0.55) }]}>{row.owner.trim()[0]?.toUpperCase() || '?'}</RNText>
    </RNView>
  );
}

const FADE = 24;

export function PrioritiesToolbar({ controls, view, groupBy, onChange }: {
  controls: PageControls;
  view: PrioritiesViewPrefs;
  /** The grouping the list draws (lib/prioritySections effectiveGroupBy). */
  groupBy: GroupBy;
  onChange: (patch: PrioritiesViewPatch) => void;
}) {
  const Theme = useTheme();
  const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false });
  const scroll = useRef(0);
  const viewport = useRef(0);
  const content = useRef(0);
  const measure = () => {
    const next = scrollEdges(scroll.current, viewport.current, content.current);
    setEdges((e) => (sameEdges(e, next) ? e : next));
  };
  const pickGroupBy = () => showActionSheet('Group by', groupBySheet(controls.groupByOptions, groupBy, (g) => onChange({ group_by: g })));
  return (
    <RNView style={styles.bar} testID="priorities-toolbar">
      <RNView style={styles.chipsBox}>
        {controls.showChips && (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
              testID="priorities-chips"
              scrollEventThrottle={32}
              onScroll={(e) => { scroll.current = e.nativeEvent.contentOffset.x; measure(); }}
              onLayout={(e) => { viewport.current = e.nativeEvent.layout.width; measure(); }}
              onContentSizeChange={(w) => { content.current = w; measure(); }}
            >
              {controls.workspaces.map((w) => {
                const on = !view.hidden.includes(w.key);
                return (
                  <TouchableOpacity
                    key={w.key}
                    onPress={() => onChange({ hidden: toggleHidden(view.hidden, w.key) })}
                    style={styles.chipPress}
                    accessibilityRole="button"
                    accessibilityLabel={w.name}
                    accessibilityState={{ selected: on }}
                    accessibilityHint={on ? `Hides ${w.name}` : `Shows ${w.name}`}
                    testID={`priorities-chip-${w.key}`}
                  >
                    <RNView style={[styles.chip, on ? styles.chipOn : styles.chipOff]}>
                      <WorkspaceMark workspace={w.key} size={12} dim={!on} />
                      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} numberOfLines={1} style={[styles.chipText, !on && { color: Theme.textDim }]}>{w.name}</RNText>
                    </RNView>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {/* A fade on each edge with chips past it: the right while more lie that way, the left once scrolled. */}
            {edges.left && <EdgeFade side="left" />}
            {edges.right && <EdgeFade side="right" />}
          </>
        )}
      </RNView>
      {controls.showGroupBy && (
        <TouchableOpacity
          onPress={pickGroupBy}
          style={styles.icon}
          accessibilityRole="button"
          accessibilityLabel={`Grouped by ${GROUP_BY_LABEL[groupBy].toLowerCase()}`}
          testID="priorities-group-by"
        >
          <Feather name="layers" size={16} color={Theme.textMuted} />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        onPress={() => onChange({ compact: !view.compact })}
        style={[styles.icon, view.compact && { backgroundColor: Theme.bgAlt }]}
        accessibilityRole="button"
        accessibilityLabel="Compact"
        accessibilityState={{ selected: view.compact }}
        testID="priorities-compact"
      >
        <Feather name="align-justify" size={16} color={view.compact ? Theme.text : Theme.textMuted} />
      </TouchableOpacity>
    </RNView>
  );
}

/** The fade over one edge of the chip row, toward the page's background. */
function EdgeFade({ side }: { side: 'left' | 'right' }) {
  const Theme = useTheme();
  const id = `chipFade-${side}`;
  return (
    <RNView pointerEvents="none" style={[styles.fade, side === 'left' ? { left: 0 } : { right: 0 }]} testID={`priorities-chips-fade-${side}`}>
      <Svg width={FADE} height="100%">
        <Defs>
          <LinearGradient id={id} x1={side === 'left' ? '1' : '0'} y1="0" x2={side === 'left' ? '0' : '1'} y2="0">
            <Stop offset="0" stopColor={Theme.bg} stopOpacity={0} />
            <Stop offset="1" stopColor={Theme.bg} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={FADE} height="100%" fill={`url(#${id})`} />
      </Svg>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 4 },
  chipsBox: { flex: 1, minWidth: 0 },
  chips: { alignItems: 'center', gap: 6 },
  chipPress: { minHeight: 44, justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 11, borderRadius: 15, borderWidth: 1 },
  chipOn: { borderColor: Theme.border, backgroundColor: Theme.bgAlt },
  chipOff: { borderColor: Theme.border, borderStyle: 'dashed' },
  chipText: { fontSize: 12.5, fontWeight: '500', color: Theme.text },
  fade: { position: 'absolute', top: 0, bottom: 0, width: FADE },
  icon: { width: 44, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  initial: { alignItems: 'center', justifyContent: 'center', backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border },
  initialText: { fontWeight: '500', color: Theme.textMuted },
}));
