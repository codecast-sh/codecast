/** The hatch beside the framed page is the conversation-scroll lane. Wheel
 *  inside the frame reads the object; wheel on the gutter (or its lanes)
 *  moves the parent thread. */
export function revealWheelGoesToParent(target: EventTarget | null, _band?: HTMLElement): boolean {
  const start = target instanceof Element ? target : null;
  if (!start) return true;
  return !start.closest(".object-reveal__frame");
}
