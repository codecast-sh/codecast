// The desktop room panel's width: 420 by default, between 340 and
// min(640, half the viewport), remembered on this device (DESIGN 6.3).
export const ROOM_DEFAULT = 420;
const ROOM_MIN = 340;
const ROOM_MAX = 640;

export function clampWidth(w: number): number {
  return Math.round(Math.min(Math.max(w, ROOM_MIN), Math.min(ROOM_MAX, innerWidth * 0.5)));
}
