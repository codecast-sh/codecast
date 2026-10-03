import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, Share, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useMutation } from "convex/react";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useGuestLinks } from "@codecast/web/hooks/useGuestLinks";
import { useQueryNoThrow } from "@codecast/web/hooks/useQueryNoThrow";
import { useConvexSync } from "@codecast/web/hooks/useConvexSync";
import { api } from "@codecast/convex/convex/_generated/api";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { CODECAST_BASE_URL } from "@codecast/shared/entities";
import { Text } from "@/components/Themed";
// The call stage is always dark (call.tsx says why), so the light palette's
// contrast reads are the right ones here too.
import { SolarizedLight as Theme } from "@/constants/Theme";
import { useAuth } from "@/lib/auth";

// THE DOOR, ON A PHONE: somebody from outside the team, on a guest link,
// asking to be let in (callGuests.ts has the rules).
//
// A room whose people are all on phones could otherwise never admit a guest:
// the web's door lives on its stage, and a guest would wait at "the room
// knows you're here" for nobody. So the call screen shows each guest at the
// door with the two answers. A guest is always named with "(guest)" (a
// phone has no room for the web's badge), and Admit sends the name this card
// showed, so somebody who renamed themselves since is asked about again
// rather than let in unseen (admitGuest's `name`). The card says whose link
// brought them, and a link the room already turned somebody away from offers
// to close with the answer, as the web's door does. A person who may not
// answer the door (getRoomKnocks' can_answer) sees who is waiting and no
// buttons. Teammates' knocks stay with the web's door, as before.
//
// Inside, a guest's face is pressable (useGuestRemover): somebody hosting
// from a phone can put out a guest who should not be there, and close the
// link they came in on.
//
// And the link itself (GuestInviteRow): the "a guest is waiting" push brings
// the link's maker to this screen, so this screen is where they send it
// again, or to somebody else, and turn it off. The phone's own share sheet
// is the copy button.

type GuestKnock = {
  from_user: string;
  from_name: string;
  created_at: number;
  kind?: "guest" | "person";
  guest_id?: string;
  can_answer?: boolean;
  link_turned_away?: number;
  link_by?: string;
  link_mine?: boolean;
};

/** Whose link brought a guest, as the door says it. */
function linkOf(k: GuestKnock): string | null {
  if (!k.link_by) return null;
  return k.link_mine ? "your link" : `${k.link_by.split(/\s+/)[0]}'s link`;
}

/** Put a guest out from a phone: the press on their face asks first, and
 *  offers to close the link they came in on (somebody put out can open it
 *  again in a private window and knock as somebody new). Null for a viewer
 *  who could not (the same answer the web's remove button reads: whether
 *  the room's link list answers them at all). */
export function useGuestRemover(roomKey: string | null): ((guestId: string, name: string) => void) | null {
  const { canInvite } = useGuestLinks(roomKey);
  if (!roomKey || !canInvite) return null;
  return (guestId, name) => {
    // The store's action takes them off the faces now; a refusal puts them back.
    const out = (revokeLink: boolean) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      void useInboxStore.getState().removeCallGuest(roomKey, guestId, revokeLink).catch((err: unknown) =>
        Alert.alert("Couldn't remove them", humanizeConvexError(err, "Something went wrong")),
      );
    };
    Alert.alert(`Remove ${name} (guest)?`, "They leave the call at once. Turning off their link also stops anyone new from using it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => out(false) },
      { text: "Remove and turn off link", style: "destructive", onPress: () => out(true) },
    ]);
  };
}

/** Invite somebody from outside the team, from the phone: make a link (or
 *  take the one already open) and hand it to the share sheet, and turn it
 *  off. Shown to whoever could make one here, which is the server's answer:
 *  callGuests.listGuestLinks is null for anybody else, the gate the web's
 *  invite reads. The link stays open for the default time; picking another
 *  length is the web panel's. */
