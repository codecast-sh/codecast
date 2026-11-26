// Which of a list's viewable items are session rows under the owners model,
// in list order: the ids a phone list reports to the window's owners feeder
// (web lib/visibleOwnerCards setViewableOwnerCards). No React Native in here.
import { underOwnersModel } from '@codecast/shared/contracts';
import { isConvexId } from '@codecast/web/lib/entityLinks';

type Viewable = { index: number | null; item: { kind: string; session?: { _id: string } } | null | undefined };

export function viewableOwnerIds(items: readonly Viewable[]): string[] {
  return items
    .filter((v) => v.item?.kind === 'row' && !!v.item.session && underOwnersModel(v.item.session as never) && isConvexId(v.item.session._id))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((v) => String(v.item!.session!._id));
}
