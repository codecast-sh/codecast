/** Human copy for when a team invite code stops working. Lives in lib/ so
 *  InvitePanel stays a clean Fast Refresh boundary (component-only exports). */
export function formatInviteExpiry(timestamp: number | undefined): string {
  if (!timestamp) return "No expiry set";
  const diff = timestamp - Date.now();
  if (diff < 0) return "Expired";
  const hour = 1000 * 60 * 60;
  const day = 24 * hour;
  // Round, never floor: a link made a moment ago has 7 days minus a few
  // seconds left, and it must read "Expires in 7 days", the promise the
  // regenerate note makes.
  if (diff >= day) {
    const days = Math.round(diff / day);
    return `Expires in ${days} day${days === 1 ? "" : "s"}`;
  }
  if (diff >= hour) {
    const hours = Math.round(diff / hour);
    return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return "Expires soon";
}
