// An approval at the foot of its hosted conversation on the phone (mounted by
// the session screen, app/session/[id]), drawn as the web's card
// (HostedApprovalCard): the question in the step's own words ("Set up the
// routine "Stretch"?"), the plan as the engine wrote it for the card (its
// "When" line left out when the plan already says the time), what Yes does,
// then Yes and Not now, with Always allow as a quiet third. The rules are the
// web's (lib/hostedApproval). The answer goes through the store's decision
// action, so the card leaves the moment it is tapped and the conversation
// wakes with the answer. Any other choice (a pick-one with its own options,
// a pick-several, a ranking or a form) answers through the decision
// screen's own controls.
import { useEffect, useState } from 'react';
import { AppState, Linking, Pressable, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Notifications from 'expo-notifications';
import { Text } from '@/components/Themed';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { useInboxStore, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { LANE_COPY, answerNotes, answerTone, answersInline } from '@codecast/web/components/simple/lane';
import { ROUTINE_NOTIFY_OFF, approvalSettledWords, isHostedApproval, isRoutineYes, planForCard, yesWords } from '@codecast/web/lib/hostedApproval';
import { APPROVAL_REFUSED, useOneAnswer } from '@codecast/web/hooks/useOneAnswer';
import { APPROVAL_ANSWERS, approvalButtonLabel } from '@codecast/shared/contracts/assistant';
import { AnswerControls, type AnswerLook } from '@/components/decisions/AnswerControls';
import { HostedButton, Rise } from './HostedUI';
import { HOSTED_RADIUS, HOSTED_RADIUS_SM, useHostedTheme, type HostedColors } from './hostedTheme';

/** The decision screen's answer controls in the hosted colours. */
function hostedAnswerLook(c: HostedColors): AnswerLook {
  return {
    text: c.ink,
    muted: c.soft,
    faint: c.faint,
    surface: c.sheet,
    border: c.lineStrong,
    picked: c.ok,
    accent: c.accent,
    onAccent: c.onSolid,
    danger: c.danger,
    placeholder: c.faint,
    radius: HOSTED_RADIUS_SM,
    numbered: false,
    icons: 'feather',
    press: 'shrink',
  };
}

/** How much of a draft shows before its fold: enough for a routine's
 *  instruction and its time, so only a long email or note folds. */
const FOLD_HEIGHT = 220;

/** Where a routine's runs reach the person on this phone (the web's
 *  RoutineNotifyLine): nothing while notifications are on; while they are
 *  not, the plain consequence and the one tap that fixes it, asking when iOS
 *  still can and opening the app's Settings once it was refused. Re-read on
 *  return to the app, so the line leaves after a trip to Settings. */
function RoutineNotifyLine() {
  const { c } = useHostedTheme();
  const [state, setState] = useState<'on' | 'ask' | 'off' | null>(null);
  useEffect(() => {
    const read = () => void Notifications.getPermissionsAsync()
      .then((p) => setState(p.granted ? 'on' : p.canAskAgain ? 'ask' : 'off'))
      .catch(() => setState(null));
    read();
    const sub = AppState.addEventListener('change', (next) => { if (next === 'active') read(); });
    return () => sub.remove();
  }, []);
  if (state !== 'ask' && state !== 'off') return null;
  const turnOn = () => {
    if (state === 'off') void Linking.openSettings();
    else void Notifications.requestPermissionsAsync().then((p) => setState(p.granted ? 'on' : p.canAskAgain ? 'ask' : 'off')).catch(() => {});
  };
  return (
    <Text style={{ marginTop: 6, fontSize: 12.5, lineHeight: 18, color: c.soft }}>
      {ROUTINE_NOTIFY_OFF[state]}{' '}
      <Text style={{ color: c.ink, textDecorationLine: 'underline' }} accessibilityRole="button" onPress={turnOn}>
        {state === 'off' ? 'Open Settings' : 'Turn on notifications'}
      </Text>
    </Text>
  );
}

/** The answered card, held where the card was until the turn moves on, so
 *  the tap shows it registered (the web's HostedApprovalSettled). */
export function ApprovalSettled({ label }: { label: string }) {
  const { c } = useHostedTheme();
  return (
    <View accessibilityRole="text" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: HOSTED_RADIUS, borderWidth: 1, borderColor: c.line, backgroundColor: c.sheet, paddingHorizontal: 15, paddingVertical: 12 }}>
      <Feather name="check" size={14} color={c.faint} />
      <Text style={{ flex: 1, fontSize: 13.5, color: c.soft }}>{approvalSettledWords(label)}</Text>
    </View>
  );
}

/** The card's place while its decision row is still on its way (the web's
 *  HostedApprovalPending). */
