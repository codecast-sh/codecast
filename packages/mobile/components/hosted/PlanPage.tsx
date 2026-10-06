// Settings > Plan on the phone (web app/settings/plan/page.tsx): the hosted
// assistant's month as a meter, the plans, billing, extra credit, where the
// month's usage went and the account's history. Every number comes from the
// wallet through the web's own hooks (usePlanFigures) and every word from the
// shared plan rules (web components/simple/lane.ts). Checkout and the billing
// portal open in the browser and return to the web's plan page; the meter
// here updates by itself when a payment lands.
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import Animated, { FadeIn } from 'react-native-reanimated';
import Svg, { Defs, Pattern, Rect } from 'react-native-svg';
import { Text } from '@/components/Themed';
import { SettingsGroup, SettingsScroll } from '@/components/settings/SettingsUI';
import { openLink, openWebPage } from '@/lib/links';
import { PLANS } from '@codecast/shared/contracts/assistant';
import { LANE_COPY, TOPUP_AMOUNTS_USD, conversationTitle, ledgerLines, meterLegend, monthShare, planCard, planPoints, planPrice, topupLabel, usageHeadline, workedTimes, type SupportWords } from '@codecast/web/components/simple/lane';
import { useBilling } from '@codecast/web/components/simple/billing';
import { planDay, usePlanFigures, usePlanMeter } from '@codecast/web/components/simple/usePlanFigures';
import { supportMailto } from '@codecast/web/lib/siteLinks';
import { Callout, HostedButton, HostedRow, Pill } from './HostedUI';
import { HOSTED_RADIUS_SM, useHostedTheme } from './hostedTheme';

const openPage = (url: string) => void openWebPage(url);
const WORDS = LANE_COPY.plan;

/** Money set aside for work in progress: wash stripes over the track, so it
 *  reads apart from both the track and what is used (web MeterBar). */
function HeldStripes({ width, color }: { width: number; color: string }) {
  if (width <= 0) return null;
  return (
    <View style={{ width: `${width * 100}%` }}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="held" patternUnits="userSpaceOnUse" width={11} height={11} patternTransform="rotate(45)">
            <Rect width={6} height={11} fill={color} />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#held)" />
      </Svg>
    </View>
  );
}

/** A sentence that ends in "write to us" (lane.ts SupportWords). */
function Support({ words }: { words: SupportWords }) {
  const { c } = useHostedTheme();
  return (
    <>
      {words.before}
      <Text style={{ color: c.accent }} onPress={() => void openLink(supportMailto(words.subject))} accessibilityRole="link">
        {words.link}
      </Text>
      {words.after}
    </>
  );
}

/** The month's meter: what is used, what is held for work in progress, the track. */
function Meter({ meter }: { meter: ReturnType<typeof usePlanMeter> }) {
  const { c } = useHostedTheme();
  const { known, figures, fill, full } = meter;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={WORDS.meterLabel}
      accessibilityValue={{ min: 0, max: Math.round(figures.cap_usd * 100), now: Math.round(Math.min(figures.used_usd, figures.cap_usd) * 100) }}
      style={{ flexDirection: 'row', height: 10, borderRadius: 999, overflow: 'hidden', backgroundColor: c.wash }}
    >
      {known ? (
        <>
          <Animated.View entering={FadeIn.duration(800)} style={{ width: `${fill.used * 100}%`, borderRadius: 999, backgroundColor: full ? c.attention : c.accent }} />
          <HeldStripes width={fill.held} color={c.wash} />
        </>
      ) : null}
    </View>
  );
}

