// The plan on the phone (web app/simple/plan/page.tsx): this month's usage as
// a meter, the plans, and the ways to get more. The figures are the web's
// (usePlanFigures), and checkout is the web's (useBilling); a Stripe page
// opens in the browser and returns to the web plan page, and the meter here
// updates by itself when the payment lands.
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Text } from '@/components/Themed';
import { openLink, openWebPage } from '@/lib/links';
import { PLANS } from '@codecast/shared/contracts/assistant';
import { LANE_COPY, TOPUP_AMOUNTS_USD, conversationPath, conversationTitle, dollars, meterLegend, planCard, planPoints, planPrice, topupLabel, usageHeadline, workedTimes } from '@codecast/web/components/simple/lane';
import { useBilling } from '@codecast/web/components/simple/billing';
import { planDay, usePlanFigures } from '@codecast/web/components/simple/usePlanFigures';
import { supportMailto } from '@codecast/web/lib/siteLinks';
import { LaneTop, useTabBarClearance } from '@/components/simple/LaneChrome';
import { Callout, LaneButton, LanePage, LaneRow, Pill, Rise, SectionHead } from '@/components/simple/LaneUI';
import { useLaneTheme } from '@/components/simple/laneTheme';

const openPage = (url: string) => void openWebPage(url);
const WORDS = LANE_COPY.plan;

