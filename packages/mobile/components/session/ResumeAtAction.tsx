// A stopped run's Resume press on the phone, the same as the web's Ship bar (web lib/ship/resumeAt.ts,
// hooks/useResumeAt.ts): a native button that resumes the run at the station its reason names (Landing unknown and
// Land cut off resume at Land). It reads Resuming… until the run moves on, which takes the stop and this press with
// it, and a refusal says the server's own words under it. The run card and the run screen both show it.
import React from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, useTheme } from '@/constants/Theme';
import { useResumeAt } from '@codecast/web/hooks/useResumeAt';
import { resumeWords, type ResumeAt } from '@codecast/web/lib/ship/resumeAt';
import { resumeAtLedger } from '@codecast/web/components/consequential/resumeLedger';
import { ledgerLines } from '@codecast/web/components/consequential/roleOnline';
import { appAlert } from '@/lib/popups';

export function ResumeAtAction({ runId, resume }: { runId: string; resume: ResumeAt }) {
  const Theme = useTheme();
  const { state, press } = useResumeAt(runId, resume.at);
  const pending = state.kind === 'pending';
  return (
    <RNView style={styles.wrap}>
      <Pressable
        onPress={() => {
          // It may push to main and deploy: the same review as the web's, as an alert (AGENTS.md, consequential presses).
          const l = resumeAtLedger(resume);
          appAlert(l.name, ledgerLines(l).join('\n'), [{ text: l.keep ?? 'Not now', style: 'cancel' }, { text: l.confirm, onPress: () => void press() }]);
        }}
        disabled={pending}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ disabled: pending, busy: pending }}
        style={[styles.press, { borderColor: Theme.blue, backgroundColor: Theme.blue + '18', opacity: pending ? 0.6 : 1 }]}
        testID="resume-at"
      >
        <RNText style={[styles.words, { color: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{pending ? 'Resuming…' : resumeWords(resume)}</RNText>
      </Pressable>
      {state.kind === 'refused' ? (
        <RNText style={[styles.refused, { color: Theme.red }]} maxFontSizeMultiplier={CHROME_FONT_CAP} accessibilityRole="alert" testID="resume-at-refused">Could not resume: {state.why}</RNText>
      ) : null}
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4, marginTop: 6 },
  press: { alignSelf: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' },
  words: { fontSize: 13, fontWeight: '600' },
  refused: { fontSize: 13, lineHeight: 18 },
});
