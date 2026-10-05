// Connections on the phone (web app/simple/connections/page.tsx): the
// person's mail and calendar, connected through Whisk, what each part lets
// the assistant do, and connect, disconnect or open Whisk. Whisk's approval
// comes back to codecast in the browser that started it, where the signed-in
// session finishes the connection; so Connect opens the web Connections page,
// and the screen here updates when the connection lands.
import { useState } from 'react';
import { View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { openWebPage } from '@/lib/links';
import { CODECAST_BASE_URL } from '@codecast/shared/entities';
import { LANE_COPY, LANE_PATHS, connectionControls, plainConnectError } from '@codecast/web/components/simple/lane';
import { useLaneMail } from '@codecast/web/components/simple/useLaneMail';
import { MAIL_COMING } from '@codecast/web/components/simple/assistantPromise';
import { calendarAbility, disconnectNote, emailAbility, mailboxLine } from '@codecast/web/components/simple/connectionWords';
import { LaneTop, useTabBarClearance } from '@/components/simple/LaneChrome';
import { Callout, LaneButton, LanePage, Pill, Rise } from '@/components/simple/LaneUI';
import { LANE_RADIUS, useLaneTheme } from '@/components/simple/laneTheme';

function Service({ icon, title, on, children }: { icon: React.ComponentProps<typeof Feather>['name']; title: string; on: boolean; children: string }) {
  const { c, s } = useLaneTheme();
  return (
    <View style={[{ flexDirection: 'row', gap: 14, paddingVertical: 15, paddingHorizontal: 17 }, s.rowRule]}>
      <View style={{ width: 40, height: 40, borderRadius: LANE_RADIUS, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.wash : c.accentWash }}>
        <Feather name={icon} size={19} color={on ? c.mark : c.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', color: c.ink }}>{title}</Text>
          <Pill label={on ? WORDS.on : WORDS.off} off={!on} />
        </View>
        <Text style={{ marginTop: 3, fontSize: 14.5, lineHeight: 21, color: c.soft }}>{children}</Text>
      </View>
    </View>
  );
}

const WORDS = LANE_COPY.connections;

export default function SimpleConnections() {
  const { c, s } = useLaneTheme();
  const mail = useLaneMail(LANE_PATHS.connections);
  const { actions, connected, can, email, mailboxes, whiskUrl, known } = mail;
  const [confirming, setConfirming] = useState(false);
  const controls = connectionControls(mail, confirming);
  const [opened, setOpened] = useState(false);
  const error = plainConnectError(actions.error);

  const openConnect = () => {
    setOpened(true);
    void openWebPage(`${CODECAST_BASE_URL}${LANE_PATHS.connections}`);
  };

  return (
    <LanePage bottomInset={useTabBarClearance()}>
      <LaneTop />
      <Rise><Text style={s.pageTitle} accessibilityRole="header">{WORDS.title}</Text></Rise>
      <Rise i={1}>
        <Text style={s.lede}>{WORDS.lede(can)}</Text>
      </Rise>

      <Rise i={2} style={[s.card, { overflow: 'hidden' }]}>
        <View style={{ paddingHorizontal: 17, paddingTop: 16, paddingBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
            <Text style={{ fontSize: 18, fontWeight: '600', letterSpacing: -0.2, color: c.ink }}>{WORDS.mail}</Text>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: c.faint }}>
              {!known ? '' : connected ? mailboxLine(email, mailboxes) ?? WORDS.connected : WORDS.notConnected}
            </Text>
          </View>
          <Text style={{ marginTop: 2, fontSize: 13.5, color: c.faint }}>{WORDS.through}</Text>
        </View>
        <Service icon="mail" title={WORDS.email} on={!!can?.read_mail}>{emailAbility(can)}</Service>
        <Service icon="calendar" title={WORDS.calendar} on={!!can?.calendar}>{calendarAbility(can)}</Service>
        {error ? (
          <Callout accent icon={<Feather name="alert-circle" size={17} color={c.accent} />} style={{ marginHorizontal: 17, marginBottom: 14 }}>
            {error}
          </Callout>
        ) : null}
        {known ? (
          <View style={[{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 17, paddingTop: 14, paddingBottom: 16 }, s.rowRule]}>
            {controls.coming ? <Text style={[s.muted, { fontSize: 14, lineHeight: 20 }]}>{MAIL_COMING}</Text> : null}
            {controls.connect ? <LaneButton tone="yes" label={WORDS.connect} onPress={openConnect} /> : null}
            {controls.allow ? <LaneButton tone="yes" label={WORDS.allow} onPress={openConnect} /> : null}
            {controls.confirm ? (
              <>
                <Text style={[s.muted, { fontSize: 14 }]} numberOfLines={1}>{WORDS.disconnectAsk(email)}</Text>
                <LaneButton
                  tone="danger"
                  label={WORDS.disconnect}
                  disabled={actions.busy}
                  onPress={() => {
                    // The row settles at once; a refusal shows through actions.error.
                    setConfirming(false);
                    actions.disconnect().catch(() => {});
                  }}
                />
                <LaneButton tone="no" label={WORDS.keep} onPress={() => setConfirming(false)} />
              </>
            ) : null}
            {connected && !controls.confirm ? (
              <LaneButton tone="no" label={WORDS.openWhisk} onPress={() => void openWebPage(whiskUrl)} />
            ) : null}
            {controls.disconnect ? (
              <LaneButton tone="no" label={WORDS.disconnect} disabled={controls.disconnect === 'off'} onPress={() => setConfirming(true)} />
            ) : null}
          </View>
        ) : null}
      </Rise>

      {opened ? (
        <Rise i={3} style={{ marginTop: 12 }}>
          <Callout icon={<Feather name="external-link" size={17} color={c.soft} />}>
            {WORDS.browserNote}
          </Callout>
        </Rise>
      ) : null}

      {known && (controls.connect || connected) ? (
        <Rise i={4}>
          <Text style={[s.faint, { fontSize: 13.5, lineHeight: 20, marginTop: 16 }]}>{disconnectNote(connected)}</Text>
        </Rise>
      ) : null}

      {known && !controls.coming ? (
        <Rise i={5}>
          <Text style={[s.faint, { fontSize: 13.5, lineHeight: 20, marginTop: 8 }]}>
            {WORDS.whiskNote}
            {connected ? null : (
              <Text style={{ color: c.accent }} onPress={() => void openWebPage(whiskUrl)}>{` ${WORDS.openWhisk}`}</Text>
            )}
          </Text>
        </Rise>
      ) : null}
    </LanePage>
  );
}
