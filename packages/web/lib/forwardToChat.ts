// Forward-to-chat: the one handler behind every share surface's forward icon.
// Opens the command palette in channel pick mode (channels, DMs, teammates
// without a room yet); choosing a room leads to the palette's confirm step
// (optional message, Send button), which sends the link. Both halves are
// local-first — openDmChannel and sendChatMessage return ids synchronously —
// so the flow never waits on the server. Surfaces gate the icon on
// useTeamFeature("chat").

import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import type { PalettePickResult, PalettePickTarget } from "./palettePick";

export type ForwardToChatPayload = {
  /** The link to send — the same URL the surface's copy-link action copies. */
  url: string;
  /** Short name of what is being sent, shown in the picker title. */
  label?: string;
};

export function openForwardToChat(payload: ForwardToChatPayload) {
  useInboxStore.getState().openPalette({
    pick: {
      title: `Send ${payload.label ?? "link"} to…`,
      kinds: ["channel"],
      notePlaceholder: "Add a message (optional)",
      confirmLabel: "Send",
      onPick: (target: PalettePickTarget, result: PalettePickResult) => {
        if (target.kind === "extra") return;
        const store = useInboxStore.getState();
        const channelId =
          target.kind === "person" ? store.openDmChannel([target.id])
          : target.kind === "channel" ? target.id
          : null;
        if (!channelId) return;
        const content = [result.note, payload.url].filter(Boolean).join("\n");
        store.sendChatMessage(channelId, content);
        toast.success(`Sent to ${target.label}`);
      },
    },
  });
}