export function ApprovalPending() {
  const { c } = useHostedTheme();
  return (
    <View style={{ borderRadius: HOSTED_RADIUS, borderWidth: 1, borderStyle: 'dashed', borderColor: c.lineStrong, paddingHorizontal: 15, paddingVertical: 12 }}>
      <Text style={{ fontSize: 13.5, color: c.faint }}>Getting the card ready…</Text>
    </View>
  );
}

export function ApprovalCard({ decision, index = 0 }: { decision: SessionDecisionItem; index?: number }) {
  const { c } = useHostedTheme();
  const draft = decision.context_md?.trim() ?? '';
  const inline = answersInline(decision);
  // An approval the engine wrote (Approve, Decline, maybe Always allow).
  const approval = inline && isHostedApproval(decision.options);
  const notes = inline && !approval ? answerNotes(decision.options) : [];
  // One answer per card: a second tap before the row leaves would answer twice.
  const { answered, refused, pick: answer } = useOneAnswer((i) => useInboxStore.getState().answerDecision(decision._id, { index: i }));
  const at = (label: string) => decision.options.findIndex((o) => o.label === label);
  const yes = approval ? decision.options[at(APPROVAL_ANSWERS.approve)] : undefined;
  const always = approval ? at(APPROVAL_ANSWERS.always) : -1;

  return (
    <Rise i={index}>
      <View
        accessibilityLabel={decision.question}
        style={{ borderRadius: HOSTED_RADIUS, backgroundColor: c.sheet, borderWidth: 1, borderColor: c.lineStrong, paddingHorizontal: 15, paddingTop: 13, paddingBottom: 13 }}
      >
        <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: c.ink }}>{decision.question}</Text>
        {draft ? (
          <View style={{ marginTop: 6 }}>
            <CollapsibleBody
              fadeColor={c.sheet}
              height={FOLD_HEIGHT}
              toggleColor={c.ink2}
              labels={[LANE_COPY.approval.showAll, LANE_COPY.approval.showLess]}
            >
              <MarkdownContent text={approval ? planForCard(draft) : draft} plainTextFences baseStyle={{ fontSize: 14, lineHeight: 21, color: c.soft }} />
            </CollapsibleBody>
          </View>
        ) : null}
        {/* What Yes does sits with the plan it answers, above both buttons,
            so it never reads as describing Not now. */}
        {yes?.description ? (
          <Text style={{ marginTop: 6, fontSize: 12.5, lineHeight: 18, color: c.faint }}>
            {yesWords(yes.description)}
          </Text>
        ) : null}
        {yes?.description && isRoutineYes(yes.description) && !answered ? <RoutineNotifyLine /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingTop: 13 }}>
          {approval ? (
            <>
              {decision.options.map((o, i) => (o.label === APPROVAL_ANSWERS.always ? null : (
                <HostedButton
                  key={`${i}-${o.label}`}
                  label={approvalButtonLabel(o.label)}
                  tone={o.label === APPROVAL_ANSWERS.approve ? 'yes' : 'plain'}
                  disabled={answered}
                  hint={o.label === APPROVAL_ANSWERS.approve && yes?.description && isRoutineYes(yes.description) ? undefined : o.description}
                  onPress={() => answer(i)}
                />
              )))}
              {always >= 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityHint={decision.options[always].description}
                  onPress={() => answer(always)}
                  disabled={answered}
                  hitSlop={8}
                  style={{ marginLeft: 'auto' }}
                >
                  <Text style={{ fontSize: 12.5, color: c.faint }}>{approvalButtonLabel(APPROVAL_ANSWERS.always)}</Text>
                </Pressable>
              ) : null}
            </>
          ) : inline ? (
            decision.options.map((o, i) => (
              <HostedButton key={`${i}-${o.label}`} label={o.label} tone={answerTone(o.label, i)} hint={o.description} disabled={answered} onPress={() => answer(i)} />
            ))
          ) : (
            <View style={{ flexBasis: '100%' }}>
              <AnswerControls
                decisionId={decision._id}
                decision={decision}
                look={hostedAnswerLook(c)}
                onAnswer={(input) => useInboxStore.getState().answerDecision(decision._id, input)}
              />
            </View>
          )}
        </View>
        {refused ? <Text accessibilityRole="alert" style={{ marginTop: 8, fontSize: 12.5, color: c.soft }}>{APPROVAL_REFUSED}</Text> : null}
        {notes.length > 0 ? (
          <View style={{ gap: 4, paddingTop: 8 }}>
            {notes.map((n) => (
              <Text key={n.label} style={{ fontSize: 12.5, lineHeight: 18, color: c.soft }}>
                <Text style={{ fontWeight: '600', color: c.ink2 }}>{n.label}</Text>
                {`: ${n.note}`}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </Rise>
  );
}
