/** Human copy for when a team invite code stops working. Lives in lib/ so
 *  InvitePanel stays a clean Fast Refresh boundary (component-only exports). */
export function formatInviteExpiry(timestamp: number | undefined): string {
  if (!timestamp) return "No expiry set";
  const diff = timestamp - Date.now();
  if (diff < 0) return "Expired";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `Expires in ${days} day${days === 1 ? "" : "s"}`;
  if (hours > 0) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "Expires soon";
}
