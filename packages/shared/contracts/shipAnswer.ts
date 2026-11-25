// Whether a card's answer is a yes to merging (pl-1075 Words): "Ship", as the card's button read until now, or
// "Approve merge", as it reads now. The one test of it everywhere: the server's merge checks (convex
// lib/taskVerdicts), the run pages and the evals.
export const optionIsShip = (label: unknown): boolean => /^(ship|approve merge)\b/i.test(String(label ?? "").trim());
