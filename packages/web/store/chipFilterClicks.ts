import { useInboxStore, chipBucketFilters, chipProjectFilters, type BucketFilterTerm } from "./inboxStore";

// Click is a pure toggle: include the chip, click again to clear. Exclude
// ("everything but this") is a deliberate gesture — ⌥/Alt-click, or the
// right-click menu — never a state the plain click cycles through. Clicking
// a chip that is THE filter in either mode clears it, so a click's result
// never surprises: same chip = off, different chip = on (a plain click on a
// multi-term filter collapses it to just the clicked chip). ⇧ makes the
// gesture ADDITIVE instead: toggle this chip in the include list, ⇧⌥ in
// the negative list. ONE gesture table for both axes — a label and a
// project chip differ only in which store setters they reach — and for every
// surface that names a label or a project: the chip row and the session card.
function clickTerm(
  filters: readonly BucketFilterTerm[],
  id: string,
  alt: boolean | undefined,
  shift: boolean | undefined,
  set: (id: string | null, exclude?: boolean) => void,
  toggle: (id: string, exclude: boolean) => void,
) {
  if (shift) {
    toggle(id, !!alt);
    return;
  }
  const sole = filters.length === 1 && filters[0].id === id;
  if (alt) {
    if (sole && filters[0].exclude) set(null);
    else set(id, true);
  } else {
    set(sole ? null : id);
  }
}

export function clickBucketChip(bucketId: string, alt?: boolean, shift?: boolean) {
  const store = useInboxStore.getState();
  clickTerm(chipBucketFilters(store), bucketId, alt, shift,
    (id, exclude) => store.setActiveBucketFilter(id, exclude),
    (id, exclude) => store.toggleBucketFilterTerm(id, exclude));
}

export function clickProjectChip(name: string, path: string | null, alt?: boolean, shift?: boolean) {
  const store = useInboxStore.getState();
  clickTerm(chipProjectFilters(store), name, alt, shift,
    (id, exclude) => store.setActiveProjectFilter(id, id ? path : null, exclude),
    (id, exclude) => store.toggleProjectFilterTerm(id, path, exclude));
}
