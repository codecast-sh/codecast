import React, { useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { parseCastDiff, type DiffFileSection } from '@codecast/web/lib/castDiff';
import { parseApplyPatchSections } from '@codecast/convex/convex/fileChanges/applyPatchParser';
import type { PatchHunk } from '@codecast/convex/convex/fileChanges/patchParser';
import { diffRows, diffStats, editHunk, type DiffRow } from '@/lib/diffRows';
import { HighlightedCodeText } from './CodeText';

// Diffs on a phone. Lines wrap rather than scroll sideways, so a whole change
// reads without scrubbing; unchanged runs fold into one row; a long diff shows
// its first rows inline and opens whole in a full-screen sheet.

const INLINE_ROWS = 24;

/** Diff rows: a line-number gutter, the +/- mark, and the wrapped line. */
export function DiffLines({ rows, numbers = true, onGapPress }: { rows: DiffRow[]; numbers?: boolean; onGapPress?: () => void }) {
  const Theme = useTheme();
  const gutter = useMemo(() => {
    let max = 0;
    for (const r of rows) if (r.kind === 'line' && r.num != null) max = Math.max(max, r.num);
    return numbers && max > 0 ? String(max).length * 6.6 + 6 : 0;
  }, [rows, numbers]);
  return (
    <RNView>
      {rows.map((r, i) => {
        if (r.kind === 'gap') {
          return (
            <TouchableOpacity key={i} disabled={!onGapPress} onPress={onGapPress} activeOpacity={0.6} style={[styles.gap, { backgroundColor: Theme.blue + '0f' }]}>
              <RNText style={[styles.gapText, onGapPress && { color: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                {onGapPress && <Feather name="chevrons-down" size={10} color={Theme.blue} />}{onGapPress ? ' ' : ''}{r.count} unchanged {r.count === 1 ? 'line' : 'lines'}
              </RNText>
            </TouchableOpacity>
          );
        }
        const tint = r.type === 'addition' ? Theme.green : r.type === 'deletion' ? Theme.red : null;
        return (
          <RNView key={i} style={[styles.row, tint ? { backgroundColor: tint + '14' } : null]}>
            {gutter > 0 && (
              <RNText style={[styles.num, { width: gutter }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{r.num ?? ''}</RNText>
            )}
            <RNText style={[styles.mark, { color: tint ?? Theme.textDim }]}>
              {r.type === 'addition' ? '+' : r.type === 'deletion' ? '-' : ' '}
            </RNText>
            <HighlightedCodeText content={r.content || ' '} style={styles.code} />
          </RNView>
        );
      })}
    </RNView>
  );
}

const STATUS: Record<DiffFileSection['status'], { label: string; tone: 'green' | 'red' | 'yellow' }> = {
  added: { label: 'A', tone: 'green' },
  deleted: { label: 'D', tone: 'red' },
  modified: { label: 'M', tone: 'yellow' },
};

/** The header every diff card shares: status, file name with its folder, line counts. */
export function DiffFileHeader({ path, status, additions, deletions, icon }: {
  path: string;
  status?: DiffFileSection['status'];
  additions: number;
  deletions: number;
  icon?: React.ReactNode;
}) {
  const Theme = useTheme();
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dir = slash > 0 ? path.slice(0, slash + 1) : '';
  const s = status ? STATUS[status] : null;
  return (
    <RNView style={styles.header}>
      {icon}
      {s && (
        <RNText style={[styles.status, { color: Theme[s.tone], backgroundColor: Theme[s.tone] + '22' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}</RNText>
      )}
      <RNText style={styles.path} numberOfLines={1} ellipsizeMode="head" maxFontSizeMultiplier={CHROME_FONT_CAP}>
        {!!dir && <RNText style={{ color: Theme.textDim }}>{dir}</RNText>}
        <RNText style={{ color: Theme.text, fontWeight: '600' }}>{name}</RNText>
      </RNText>
      {additions > 0 && <RNText style={[styles.count, { color: Theme.green }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>+{additions}</RNText>}
      {deletions > 0 && <RNText style={[styles.count, { color: Theme.red }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>−{deletions}</RNText>}
    </RNView>
  );
}

/**
 * A diff card: header, the first rows inline, and the whole diff one tap away.
 * `fullRows` is what the sheet shows (every line of a full-context diff);
 * it defaults to the folded rows.
 */
export function DiffCard({ header, rows, fullRows, numbers = true }: {
  header: React.ReactNode;
  rows: DiffRow[];
  fullRows?: DiffRow[];
  numbers?: boolean;
}) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const insets = useSafeAreaInsets();
  const clipped = rows.length > INLINE_ROWS;
  const canExpand = clipped || !!fullRows;
  return (
    <RNView style={styles.card}>
      <TouchableOpacity activeOpacity={canExpand ? 0.7 : 1} disabled={!canExpand} onPress={() => setOpen(true)}>
        <RNView style={styles.headerWrap}>
          <RNView style={{ flex: 1, minWidth: 0 }}>{header}</RNView>
          {canExpand && <FontAwesome name="expand" size={11} color={Theme.textDim} style={{ marginLeft: 8 }} />}
        </RNView>
      </TouchableOpacity>
      <DiffLines rows={clipped ? rows.slice(0, INLINE_ROWS) : rows} numbers={numbers} onGapPress={fullRows ? () => { setWhole(true); setOpen(true); } : undefined} />
      {clipped && (
        <TouchableOpacity onPress={() => setOpen(true)} activeOpacity={0.6} style={styles.more}>
          <RNText style={[styles.moreText, { color: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
            Show all {rows.length} rows
          </RNText>
        </TouchableOpacity>
      )}
      {open && (
        <Modal visible animationType="slide" onRequestClose={() => { setOpen(false); setWhole(false); }}>
          <RNView style={[styles.sheet, { paddingTop: insets.top }]}>
            <RNView style={styles.sheetHeader}>
              <RNView style={{ flex: 1, minWidth: 0 }}>{header}</RNView>
              {!!fullRows && (
                <TouchableOpacity onPress={() => setWhole((w) => !w)} hitSlop={8} activeOpacity={0.6} style={{ marginLeft: 14 }}>
                  <RNText style={[styles.moreText, { color: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                    {whole ? 'Changes only' : 'Whole file'}
                  </RNText>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => { setOpen(false); setWhole(false); }} hitSlop={8} activeOpacity={0.6} style={{ marginLeft: 14 }}>
                <FontAwesome name="close" size={16} color={Theme.textMuted} />
              </TouchableOpacity>
            </RNView>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
              <DiffLines rows={whole && fullRows ? fullRows : rows} numbers={numbers} onGapPress={fullRows ? () => setWhole(true) : undefined} />
            </ScrollView>
          </RNView>
        </Modal>
      )}
    </RNView>
  );
}

/** One file's change: its path, how it changed, and its hunks. */
export type FileDiff = {
  path: string;
  status?: DiffFileSection['status'];
  hunks: PatchHunk[];
  /** The hunks hold the whole file, so the sheet can show all of it. */
  fullContext?: boolean;
  /** False when the hunks carry no real line numbers. */
  numbers?: boolean;
};

/** A card per changed file. */
export function FileDiffCards({ files }: { files: FileDiff[] }) {
  return (
    <RNView style={{ gap: 8 }}>
      {files.map((f, i) => (
        <FileDiffCard key={`${f.path}:${i}`} file={f} />
      ))}
    </RNView>
  );
}

function FileDiffCard({ file }: { file: FileDiff }) {
  const rows = useMemo(() => diffRows(file.hunks), [file]);
  const fullRows = useMemo(() => (file.fullContext ? diffRows(file.hunks, Infinity) : undefined), [file]);
  const { additions, deletions } = diffStats(file.hunks);
  return (
    <DiffCard
      header={<DiffFileHeader path={file.path} status={file.status} additions={additions} deletions={deletions} />}
      rows={rows}
      fullRows={fullRows}
      numbers={file.numbers}
    />
  );
}

/** The ```cast-diff fence: one card per file in the patch; `fallback` when it holds no hunks. */
export function CastDiff({ raw, fallback }: { raw: string; fallback: React.ReactNode }) {
  const files = useMemo(() => parseCastDiff(raw), [raw]);
  if (!files.length) return <>{fallback}</>;
  return <FileDiffCards files={files} />;
}

const PATCH_STATUS = { Add: 'added', Delete: 'deleted', Update: 'modified' } as const;

/**
 * A Codex `apply_patch` (or a patch a shell command carried): a card per file.
 * `fallback` when no section parses.
 */
export function ApplyPatchDiff({ inputs, fallback }: { inputs: readonly string[]; fallback: React.ReactNode }) {
  const files = useMemo(
    () => inputs.flatMap(parseApplyPatchSections).map((sec): FileDiff => (
      // A Codex hunk names its place by a line of context (`@@ function x`),
      // not by numbers, so it carries no lines of its own: diff the section's
      // text before and after, as web does.
      sec.hunks.some((h) => h.lines.length)
        ? { path: sec.filePath, status: PATCH_STATUS[sec.operation], hunks: sec.hunks }
        : { path: sec.filePath, status: PATCH_STATUS[sec.operation], hunks: [editHunk(sec.oldContent, sec.newContent)], numbers: false }
    )),
    [inputs],
  );
  if (!files.length) return <>{fallback}</>;
  return <FileDiffCards files={files} />;
}

/**
 * An Edit tool call: the text it replaced against the text it wrote, as a
 * line diff. The snippet's line numbers are not the file's, so none show.
 */
export function EditDiff({ oldStr, newStr, filePath }: { oldStr: string; newStr: string; filePath: string }) {
  const hunks = useMemo(() => [editHunk(oldStr, newStr)], [oldStr, newStr]);
  const rows = useMemo(() => diffRows(hunks), [hunks]);
  const fullRows = useMemo(() => (rows.some((r) => r.kind === 'gap') ? diffRows(hunks, Infinity) : undefined), [hunks, rows]);
  const { additions, deletions } = diffStats(hunks);
  return (
    <DiffCard
      header={<DiffFileHeader path={filePath || 'edit'} additions={additions} deletions={deletions} />}
      rows={rows}
      fullRows={fullRows}
      numbers={false}
    />
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: Theme.bgAlt,
  },
  headerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  status: {
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 4,
    borderRadius: 3,
    overflow: 'hidden',
  },
  path: {
    flex: 1,
    fontSize: 12,
  },
  count: {
    fontSize: 11,
  },
  row: {
    flexDirection: 'row',
    paddingRight: 6,
  },
  num: {
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'right',
    color: Theme.textDim,
    marginRight: 4,
  },
  mark: {
    width: 14,
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 16,
  },
  code: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    color: Theme.textSecondary,
  },
  gap: {
    paddingVertical: 3,
    alignItems: 'center',
  },
  gapText: {
    fontSize: 10,
    color: Theme.textDim,
  },
  more: {
    paddingVertical: 7,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.border,
  },
  moreText: {
    fontSize: 11,
    fontWeight: '600',
  },
  sheet: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border,
  },
}));
