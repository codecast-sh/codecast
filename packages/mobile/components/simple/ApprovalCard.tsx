// One approval as the lane shows it on the phone: the question, the actual
// draft (the email, the event, whatever the assistant wants to do), and its
// answers (web components/simple/ApprovalCard.tsx). The answer goes through
// the store's decision action, so the card leaves the moment it is tapped
// and the conversation wakes with the answer.
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Text } from '@/components/Themed';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { useInboxStore, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { APPROVAL_LABEL, LANE_COPY, answerNotes, answerTone, answersInline, approvalAsk, conversationPath, draftIsLong } from '@codecast/web/components/simple/lane';
import { AnswerControls, type AnswerLook } from '@/components/decisions/AnswerControls';
import { LaneButton, Rise } from './LaneUI';
import { useLaneTheme, type LaneColors } from './laneTheme';

/** The shared answer controls in the lane's colours. */
function laneAnswerLook(c: LaneColors): AnswerLook {
  return {
    text: c.ink,
    muted: c.soft,
    faint: c.faint,
    surface: c.sheet,
    border: c.lineStrong,
    picked: c.tideInk,
    accent: c.tideSolid,
    onAccent: c.onTide,
    danger: c.rose,
    placeholder: c.faint,
    radius: 16,
    numbered: false,
    icons: 'feather',
    press: 'shrink',
  };
}
const FOLD_HEIGHT = 152;

export function ApprovalCard({ decision, from, index = 0, here = false }: {
  decision: SessionDecisionItem;
  /** The conversation's name, shown as a link to it (home and approvals). */
  from?: string;
  index?: number;
  /** The card sits in its own conversation, so every kind answers in place. */
  here?: boolean;
}) {
  const { c } = useLaneTheme();
  const draft = decision.context_md?.trim() ?? '';
  const long = draftIsLong(draft);
  const [open, setOpen] = useState(false);
  const inline = answersInline(decision);
  const notes = inline ? answerNotes(decision.options) : [];
  const answer = (i: number) => useInboxStore.getState().answerDecision(decision._id, { index: i });

  return (
    <Rise i={index}>
      <View
        accessibilityLabel={decision.question}
        style={{
          borderRadius: 22,
          backgroundColor: c.sheet,
          borderWidth: 1,
          borderColor: c.sunLine,
          shadowColor: c.sun,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.18,
          shadowRadius: 8,
          elevation: 2,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 17, paddingTop: 13 }}>
          <MaterialCommunityIcons name="hand-back-right-outline" size={15} color={c.sunInk} />
          <Text style={{ fontSize: 13, fontWeight: '600', color: c.sunInk }}>{APPROVAL_LABEL[approvalAsk(decision)]}</Text>
          {from ? (
            // The one way from a card into its conversation, so it reads as a link.
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={from}
              hitSlop={8}
              onPress={() => router.push(conversationPath(String(decision.conversation_id)) as never)}
              style={({ pressed }) => ({ marginLeft: 'auto', maxWidth: '58%', flexDirection: 'row', alignItems: 'center', gap: 1, opacity: pressed ? 0.6 : 1 })}
            >
              <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, fontWeight: '500', color: c.soft }}>{from}</Text>
              <Feather name="chevron-right" size={14} color={c.soft} />
            </Pressable>
          ) : null}
        </View>
        <Text style={{ marginHorizontal: 17, marginTop: 6, marginBottom: 13, fontSize: 19, lineHeight: 24, fontWeight: '600', letterSpacing: -0.3, color: c.ink }}>
          {decision.question}
        </Text>
        {draft ? (
          <>
            <View
              style={{
                marginHorizontal: 12,
                paddingVertical: 14,
                paddingHorizontal: 15,
                borderRadius: 14,
                backgroundColor: c.sheet2,
                borderWidth: 1,
                borderColor: c.line,
                overflow: 'hidden',
                maxHeight: long && !open ? FOLD_HEIGHT : undefined,
              }}
            >
              <MarkdownContent text={draft} baseStyle={{ fontSize: 15, lineHeight: 23, color: c.ink2 }} />
              {long && !open ? (
                <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 48 }}>
                  <Svg width="100%" height="100%">
                    <Defs>
                      <LinearGradient id="fold" x1="0" y1="0" x2="0" y2="1">
                        <Stop offset="0" stopColor={c.sheet2} stopOpacity={0} />
                        <Stop offset="1" stopColor={c.sheet2} stopOpacity={1} />
                      </LinearGradient>
                    </Defs>
                    <Rect width="100%" height="100%" fill="url(#fold)" />
                  </Svg>
                </View>
              ) : null}
            </View>
            {long ? (
              <Pressable onPress={() => setOpen((v) => !v)} hitSlop={8} accessibilityRole="button" style={{ marginHorizontal: 17, marginTop: 6 }}>
                <Text style={{ fontSize: 14, fontWeight: '500', color: c.tideInk }}>{open ? LANE_COPY.approval.showLess : LANE_COPY.approval.showAll}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 13, paddingTop: 15, paddingBottom: notes.length ? 8 : 14 }}>
          {inline ? (
            decision.options.map((o, i) => (
              <LaneButton key={`${i}-${o.label}`} label={o.label} tone={answerTone(o.label, i)} hint={o.description} onPress={() => answer(i)} />
            ))
          ) : here ? (
            // A pick-several, a ranking or a form: the app's own answer
            // controls, in the lane's colours.
            <View style={{ flexBasis: '100%' }}>
              <AnswerControls
                decisionId={decision._id}
                decision={decision}
                look={laneAnswerLook(c)}
                onAnswer={(input) => useInboxStore.getState().answerDecision(decision._id, input)}
              />
            </View>
          ) : (
            // A pick-several, a ranking or a form is answered in the
            // conversation, where there is room to say it.
            <LaneButton label={LANE_COPY.approval.answerThere} tone="yes" onPress={() => router.push(conversationPath(String(decision.conversation_id)) as never)} />
          )}
        </View>
        {notes.length > 0 ? (
          <View style={{ gap: 4, paddingHorizontal: 17, paddingBottom: 15 }}>
            {notes.map((n) => (
              <Text key={n.label} style={{ fontSize: 13.5, lineHeight: 19, color: c.soft }}>
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
