// Settings › Voice: whether the composers offer a mic (dictation), whether
// codecast may learn the viewer's voice from the recordings where they are
// named, how much it holds, and a way to delete it. The switches have one home
// each, currentUser.dictation_enabled and currentUser.voice_id_enabled; the
// counts are the myVoiceprint singleton. All are written on the store's draft,
// so a flip or a delete shows in the same tick (setDictationEnabled,
// setVoiceIdEnabled, deleteMyVoiceprints).
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { isParkedDispatchError } from '@codecast/web/store/mutativeMiddleware';
import { useMyVoiceprint } from '@codecast/web/hooks/useSyncCalls';
import { ledgerLines } from '@codecast/web/components/consequential/roleOnline';
import { voiceIdLedger } from '@codecast/web/components/settings/voiceIdLedger';
import { formatRelativeTime } from '@/components/sessionFormat';
import { View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { appAlert } from '@/lib/popups';
import { showNotice } from '@/lib/undoBar';
import { useSettingsUser } from './SettingsPages';
import { SettingsScroll, SettingsGroup, ToggleRow, NavRow, settingsStyles } from './SettingsUI';

export function voiceDetail(user: any): string {
  const on = [user?.dictation_enabled === true && 'Dictation', !!user?.voice_id_enabled && 'Recognition'].filter(Boolean);
  return on.length ? on.join(', ') : 'Off';
}

export function VoicePage() {
  const user = useSettingsUser();
  const mine = useMyVoiceprint();
  const on = !!user?.voice_id_enabled;
  const count = mine?.count ?? 0;
  const failed = (e: unknown) => {
    if (!isParkedDispatchError(e)) showNotice("Couldn't save. Try again");
  };

  const dictation = user?.dictation_enabled === true;
  const setDictation = (v: boolean) => void useInboxStore.getState().setDictationEnabled(v).catch(failed);

  const set = (v: boolean) => void useInboxStore.getState().setVoiceIdEnabled(v).catch(failed);
  const flip = (v: boolean) => {
    // On grants codecast a person's voice: the review comes first (what is
    // kept, who sees it, how to stop), the same ledger the web shows.
    if (v) {
      const l = voiceIdLedger();
      return appAlert(l.subject ? `${l.name}: ${l.subject}` : l.name, ledgerLines(l).join('\n'), [
        { text: l.keep ?? 'Not now', style: 'cancel' },
        { text: l.confirm, onPress: () => set(true) },
      ]);
    }
    if (!count) return set(false);
    appAlert('Turn off voice recognition?', `This deletes ${samples(count)} of your voice.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: () => set(false) },
    ]);
  };
  const remove = () =>
    appAlert(`Delete ${samples(count)}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void useInboxStore.getState().deleteMyVoiceprints().catch(failed),
      },
    ]);

  return (
    <SettingsScroll>
      <SettingsGroup footnote="A mic in the message boxes types what you say.">
        <ToggleRow label="Dictation" value={dictation} onValueChange={setDictation} />
      </SettingsGroup>
      <SettingsGroup footnote="Stores samples of your voice. Only you see them.">
        <ToggleRow label="Recognize my voice" value={on} onValueChange={flip} />
      </SettingsGroup>
      {on || count ? (
        <SettingsGroup title="Samples">
          <RNView style={settingsStyles.row}>
            <RNText style={[settingsStyles.label, { flex: 1 }]}>{count ? samples(count) : 'No samples yet'}</RNText>
            {count && mine?.last_added_at ? (
              <RNText style={settingsStyles.detail}>Last added {formatRelativeTime(mine.last_added_at)}</RNText>
            ) : null}
          </RNView>
          {count ? <NavRow label="Delete samples" tone="danger" trailingIcon="trash-o" onPress={remove} /> : null}
        </SettingsGroup>
      ) : null}
    </SettingsScroll>
  );
}

function samples(n: number): string {
  return `${n} sample${n === 1 ? '' : 's'}`;
}
