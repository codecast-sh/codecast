// A live artifact (board, sheet, dashboard) drawn natively inside the doc
// screen. The data path is the web's own (components/live/useLiveArtifact):
// the same feeders fill the shared store, reads paint from it, and writes are
// ops through the same handle, so a phone edit is a web edit.
import { ActivityIndicator, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ArtifactType } from '@codecast/shared/artifacts';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useLiveArtifact, useLiveElements, type LiveHandle } from '@codecast/web/components/live/useLiveArtifact';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { BoardCanvas } from './BoardCanvas';
import { SheetGrid } from './SheetGrid';
import { DashboardBlocks } from './DashboardBlocks';

export type ArtifactDoc = { _id: string; title: string; doc_type: ArtifactType; archived_at?: number };
export type ArtifactBodyProps = { doc: ArtifactDoc; live: LiveHandle; editable: boolean };

export function ArtifactView({ doc }: { doc: ArtifactDoc }) {
  const Theme = useTheme();
  const live = useLiveArtifact(doc._id);
  const elements = useLiveElements(doc._id);
  const canEdit = useInboxStore((s: any) => s.liveHeads?.[doc._id]?.can_edit !== false);
  const cold = !live.ready && elements.length === 0;
  const editable = !doc.archived_at && canEdit && !cold;

  if (cold) {
    return (
      <RNView style={styles.cold}>
        <ActivityIndicator size="small" color={Theme.textMuted} />
      </RNView>
    );
  }
  const Body = doc.doc_type === 'board' ? BoardCanvas : doc.doc_type === 'sheet' ? SheetGrid : DashboardBlocks;
  return (
    <RNView style={styles.root}>
      <RNView style={styles.head}>
        <RNText style={styles.title} numberOfLines={1}>{doc.title || 'Untitled'}</RNText>
        {editable ? (
          <>
            <UndoButton icon="undo" enabled={live.canUndo} onPress={live.undo} label="Undo" />
            <UndoButton icon="repeat" enabled={live.canRedo} onPress={live.redo} label="Redo" />
          </>
        ) : (
          <RNView style={styles.readOnly}>
            <FontAwesome name="lock" size={11} color={Theme.textMuted0} />
            <RNText style={styles.readOnlyText}>{doc.archived_at ? 'Archived' : 'View only'}</RNText>
          </RNView>
        )}
      </RNView>
      <Body doc={doc} live={live} editable={editable} />
    </RNView>
  );
}

function UndoButton({ icon, enabled, onPress, label }: { icon: 'undo' | 'repeat'; enabled: boolean; onPress: () => void; label: string }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={!enabled}
      style={styles.undoBtn}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <FontAwesome name={icon} size={13} color={enabled ? Theme.text : Theme.textDim} />
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: Theme.bg },
  cold: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  title: { flex: 1, fontSize: 17, fontWeight: '700', color: Theme.text },
  undoBtn: {
    width: 32,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  readOnly: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  readOnlyText: { fontSize: 11, color: Theme.textMuted0 },
}));
