// The two ways to reach a teammate from the phone, shared by the Chat tab's
// people rows and the person screen so both open the same room the same way.
import * as Haptics from 'expo-haptics';
import type { Router } from 'expo-router';
import { dmRoomKey } from '@codecast/shared/contracts';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import type { LiveRoomRow } from '@/components/calls/LiveRooms';
import { joinCall, startHuddle } from '@/lib/calls/callManager';

/** Open the direct message with one person. Local-first: openDmChannel
 *  answers in this tick with the room's real id or a stub the server row
 *  supersedes, so the push never waits on the network. */
export function openDmWith(router: Router, userId: string): void {
  void Haptics.selectionAsync();
  const channelId = useInboxStore.getState().openDmChannel([userId]);
  router.push({ pathname: '/chat/[id]', params: { id: channelId } } as never);
}

/** Join the huddle they are in when this viewer may, else ring them into a
 *  new one. */
export function huddleWith(router: Router, viewerId: string, userId: string, inRoom: LiveRoomRow | null): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  if (inRoom && (inRoom.canJoin || inRoom.mine)) {
    void joinCall(inRoom.roomKey);
  } else {
    void startHuddle({ roomKey: dmRoomKey(viewerId, userId), toUserIds: [userId] });
  }
  router.push('/call');
}

/** The live room a person sits in, from the rows useLiveRooms holds. */
export function liveRoomOf(rooms: readonly LiveRoomRow[] | undefined, userId: string): LiveRoomRow | null {
  return (rooms ?? []).find((r) => r.members.some((x) => String(x.user_id) === userId)) ?? null;
}