export function PlanPage() {
  const { c, s } = useHostedTheme();
  const planFigures = usePlanFigures();
  const { wallet, known, plan, month, figures, resets, names, lines, history } = planFigures;
  const billing = useBilling(openPage);
  const ledger = ledgerLines(lines, month);

  return (
    <SettingsScroll>
      <SettingsGroup title={WORDS.thisMonth} footnote={WORDS.settingsLede}>
        <View style={{ padding: 16, gap: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: c.ink }}>{known ? usageHeadline(figures) : WORDS.checking}</Text>
          <Meter meter={planFigures} />
          {known ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4 }}>
              {meterLegend(figures, resets, month).map((line) => (
                <Text key={line.key} style={{ fontSize: 12.5, color: c.soft }}>
                  {line.strong ? <Text style={{ fontWeight: '600', color: c.ink }}>{line.strong}</Text> : null}
                  {line.rest}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </SettingsGroup>

      <SettingsGroup title={WORDS.plans}>
        {billing.known && !billing.available ? (
          <Callout icon={<Feather name="info" size={15} color={c.soft} />} style={{ margin: 12 }}>
            <Support words={WORDS.cardClosed} />
          </Callout>
        ) : null}
        {Object.values(PLANS).map((p) => {
          const { current, offer } = planCard(p.id, planFigures, billing);
          return (
            <View key={p.id} style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.ink }}>{p.label}</Text>
                {current ? <Pill label={WORDS.yours} /> : null}
                <Text style={{ marginLeft: 'auto', fontSize: 14, color: c.soft, fontVariant: ['tabular-nums'] }}>{planPrice(p)}</Text>
              </View>
              <View style={{ gap: 3 }}>
                {planPoints(p).map((point) => (
                  <View key={point} style={{ flexDirection: 'row', gap: 7 }}>
                    <Feather name="check" size={13} color={c.ok} style={{ marginTop: 3 }} />
                    <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: c.soft }}>{point}</Text>
                  </View>
                ))}
              </View>
              {offer === 'checkout' ? (
                <HostedButton tone="yes" small label={WORDS.moveTo(p.label)} disabled={billing.busy} onPress={() => void billing.checkout({ plan: p.id })} style={{ alignSelf: 'flex-start', marginTop: 2 }} />
              ) : offer === 'ask' ? (
                <HostedButton tone="plain" small label={WORDS.askMove(p.label)} onPress={() => void openLink(supportMailto(WORDS.askMoveSubject(p.label)))} style={{ alignSelf: 'flex-start', marginTop: 2 }} />
              ) : null}
            </View>
          );
        })}
      </SettingsGroup>

      {billing.available && wallet?.billing_account ? (
        <SettingsGroup title={WORDS.billing} footnote={WORDS.manageNote}>
          <View style={{ padding: 12 }}>
            <HostedButton tone="plain" label={WORDS.manage} disabled={billing.busy} onPress={() => void billing.manage()} style={{ alignSelf: 'flex-start' }} />
          </View>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={WORDS.extraCredit} footnote={WORDS.moreNote}>
        <View style={{ padding: 12, gap: 10 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {TOPUP_AMOUNTS_USD.map((usd) => {
              const { label, note } = topupLabel(usd, plan);
              const disabled = !billing.topup || billing.busy;
              return (
                <TopupButton key={usd} label={label} note={note} disabled={disabled} onPress={() => void billing.checkout({ topup_usd: usd })} />
              );
            })}
          </View>
          {/* Buttons that cannot work yet say why, unless the Plans note
              above already said card payments are closed. */}
          {billing.known && billing.available && !billing.topup ? (
            <Text style={[s.muted, { fontSize: 12.5, lineHeight: 18 }]}><Support words={WORDS.topupClosed} /></Text>
          ) : null}
          {billing.error ? (
            <Callout attention icon={<Feather name="alert-circle" size={15} color={c.attention} />}>{billing.error}</Callout>
          ) : null}
        </View>
      </SettingsGroup>

      {ledger.shown.length > 0 || ledger.small > 0 ? (
        <SettingsGroup title={WORDS.where}>
          {ledger.shown.map((line) => {
            const title = names.get(String(line.conversation_id)) ?? conversationTitle(null);
            return (
              <HostedRow key={line.conversation_id} first label={title} onPress={() => router.push(`/session/${line.conversation_id}` as never)}>
                <View style={s.rowMain}>
                  <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
                  <Text style={s.rowSub}>{workedTimes(line.turns)}</Text>
                </View>
                <Text style={s.rowAside}>{monthShare(line.cost_usd, month)}</Text>
              </HostedRow>
            );
          })}
          {ledger.small > 0 ? (
            <Text style={[s.rowSub, { paddingHorizontal: 15, paddingVertical: 12 }]}>{WORDS.smallLines(ledger.small)}</Text>
          ) : null}
        </SettingsGroup>
      ) : null}

      {history.length > 0 ? (
        <SettingsGroup title={WORDS.history}>
          {history.map((h, n) => (
            <HostedRow key={`${h.at}-${n}`} first>
              <View style={s.rowMain}>
                <Text style={s.rowTitle}>{h.text}</Text>
                <Text style={s.rowSub}>{h.detail ? `${planDay(h.at)}, ${h.detail}` : planDay(h.at)}</Text>
              </View>
            </HostedRow>
          ))}
        </SettingsGroup>
      ) : null}
    </SettingsScroll>
  );
}

/** A top-up amount: the money on top, the share of a month it buys under it. */
function TopupButton({ label, note, disabled, onPress }: { label: string; note: string; disabled: boolean; onPress: () => void }) {
  const { c } = useHostedTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${note}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 13,
        borderRadius: HOSTED_RADIUS_SM,
        borderWidth: 1,
        borderColor: c.lineStrong,
        backgroundColor: pressed ? c.hover : c.sheet,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Text style={{ fontSize: 14, fontWeight: '600', color: c.ink }}>{label}</Text>
      <Text style={{ fontSize: 11.5, color: c.soft }}>{note}</Text>
    </Pressable>
  );
}
