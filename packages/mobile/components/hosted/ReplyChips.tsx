// What a hosted conversation's last reply offers under it on the phone, as
// the web's chips do (conversation/HostedNotice MailConnectChip and
// RoutineOfferChip, over the one rule in lib/hostedOffers): a reply that
// says to connect mail gets the way to connect it (or, while connecting is
// closed, Whisk on its own), and a first finished answer to an errand that
// repeats offers it as a routine.
import { Pressable } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { Text } from '@/components/Themed';
import { openWebPage } from '@/lib/links';
import { offersMailConnect, routineOffer } from '@codecast/web/lib/hostedOffers';
import { sendToSession } from '@codecast/web/lib/sendToSession';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { WHISK_HOME, useLaneMailAbilities } from '@codecast/web/components/simple/useLaneMail';
import { HOSTED_RADIUS_SM, useHostedTheme } from './hostedTheme';

function Chip({ icon, label, onPress }: { icon: React.ComponentProps<typeof Feather>['name']; label: string; onPress: () => void }) {
  const { c } = useHostedTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        minHeight: 34,
        paddingHorizontal: 12,
        marginTop: 2,
        marginBottom: 10,
        borderRadius: HOSTED_RADIUS_SM,
        borderWidth: 1,
        borderColor: c.lineStrong,
        backgroundColor: pressed ? c.hover : c.sheet,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Feather name={icon} size={13} color={c.ink2} />
      <Text style={{ fontSize: 13, fontWeight: '500', color: c.ink }}>{label}</Text>
    </Pressable>
  );
}

function MailChip() {
  const mail = useLaneMailAbilities();
  const reconnect = mail.connected && mail.needsReconnect;
  if (!mail.known || (mail.connected && !reconnect)) return null;
  if (!reconnect && mail.available === false) {
    return <Chip icon="external-link" label={LANE_COPY.connections.useWhiskNow} onPress={() => void openWebPage(WHISK_HOME)} />;
  }
  if (!reconnect && mail.available !== true) return null;
  return (
    <Chip
      icon="mail"
      label={reconnect ? LANE_COPY.connections.reconnect : 'Connect mail and calendar'}
      onPress={() => router.push('/settings/mail' as never)}
    />
  );
}

/** Under the conversation's last reply: `asked` is the person's last ask,
 *  `personTurns` how many asks they have made, `working` whether a turn
 *  still runs. */
export function ReplyChips({ conversationId, reply, asked, personTurns, working }: {
  conversationId: string;
  reply: string | null | undefined;
  asked: string | undefined;
  personTurns: number;
  working: boolean;
}) {
  if (offersMailConnect(reply)) return <MailChip />;
  const offer = routineOffer(reply, asked, personTurns, working);
  if (!offer) return null;
  return <Chip icon="repeat" label={offer.label} onPress={() => sendToSession(conversationId, offer.ask)} />;
}
