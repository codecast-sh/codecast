"use client";

import { Unlink, UserMinus } from "lucide-react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { agentFaceConversationId, callParticipantKind, guestIdFromIdentity } from "@codecast/shared/contracts";
import { ContextMenu, CtxItem, type ContextMenuState } from "../ui/context-menu";
import { useGuestLinks } from "../../hooks/useGuestLinks";
import { removeGuest } from "../../lib/calls/guestDoorActions";
import { sayRefusal } from "../../lib/calls/sayRefusal";
import { serverErrorText } from "../../lib/errorCause";
import { firstName } from "./speakers";

export type StagePerson = { identity: string; name: string };

/** What a right click on someone in the call offers: putting them out of it,
 *  at once. An agent goes with its feed (callFace.removeAgent), a guest the
 *  way the door puts one out, a teammate by the media server dropping them
 *  (calls.putOutOfCall). */
export function StagePersonMenu({ roomKey, state, selfId }: { roomKey: string; state: ContextMenuState<StagePerson>; selfId: string | null }) {
  const removeAgent = useAction(api.callFace.removeAgent);
  const putOutOfCall = useAction(api.calls.putOutOfCall);
  const { canInvite } = useGuestLinks(roomKey);
  return (
    <ContextMenu state={state}>
      {({ identity, name }) => {
        const who = firstName(name);
        const refused = sayRefusal(`Could not remove ${who}`);
        const fail = (e: unknown) => refused(serverErrorText(e));
        const kind = callParticipantKind(identity);
        if (kind === "agent") {
          const conversationId = agentFaceConversationId(identity);
          return (
            <CtxItem
              icon={UserMinus}
              danger
              disabled={!conversationId}
              onSelect={() => conversationId && void removeAgent({ room_key: roomKey, conversation_id: conversationId }).catch(fail)}
            >
              Remove {who} from the call
            </CtxItem>
          );
        }
        if (kind === "guest") {
          const guestId = guestIdFromIdentity(identity);
          const off = !guestId || !canInvite;
          return (
            <>
              <CtxItem icon={UserMinus} danger disabled={off} onSelect={() => guestId && void removeGuest(roomKey, guestId, false, refused)}>
                Remove {who} from the call
              </CtxItem>
              <CtxItem icon={Unlink} danger disabled={off} onSelect={() => guestId && void removeGuest(roomKey, guestId, true, refused)}>
                Remove {who} and turn off their link
              </CtxItem>
            </>
          );
        }
        return (
          <CtxItem
            icon={UserMinus}
            danger
            disabled={identity === selfId}
            onSelect={() => void putOutOfCall({ room_key: roomKey, identity }).catch(fail)}
          >
            Remove {who} from the call
          </CtxItem>
        );
      }}
    </ContextMenu>
  );
}
