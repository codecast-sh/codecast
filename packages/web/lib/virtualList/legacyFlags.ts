// TEMP-VSTAT: A/B switch for the virtuoso-study benchmark. Removed once measured.
// localStorage.vlistLegacy = "1" runs the old measurement, ladder and heal paths.
export const VLIST_LEGACY = (() => {
  try { return typeof localStorage !== "undefined" && localStorage.getItem("vlistLegacy") === "1"; } catch { return false; }
})();
// localStorage.vlistNoSeek = "1" turns fast-scroll placeholders off alone.
export const VLIST_NO_SEEK = VLIST_LEGACY || (() => {
  try { return typeof localStorage !== "undefined" && localStorage.getItem("vlistNoSeek") === "1"; } catch { return false; }
})();