export function GuestInviteRow({ roomKey }: { roomKey: string | null }) {
  // The room's links off the store's guestLinks home (web's own feeder):
  // whether the viewer may invite is the server's answer, unknown until it
  // lands, and the row waits for it rather than offer a press that fails.
  const { links, canInvite } = useGuestLinks(roomKey);
  const create = useMutation(api.callGuests.createGuestLink);
  const revoke = useMutation(api.callGuests.revokeGuestLink);
  const [busy, setBusy] = useState<null | "share" | "off">(null);
  if (!roomKey || !canInvite) return null;
  const mine = links.find((l) => l.mine) ?? null;

  const share = async () => {
    setBusy("share");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      // The server hands back the viewer's open link when there is one, so a
      // second press shares the same address rather than minting another.
      const link = mine ?? (await create({ room_key: roomKey }));
      const url = `${CODECAST_BASE_URL}${link.path}`;
      await Share.share({ message: `Join my call on codecast: ${url}`, url });
    } catch (err) {
      Alert.alert("Couldn't make a guest link", humanizeConvexError(err, "Something went wrong"));
    } finally {
      setBusy(null);
    }
  };
  const turnOff = () => {
    if (!mine) return;
    Alert.alert("Turn off your guest link?", "Nobody new can use it. Guests already in the call stay.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Turn off",
        style: "destructive",
        onPress: () => {
          setBusy("off");
          void revoke({ link_id: mine.link_id as any })
            .catch((err: unknown) => Alert.alert("Couldn't turn the link off", humanizeConvexError(err, "Something went wrong")))
            .finally(() => setBusy(null));
        },
      },
    ]);
  };
  const state = mine
    ? [mine.waiting > 0 ? `${mine.waiting} waiting` : null, mine.admitted > 0 ? `${mine.admitted} in the call` : null].filter(Boolean).join(" · ") ||
      "Your link is open"
    : "They join from a link in a browser, no account";

  return (
    <View style={styles.invite}>
      <View style={styles.body}>
        <Text style={styles.inviteTitle}>Invite a guest</Text>
        <Text style={styles.text} numberOfLines={1}>
          {state}
        </Text>
      </View>
      <View style={styles.actions}>
        {mine && (
          <Pressable
            disabled={!!busy}
            onPress={turnOff}
            hitSlop={6}
            style={({ pressed }) => [styles.btn, (pressed || busy === "off") && styles.pressed]}
            accessibilityLabel="Turn off your guest link"
          >
            <Text style={styles.btnText}>{busy === "off" ? "…" : "Turn off"}</Text>
          </Pressable>
        )}
        <Pressable
          disabled={!!busy}
          onPress={() => void share()}
          hitSlop={6}
          style={({ pressed }) => [styles.btn, styles.btnPrimary, (pressed || busy === "share") && styles.pressed]}
          accessibilityLabel={mine ? "Share your guest link" : "Make a guest link and share it"}
        >
          <Text style={styles.btnPrimaryText}>{busy === "share" ? "…" : mine ? "Share link" : "Get link"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function GuestDoor({ roomKey }: { roomKey: string | null }) {
  // Who is at the door, in the store's roomKnocks home: fed here while the
  // stage shows the room, and answered through the store's localFirst
  // actions, so an answered knock leaves at once and a refusal restores it.
  const { isAuthenticated } = useAuth();
  const { data: knockFeed } = useQueryNoThrow(
    api.calls.getRoomKnocks,
    isAuthenticated && roomKey ? { room_key: roomKey, guests: true } : "skip",
  );
  useConvexSync(knockFeed, useCallback((d: any) => {
    useInboxStore.getState().syncTable("roomKnocks", d);
  }, []));
  const knocks = useInboxStore((s) => s.roomKnocks) as GuestKnock[];
  const guests = knocks.filter((k) => k.kind === "guest" && k.guest_id);

  // A new knock is felt as well as seen: the phone may be face up on a desk.
  const heard = useRef(new Set<string>());
  useEffect(() => {
    let fresh = false;
    for (const k of guests) {
      const key = `${k.guest_id}:${k.created_at}`;
      if (!heard.current.has(key)) fresh = true;
      heard.current.add(key);
    }
    if (fresh) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [guests.map((k) => `${k.guest_id}:${k.created_at}`).join("|")]);

  if (guests.length === 0) return null;

  const answer = (k: GuestKnock, how: "admit" | "deny" | "deny_link") => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const store = useInboxStore.getState();
    const run =
      how === "admit"
        ? store.admitGuestKnock(k.guest_id!, k.from_name)
        : store.denyGuestKnock(k.guest_id!, how === "deny_link");
    void run.catch((err: unknown) =>
      Alert.alert(how === "admit" ? "Couldn't let them in" : "Couldn't turn them away", humanizeConvexError(err, "Something went wrong")),
    );
  };

  return (
    <View style={styles.wrap}>
      {guests.map((k) => {
        const canAnswer = k.can_answer !== false;
        return (
          <View key={k.from_user} style={styles.card} accessibilityRole="alert">
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={1}>
                {k.from_name} <Text style={styles.guest}>(guest)</Text>
              </Text>
              <Text style={styles.text}>
                {canAnswer
                  ? `Wants to join from ${linkOf(k) ?? "a guest link"}`
                  : "Waiting at the door. Someone in the call can let them in"}
              </Text>
              {canAnswer && (k.link_turned_away ?? 0) >= 1 && (
                <Pressable
                  onPress={() => answer(k, "deny_link")}
                  hitSlop={6}
                  style={({ pressed }) => [styles.linkBtn, pressed && styles.pressed]}
                  accessibilityLabel={`Turn ${k.from_name} away and turn the link off`}
                >
                  <Text style={styles.linkBtnText}>
                    {k.link_turned_away} turned away from this link already · Deny and turn off link
                  </Text>
                </Pressable>
              )}
            </View>
            {canAnswer && (
              <View style={styles.actions}>
                <Pressable
                  onPress={() => answer(k, "deny")}
                  hitSlop={6}
                  style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
                  accessibilityLabel={`Don't let ${k.from_name} in`}
                >
                  <Text style={styles.btnText}>Deny</Text>
                </Pressable>
                <Pressable
                  onPress={() => answer(k, "admit")}
                  hitSlop={6}
                  style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}
                  accessibilityLabel={`Let ${k.from_name} in`}
                >
                  <Text style={styles.btnPrimaryText}>Admit</Text>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 14, marginBottom: 8, gap: 6 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "rgba(181,137,0,0.12)",
    borderWidth: 1,
    borderColor: "rgba(181,137,0,0.30)",
  },
  invite: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 14,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "rgba(253,246,227,0.05)",
    borderWidth: 1,
    borderColor: "rgba(253,246,227,0.10)",
  },
  inviteTitle: { fontSize: 12.5, color: Theme.bgAlt },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 12.5, color: Theme.bgAlt },
  guest: { fontSize: 12.5, color: Theme.yellow },
  text: { fontSize: 11.5, lineHeight: 16, color: Theme.textDim },
  actions: { flexDirection: "row", gap: 6 },
  btn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: "rgba(253,246,227,0.10)" },
  btnPrimary: { backgroundColor: Theme.yellow },
  btnText: { fontSize: 12, color: Theme.bgAlt },
  btnPrimaryText: { fontSize: 12, color: "#002b36" },
  linkBtn: { marginTop: 4, alignSelf: "flex-start" },
  linkBtnText: { fontSize: 11, color: Theme.red },
  pressed: { opacity: 0.6 },
});
