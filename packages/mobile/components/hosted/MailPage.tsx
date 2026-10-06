// Settings > Mail and calendar on the phone (web components/integrations/
// WhiskCard.tsx): the person's mail and calendar, connected through Whisk,
// what each part lets the assistant do, and connect, disconnect or open
// Whisk. Whisk's approval comes back to codecast in the browser that started
// it, where the signed-in session finishes the connection; so Connect opens
// the web's Integrations page, and this screen updates when the connection
// lands.
import { useState } from 'react';
import { View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { SettingsGroup, SettingsScroll } from '@/components/settings/SettingsUI';
import { openWebPage } from '@/lib/links';
import { CODECAST_BASE_URL } from '@codecast/shared/entities';
import type { WhiskReturnPath } from '@codecast/convex/convex/whisk';
import { LANE_COPY, connectionControls, plainConnectError } from '@codecast/web/components/simple/lane';
import { useLaneMail } from '@codecast/web/components/simple/useLaneMail';
import { calendarAbility, disconnectNote, emailAbility, mailboxLine } from '@codecast/web/components/simple/connectionWords';
import { Callout, HostedButton, Pill } from './HostedUI';
import { HOSTED_RADIUS, useHostedTheme } from './hostedTheme';

const WORDS = LANE_COPY.connections;
/** The web page a connect finishes on: Settings > Integrations. */
const CONNECT_PAGE = '/settings/integrations' satisfies WhiskReturnPath;

/** One part of the connection and what it lets the assistant do. `on` is
 *  null until mail is connected: nothing is on or off yet. */
function Service({ icon, title, on, children }: { icon: React.ComponentProps<typeof Feather>['name']; title: string; on: boolean | null; children: string }) {
  const { c } = useHostedTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 13, paddingHorizontal: 15 }}>
      <View style={{ width: 34, height: 34, borderRadius: HOSTED_RADIUS, alignItems: 'center', justifyContent: 'center', backgroundColor: c.wash }}>
        <Feather name={icon} size={16} color={on ? c.ink2 : c.soft} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 14.5, fontWeight: '600', color: c.ink }}>{title}</Text>
          {on === null ? null : <Pill label={on ? WORDS.on : WORDS.off} off={!on} />}
        </View>
        <Text style={{ marginTop: 3, fontSize: 13, lineHeight: 19, color: c.soft }}>{children}</Text>
      </View>
    </View>
  );
}

export function MailPage() {
  const { c, s } = useHostedTheme();
  const mail = useLaneMail(CONNECT_PAGE);
  const { actions, connected, can, email, mailboxes, whiskUrl, known } = mail;
  const [confirming, setConfirming] = useState(false);
  const controls = connectionControls(mail, confirming);
  const [opened, setOpened] = useState(false);
  const error = plainConnectError(actions.error);

  const openConnect = () => {
    setOpened(true);
    void openWebPage(`${CODECAST_BASE_URL}${CONNECT_PAGE}`);
  };

  return (
    <SettingsScroll>
      <Text style={[s.lede, { marginTop: 18, marginHorizontal: 4 }]}>
        {WORDS.whiskNote}
        {connected ? null : (
          <Text style={{ color: c.accent }} onPress={() => void openWebPage(whiskUrl)} accessibilityRole="link">{` ${WORDS.openWhisk}`}</Text>
        )}
      </Text>

      <SettingsGroup footnote={known && (controls.connect || connected) ? disconnectNote(connected) : undefined}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingHorizontal: 15, paddingVertical: 14 }}>
          <Text style={{ fontSize: 15.5, fontWeight: '600', color: c.ink }}>{WORDS.through}</Text>
          <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontSize: 13, color: connected ? c.ok : c.faint }}>
            {!known ? WORDS.checking : connected ? mailboxLine(email, mailboxes) ?? WORDS.connected : controls.coming ? WORDS.coming : WORDS.notConnected}
          </Text>
        </View>
        <Service icon="mail" title={WORDS.email} on={connected ? !!can?.read_mail : null}>{emailAbility(can)}</Service>
        <Service icon="calendar" title={WORDS.calendar} on={connected ? !!can?.calendar : null}>{calendarAbility(can)}</Service>
        {error ? (
          <Callout attention icon={<Feather name="alert-circle" size={15} color={c.attention} />} style={{ margin: 12 }}>
            {error}
          </Callout>
        ) : null}
        {known ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 12 }}>
            {controls.coming ? <Text style={[s.muted, { fontSize: 13, lineHeight: 19 }]}>{WORDS.comingNote}</Text> : null}
            {controls.connect ? <HostedButton tone="yes" label={WORDS.connect} onPress={openConnect} /> : null}
            {controls.allow ? <HostedButton tone="yes" label={WORDS.allow} onPress={openConnect} /> : null}
            {controls.confirm ? (
              <>
                <Text style={[s.muted, { fontSize: 13 }]} numberOfLines={1}>{WORDS.disconnectAsk(email)}</Text>
                <HostedButton
                  tone="danger"
                  label={WORDS.disconnect}
                  disabled={actions.busy}
                  onPress={() => {
                    // The row settles at once; a refusal shows through actions.error.
                    setConfirming(false);
                    actions.disconnect().catch(() => {});
                  }}
                />
                <HostedButton tone="no" label={WORDS.keep} onPress={() => setConfirming(false)} />
              </>
            ) : null}
            {connected && !controls.confirm ? (
              <HostedButton tone="plain" label={WORDS.openWhisk} onPress={() => void openWebPage(whiskUrl)} />
            ) : null}
            {controls.disconnect ? (
              <HostedButton tone="no" label={WORDS.disconnect} disabled={controls.disconnect === 'off'} onPress={() => setConfirming(true)} />
            ) : null}
          </View>
        ) : null}
      </SettingsGroup>

      {opened ? (
        <Callout icon={<Feather name="external-link" size={15} color={c.soft} />} style={{ marginTop: 14 }}>
          {WORDS.browserNote}
        </Callout>
      ) : null}
    </SettingsScroll>
  );
}