export default function SimplePlan() {
  const { c, s } = useLaneTheme();
  const planFigures = usePlanFigures();
  const { wallet, known, figures, fill, full, names, resets, lines, history } = planFigures;
  const billing = useBilling(openPage);

  return (
    <LanePage bottomInset={useTabBarClearance()}>
      <LaneTop />
      <Rise><Text style={s.pageTitle} accessibilityRole="header">{WORDS.title}</Text></Rise>
      <Rise i={1}>
        <Text style={s.lede}>{WORDS.lede}</Text>
      </Rise>

      <Rise i={2} style={[s.card, { paddingHorizontal: 19, paddingTop: 20, paddingBottom: 18 }]}>
        <Text style={{ fontSize: 20, lineHeight: 25, fontWeight: '600', letterSpacing: -0.4, color: c.ink }}>
          {known ? usageHeadline(figures) : WORDS.checking}
        </Text>
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={WORDS.meterLabel}
          accessibilityValue={{ min: 0, max: Math.round(figures.cap_usd * 100), now: Math.round(Math.min(figures.used_usd, figures.cap_usd) * 100) }}
          style={{ flexDirection: 'row', height: 15, marginTop: 16, marginBottom: 11, borderRadius: 999, overflow: 'hidden', backgroundColor: c.inkWash }}
        >
          {known ? (
            <>
              <Animated.View entering={FadeIn.duration(900)} style={{ width: `${fill.used * 100}%`, borderRadius: 999, backgroundColor: full ? c.sun : c.tide }} />
              <View style={{ width: `${fill.held * 100}%`, backgroundColor: c.tideWash2 }} />
            </>
          ) : null}
        </View>
        {known ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 17, rowGap: 5 }}>
            {meterLegend(figures, resets).map((line) => (
              <Text key={line.key} style={{ fontSize: 13.5, color: c.soft }}>
                {line.strong ? <Text style={{ fontWeight: '600', color: c.ink }}>{line.strong}</Text> : null}
                {line.rest}
              </Text>
            ))}
          </View>
        ) : null}
      </Rise>

      <Rise i={3} style={s.section}>
        <SectionHead title={WORDS.plans} />
        {billing.known && !billing.available ? (
          <Callout icon={<Feather name="info" size={17} color={c.soft} />} style={{ marginBottom: 12 }}>
            {WORDS.cardClosed.before}
            <Text style={{ color: c.ink2, textDecorationLine: 'underline' }} onPress={() => void openLink(supportMailto(WORDS.cardClosedSubject))} accessibilityRole="link">
              {WORDS.cardClosed.link}
            </Text>
            {WORDS.cardClosed.after}
          </Callout>
        ) : null}
        <View style={{ gap: 12 }}>
          {Object.values(PLANS).map((p) => {
            const { current, offer } = planCard(p.id, planFigures, billing);
            return (
              <View
                key={p.id}
                style={[
                  s.card,
                  { gap: 9, paddingHorizontal: 17, paddingTop: 16, paddingBottom: 16 },
                  current && { borderColor: c.tideWash2, borderWidth: 1.5 },
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: 17, fontWeight: '600', color: c.ink }}>{p.label}</Text>
                  {current ? <Pill label={WORDS.yours} /> : null}
                  <Text style={{ marginLeft: 'auto', fontSize: 20, fontWeight: '600', letterSpacing: -0.5, color: c.ink, fontVariant: ['tabular-nums'] }}>{planPrice(p)}</Text>
                </View>
                <View style={{ gap: 3 }}>
                  {planPoints(p).map((point) => (
                    <View key={point} style={{ flexDirection: 'row', gap: 8 }}>
                      <Feather name="check" size={14} color={c.tideInk} style={{ marginTop: 3 }} />
                      <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: c.soft }}>{point}</Text>
                    </View>
                  ))}
                </View>
                {offer === "checkout" ? (
                  <LaneButton tone="yes" label={WORDS.moveTo(p.label)} disabled={billing.busy} onPress={() => void billing.checkout({ plan: p.id })} style={{ marginTop: 4 }} />
                ) : offer === 'ask' ? (
                  <LaneButton tone="plain" label={WORDS.askMove(p.label)} onPress={() => void openLink(supportMailto(WORDS.askMoveSubject(p.label)))} style={{ marginTop: 4 }} />
                ) : null}
              </View>
            );
          })}
        </View>
        {billing.available && wallet?.billing_account ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 13 }}>
            <LaneButton tone="plain" label={WORDS.manage} disabled={billing.busy} onPress={() => void billing.manage()} />
            <Text style={[s.muted, { flex: 1, minWidth: 180, fontSize: 14 }]}>{WORDS.manageNote}</Text>
          </View>
        ) : null}
      </Rise>

      <Rise i={4} style={s.section}>
        <SectionHead title={WORDS.more} />
        <View style={[s.card, { paddingHorizontal: 17, paddingVertical: 16 }]}>
          <Text style={[s.muted, { fontSize: 14.5, lineHeight: 21, marginBottom: 13 }]}>
            {WORDS.moreNote}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {TOPUP_AMOUNTS_USD.map((usd) => {
              const disabled = !billing.topup || billing.busy;
              return (
                <Pressable
                  key={usd}
                  accessibilityRole="button"
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={() => void billing.checkout({ topup_usd: usd })}
                  style={({ pressed }) => ({
                    paddingVertical: 9,
                    paddingHorizontal: 16,
                    borderRadius: 18,
                    borderWidth: 1,
                    borderColor: c.lineStrong,
                    backgroundColor: pressed ? c.tideWash : c.sheet,
                    alignItems: 'center',
                    opacity: disabled ? 0.45 : 1,
                  })}
                >
                  <Text style={{ fontSize: 15, fontWeight: '600', color: c.ink }}>{topupLabel(usd).label}</Text>
                  <Text style={{ fontSize: 12, color: c.soft }}>{topupLabel(usd).note}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        {billing.error ? (
          <Callout sun icon={<Feather name="alert-circle" size={17} color={c.sun} />} style={{ marginTop: 12 }}>
            {billing.error}
          </Callout>
        ) : null}
      </Rise>

      {lines.length > 0 ? (
        <Rise i={5} style={s.section}>
          <SectionHead title={WORDS.where} />
          <View style={s.list}>
            {lines.map((line, n) => {
              const title = names.get(String(line.conversation_id)) ?? conversationTitle(null);
              return (
                <LaneRow key={line.conversation_id} first={n === 0} label={title} onPress={() => router.push(conversationPath(String(line.conversation_id)) as never)}>
                  <View style={s.rowMain}>
                    <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
                    <Text style={s.rowSub}>{workedTimes(line.turns)}</Text>
                  </View>
                  <Text style={s.rowAside}>{dollars(line.cost_usd)}</Text>
                </LaneRow>
              );
            })}
          </View>
        </Rise>
      ) : null}

      {history.length > 0 ? (
        <Rise i={6} style={s.section}>
          <SectionHead title={WORDS.history} />
          <View style={s.list}>
            {history.map((h, n) => (
              <LaneRow key={`${h.at}-${n}`} first={n === 0}>
                <View style={s.rowMain}>
                  <Text style={s.rowTitle}>{h.text}</Text>
                  <Text style={s.rowSub}>{h.detail ? `${planDay(h.at)}, ${h.detail}` : planDay(h.at)}</Text>
                </View>
                {h.amount ? <Text style={s.rowAside}>{h.amount}</Text> : null}
              </LaneRow>
            ))}
          </View>
        </Rise>
      ) : null}
    </LanePage>
  );
}
