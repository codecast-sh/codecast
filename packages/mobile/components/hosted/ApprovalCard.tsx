// An approval at the foot of its hosted conversation on the phone (mounted by
// the session screen, app/session/[id]): the question in the step's own words
// ("Send an email to Dana?"), the actual draft (the email, the event,
// whatever the assistant wants to do), and its answers. The answer goes
// through the store's decision action, so the card leaves the moment it is
// tapped and the conversation wakes with the answer. A pick-several, a
// ranking or a form answers through the decision screen's own controls.
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { useInboxStore, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { APPROVAL_LABEL, LANE_COPY, answerNotes, answerTone, answersInline, approvalAsk } from '@codecast/web/components/simple/lane';
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

export function ApprovalCard({ decision, index = 0 }: { decision: SessionDecisionItem; index?: number }) {
  const { c } = useHostedTheme();
  const draft = decision.context_md?.trim() ?? '';
  const inline = answersInline(decision);
  const notes = inline ? answerNotes(decision.options) : [];
  const answer = (i: number) => useInboxStore.getState().answerDecision(decision._id, { index: i });

  return (
    <Rise i={index}>
      <View
        accessibilityLabel={decision.question}
        style={{ borderRadius: HOSTED_RADIUS, backgroundColor: c.sheet, borderWidth: 1, borderColor: c.attentionLine }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 15, paddingTop: 12 }}>
          <Feather name="alert-circle" size={13} color={c.attention} />
          <Text style={{ fontSize: 12, fontWeight: '600', color: c.attention }}>{APPROVAL_LABEL[approvalAsk(decision)]}</Text>
        </View>
        <Text style={{ marginHorizontal: 15, marginTop: 6, marginBottom: 12, fontSize: 16, lineHeight: 22, fontWeight: '600', color: c.ink }}>
          {decision.question}
        </Text>
        {draft ? (
          <View
            style={{
              marginHorizontal: 10,
              paddingVertical: 12,
              paddingHorizontal: 13,
              borderRadius: HOSTED_RADIUS_SM,
              backgroundColor: c.sheet2,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: c.line,
            }}
          >
            <CollapsibleBody
              fadeColor={c.sheet2}
              height={FOLD_HEIGHT}
              toggleColor={c.accent}
              labels={[LANE_COPY.approval.showAll, LANE_COPY.approval.showLess]}
            >
              <MarkdownContent text={draft} plainTextFences baseStyle={{ fontSize: 13.5, lineHeight: 20, color: c.ink }} />
            </CollapsibleBody>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 11, paddingTop: 13, paddingBottom: notes.length ? 8 : 12 }}>
          {inline ? (
            decision.options.map((o, i) => (
              <HostedButton key={`${i}-${o.label}`} label={o.label} tone={answerTone(o.label, i)} hint={o.description} onPress={() => answer(i)} />
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
        {notes.length > 0 ? (
          <View style={{ gap: 4, paddingHorizontal: 15, paddingBottom: 13 }}>
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
