// A call board as a column (lib/calls/boardColumn): one card per theme,
// titled by its object's chip with a "new" mark for objects this call made,
// its notes and filed cards below, folded notes opening on tap. Opening a
// fold is this reader's view only: nothing is written to the board.
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ArtifactElement } from '@codecast/shared/artifacts';
import { api } from '@codecast/convex/convex/_generated/api';
import { useLiveElements } from '@codecast/web/components/live/useLiveArtifact';
import { useEntityResolution } from '@codecast/web/lib/entityDisplay';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { Text } from '@/components/Themed';
import { EntityPill } from '@/components/EntityPill';
import { Spacing, themedStyles, useActiveScheme, useTheme } from '@/constants/Theme';
import { plainMarks, stickyPaper, BOARD_INK } from '@/components/artifacts/artifactColors';
import { buildBoardColumn, foldLabel, type ColumnGroup, type ColumnItem } from '@/lib/calls/boardColumn';

export function BoardColumn({ docId, header }: { docId: string; header?: React.ReactNode }) {
  const elements = useLiveElements(docId) as ArtifactElement[];
  const cards = useMemo(() => buildBoardColumn(elements), [elements]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {header}
      {cards.length === 0 && <Text style={styles.empty}>Nothing on the board yet</Text>}
      {cards.map((c) =>
        c.kind === 'loose' ? (
          <RNView key={c.key} style={styles.card}>
            <Text style={styles.looseTitle}>Loose</Text>
            {c.items.map((i) => <Note key={i.key} el={i.el} />)}
          </RNView>
        ) : (
          <RNView key={c.key} style={styles.card}>
            <FrameTitle group={c} docId={docId} />
            {c.folded ? (
              <Fold group={c} topLevel open={open} toggle={toggle} />
            ) : (
              c.items.map((i) => <Item key={i.key} item={i} open={open} toggle={toggle} />)
            )}
          </RNView>
        ),
      )}
    </ScrollView>
  );
}

function Item({ item, open, toggle }: { item: ColumnItem; open: ReadonlySet<string>; toggle: (k: string) => void }) {
  if (item.kind === 'note') return <Note el={item.el} />;
  if (item.folded) return <Fold group={item} topLevel={false} open={open} toggle={toggle} />;
  return (
    <RNView style={styles.sub}>
      {(item.ref || item.title) && (
        <RNView style={styles.subTitle}>
          {item.ref ? <EntityPill shortId={item.ref} fallback={item.title || item.ref} /> : <Text style={styles.subTitleText}>{item.title}</Text>}
        </RNView>
      )}
      {item.items.map((i) => <Item key={i.key} item={i} open={open} toggle={toggle} />)}
    </RNView>
  );
}

function Fold({ group, topLevel, open, toggle }: { group: ColumnGroup; topLevel: boolean; open: ReadonlySet<string>; toggle: (k: string) => void }) {
  const Theme = useTheme();
  const isOpen = open.has(group.key);
  return (
    <RNView>
      <Pressable
        onPress={() => toggle(group.key)}
        style={({ pressed }) => [styles.foldRow, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        accessibilityLabel={foldLabel(group, topLevel)}
      >
        <Ionicons name={isOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={Theme.textMuted} />
        <Text style={styles.foldText}>{foldLabel(group, topLevel)}</Text>
      </Pressable>
      {isOpen && (
        <RNView style={styles.foldBody}>
          {group.items.map((i) => <Item key={i.key} item={i} open={open} toggle={toggle} />)}
        </RNView>
      )}
    </RNView>
  );
}

/** The theme's object chip, or its own title when it has none (or can't be read). */
function FrameTitle({ group, docId }: { group: ColumnGroup; docId: string }) {
  if (!group.ref) return <Text style={styles.title}>{group.title || 'Frame'}</Text>;
  return <RefTitle refId={group.ref} title={group.title} docId={docId} />;
}

function RefTitle({ refId, title, docId }: { refId: string; title: string; docId: string }) {
  const r = useEntityResolution(refId);
  // Web's rule (BoardFrameParts): "new" when the object's call is the call whose board this is.
  const fromCall = r.entity?.from_call ? String(r.entity.from_call) : null;
  const { data: call } = useQueryNoThrow(api.transcripts.webGetCallRef, fromCall ? { ref: fromCall } : 'skip');
  const isNew = (call as { board?: string | null } | null | undefined)?.board === docId;
  if (r.served && !r.entity) return <Text style={styles.title}>{title || refId}</Text>;
  return (
    <RNView style={styles.titleRow}>
      <EntityPill shortId={refId} fallback={title || refId} />
      {isNew && <Text style={styles.newMark}>new</Text>}
    </RNView>
  );
}

function Note({ el }: { el: ArtifactElement }) {
  const Theme = useTheme();
  const dark = useActiveScheme() === 'dark';
  if (el.kind === 'card') {
    const ref = typeof el.ref === 'string' ? el.ref : '';
    // A filed card is only as wide as what it says.
    return ref ? (
      <RNView style={styles.filed}>
        <EntityPill shortId={ref} fallback={ref} />
      </RNView>
    ) : null;
  }
  const words = plainMarks(String(el.text ?? '')).trim();
  if (!words) return null;
  if (el.kind === 'sticky') {
    return (
      <RNView style={[styles.sticky, { backgroundColor: stickyPaper(el.color, Theme, dark) }]}>
        <Text style={[styles.noteText, { color: BOARD_INK }]}>{words}</Text>
      </RNView>
    );
  }
  return <Text style={styles.plain}>{words}</Text>;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Theme.bg },
  content: { padding: Spacing.md, gap: Spacing.md, paddingBottom: 40 },
  empty: { textAlign: 'center', color: Theme.textMuted, paddingVertical: 40, fontSize: 14 },
  card: {
    gap: 8,
    padding: Spacing.md,
    borderRadius: 12,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 28 },
  title: { fontSize: 15, fontWeight: '600', color: Theme.text },
  looseTitle: { fontSize: 13, fontWeight: '600', color: Theme.textMuted },
  newMark: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.violet,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: Theme.bg,
  },
  sub: { gap: 6, paddingLeft: Spacing.sm, borderLeftWidth: 2, borderLeftColor: Theme.borderLight },
  subTitle: { flexDirection: 'row', alignItems: 'center' },
  subTitleText: { fontSize: 13, fontWeight: '600', color: Theme.textMuted },
  foldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: Theme.bg,
    alignSelf: 'flex-start',
  },
  foldText: { fontSize: 13, color: Theme.textMuted },
  foldBody: { gap: 8, paddingTop: 8 },
  pressed: { opacity: 0.6 },
  sticky: { padding: 10, borderRadius: 6 },
  noteText: { fontSize: 14, lineHeight: 20 },
  plain: { fontSize: 14, lineHeight: 20, color: Theme.text },
  filed: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
  },
}));
