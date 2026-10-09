// Presentation layer for published artifacts: every HTML surface the origin
// serves — the injected bar + og meta, the access-gate interstitials, the
// source / diff / editor pages, and the markdown reading theme. Pure string
// builders, no db access; artifacts.ts owns data, http.ts owns routing.
//
// All pages are self-contained (inline CSS/JS, no external requests except to
// `apiBase`) because artifact documents are served under a sandbox CSP with an
// opaque origin. That opaque origin also means localStorage THROWS on access —
// every storage touch goes through a try/catch helper that degrades to an
// in-memory value for the life of the page. Secrets travel only in URL
// fragments (#o / #ed / #em), never query strings.

// The codecast mark (components/Logo.tsx paths, 1024 canvas). C follows
// currentColor via the bar's text color; the coral arrow is theme-stable.
const LOGO_C =
  "M484.642334,414.398438 C441.085785,414.100739 407.961426,431.836365 389.038177,470.938019 C359.991791,530.957275 397.919464,599.922302 462.212036,610.452393 C488.377197,614.737732 512.859131,609.315125 534.993835,594.283020 C536.985901,592.930176 538.769653,590.998291 541.395325,590.790649 C542.830750,592.057068 542.358704,593.648865 542.360229,595.064209 C542.383118,615.894470 542.245728,636.725830 542.454224,657.553894 C542.495239,661.645569 540.944946,663.478516 537.347595,664.804260 C457.310547,694.300720 365.884827,658.371399 330.527679,577.853210 C318.822357,551.196838 314.364532,523.336731 317.783875,494.457825 C326.474518,421.058838 381.311096,368.253448 444.614929,354.822266 C476.047852,348.153107 507.120667,349.994629 537.405273,361.541992 C541.135986,362.964569 542.456543,364.823730 542.420715,368.821503 C542.237122,389.316772 542.366028,409.814758 542.335571,430.311707 C542.333191,431.888306 542.886780,433.635895 541.039673,435.579559 C524.470764,423.311615 505.857056,415.935822 484.642334,414.398438z";
const LOGO_ARROW =
  "M595.160889,540.159180 C602.995361,532.661072 610.436890,525.255066 618.219727,518.227051 C621.594788,515.179443 621.862915,513.288818 618.369263,510.015167 C605.976135,498.402374 593.950073,486.398682 581.638672,474.697052 C578.746277,471.947968 577.631470,469.026062 577.653381,465.050171 C577.786804,440.902161 577.692810,416.752869 577.674988,392.604004 C577.673828,390.969238 577.674927,389.334503 577.674927,387.822937 C580.475952,386.927032 581.524963,388.753571 582.754211,389.949341 C611.163818,417.584045 639.573853,445.218567 667.919434,472.919006 C680.901062,485.605255 693.661133,498.519287 706.712463,511.132599 C709.948914,514.260376 709.647461,516.128052 706.514099,519.115662 C674.820679,549.334167 643.279907,579.712769 611.649353,609.997375 C601.908936,619.323242 592.027832,628.502197 582.202148,637.738831 C581.252808,638.631287 580.419067,639.758240 578.788452,639.713379 C577.032288,638.391235 577.739929,636.409241 577.736206,634.708374 C577.682861,610.393066 577.748169,586.077332 577.625610,561.762512 C577.608215,558.319458 578.534119,555.799866 581.153076,553.487549 C585.892944,549.302612 590.338135,544.783875 595.160889,540.159180z";

// Paths drawn at more than one size (bar chip + empty state, pin button + pin
// jump), so the shape lives once and the size is the caller's choice.
const BUBBLE_PATH = `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`;
const PIN_PATH = `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>`;

import { escAttr, escHtml } from "./htmlEscape";
import { MD_THEME_CSS } from "./artifactMarkdown";
import { PAGE_AGENT_LABELS, PAGE_AGENT_PICKUP_MS } from "@codecast/shared/contracts";
export { escAttr, escHtml };

// Every icon we inject is built here, and its size rides in an INLINE STYLE,
// never in the width/height attributes alone. The bar and its panels live in
// the artifact's own DOM (no shadow root), so the artifact's CSS reaches them —
// and a width attribute has zero specificity, so one bare rule wins over it.
// A dashboard that ships `svg{display:block;width:100%;height:auto}` for its
// charts (a normal thing to write) blew every icon up to panel width. An inline
// style outranks any host rule short of !important, so the size holds.
// `display` and `flex` are pinned for the same reason: a host `svg{display:block}`
// would drop an icon onto its own line inside a text link.
function iconStyle(size: number): string {
  return `width:${size}px;height:${size}px;display:inline-block;vertical-align:middle;flex:none;max-width:none;min-width:0`;
}

function iconSvg(size: number, body: string, opts?: { sw?: number; stroke?: string }): string {
  return `<svg width="${size}" height="${size}" style="${iconStyle(size)}" viewBox="0 0 24 24" fill="none" stroke="${opts?.stroke ?? "currentColor"}" stroke-width="${opts?.sw ?? 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function logoSvg(size = 22): string {
  return `<svg width="${size}" height="${size}" style="${iconStyle(size)}" viewBox="290 340 440 340" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="${LOGO_C}"/><path fill="#e86c5d" d="${LOGO_ARROW}"/></svg>`;
}

export interface BrandOpts {
  title: string;
  author?: string | null;
  updatedAt: number;
  shareUrl: string;
  // Version of the document being served vs the artifact's current version.
  version?: number;
  currentVersion?: number;
  // Absolute URL of the ?meta=1 JSON; absent disables version chip, history,
  // polling, comments, and manage (plain legacy bar).
  metaUrl?: string;
  // Absolute origin base for API calls, e.g. https://convex.codecast.sh
  apiBase?: string;
  slug?: string;
  kind?: string;
  sessionShortId?: string | null;
  // The link target. Short ids collide across users and the web resolver
  // ranks the VIEWER's own match first, so a short-id link opened by anyone
  // holding a colliding session landed on theirs; the full id cannot collide.
  sessionConversationId?: string | null;
  sessionTitle?: string | null;
  views?: number;
  commentCount?: number;
  commentsEnabled?: boolean;
  gated?: { password: boolean; email: boolean };
  editMode?: string;
  live?: boolean;
  hasThumb?: boolean;
  // A publishing session exists: comments can be sent to its agent, and the
  // bar shows the agent's state.
  hasAgent?: boolean;
}

// ---------------------------------------------------------------------------
// The injected bar. Everything is id-prefixed __cc_ and styles are scoped to
// those ids so the bar can't collide with the artifact's own markup. Pinned to
// the viewport top; the html margin reserves its height (never an overlay).
//
// Panels (history / menu / comments / manage) are anchored dropdowns on
// desktop and become drag-handle bottom sheets under 640px. The comments
// panel is a DISCUSSION every viewer can read and post to (drafts pinned by
// tapping the page, or anchored to a text selection). Pushing the discussion
// into the author's session is owner-only: with the #o= key the panel adds
// "Send to session" / "Send all", and the server enforces the same rule.
// ---------------------------------------------------------------------------
function barHtml(o: BrandOpts): string {
  const when = new Date(o.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const version = o.version ?? 1;
  const currentVersion = o.currentVersion ?? version;
  const viewingOld = version < currentVersion;
  const interactive = !!o.metaUrl;
  const chevronSvg = iconSvg(9, `<path d="m6 9 6 6 6-6"/>`, { sw: 2.6 });
  const bubbleSvg = iconSvg(14, BUBBLE_PATH);
  const verChip = interactive
    ? `<button id="__cc_ver" type="button" title="Version history"${viewingOld ? ' class="__cc_old"' : ""}>v${version}${viewingOld ? " (old)" : ""} ${chevronSvg}</button>`
    : "";
  const upRightSvg = iconSvg(11, `<path d="M7 7h10v10"/><path d="M7 17 17 7"/>`);
  const dotsSvg = iconSvg(15, `<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`);
  const latestLink = viewingOld ? `<a id="__cc_latest" href="#">Latest ${upRightSvg}</a>` : "";
  // The chip reads as the session's TITLE (a short id means nothing to a
  // viewer); the id stays in the tooltip and the href.
  const sessionLink = o.sessionShortId
    ? `<a class="__cc_sess" href="https://codecast.sh/conversation/${escAttr(o.sessionConversationId || o.sessionShortId)}" target="_blank" rel="noopener noreferrer" title="Open the session that published this (${escAttr(o.sessionShortId)})">${escAttr(o.sessionTitle || `by ${o.sessionShortId}`)}</a>`
    : "";
  const commentsBtn = interactive && o.commentsEnabled !== false
    ? `<button id="__cc_cbtn" type="button" title="Discuss this page">${bubbleSvg}<span id="__cc_ccount">${o.commentCount || ""}</span></button>`
    : "";
  const menuBtn = interactive ? `<button id="__cc_menu" type="button" title="More">${dotsSvg}</button>` : "";
  const collapseSvg = iconSvg(13, `<path d="m17 14-5-5-5 5"/>`);
  const hideBtn = `<button id="__cc_hide" type="button" title="Hide this bar">${collapseSvg}</button>`;
  const cfg = {
    metaUrl: o.metaUrl ?? "",
    apiBase: o.apiBase ?? "",
    shareUrl: o.shareUrl,
    slug: o.slug ?? "",
    version,
    currentVersion,
    kind: o.kind ?? "html",
    views: o.views ?? 0,
    comments: o.commentCount ?? 0,
    live: !!o.live,
    editMode: o.editMode ?? "owner",
    gated: o.gated ?? { password: false, email: false },
    hasAgent: !!o.hasAgent,
    agentLabels: PAGE_AGENT_LABELS,
    agentPickupMs: PAGE_AGENT_PICKUP_MS,
  };
  return `
<style id="__cc_style">
  /* codecast web styles: JetBrains Mono (same Google Fonts source the web
     app uses) + the Solarized token palette from globals.css. */
  @import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap");
  /* Pinned to the viewport top; the html margin reserves exactly the bar's
     height so the artifact's content starts below it — pinned, not overlaying.
     Colors ride on custom properties; html.__cc_dark (set by JS from the
     artifact's measured background luminance) flips the whole palette so the
     bar reads as part of the page instead of a white strip over a dark one. */
  html { margin-top: 40px !important; }
  /* Minimized: the bar slides away and a small corner pill brings it back. */
  html.__cc_min, html.__cc_embed { margin-top: 0 !important; }
  html.__cc_embed #__cc_bar, html.__cc_embed #__cc_pill { display: none !important; }
  html.__cc_min #__cc_bar { transform: translateY(-100%); box-shadow: none; pointer-events: none; }
  html.__cc_min #__cc_pill { display: inline-flex; }
  #__cc_bar, .__cc_panel, #__cc_hint, #__cc_pill, #__cc_mlist, #__cc_notes, #__cc_qbtn {
    --cc-bg: rgba(253,252,250,.9); --cc-ink: #002b36; --cc-mut: #586e75; --cc-dim: rgba(0,43,54,.48);
    --cc-line: rgba(88,110,117,.22); --cc-hov: rgba(0,43,54,.06); --cc-card: #ffffff; --cc-soft: #faf9f7;
    --cc-inbd: rgba(0,43,54,.22); --cc-blue: #268bd2; --cc-green: #859900; --cc-coral: #e86c5d;
    --cc-shadow: rgba(0,43,54,.16); }
  html.__cc_dark #__cc_bar, html.__cc_dark .__cc_panel, html.__cc_dark #__cc_hint, html.__cc_dark #__cc_pill, html.__cc_dark #__cc_mlist, html.__cc_dark #__cc_notes, html.__cc_dark #__cc_qbtn {
    --cc-bg: rgba(0,43,54,.85); --cc-ink: #fdf6e3; --cc-mut: #93a1a1; --cc-dim: rgba(253,246,227,.45);
    --cc-line: rgba(147,161,161,.18); --cc-hov: rgba(147,161,161,.1); --cc-card: #08404e; --cc-soft: #073642;
    --cc-inbd: rgba(147,161,161,.32); --cc-blue: #268bd2; --cc-green: #859900;
    --cc-shadow: rgba(0,0,0,.5); }
  #__cc_bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; z-index: 2147483647;
    display: flex; align-items: center; gap: 2px;
    box-sizing: border-box;
    padding: 0 calc(10px + env(safe-area-inset-right)) 0 calc(12px + env(safe-area-inset-left));
    font: 500 12px/1 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--cc-bg); color: var(--cc-mut);
    -webkit-backdrop-filter: saturate(1.6) blur(12px); backdrop-filter: saturate(1.6) blur(12px);
    border-bottom: 1px solid var(--cc-line); box-shadow: 0 1px 8px rgba(0,0,0,.05);
    text-align: left; transition: transform .22s ease; }
  #__cc_pill { position: fixed; top: 8px; right: calc(8px + env(safe-area-inset-right)); z-index: 2147483647;
    display: none; align-items: center; justify-content: center; width: 30px; height: 30px;
    border: 1px solid var(--cc-line); border-radius: 999px; background: var(--cc-bg); color: var(--cc-ink);
    -webkit-backdrop-filter: saturate(1.6) blur(12px); backdrop-filter: saturate(1.6) blur(12px);
    cursor: pointer; padding: 0; margin: 0; opacity: .55; transition: opacity .15s ease, transform .15s ease;
    -webkit-tap-highlight-color: transparent; }
  #__cc_pill:hover { opacity: 1; transform: scale(1.06); }
  #__cc_pill svg { display: block; }
  #__cc_bar .__cc_brand { color: var(--cc-ink); text-decoration: none; display: inline-flex; align-items: center;
    opacity: .85; margin-right: 8px; }
  #__cc_bar .__cc_brand:hover { opacity: 1; }
  #__cc_bar .__cc_title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500; color: var(--cc-ink); opacity: .82; letter-spacing: .01em; margin-right: 8px; }
  #__cc_bar .__cc_sess { color: var(--cc-blue); text-decoration: none; white-space: nowrap; font-weight: 400;
    opacity: .8; padding: 5px 7px; border-radius: 7px; max-width: 28ch; overflow: hidden; text-overflow: ellipsis; }
  #__cc_bar .__cc_sess:hover { opacity: 1; background: var(--cc-hov); }
  #__cc_bar .__cc_when { color: var(--cc-dim); font-weight: 400; white-space: nowrap; padding: 0 7px; }
  #__cc_bar .__cc_dot { color: var(--cc-dim); opacity: .6; }
  #__cc_bar button { all: unset; cursor: pointer; padding: 5px 8px; border-radius: 7px; font: inherit; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 5px; color: var(--cc-mut);
    -webkit-tap-highlight-color: transparent; transition: background .1s ease, color .1s ease; }
  #__cc_bar button:hover { background: var(--cc-hov); color: var(--cc-ink); }
  #__cc_bar button[hidden] { display: none; }
  #__cc_bar button svg { flex: none; opacity: .8; }
  #__cc_bar #__cc_ver { border: 1px solid var(--cc-line); border-radius: 999px; padding: 3px 9px; gap: 4px;
    font-weight: 600; color: var(--cc-ink); }
  #__cc_bar #__cc_ver:hover { border-color: var(--cc-inbd); background: var(--cc-hov); }
  #__cc_bar #__cc_ver.__cc_old { color: #c07a28; border-color: rgba(192,122,40,.45); }
  #__cc_bar #__cc_new { background: var(--cc-coral); color: #ffffff; font-weight: 600; margin: 0 2px; padding: 5px 10px; }
  #__cc_bar #__cc_new:hover { background: #d85b4c; color: #ffffff; }
  #__cc_bar #__cc_latest { color: var(--cc-blue); text-decoration: none; padding: 5px 8px; border-radius: 7px; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 3px; }
  #__cc_bar #__cc_latest:hover { background: var(--cc-hov); }
  /* The page's agent: a quiet status chip (idle / working / needs input /
     updating after a comment was sent to it). */
  #__cc_bar #__cc_agent { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; margin: 0 4px;
    border-radius: 999px; color: var(--cc-dim); font-weight: 500; white-space: nowrap; cursor: default; }
  #__cc_bar #__cc_agent[hidden] { display: none; }
  #__cc_bar #__cc_agent .__cc_adot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .7; flex: none; }
  #__cc_bar #__cc_agent.__cc_aw { color: var(--cc-blue); }
  #__cc_bar #__cc_agent.__cc_au { color: var(--cc-coral); background: rgba(232,108,93,.1); }
  #__cc_bar #__cc_agent.__cc_an { color: #c07a28; background: rgba(192,122,40,.1); }
  #__cc_bar #__cc_agent.__cc_aw .__cc_adot, #__cc_bar #__cc_agent.__cc_au .__cc_adot { opacity: 1; animation: __cc_abreathe 1.6s ease-in-out infinite; }
  @keyframes __cc_abreathe { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { #__cc_bar #__cc_agent .__cc_adot { animation: none !important; } }
  #__cc_bar #__cc_ccount { color: var(--cc-dim); font-size: 10px; font-weight: 600; }
  #__cc_bar #__cc_ccount:empty { display: none; }
  .__cc_panel { position: fixed; top: 46px; right: 10px; z-index: 2147483647; min-width: 272px; max-width: min(92vw, 400px);
    max-height: 72vh; overflow-y: auto; overscroll-behavior: contain;
    background: var(--cc-card); color: var(--cc-mut); border-radius: 12px;
    box-shadow: 0 10px 32px var(--cc-shadow), 0 0 0 1px var(--cc-line);
    font: 400 12px/1.45 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 8px; text-align: left;
    opacity: 0; transform: translateY(-4px); transition: opacity .16s ease, transform .16s ease; }
  .__cc_panel.__cc_in { opacity: 1; transform: none; }
  .__cc_panel[hidden] { display: none; }
  .__cc_panel a { color: inherit; text-decoration: none; }
  .__cc_panel .__cc_row { display: flex; justify-content: space-between; gap: 14px; align-items: baseline; padding: 6px 8px; border-radius: 7px; }
  .__cc_panel .__cc_row:hover { background: var(--cc-hov); }
  .__cc_panel .__cc_vlabel { font-weight: 600; color: var(--cc-ink); }
  .__cc_panel a.__cc_cur .__cc_vlabel::after { content: " · current"; font-weight: 400; color: var(--cc-green); }
  .__cc_panel a.__cc_viewing { background: rgba(232,108,93,.12); }
  .__cc_panel .__cc_vwhen { color: var(--cc-dim); white-space: nowrap; }
  .__cc_panel .__cc_note { padding: 6px 8px; color: var(--cc-dim); }
  .__cc_panel .__cc_dlink { opacity: .6; margin-left: 8px; }
  .__cc_panel .__cc_dlink:hover { opacity: 1; color: var(--cc-blue); }
  .__cc_panel .__cc_ph { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px 8px; }
  .__cc_panel .__cc_pht { font-weight: 600; color: var(--cc-ink); font-size: 13px; }
  .__cc_panel .__cc_phn { color: var(--cc-dim); }
  .__cc_panel .__cc_h2 { font-weight: 600; color: var(--cc-ink); padding: 12px 8px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .07em; opacity: .7; }
  .__cc_panel .__cc_kv { display: flex; align-items: center; gap: 8px; padding: 5px 8px; flex-wrap: wrap; }
  .__cc_panel .__cc_k { color: var(--cc-ink); }
  .__cc_panel .__cc_v { color: var(--cc-dim); }
  .__cc_panel .__cc_v.__cc_on { color: var(--cc-green); }
  .__cc_panel .__cc_sp { flex: 1; }
  .__cc_panel .__cc_btn { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 7px; background: var(--cc-hov); color: var(--cc-ink);
    white-space: nowrap; -webkit-tap-highlight-color: transparent; }
  .__cc_panel .__cc_btn:hover { filter: brightness(.96); }
  html.__cc_dark .__cc_panel .__cc_btn:hover { filter: brightness(1.2); }
  .__cc_panel .__cc_btn:disabled { opacity: .5; cursor: default; }
  .__cc_panel .__cc_btn.__cc_danger { color: #c25446; background: rgba(179,55,42,.1); }
  .__cc_panel .__cc_btn.__cc_danger:hover { background: rgba(179,55,42,.18); }
  .__cc_panel .__cc_chips { display: flex; gap: 6px; padding: 4px 8px; flex-wrap: wrap; }
  .__cc_panel .__cc_chip2 { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: var(--cc-hov); color: var(--cc-ink);
    -webkit-tap-highlight-color: transparent; }
  .__cc_panel .__cc_chip2:hover { filter: brightness(.96); }
  html.__cc_dark .__cc_panel .__cc_chip2:hover { filter: brightness(1.2); }
  .__cc_panel .__cc_chip2.__cc_segon { background: var(--cc-ink); color: var(--cc-card); }
  .__cc_panel .__cc_in2 { font: inherit; flex: 1; min-width: 120px; padding: 6px 9px; border: 1px solid var(--cc-inbd); border-radius: 7px;
    color: var(--cc-ink); background: var(--cc-card); outline: none; box-sizing: border-box; }
  .__cc_panel .__cc_in2::placeholder { color: var(--cc-dim); }
  .__cc_panel .__cc_in2:focus { border-color: var(--cc-coral); box-shadow: 0 0 0 3px rgba(232,108,93,.15); }
  .__cc_panel .__cc_draft { margin: 2px 8px 8px; padding: 0; }
  .__cc_panel .__cc_dtop { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .__cc_panel .__cc_dnum { width: 18px; height: 18px; border-radius: 50%; background: #b58900; color: #000000; font-weight: 700;
    font-size: 10px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .__cc_panel .__cc_dsnip { color: var(--cc-dim); font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .__cc_panel .__cc_x { all: unset; cursor: pointer; padding: 2px 7px; border-radius: 6px; opacity: .5; font-size: 14px; }
  .__cc_panel .__cc_x:hover { opacity: 1; background: var(--cc-hov); }
  .__cc_panel .__cc_ta { font: inherit; width: 100%; box-sizing: border-box; border: 1px solid var(--cc-inbd); border-radius: 7px;
    padding: 7px 9px; color: var(--cc-ink); resize: vertical; min-height: 44px; outline: none; background: var(--cc-card); }
  .__cc_panel .__cc_ta::placeholder { color: var(--cc-dim); }
  .__cc_panel .__cc_ta:focus { border-color: var(--cc-coral); box-shadow: 0 0 0 3px rgba(232,108,93,.15); }
  .__cc_panel .__cc_addrow { display: flex; gap: 6px; padding: 6px 8px; }
  .__cc_panel .__cc_who { padding: 2px 8px 6px; display: flex; }
  .__cc_panel .__cc_actions { display: flex; gap: 6px; margin: 2px 8px 6px; }
  .__cc_panel .__cc_send { all: unset; cursor: pointer; flex: 1; text-align: center; padding: 8px 12px;
    border-radius: 8px; background: var(--cc-coral); color: #ffffff; font-weight: 600; -webkit-tap-highlight-color: transparent; }
  .__cc_panel .__cc_send:hover { background: #d85b4c; }
  .__cc_panel .__cc_send:disabled { opacity: .45; cursor: default; }
  .__cc_panel .__cc_ghost { all: unset; cursor: pointer; text-align: center; padding: 8px 12px; border-radius: 8px;
    color: var(--cc-mut); -webkit-tap-highlight-color: transparent; }
  .__cc_panel .__cc_ghost:hover { background: var(--cc-hov); color: var(--cc-ink); }
  .__cc_panel .__cc_ghost:disabled { opacity: .45; cursor: default; }
  .__cc_panel .__cc_cerr { color: #c25446; padding: 0 8px 6px; }
  .__cc_panel .__cc_okwrap { text-align: center; padding: 22px 12px 26px; }
  .__cc_panel .__cc_okmark { width: 36px; height: 36px; margin: 0 auto 10px; border-radius: 50%; background: rgba(61,138,61,.14);
    color: var(--cc-green); font-size: 18px; line-height: 36px; }
  .__cc_panel .__cc_okt { font-weight: 600; color: var(--cc-ink); margin-bottom: 4px; }
  .__cc_panel .__cc_oks { color: var(--cc-dim); }
  .__cc_panel .__cc_cmt { margin: 0 8px; padding: 9px 2px; border-top: 1px solid var(--cc-line); }
  .__cc_panel .__cc_cmeta { color: var(--cc-dim); margin-bottom: 2px; }
  .__cc_panel .__cc_ctext { color: var(--cc-ink); margin: 4px 0 8px; white-space: pre-wrap; word-break: break-word; }
  .__cc_panel .__cc_stag { font-size: 10px; font-weight: 600; white-space: nowrap; }
  .__cc_panel .__cc_stag.__cc_pend { color: #c07a28; }
  .__cc_panel .__cc_stag.__cc_sent { color: var(--cc-dim); }
  .__cc_panel .__cc_stag.__cc_done { color: var(--cc-green); }
  /* "at 0:14": a comment's moment on the page's timeline; clicking seeks. */
  .__cc_tat { all: unset; cursor: pointer; font-size: 10px; font-weight: 600; color: var(--cc-blue); padding: 1px 5px;
    border-radius: 5px; white-space: nowrap; flex: none; font-variant-numeric: tabular-nums; }
  .__cc_tat:hover { background: var(--cc-hov); }
  /* Per-comment "Send to agent" switch in the composer. */
  #__cc_cpanel .__cc_toagent { display: flex; align-items: center; gap: 7px; padding: 6px 1px 0; color: var(--cc-mut);
    font-size: 11px; cursor: pointer; user-select: none; width: fit-content; }
  #__cc_cpanel .__cc_toagent input { appearance: none; -webkit-appearance: none; margin: 0; flex: none; cursor: pointer;
    width: 24px; height: 14px; border-radius: 999px; background: var(--cc-inbd); position: relative; transition: background .15s ease; }
  #__cc_cpanel .__cc_toagent input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px;
    border-radius: 50%; background: #ffffff; transition: transform .15s ease; }
  #__cc_cpanel .__cc_toagent input:checked { background: var(--cc-coral); }
  #__cc_cpanel .__cc_toagent input:checked::after { transform: translateX(10px); }
  #__cc_cpanel .__cc_toagent input:focus-visible { outline: 2px solid var(--cc-blue); outline-offset: 2px; }
  #__cc_cpanel .__cc_toagent.__cc_on { color: var(--cc-ink); }
  /* Avatars (shared by the panel and the fixed mention layer). */
  .__cc_panel .__cc_av, #__cc_mlist .__cc_av { width: 20px; height: 20px; border-radius: 50%; flex: none; object-fit: cover; display: block; }
  .__cc_panel .__cc_avi, #__cc_mlist .__cc_avi { width: 20px; height: 20px; border-radius: 50%; flex: none; background: var(--cc-hov); color: var(--cc-mut);
    font-size: 10px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; text-transform: uppercase; }
  /* ------------------------------------------------------------------ */
  /* Discussion panel: its own layout — sticky header, flush sections.  */
  /* ------------------------------------------------------------------ */
  #__cc_cpanel { padding: 0; min-width: 316px; max-width: min(92vw, 420px); }
  #__cc_cpanel .__cc_phdr { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
    padding: 11px 14px 10px; background: var(--cc-card); border-bottom: 1px solid var(--cc-line); border-radius: 12px 12px 0 0; }
  #__cc_cpanel .__cc_phdr .__cc_pht { font-weight: 600; color: var(--cc-ink); font-size: 13px; letter-spacing: .01em; }
  #__cc_cpanel .__cc_phdr .__cc_phn { color: var(--cc-dim); font-size: 10px; font-weight: 600; background: var(--cc-hov);
    padding: 2px 7px; border-radius: 999px; }
  #__cc_cpanel .__cc_meid { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 4px;
    border: 1px solid var(--cc-line); border-radius: 999px; color: var(--cc-mut); font-size: 11px; max-width: 18ch; }
  #__cc_cpanel .__cc_meid .__cc_mename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #__cc_cpanel .__cc_meid .__cc_av, #__cc_cpanel .__cc_meid .__cc_avi { width: 16px; height: 16px; font-size: 8px; }
  #__cc_cpanel a.__cc_signin { color: var(--cc-blue); cursor: pointer; font-size: 11px; padding: 4px 8px; border-radius: 7px; }
  #__cc_cpanel a.__cc_signin:hover { background: var(--cc-hov); }
  #__cc_cpanel .__cc_pbody { padding: 10px 10px 0; }
  #__cc_cpanel .__cc_pbody > :last-child { margin-bottom: 10px; }
  #__cc_cpanel .__cc_pbody > .__cc_threads:last-child { margin-bottom: 0; }
  /* Sheet mode keeps the flush layout; the home-indicator inset rides on the
     last row instead of panel padding. */
  #__cc_cpanel.__cc_sheet { padding: 0; }
  #__cc_cpanel.__cc_sheet .__cc_phdr { border-radius: 0; }
  #__cc_cpanel.__cc_sheet .__cc_pbody > :last-child { margin-bottom: calc(14px + env(safe-area-inset-bottom)); }
  #__cc_cpanel.__cc_sheet .__cc_pbody > .__cc_threads:last-child { margin-bottom: 0; }
  #__cc_cpanel.__cc_sheet .__cc_thread:last-child { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
  #__cc_cpanel .__cc_empty { text-align: center; padding: 26px 18px 24px; color: var(--cc-dim); }
  #__cc_cpanel .__cc_empty svg { opacity: .4; margin-bottom: 8px; }
  #__cc_cpanel .__cc_empty .__cc_e1 { color: var(--cc-mut); font-weight: 600; margin-bottom: 3px; }
  #__cc_cpanel .__cc_empty .__cc_e2 { font-size: 11px; }
  /* Composer. One container (the panel) — interior structure comes from
     whitespace and hairlines, never nested outlined boxes. The only "box" is
     the input itself: a flat soft slab with no border. */
  #__cc_cpanel .__cc_draft { margin: 0 0 10px; padding: 0; }
  #__cc_cpanel .__cc_draft .__cc_dtop { margin-bottom: 5px; }
  #__cc_cpanel .__cc_dlabel { color: var(--cc-dim); font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; }
  #__cc_cpanel .__cc_ta, #__cc_cpanel .__cc_in2 { background: var(--cc-soft); border: none; border-radius: 8px;
    padding: 8px 10px; box-shadow: none; }
  html.__cc_dark #__cc_cpanel .__cc_ta, html.__cc_dark #__cc_cpanel .__cc_in2 { background: rgba(147,161,161,.08); }
  #__cc_cpanel .__cc_ta { min-height: 52px; }
  #__cc_cpanel .__cc_ta:focus, #__cc_cpanel .__cc_in2:focus { border: none;
    box-shadow: inset 0 0 0 1.5px rgba(232,108,93,.38); }
  #__cc_cpanel .__cc_addrow { display: flex; gap: 2px; padding: 0; margin-left: -7px; }
  #__cc_cpanel .__cc_addrow .__cc_btn { display: inline-flex; align-items: center; gap: 6px; background: none; border: none;
    border-radius: 7px; padding: 5px 9px; color: var(--cc-mut); font-size: 11px; }
  #__cc_cpanel .__cc_addrow .__cc_btn:hover { color: var(--cc-ink); background: var(--cc-hov); filter: none; }
  #__cc_cpanel .__cc_addrow .__cc_btn svg { opacity: .65; flex: none; }
  #__cc_cpanel .__cc_asme { display: flex; align-items: center; gap: 6px; padding: 6px 1px 0; color: var(--cc-dim); font-size: 11px; }
  #__cc_cpanel .__cc_asme .__cc_av, #__cc_cpanel .__cc_asme .__cc_avi { width: 15px; height: 15px; font-size: 8px; }
  #__cc_cpanel .__cc_who { padding: 6px 0 0; display: flex; }
  #__cc_cpanel .__cc_actions { display: flex; gap: 6px; margin: 8px 0 2px; }
  #__cc_cpanel .__cc_cerr { padding: 4px 1px 0; }
  #__cc_cpanel .__cc_cerr:empty { display: none; }
  #__cc_cpanel .__cc_pendrow { margin: 10px 0 0; padding: 8px 1px 0; border-top: 1px solid var(--cc-line); font-size: 11px; }
  /* Threads: avatar-column grid, replies on a connector line. */
  #__cc_cpanel .__cc_threads { margin: 4px -10px -10px; }
  #__cc_cpanel .__cc_thread { position: relative; padding: 10px 14px 9px; border-top: 1px solid var(--cc-line); }
  #__cc_cpanel .__cc_thread:last-child { border-radius: 0 0 12px 12px; }
  #__cc_cpanel .__cc_thread.__cc_sel { background: rgba(38,139,210,.07); }
  #__cc_cpanel .__cc_thread.__cc_sel::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 2px;
    border-radius: 2px; background: var(--cc-blue); }
  #__cc_cpanel .__cc_cmt2 { display: grid; grid-template-columns: 22px 1fr auto; column-gap: 9px; align-items: start; }
  #__cc_cpanel .__cc_cmt2 .__cc_av, #__cc_cpanel .__cc_cmt2 .__cc_avi { width: 22px; height: 22px; margin-top: 1px; }
  #__cc_cpanel .__cc_cmhead { display: flex; align-items: baseline; gap: 6px; min-width: 0; padding-top: 3px; }
  #__cc_cpanel .__cc_cname { font-weight: 600; color: var(--cc-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #__cc_cpanel .__cc_vck { color: var(--cc-green); font-size: 10px; flex: none; }
  #__cc_cpanel .__cc_ctime { color: var(--cc-dim); font-size: 10px; white-space: nowrap; flex: none; }
  #__cc_cpanel .__cc_cbody { grid-column: 2 / 4; min-width: 0; }
  #__cc_cpanel .__cc_ctext { margin: 3px 0 0; font-size: 12px; }
  #__cc_cpanel .__cc_csnip { margin: 4px 0 1px; padding: 1px 0 1px 8px; border-left: 2px solid var(--cc-inbd);
    color: var(--cc-dim); font-style: italic; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #__cc_cpanel .__cc_jump { all: unset; cursor: pointer; color: var(--cc-dim); flex: none; padding: 3px 5px; border-radius: 6px;
    opacity: 0; transition: opacity .12s ease; margin-top: 1px; }
  #__cc_cpanel .__cc_thread:hover .__cc_jump { opacity: .7; }
  #__cc_cpanel .__cc_jump:hover { background: var(--cc-hov); color: var(--cc-blue); opacity: 1 !important; }
  #__cc_cpanel .__cc_replies { margin: 6px 0 0 10px; padding-left: 19px; border-left: 2px solid var(--cc-line); }
  #__cc_cpanel .__cc_reply { padding: 7px 0 0; }
  #__cc_cpanel .__cc_reply .__cc_cmt2 { grid-template-columns: 18px 1fr auto; column-gap: 8px; }
  #__cc_cpanel .__cc_reply .__cc_av, #__cc_cpanel .__cc_reply .__cc_avi { width: 18px; height: 18px; font-size: 9px; }
  #__cc_cpanel .__cc_rbtn { all: unset; cursor: pointer; color: var(--cc-dim); font-size: 11px; padding: 3px 7px;
    border-radius: 6px; margin: 5px 0 0 24px; opacity: .55; transition: opacity .12s ease; }
  #__cc_cpanel .__cc_rwrap, #__cc_cpanel .__cc_rbtn { margin-left: 31px; }
  #__cc_cpanel .__cc_thread:hover .__cc_rbtn { opacity: 1; }
  #__cc_cpanel .__cc_rbtn:hover { background: var(--cc-hov); color: var(--cc-ink); }
  #__cc_cpanel .__cc_rwrap { margin: 8px 0 2px 24px; padding: 0; }
  #__cc_cpanel .__cc_rwrap .__cc_actions { margin: 6px 0 0; }
  #__cc_cpanel .__cc_rwrap .__cc_who { padding: 0 0 6px; }
  /* @mention autocomplete: a fixed top layer on <body>, immune to panel
     scroll/stacking (the in-panel version lost z-order fights with buttons). */
  #__cc_mlist { position: fixed; z-index: 2147483647; background: var(--cc-card); border: 1px solid var(--cc-line);
    border-radius: 10px; box-shadow: 0 12px 32px var(--cc-shadow); padding: 4px; min-width: 224px; max-width: 320px;
    max-height: 218px; overflow-y: auto; overscroll-behavior: contain;
    font: 400 12px/1.45 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  #__cc_mlist .__cc_mrow { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 7px; cursor: pointer;
    color: var(--cc-ink); }
  #__cc_mlist .__cc_mrow .__cc_mh { color: var(--cc-dim); margin-left: auto; font-size: 10px; padding-left: 10px; flex: none; }
  #__cc_mlist .__cc_mrow.__cc_mon { background: var(--cc-hov); }
  .__cc_panel .__cc_pendrow { display: flex; align-items: center; gap: 8px; margin: 6px 8px 0; padding: 5px 2px;
    color: var(--cc-dim); }
  .__cc_panel .__cc_pendrow .__cc_sendall { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 7px;
    color: var(--cc-coral); font-weight: 600; white-space: nowrap; -webkit-tap-highlight-color: transparent; }
  .__cc_panel .__cc_pendrow .__cc_sendall:hover { background: var(--cc-hov); }
  .__cc_panel .__cc_pendrow .__cc_sendall:disabled { opacity: .5; cursor: default; }
  #__cc_pins { position: absolute; top: 0; left: 0; width: 100%; height: 0; overflow: visible; z-index: 2147483645; pointer-events: none; }
  #__cc_pins .__cc_pin { position: absolute; transform: translate(-50%,-100%); width: 18px; height: 18px;
    border-radius: 50% 50% 50% 4px; background: #e86c5d; color: #ffffff; font: 600 10px/18px "JetBrains Mono", ui-monospace, Menlo, monospace;
    text-align: center; box-shadow: 0 1px 5px rgba(0,0,0,.2); pointer-events: auto; cursor: pointer;
    animation: __cc_pop .18s ease; }
  #__cc_pins .__cc_pin.__cc_spin { width: 12px; height: 12px; background: #ffffff; border: 2px solid #e86c5d;
    box-sizing: border-box; border-radius: 50% 50% 50% 3px; font-size: 0; opacity: .6; }
  #__cc_pins .__cc_pin.__cc_spin:hover { opacity: 1; transform: translate(-50%,-100%) scale(1.25); }
  #__cc_pins .__cc_pin.__cc_flash { animation: __cc_pulse .9s ease 2; }
  @keyframes __cc_pop { from { transform: translate(-50%,-100%) scale(.6); opacity: 0; } }
  @keyframes __cc_pulse { 50% { transform: translate(-50%,-100%) scale(1.5); } }
  #__cc_hint { position: fixed; left: 50%; bottom: calc(18px + env(safe-area-inset-bottom)); transform: translateX(-50%);
    z-index: 2147483647; background: var(--cc-ink); color: var(--cc-card); padding: 11px 18px; border-radius: 999px;
    font: 500 12px/1 "JetBrains Mono", ui-monospace, Menlo, monospace; box-shadow: 0 6px 20px rgba(0,0,0,.3); white-space: nowrap; }
  html.__cc_pinmode, html.__cc_pinmode * { cursor: crosshair !important; }
  /* Notes: the codecast gallery's pins on a page. A numbered yellow dot where
     the reader clicked, its note as a dark label beside it, and the note's
     editor opening at the dot. */
  #__cc_notes { position: absolute; top: 0; left: 0; width: 100%; height: 0; overflow: visible; z-index: 2147483646;
    pointer-events: none; font: 400 12px/1.45 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    text-align: left; letter-spacing: normal; text-transform: none; }
  #__cc_notes .__cc_np { position: absolute; width: 0; height: 0; }
  #__cc_notes .__cc_nd { all: unset; box-sizing: border-box; position: absolute; left: -12px; top: -12px; width: 24px; height: 24px;
    border-radius: 50%; background: #b58900; color: #000000; border: 2px solid rgba(0,0,0,.6);
    box-shadow: 0 0 0 2px rgba(0,0,0,.45); font: 700 11px/20px "JetBrains Mono", ui-monospace, Menlo, monospace;
    text-align: center; cursor: pointer; pointer-events: auto; transition: transform .12s ease; animation: __cc_npop .18s ease; }
  #__cc_notes .__cc_nd:hover { transform: scale(1.1); }
  #__cc_notes .__cc_np.__cc_on .__cc_nd { border-color: #ffffff; }
  #__cc_notes .__cc_nl { position: absolute; left: 16px; top: -10px; max-width: 16rem; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; border-radius: 4px; background: rgba(0,0,0,.75); color: rgba(255,255,255,.85); padding: 2px 6px;
    font-size: 11px; line-height: 16px; }
  #__cc_notes .__cc_ne { position: absolute; width: 288px; box-sizing: border-box; padding: 8px; border-radius: 8px;
    background: var(--cc-card); color: var(--cc-ink); border: 1px solid var(--cc-line); box-shadow: 0 12px 32px var(--cc-shadow);
    pointer-events: auto; cursor: auto; animation: __cc_npop .14s ease; }
  #__cc_notes .__cc_neh { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; font-size: 10px; color: var(--cc-dim); }
  #__cc_notes .__cc_neh .__cc_sp { flex: 1; }
  #__cc_notes .__cc_nx { all: unset; cursor: pointer; padding: 0 4px; border-radius: 4px; font-size: 14px; line-height: 16px; color: var(--cc-dim); }
  #__cc_notes .__cc_nx:hover { color: #dc322f; background: var(--cc-hov); }
  #__cc_notes .__cc_nsnip { margin: 0 0 6px; padding: 1px 0 1px 8px; border-left: 2px solid #b58900; color: var(--cc-mut);
    font-style: italic; font-size: 11px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  #__cc_notes .__cc_neta { display: block; width: 100%; box-sizing: border-box; min-height: 44px; max-height: 200px; resize: none; margin: 0;
    padding: 6px 8px; border: none; border-radius: 6px; outline: none; background: var(--cc-soft); color: var(--cc-ink);
    font: inherit; box-shadow: none; }
  html.__cc_dark #__cc_notes .__cc_neta { background: rgba(147,161,161,.08); }
  #__cc_notes .__cc_neta:focus { box-shadow: inset 0 0 0 1.5px rgba(181,137,0,.55); }
  #__cc_notes .__cc_nef { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 6px; }
  #__cc_notes .__cc_nef button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px;
    border-radius: 5px; font-size: 11px; color: var(--cc-mut); }
  #__cc_notes .__cc_nef button:hover { background: var(--cc-hov); color: var(--cc-ink); }
  #__cc_notes .__cc_nef .__cc_nlead { margin-right: auto; padding-left: 2px; }
  #__cc_notes .__cc_nef .__cc_nok { background: #b58900; color: #000000; font-weight: 600; }
  #__cc_notes .__cc_nef .__cc_nok:hover { background: #c99a0a; color: #000000; }
  #__cc_notes kbd { font: 600 9px/1 "JetBrains Mono", ui-monospace, Menlo, monospace; padding: 2px 4px; border-radius: 3px;
    border: 1px solid currentColor; opacity: .55; }
  #__cc_qbtn { all: unset; box-sizing: border-box; position: absolute; z-index: 2147483646; transform: translate(-50%,-100%);
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; cursor: pointer;
    background: var(--cc-ink); color: var(--cc-card); box-shadow: 0 6px 20px rgba(0,0,0,.25);
    font: 600 11px/1 "JetBrains Mono", ui-monospace, Menlo, monospace; animation: __cc_npop .12s ease; }
  #__cc_qbtn svg { color: #b58900; }
  @keyframes __cc_npop { from { opacity: 0; transform: scale(.85); } }
  /* Bottom-sheet mode. The media query catches real narrow layout viewports;
     the .__cc_sheet class is the same rules applied by JS from screen.width,
     because an artifact WITHOUT a viewport meta lays out at ~980px on phones
     and the media query alone would never fire there. */
  @media (max-width: 640px) {
    #__cc_bar .__cc_when { display: none; }
    .__cc_panel { left: 0; right: 0; top: auto; bottom: 0; max-width: none; min-width: 0; max-height: 78vh;
      border-radius: 16px 16px 0 0; padding: 8px 10px calc(14px + env(safe-area-inset-bottom));
      box-shadow: 0 -8px 32px var(--cc-shadow); transform: translateY(24px); }
    .__cc_panel::before { content: ""; display: block; width: 38px; height: 4px; border-radius: 2px;
      background: var(--cc-inbd); margin: 2px auto 10px; }
    .__cc_panel.__cc_in { transform: none; }
    .__cc_panel .__cc_row { padding: 11px 8px; }
    .__cc_panel .__cc_kv { padding: 8px; }
    .__cc_panel .__cc_btn { padding: 8px 12px; }
    .__cc_panel .__cc_chip2 { padding: 8px 12px; }
    .__cc_panel .__cc_send { padding: 13px 12px; }
    .__cc_panel .__cc_ghost { padding: 13px 12px; }
    .__cc_panel .__cc_ta { min-height: 56px; }
  }
  .__cc_panel.__cc_sheet { left: 0; right: 0; top: auto; bottom: 0; max-width: none; min-width: 0; max-height: 78vh;
    border-radius: 16px 16px 0 0; padding: 8px 10px calc(14px + env(safe-area-inset-bottom));
    box-shadow: 0 -8px 32px var(--cc-shadow); transform: translateY(24px); }
  .__cc_panel.__cc_sheet::before { content: ""; display: block; width: 38px; height: 4px; border-radius: 2px;
    background: var(--cc-inbd); margin: 2px auto 10px; }
  .__cc_panel.__cc_sheet.__cc_in { transform: none; }
  .__cc_panel.__cc_sheet .__cc_row { padding: 11px 8px; }
  .__cc_panel.__cc_sheet .__cc_send { padding: 13px 12px; }
  .__cc_panel.__cc_sheet .__cc_ghost { padding: 13px 12px; }
  @media (max-width: 480px) {
    #__cc_bar { gap: 0; }
    #__cc_bar .__cc_sess { display: none; }
    #__cc_bar #__cc_agent:not(.__cc_au):not(.__cc_an) #__cc_alabel { display: none; }
  }
</style>
<div id="__cc_bar">
  <a class="__cc_brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer" title="Published with codecast">${logoSvg(22)}</a>
  <span class="__cc_title">${escAttr(o.title)}</span>
  ${sessionLink}
  ${latestLink}<button id="__cc_new" type="button" hidden></button>
  <span class="__cc_when" id="__cc_when" data-ts="${o.updatedAt}">updated ${escAttr(when)}</span>
  ${interactive && o.hasAgent ? `<span id="__cc_agent" role="status" hidden><span class="__cc_adot"></span><span id="__cc_alabel"></span></span>` : ""}
  ${verChip}
  ${commentsBtn}
  ${menuBtn}
  ${hideBtn}
</div>
<button id="__cc_pill" type="button" title="Show the codecast bar">${logoSvg(15)}</button>
<div id="__cc_hist" class="__cc_panel" hidden></div>
<div id="__cc_menupanel" class="__cc_panel" hidden></div>
<div id="__cc_cpanel" class="__cc_panel" hidden></div>
<div id="__cc_mgr" class="__cc_panel" hidden></div>
<script>(function(){
  var CC=${JSON.stringify(cfg)};
  var frag=new URLSearchParams(location.hash.replace(/^#/,""));
  var ownerKey=frag.get("o")||"";
  var editKey=frag.get("ed")||"";
  var gateEmail=frag.get("em")||"";
  // Signed-in commenter identity, minted by codecast.sh/pages/auth and carried
  // back here in the fragment (the sandbox's opaque origin has no storage that
  // survives navigation, so the fragment IS the session).
  var idTok=frag.get("i")||"";
  // The viewing gates this document cleared, in the query string the origin
  // validated before serving us. Echoed back on every write so the mutation
  // re-checks them: it is reachable without going through this page.
  var qs=new URLSearchParams(location.search);
  var gateK=qs.get("k")||"";
  var gateE=qs.get("e")||"";
  // Opaque-origin storage: localStorage throws under the sandbox CSP, so every
  // touch is guarded and falls back to page-lifetime memory.
  var mem={};
  var sGet=function(k){try{var v=localStorage.getItem(k);if(v!=null)return v;}catch(e){}return mem[k]||"";};
  var sSet=function(k,v){mem[k]=v;try{localStorage.setItem(k,v);}catch(e){}};
  var el=function(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
  var host=function(){return document.body||document.documentElement;};
  // Match the artifact instead of fighting it: measure the page's effective
  // background luminance and flip the bar (and panels) to the dark palette on
  // dark pages. Re-checked on load because stylesheets can land after us.
  var bgLum=function(node){try{
    var c=getComputedStyle(node).backgroundColor||"";
    var m=c.match(/rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+))?/);
    if(!m)return null;
    if(m[4]!=null&&parseFloat(m[4])<.4)return null;
    return (0.2126*(+m[1])+0.7152*(+m[2])+0.0722*(+m[3]))/255;
  }catch(e){return null;}};
  var applyTheme=function(){
    var l=document.body?bgLum(document.body):null;
    if(l==null)l=bgLum(document.documentElement);
    if(l==null)l=1;
    document.documentElement.classList.toggle("__cc_dark",l<0.5);
  };
  applyTheme();
  if(document.readyState!=="complete")window.addEventListener("load",applyTheme);
  // Pages with their own light/dark switch (the markdown theme, many
  // dashboards) flip a class or attribute on <html> or <body>, or follow the
  // OS: follow them. Toggling __cc_dark to the value it already has records
  // no mutation, so the observer cannot feed itself.
  try{
    var reTheme=function(){requestAnimationFrame(applyTheme);};
    var mo=new MutationObserver(reTheme);
    var watchEl=function(n){if(n)mo.observe(n,{attributes:true,attributeFilter:["class","style","data-theme"]});};
    watchEl(document.documentElement);
    if(document.body)watchEl(document.body);else document.addEventListener("DOMContentLoaded",function(){watchEl(document.body);});
    var osq=matchMedia("(prefers-color-scheme: dark)");
    if(osq.addEventListener)osq.addEventListener("change",reTheme);
  }catch(e){}
  var rel=function(ts){var s=Math.max(0,(Date.now()-ts)/1e3);
    return s<60?"just now":s<3600?Math.floor(s/60)+"m ago":s<86400?Math.floor(s/3600)+"h ago":s<2592e3?Math.floor(s/86400)+"d ago":new Date(ts).toLocaleDateString();};
  var inFmt=function(ts){var s=(ts-Date.now())/1e3;
    return s<=0?"expired":s<3600?"in "+Math.ceil(s/60)+"m":s<86400?"in "+Math.ceil(s/3600)+"h":"in "+Math.ceil(s/86400)+"d";};
  var w=document.getElementById("__cc_when");
  if(w){var ts=+w.getAttribute("data-ts");var tick=function(){w.textContent="updated "+rel(ts);};tick();setInterval(tick,6e4);}
  var copyText=function(u,done){
    var fallback=function(){var t=document.createElement("textarea");t.value=u;t.style.position="fixed";t.style.opacity="0";
      host().appendChild(t);t.select();try{document.execCommand("copy");done();}catch(e){window.prompt("Copy:",u);}t.remove();};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done,fallback);}else{fallback();}
  };
  var flashLabel=function(btn,label,back){btn.textContent=label;setTimeout(function(){btn.textContent=back;},1400);};
  // Minimize: bar slides away, the corner pill brings it back. Per-page
  // persistence (best effort — the opaque origin usually has no storage).
  // A framed page (embedded in a conversation, the decision queue, another
  // site) starts minimized: the embedder supplies its own chrome, and a 40px
  // bar inside a 420px frame is mostly bar. The pill still restores it, and
  // an explicit restore ("0") wins over the framed default where storage holds.
  var minKey="__cc_min:"+(CC.slug||location.pathname);
  var framed=false;try{framed=window.self!==window.top;}catch(e){framed=true;}
  var setMin=function(on,remember){
    document.documentElement.classList.toggle("__cc_min",on);
    if(remember)sSet(minKey,on?"1":"0");
    if(on&&typeof closeAll==="function")closeAll();
  };
  var hideB=document.getElementById("__cc_hide");
  var pillB=document.getElementById("__cc_pill");
  if(hideB)hideB.addEventListener("click",function(e){e.stopPropagation();setMin(true,true);});
  if(pillB)pillB.addEventListener("click",function(e){e.stopPropagation();setMin(false,true);});
  var minPref=sGet(minKey);
  if(minPref==="1"||(framed&&minPref!=="0"))setMin(true,false);
  // A codecast conversation frames the page frameless (?embed=1) and carries
  // every verb in its own toolbar, so neither the bar nor its pill shows.
  if(framed&&/[?&]embed=1(&|$)/.test(location.search))document.documentElement.classList.add("__cc_embed");
  // --- the page's timeline ---
  // window.__castTimeline, provided by <cast-player> and motion pages (it
  // dispatches "cast:timeline-ready" once assigned). A comment made while one
  // exists records its moment (anchor.t, seconds); the panel and the note
  // editor seek back to it, and the open comments become timeline markers.
  var TL={
    get:function(){var t=window.__castTimeline;return t&&typeof t.time==="function"&&typeof t.seek==="function"?t:null;},
    has:function(){return !!TL.get();},
    now:function(){var t=TL.get();if(!t)return null;try{var v=+t.time();return isFinite(v)?Math.round(v*10)/10:null;}catch(e){return null;}},
    seek:function(s){var t=TL.get();if(t)try{t.seek(s);}catch(e){}},
    fmt:function(s){s=Math.max(0,Math.round(s));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;
      return (h?h+":"+(m<10?"0":""):"")+m+":"+(x<10?"0":"")+x;},
    markers:function(list){var t=TL.get();if(t&&typeof t.setMarkers==="function")try{t.setMarkers(list);}catch(e){}}
  };
  // --- notes layer ---
  // The codecast gallery's way of commenting on a picture, on a page: pin
  // mode turns a click into a numbered dot, its note opens beside the dot, and
  // a written note shows as a label until clicked again. Selecting text offers
  // a note anchored to those words. The notes come from a source: this page's
  // own discussion drafts, or, framed in a codecast conversation, that
  // conversation's quote batch, which the parent window owns and mirrors here.
  var NL=(function(){
    var src=null,layer=null,hintEl=null,qb=null,on=false,nodes={},edKey=null,edNode=null;
    var bubble='${iconSvg(12, BUBBLE_PATH)}';
    var docSize=function(){var d=document.documentElement;return{w:Math.max(d.scrollWidth,1),h:Math.max(d.scrollHeight,1)};};
    var rnd=function(v){return Math.round(Math.min(1,Math.max(0,v))*1000)/1000;};
    var place=function(box,pin){
      // Open toward the middle of the viewport so the editor stays on screen.
      var r=pin.getBoundingClientRect();
      box.style.left=box.style.right=box.style.top=box.style.bottom="";
      if(r.left>window.innerWidth-310)box.style.right="16px";else box.style.left="16px";
      if(r.top>window.innerHeight-190)box.style.bottom="8px";else box.style.top="-8px";
    };
    var editor=function(nt){
      var box=el("div","__cc_ne");
      box.addEventListener("click",function(e){e.stopPropagation();});
      box.addEventListener("mousedown",function(e){e.stopPropagation();});
      var hd=el("div","__cc_neh");
      hd.appendChild(el("span",null,src.label(nt)));
      if(nt.t!=null&&TL.has()){
        var tb=el("button","__cc_tat","at "+TL.fmt(nt.t));tb.type="button";tb.title="Seek the page's timeline here";
        tb.addEventListener("mousedown",function(e){e.preventDefault();});
        tb.addEventListener("click",function(e){e.stopPropagation();TL.seek(nt.t);});
        hd.appendChild(tb);
      }
      hd.appendChild(el("span","__cc_sp"));
      var x=el("button","__cc_nx","×");x.type="button";x.title="Remove this note";
      x.addEventListener("mousedown",function(e){e.preventDefault();});
      x.addEventListener("click",function(){src.remove(nt.key);});
      hd.appendChild(x);box.appendChild(hd);
      if(nt.snippet)box.appendChild(el("div","__cc_nsnip",nt.snippet));
      var ta=document.createElement("textarea");ta.className="__cc_neta";ta.rows=2;
      ta.placeholder="Add a note… (optional)";ta.value=nt.body||"";
      var opened=ta.value,t=null,closing=false;
      var flush=function(){clearTimeout(t);t=null;src.body(nt.key,ta.value);};
      var close=function(){if(closing)return;closing=true;flush();src.edit(null);};
      var grow=function(){ta.style.height="auto";ta.style.height=Math.min(ta.scrollHeight,200)+"px";};
      ta.addEventListener("input",function(){grow();clearTimeout(t);t=setTimeout(flush,300);});
      ta.addEventListener("keydown",function(e){
        e.stopPropagation();
        if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();close();}
        else if(e.key==="Escape"){e.preventDefault();ta.value=opened;close();}
      });
      ta.addEventListener("blur",close);
      box.appendChild(ta);
      var ft=el("div","__cc_nef");
      if(src.lead)src.lead(ft,flush);
      var ok=el("button","__cc_nok");ok.type="button";ok.innerHTML="Save <kbd>↵</kbd>";
      ok.addEventListener("mousedown",function(e){e.preventDefault();});
      ok.addEventListener("click",close);
      ft.appendChild(ok);box.appendChild(ft);
      setTimeout(function(){try{ta.focus({preventScroll:true});var n=ta.value.length;ta.setSelectionRange(n,n);grow();}catch(e){}},0);
      return box;
    };
    var draw=function(){
      if(!src)return;
      var list=src.notes(),ed=src.editing(),sz=docSize(),seen={};
      if(!layer){if(!list.length)return;layer=el("div");layer.id="__cc_notes";host().appendChild(layer);}
      list.forEach(function(nt){
        var k=nt.key;seen[k]=1;
        var p=nodes[k];
        if(!p){
          p=nodes[k]=el("div","__cc_np");
          var dot=el("button","__cc_nd");dot.type="button";
          dot.addEventListener("mousedown",function(e){e.stopPropagation();});
          dot.addEventListener("click",function(e){e.stopPropagation();src.edit(src.editing()===k?null:k);});
          p.appendChild(dot);p.appendChild(el("div","__cc_nl"));
          layer.appendChild(p);
        }
        p.style.left=(nt.x*sz.w)+"px";p.style.top=(nt.y*sz.h)+"px";
        p.firstChild.textContent=String(nt.n);
        p.firstChild.title=nt.body||"Pinned note (click to edit)";
        p.firstChild.setAttribute("aria-label","Note "+nt.n+(nt.body?": "+nt.body:""));
        var lab=p.childNodes[1];lab.textContent=nt.body||"";lab.style.display=nt.body&&ed!==k?"":"none";
        p.classList.toggle("__cc_on",ed===k);
      });
      Object.keys(nodes).forEach(function(k){if(!seen[k]){nodes[k].remove();delete nodes[k];}});
      if(edNode&&(edKey!==ed||!nodes[ed])){edNode.remove();edNode=null;edKey=null;}
      if(ed&&!edNode&&nodes[ed]){
        var nt=null;list.forEach(function(n){if(n.key===ed)nt=n;});
        edKey=ed;edNode=editor(nt);nodes[ed].appendChild(edNode);place(edNode,nodes[ed]);
      }
    };
    var setPin=function(v,tell){
      on=!!v&&!!src;
      document.documentElement.classList.toggle("__cc_pinmode",on);
      if(on&&!hintEl){hintEl=el("div",null,src.hint);hintEl.id="__cc_hint";host().appendChild(hintEl);}
      if(!on&&hintEl){hintEl.remove();hintEl=null;}
      if(tell&&src&&src.pinMode)src.pinMode(on);
    };
    var hideQ=function(){if(qb){qb.remove();qb=null;}};
    // The bar's own layers, and a motion page's transport (#__cm_bar): a click
    // there is a control, never a spot to pin.
    var mine="#__cc_bar,.__cc_panel,#__cc_hint,#__cc_pins,#__cc_notes,#__cc_qbtn,#__cc_pill,#__cm_bar";
    document.addEventListener("click",function(e){
      if(!on)return;
      var t=e.target;
      if(t&&t.closest&&t.closest(mine))return;
      e.preventDefault();e.stopPropagation();
      var sz=docSize();
      var snip=t&&t.textContent?t.textContent.replace(/\\s+/g," ").trim().slice(0,160):"";
      src.add({x:rnd(e.pageX/sz.w),y:rnd(e.pageY/sz.h)},snip,t);
      if(!src.sticky)setPin(false,true);
    },true);
    document.addEventListener("keydown",function(e){if(e.key==="Escape"){hideQ();if(on)setPin(false,true);}});
    document.addEventListener("mousedown",function(e){if(qb&&e.target!==qb&&!qb.contains(e.target))hideQ();});
    // A text selection offers a note on those words, pinned at the end of the
    // selection.
    document.addEventListener("mouseup",function(e){
      if(!src||on)return;
      var t=e.target;
      if(t&&t.closest&&t.closest(mine))return;
      setTimeout(function(){
        var s=window.getSelection(),txt=s?String(s).replace(/\\s+/g," ").trim():"";
        hideQ();
        if(!txt||!s.rangeCount)return;
        var rs=s.getRangeAt(0).getClientRects(),r=rs.length?rs[rs.length-1]:s.getRangeAt(0).getBoundingClientRect();
        var px=r.right+window.pageXOffset,py=r.top+r.height/2+window.pageYOffset;
        qb=el("button");qb.id="__cc_qbtn";qb.type="button";qb.innerHTML=bubble+"Comment";
        var first=s.getRangeAt(0).getBoundingClientRect();
        qb.style.left=(first.left+first.width/2+window.pageXOffset)+"px";qb.style.top=(first.top+window.pageYOffset-8)+"px";
        qb.addEventListener("mousedown",function(ev){ev.preventDefault();ev.stopPropagation();});
        qb.addEventListener("click",function(ev){
          ev.stopPropagation();var sz=docSize();
          var anchorEl=s.anchorNode&&(s.anchorNode.nodeType===1?s.anchorNode:s.anchorNode.parentElement);
          src.add({x:rnd(px/sz.w),y:rnd(py/sz.h)},txt.slice(0,500),anchorEl);
          hideQ();try{s.removeAllRanges();}catch(x){}
        });
        host().appendChild(qb);
      },0);
    });
    var rszT=null;
    window.addEventListener("resize",function(){clearTimeout(rszT);rszT=setTimeout(draw,150);});
    window.addEventListener("load",function(){draw();});
    return{
      use:function(s2){if(on)setPin(false,false);src=s2;hideQ();draw();},
      is:function(s2){return src===s2;},
      draw:draw,
      pin:setPin,
      on:function(){return on;}
    };
  })();
  // Framed in a codecast conversation, the parent speaks first: its notes
  // message hands this page's notes over to the conversation's quote batch,
  // and every gesture here goes back to it as a message.
  var qNotes=[],qEditing=null;
  var toParent=function(m){try{window.parent.postMessage(m,"*");}catch(e){}};
  var quoteSrc={sticky:true,hint:"Click anywhere to pin a note for the agent · Esc to stop",
    notes:function(){return qNotes;},editing:function(){return qEditing;},
    label:function(nt){return "Note "+nt.n+" · on your next message";},
    add:function(pt,snip){toParent({type:"codecast:note-add",point:pt,snippet:snip||undefined});},
    body:function(k,b){toParent({type:"codecast:note-body",id:k,body:b});},
    edit:function(k){toParent({type:"codecast:note-edit",id:k});},
    remove:function(k){toParent({type:"codecast:note-remove",id:k});},
    pinMode:function(v){toParent({type:"codecast:pin-mode",on:v});}};
  window.addEventListener("message",function(e){
    if(!framed||e.source!==window.parent)return;
    var d=e.data;if(!d||d.type!=="codecast:notes")return;
    qNotes=(d.notes||[]).map(function(n){return{key:String(n.id),n:+n.n||0,x:+n.x||0,y:+n.y||0,body:String(n.body||""),snippet:n.snippet?String(n.snippet):""};});
    qEditing=d.editing?String(d.editing):null;
    if(!NL.is(quoteSrc))NL.use(quoteSrc);
    if(!!d.pinMode!==NL.on())NL.pin(!!d.pinMode,false);
    NL.draw();
  });
  if(!CC.metaUrl)return;
  var api=function(path,body){return fetch(CC.apiBase+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();});};
  // View beacon — one per page load; carries the gate email when present.
  try{api("/cli/artifacts/view",{slug:CC.slug,email:gateEmail||undefined,k:gateK||undefined,e:gateE||undefined});}catch(e){}
  // Resolve the identity token to a display identity (+ @mention roster for
  // teammates). Server-authoritative: a bad token silently degrades the page
  // back to anonymous commenting.
  var me=null,meLoaded=!idTok;
  if(idTok){
    api("/cli/artifacts/identity",{slug:CC.slug,token:idTok}).then(function(r){
      meLoaded=true;
      if(r&&!r.error&&r.name){me=r;}else{idTok="";}
      // Drafts begun before we knew who this is take the owner's default.
      if(steerRole()==="owner")drafts.forEach(function(d){if(!d.agentSet)d.agent=true;});
      if(typeof renderC==="function"&&cpanel&&!cpanel.hidden)renderC();
    },function(){meLoaded=true;});
  }
  // Who may send comments to the page's agent: the owner (the #o= key, or the
  // owning account) and verified teammates who can see the page. The server
  // decides the same thing again on every post.
  var steerRole=function(){if(!CC.hasAgent)return null;if(ownerKey)return "owner";return me&&me.steer?me.steer:null;};
  var signinUrl=function(){
    var origin="https://codecast.sh";
    try{origin=new URL(CC.shareUrl).origin;}catch(e){}
    return origin+"/pages/auth?slug="+encodeURIComponent(CC.slug)+"&back="+encodeURIComponent(location.href);
  };
  var avatarNode=function(x){
    if(x&&x.avatar){var im=document.createElement("img");im.className="__cc_av";im.src=x.avatar;im.alt="";im.referrerPolicy="no-referrer";return im;}
    return el("span","__cc_avi",((x&&x.name)||"?").slice(0,1));
  };
  // Version links stay on whatever host serves this document. r is a
  // cache-buster (new URL → new cache key past the 60s edge/browser cache).
  // EVERY navigation must carry the gate tokens (k/e) and live flag forward,
  // or a reload on a gated page lands back on the password wall. This helper
  // (and the a.back rewrite in pageShell) is the single place that encodes
  // WHERE tokens live: the query string. If gated bundle assets ever move
  // tokens into the path (e.g. /_k/<tok>/ under a base href), both must
  // change in the same commit or in-page nav strands unlocked viewers.
  var keepHash=location.hash||"";
  var withQ=function(extra){var q=new URLSearchParams(location.search);var out=new URLSearchParams();
    ["k","e","live"].forEach(function(p){var val=q.get(p);if(val)out.set(p,val);});
    if(CC.live)out.set("live","1");
    Object.keys(extra).forEach(function(p){out.set(p,String(extra[p]));});
    return location.pathname+"?"+out.toString()+keepHash;};
  var verUrl=function(n,current){return withQ(current?{r:n}:{v:n});};
  var reloadFresh=function(){location.href=withQ({r:Date.now()});};
  var latest=document.getElementById("__cc_latest");
  if(latest)latest.setAttribute("href",verUrl(CC.currentVersion,true));
  // --- panel machinery: dropdowns on desktop, bottom sheets on mobile ---
  var panels=["__cc_hist","__cc_menupanel","__cc_cpanel","__cc_mgr"].map(function(id){return document.getElementById(id);});
  // Sheet mode from the PHYSICAL screen, not the layout viewport: a document
  // without a viewport meta lays out at ~980px on phones, so a media query
  // alone would keep desktop dropdowns on mobile.
  if((screen.width||9999)<=680||matchMedia("(max-width: 640px)").matches){
    panels.forEach(function(p){if(p)p.classList.add("__cc_sheet");});
  }
  var closeAll=function(){panels.forEach(function(p){if(p){p.hidden=true;p.classList.remove("__cc_in");}});};
  var show=function(p){
    panels.forEach(function(q){if(q&&q!==p){q.hidden=true;q.classList.remove("__cc_in");}});
    // Forced reflow between unhide and the class add makes the entrance
    // transition reliable without rAF (which Chrome throttles in occluded
    // windows and embedded iframes — the class must land regardless).
    if(p.hidden){p.hidden=false;void p.offsetWidth;p.classList.add("__cc_in");}
  };
  document.addEventListener("click",closeAll);
  panels.forEach(function(p){if(p)p.addEventListener("click",function(e){e.stopPropagation();});});
  var fetchMeta=function(cb){fetch(CC.metaUrl,{cache:"no-store"}).then(function(r){return r.json();}).then(cb,function(){});};
  var setCount=function(){var cc=document.getElementById("__cc_ccount");if(cc)cc.textContent=CC.comments?String(CC.comments):"";};
  // --- the page's agent ---
  // The session that made the page, as a quiet chip: idle, working, needs
  // input, and "updating" from a send to the agent until a newer version
  // lands (meta's awaiting_since, or this viewer's own send a moment ago).
  var agentEl=document.getElementById("__cc_agent"),agentLab=document.getElementById("__cc_alabel");
  var lastAgent=null,sentAt=0;
  var renderAgent=function(){
    if(!agentEl)return;
    var a=lastAgent;
    if(!a){agentEl.hidden=true;return;}
    // The server decides the chip (pageAgentChip); this viewer's own send a
    // moment ago reads as updating before the next meta catches up.
    var chip=a.chip||"idle";
    if(sentAt&&chip!=="needs_input"&&Date.now()-sentAt<CC.agentPickupMs)chip="updating";
    var k={working:"w",updating:"u",needs_input:"n"}[chip]||"";
    agentEl.className=k?"__cc_a"+k:"";
    agentLab.textContent=CC.agentLabels[chip]||CC.agentLabels.idle;
    agentEl.title=(k==="u"?"A comment was sent to the session that made this page; the page reloads when it publishes a new version. ":"The session that made this page. ")
      +(a.since?"Last moved "+rel(a.since)+".":"");
    agentEl.hidden=false;
  };
  var applyMeta=function(m){
    if(m.versions)metaVersions=m.versions;
    if(m.version>CC.version)sentAt=0;
    lastAgent=m.agent||null;renderAgent();
  };
  // After sending to the agent, the page follows it: live mode polls fast and
  // loads the new version by itself the moment it is published.
  var goLive=function(){};
  var awaitAgent=function(){sentAt=Date.now();renderAgent();goLive();};
  // --- history panel (restore appears with the owner key) ---
  var chip=document.getElementById("__cc_ver");
  var hist=document.getElementById("__cc_hist");
  if(chip&&hist){
    var render=function(m){
      hist.innerHTML="";
      (m.versions||[]).forEach(function(v){
        var a=document.createElement("a");a.className="__cc_row";
        a.href=verUrl(v.version,v.version===m.version);
        if(v.version===m.version)a.className+=" __cc_cur";
        if(v.version===CC.version)a.className+=" __cc_viewing";
        var l=document.createElement("span");l.className="__cc_vlabel";l.textContent="v"+v.version;
        if(v.edited_by){var eb=document.createElement("span");eb.style.opacity=".6";eb.style.fontWeight="400";eb.textContent=" by "+v.edited_by;l.appendChild(eb);}
        if(v.version!==m.version){
          var d=document.createElement("a");d.className="__cc_dlink";d.textContent="diff";
          d.href=withQ({diff:v.version+".."+m.version});
          d.title="What changed between v"+v.version+" and v"+m.version;
          d.addEventListener("click",function(e){e.stopPropagation();});
          l.appendChild(d);
          if(ownerKey){
            var rb=document.createElement("a");rb.className="__cc_dlink";rb.textContent="restore";rb.href="#";
            rb.title="Republish v"+v.version+" as the newest version";
            rb.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();rb.textContent="restoring…";
              api("/cli/artifacts/manage",{slug:CC.slug,owner_key:ownerKey,rollback_to:v.version}).then(function(r){
                if(r&&r.ok)reloadFresh();else rb.textContent="failed";
              },function(){rb.textContent="failed";});});
            l.appendChild(rb);
          }
        }
        var t=document.createElement("span");t.className="__cc_vwhen";t.textContent=rel(v.published_at);
        a.appendChild(l);a.appendChild(t);hist.appendChild(a);
      });
      if(!hist.childNodes.length){hist.appendChild(el("div","__cc_note","No history yet"));}
    };
    chip.addEventListener("click",function(e){
      e.stopPropagation();
      if(!hist.hidden){closeAll();return;}
      hist.innerHTML="";hist.appendChild(el("div","__cc_note","Loading…"));
      show(hist);
      fetchMeta(render);
    });
  }
  // --- comments ---
  // Three tiers: DRAFTS (this page load only) → PENDING (stored, visible to
  // every viewer, NOT yet sent to the author's session) → SENT. Saved
  // comments come from ?meta=1 and render as hollow pins + a list in the
  // panel; "Send all" flushes everything pending to the session as one batch.
  var cbtn=document.getElementById("__cc_cbtn");
  var cpanel=document.getElementById("__cc_cpanel");
  var drafts=[];
  var saved=[],savedLoaded=false;
  // Inline reply composers: which thread is open, and per-thread draft text
  // (kept out of the DOM so meta refreshes don't eat what's being typed).
  var replyState={open:null,text:{}};
  // The version that answered a comment sent to the agent: the first one
  // above the version that was current when it went.
  var metaVersions=[];
  var answeredIn=function(c){
    var sentOn=c.delivered_version||c.version,best=0;
    metaVersions.forEach(function(v){if(v.version>sentOn&&(!best||v.version<best))best=v.version;});
    return best;
  };
  // Unsent comments "Send all" can carry: anonymous ones never reach the agent.
  var pendingCount=function(){return saved.filter(function(c){return !c.delivered&&!!c.role;}).length;};
  // @mention autocomplete on a textarea — teammates only (me.roster is empty
  // for everyone else, which disables this entirely).
  var wireMentions=function(ta){
    if(!me||!me.roster||!me.roster.length)return;
    // The list is a FIXED layer on <body>, never inside the scrolling panel:
    // in-panel absolute positioning lost stacking fights with later siblings
    // (the send button rendered on top) and clipped at the panel edge.
    var list=null,items=[],sel=0,start=-1;
    var close=function(){if(list){list.remove();list=null;}items=[];start=-1;};
    var restyle=function(){if(!list)return;[].forEach.call(list.children,function(n,i){n.className="__cc_mrow"+(i===sel?" __cc_mon":"");});};
    var pick=function(u){
      var handle=u.username||u.name;
      var v=ta.value,pos=ta.selectionStart;
      ta.value=v.slice(0,start)+"@"+handle+" "+v.slice(pos);
      var np=start+handle.length+2;
      ta.setSelectionRange(np,np);
      ta.dispatchEvent(new Event("input",{bubbles:false}));
      close();ta.focus();
    };
    var place=function(){
      if(!list)return;
      var tr=ta.getBoundingClientRect();
      var lw=Math.min(Math.max(224,tr.width),320);
      var left=Math.min(Math.max(8,tr.left),window.innerWidth-lw-8);
      list.style.left=left+"px";list.style.width=lw+"px";
      // Below the textarea when it fits, above when it doesn't.
      var lh=Math.min(list.scrollHeight+2,218);
      if(tr.bottom+lh+12<window.innerHeight){list.style.top=(tr.bottom+4)+"px";list.style.bottom="auto";}
      else{list.style.top="auto";list.style.bottom=(window.innerHeight-tr.top+4)+"px";}
    };
    var update=function(){
      var pos=ta.selectionStart,vv=ta.value.slice(0,pos);
      var m=vv.match(/@([A-Za-z0-9_.-]*)$/);
      if(!m){close();return;}
      start=pos-m[0].length;
      var qq=m[1].toLowerCase();
      var hits=me.roster.filter(function(u){
        return (u.username||"").toLowerCase().indexOf(qq)===0||(u.name||"").toLowerCase().indexOf(qq)===0;
      }).slice(0,6);
      if(!hits.length){close();return;}
      if(!list){
        list=el("div",null);list.id="__cc_mlist";
        list.addEventListener("click",function(e){e.stopPropagation();});
        host().appendChild(list);
      }
      list.innerHTML="";items=hits;sel=0;
      hits.forEach(function(u,i){
        var r=el("div","__cc_mrow"+(i===0?" __cc_mon":""));
        r.appendChild(avatarNode(u));
        var nm2=el("span",null,u.name);nm2.style.overflow="hidden";nm2.style.textOverflow="ellipsis";nm2.style.whiteSpace="nowrap";
        r.appendChild(nm2);
        if(u.username)r.appendChild(el("span","__cc_mh","@"+u.username));
        r.addEventListener("mousedown",function(e){e.preventDefault();pick(u);});
        list.appendChild(r);
      });
      place();
    };
    ta.addEventListener("input",update);
    ta.addEventListener("keydown",function(e){
      if(!list)return;
      if(e.key==="ArrowDown"){e.preventDefault();sel=(sel+1)%items.length;restyle();}
      else if(e.key==="ArrowUp"){e.preventDefault();sel=(sel-1+items.length)%items.length;restyle();}
      else if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();pick(items[sel]);}
      else if(e.key==="Escape"){e.stopPropagation();close();}
    });
    ta.addEventListener("blur",function(){setTimeout(close,150);});
    // The anchor moves under panel scroll / window resize; keep up or fold.
    cpanel.addEventListener("scroll",place);
    window.addEventListener("resize",close);
  };
  var parseAnchor=function(c){if(c.__a!==undefined)return c.__a;try{c.__a=c.anchor?JSON.parse(c.anchor):null;}catch(e){c.__a=null;}return c.__a;};
  // Where a saved comment's pin goes. Prefer the element it was made on (it
  // follows the element when the page reflows or a new version moves it),
  // at the recorded spot inside its box; then the page-fraction point; then
  // a right-edge rail marker when only a vertical fraction survives.
  var elFor=function(an){if(!an||!an.sel)return null;try{return document.querySelector(an.sel);}catch(e){return null;}};
  var posFor=function(an){
    if(!an)return null;
    var docEl=document.documentElement;
    var docH=Math.max(docEl.scrollHeight,1),docW=Math.max(docEl.scrollWidth,1);
    var n=elFor(an);
    if(n){var r=n.getBoundingClientRect();
      if(r.width||r.height){
        var inBox=typeof an.ox==="number"&&typeof an.oy==="number";
        return{x:r.left+window.pageXOffset+(inBox?an.ox*r.width:Math.min(r.width/2,300)),
          y:r.top+window.pageYOffset+(inBox?an.oy*r.height:10)};
      }}
    if(typeof an.y==="number"&&typeof an.x==="number")return{x:an.x*docW,y:an.y*docH};
    if(typeof an.y==="number")return{x:docW-26,y:an.y*docH};
    return null;
  };
  var pinLayer=null;
  var pinsOn=function(){if(!pinLayer){pinLayer=document.createElement("div");pinLayer.id="__cc_pins";host().appendChild(pinLayer);}return pinLayer;};
  var renderPins=function(){
    var savedPos=saved.map(function(c){return{c:c,p:posFor(parseAnchor(c))};}).filter(function(s){return !!s.p;});
    NL.draw();
    var marks=[];
    saved.forEach(function(c){var an=parseAnchor(c);
      if(an&&typeof an.t==="number"&&!c.parent_id)marks.push({t:an.t,n:marks.length+1,label:c.author_name+": "+c.text.slice(0,80),avatar:c.author_avatar||undefined,id:c.id});});
    TL.markers(marks);
    if(!pinLayer&&!savedPos.length)return;
    pinsOn().innerHTML="";
    savedPos.forEach(function(s){
      var p=el("div","__cc_pin __cc_spin","");
      p.style.left=s.p.x+"px";p.style.top=s.p.y+"px";
      p.title=s.c.author_name+": "+s.c.text.slice(0,80);
      p.setAttribute("data-cid",s.c.id);
      p.addEventListener("click",function(e){e.stopPropagation();seekTo(s.c);openC(null,s.c.id,true);});
      pinLayer.appendChild(p);
    });
  };
  var seekTo=function(c){var an=parseAnchor(c);if(an&&typeof an.t==="number")TL.seek(an.t);};
  // A timeline that arrives after the bar: hand it the markers, and give the
  // open panel its seek buttons.
  window.addEventListener("cast:timeline-ready",function(){renderPins();if(cpanel&&!cpanel.hidden&&!drafts.length)renderC();});
  // A click on a comment's marker on the timeline opens that comment (the
  // provider seeks there itself; seeking again is harmless).
  window.addEventListener("cast:marker",function(e){
    var d=e&&e.detail;if(!d||!d.id)return;
    var c=null;saved.forEach(function(x){if(x.id===d.id)c=x;});
    if(!c)return;
    // Next tick: the marker's click is still bubbling toward the document
    // handler that closes every panel.
    seekTo(c);setTimeout(function(){openC(null,c.id,true);},0);
  });
  var refreshSaved=function(cb){fetchMeta(function(m){
    if(!m)return;
    saved=m.comments||[];savedLoaded=true;
    if(typeof m.comment_count==="number")CC.comments=m.comment_count;
    applyMeta(m);setCount();renderPins();
    if(cb)cb();
  });};
  // ?c=<comment id> — a notification deep link: open the discussion with that
  // comment's thread selected, and jump the page to its pin when it has one.
  var focusCid=(new URLSearchParams(location.search)).get("c")||"";
  if(focusCid){
    refreshSaved(function(){
      var target=null;saved.forEach(function(x){if(x.id===focusCid)target=x;});
      var tid=target&&target.parent_id?target.parent_id:focusCid;
      openC(null,tid,true);
      var p=target?posFor(parseAnchor(target)):null;
      if(!p){var top2=null;saved.forEach(function(x){if(x.id===tid)top2=x;});if(top2)p=posFor(parseAnchor(top2));}
      if(p){
        window.scrollTo({top:Math.max(0,p.y-140),behavior:"smooth"});
        var pin=pinLayer&&pinLayer.querySelector('[data-cid="'+tid+'"]');
        if(pin){pin.classList.remove("__cc_flash");void pin.offsetWidth;pin.classList.add("__cc_flash");}
      }
    });
  }else if(CC.comments>0)refreshSaved();
  // Fraction-based pin positions depend on the laid-out document size.
  var rszT=null;
  window.addEventListener("resize",function(){clearTimeout(rszT);rszT=setTimeout(renderPins,150);});
  // A stable path to an element: up to the nearest unique id or data-cast-id
  // (an author's own handle for a spot), else nth-of-type steps from <body>.
  // Kept only if it resolves back to the same element.
  var selPath=function(start){try{
    var parts=[],n=start,d=0;
    while(n&&n.nodeType===1&&n!==document.body&&n!==document.documentElement&&d<12){
      var cid=n.getAttribute("data-cast-id");
      if(cid){parts.unshift("[data-cast-id="+JSON.stringify(cid)+"]");break;}
      if(n.id&&document.querySelectorAll("#"+CSS.escape(n.id)).length===1){parts.unshift("#"+CSS.escape(n.id));break;}
      var tag=n.tagName.toLowerCase(),ix=1,s=n;
      while((s=s.previousElementSibling))if(s.tagName===n.tagName)ix++;
      parts.unshift(tag+":nth-of-type("+ix+")");
      n=n.parentElement;d++;
    }
    if(!parts.length)return "";
    if(n===document.body)parts.unshift("body");
    var path=parts.join(">");
    return document.querySelector(path)===start?path:"";
  }catch(e){return "";}};
  // The anchor for a new comment: the point, the element under it (with the
  // point's place inside its box), and the timeline moment when there is one.
  var anchorAt=function(pt,snip,t){
    var a={x:pt.x,y:pt.y};if(snip)a.snippet=snip.slice(0,120);
    var sp=t&&t!==document.body&&t!==document.documentElement?selPath(t):"";
    if(sp){
      a.sel=sp;
      try{var r=t.getBoundingClientRect(),sz=document.documentElement;
        if(r.width&&r.height){
          var px=pt.x*Math.max(sz.scrollWidth,1)-(r.left+window.pageXOffset),py=pt.y*Math.max(sz.scrollHeight,1)-(r.top+window.pageYOffset);
          a.ox=Math.round(Math.min(1,Math.max(0,px/r.width))*1000)/1000;a.oy=Math.round(Math.min(1,Math.max(0,py/r.height))*1000)/1000;
        }}catch(e){}
    }
    var tt=TL.now();if(tt!=null)a.t=tt;
    return a;
  };
  // Drafts with a spot on the page draw through the notes layer: a numbered
  // dot with the draft's editor at it. Posting stays the discussion panel's
  // job, where the name and the send live, so the editor links there.
  var dSeq=0,draftEd=null;
  // A draft's "Send to agent" starts on for the owner and off for a teammate.
  var newDraft=function(a){var d={id:"d"+(++dSeq),text:"",anchor:a,agent:steerRole()==="owner"};drafts.push(d);return d;};
  var hasSpot=function(d){return !!(d.anchor&&typeof d.anchor.x==="number"&&typeof d.anchor.y==="number");};
  var draftSrc={sticky:false,hint:"Click anywhere to pin your comment · Esc cancels",
    notes:function(){var out=[];drafts.forEach(function(d,i){if(hasSpot(d))out.push({key:d.id,n:i+1,x:d.anchor.x,y:d.anchor.y,t:d.anchor.t,body:d.text,snippet:d.anchor.snippet||""});});return out;},
    editing:function(){return draftEd;},
    label:function(nt){return "Draft "+nt.n+" · not posted yet";},
    add:function(pt,snip,t){
      closeAll();draftEd=newDraft(anchorAt(pt,snip,t)).id;NL.draw();syncSend();
    },
    body:function(k,b){drafts.forEach(function(d){if(d.id===k)d.text=b;});syncSend();},
    edit:function(k){draftEd=k;NL.draw();},
    remove:function(k){drafts=drafts.filter(function(d){return d.id!==k;});if(draftEd===k)draftEd=null;renderPins();syncSend();if(!cpanel.hidden)renderC();},
    lead:function(ft,flush){
      var b=el("button","__cc_nlead",ownerKey?"Review & send…":"Review & post…");b.type="button";
      b.title="Open the discussion to post your drafts";
      b.addEventListener("mousedown",function(e){e.preventDefault();});
      b.addEventListener("click",function(e){e.stopPropagation();flush();var k=draftEd;draftEd=null;NL.draw();
        var i=-1;drafts.forEach(function(d,j){if(d.id===k)i=j;});openC(i>=0?i:null);});
      ft.appendChild(b);
    }};
  NL.use(draftSrc);
  var enterPin=function(){closeAll();if(!NL.is(draftSrc))NL.use(draftSrc);NL.pin(true,false);};
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closeAll();});
  var toAgent=function(d){return !!steerRole()&&!!d.agent;};
  var syncSend=function(){
    var ready=drafts.filter(function(d){return d.text.trim();});
    var n=ready.length,na=ready.filter(toAgent).length;
    var b=document.getElementById("__cc_sendbtn");
    if(b){b.disabled=!n;
      b.textContent=!n?"Comment":na===n?(n>1?"Send "+n+" to agent":"Send to agent"):na?"Post "+n+" \\u00B7 "+na+" to agent":(n>1?"Post "+n+" comments":"Comment");}
  };
  // One post per batch; each comment says for itself whether it goes to the
  // agent. The batch's deliver:false means an unmarked comment never does.
  var doSend=function(name){
    var ready=drafts.filter(function(d){return d.text.trim();});
    if(!ready.length)return;
    var na=ready.filter(toAgent).length;
    var b=document.getElementById("__cc_sendbtn");
    var errBox=cpanel.querySelector(".__cc_cerr");
    if(b){b.disabled=true;b.textContent=na?"Sending…":"Posting…";}
    sSet("__cc_name",name||"");
    api("/cli/artifacts/comment",{slug:CC.slug,author_name:me?me.name:((name||"").trim()||"anonymous"),
      author_email:gateEmail||undefined,version:CC.version,
      k:gateK||undefined,e:gateE||undefined,
      deliver:false,
      owner_key:ownerKey||undefined,
      identity_token:idTok||undefined,
      comments:ready.map(function(d){var c={text:d.text.trim(),deliver:toAgent(d)};if(d.anchor)c.anchor=JSON.stringify(d.anchor);return c;})})
    .then(function(r){
      if(!r||r.error){if(errBox)errBox.textContent=(r&&r.error)||"Send failed — try again";syncSend();return;}
      drafts=[];renderPins();
      cpanel.innerHTML="";
      var ok=el("div","__cc_okwrap");
      ok.appendChild(el("div","__cc_okmark","✓"));
      ok.appendChild(el("div","__cc_okt",(na?"Sent ":"Posted ")+ready.length+(ready.length===1?" comment":" comments")));
      ok.appendChild(el("div","__cc_oks",na
        ?(r.delivered?"The agent has it. This page reloads when it publishes a new version."
          :"Posted, but the agent's session could not be reached. "+(ownerKey?"Use \\u201CSend all\\u201D later.":"The owner can send it later."))
        :"Now part of this page's discussion."));
      cpanel.appendChild(ok);
      if(na&&r.delivered){awaitAgent();}
      refreshSaved(function(){setTimeout(function(){if(!cpanel.hidden)renderC();},1600);});
    },function(){if(errBox)errBox.textContent="Network error — your drafts are kept";syncSend();});
  };
  // "Send all" (owner-only): flush the discussion's unsent comments to the
  // session in one batch message.
  var sendAll=function(btn){
    btn.disabled=true;btn.textContent="Sending…";
    api("/cli/artifacts/comment",{slug:CC.slug,deliver_pending:true,owner_key:ownerKey})
    .then(function(r){
      if(!r||r.error){btn.textContent="Failed";setTimeout(function(){if(!cpanel.hidden)renderC();},1600);return;}
      if(r.delivered)awaitAgent();
      refreshSaved(function(){if(!cpanel.hidden)renderC();});
    },function(){btn.textContent="Network error";setTimeout(function(){if(!cpanel.hidden)renderC();},1600);});
  };
  var pinSvg='${iconSvg(12, PIN_PATH)}';
  var noteSvg='${iconSvg(12, `<path d="M12 5v14"/><path d="M5 12h14"/>`)}';
  var jumpSvg='${iconSvg(11, PIN_PATH)}';
  var bigBubbleSvg='${iconSvg(22, BUBBLE_PATH, { sw: 1.6 })}';
  var iconBtn=function(cls,svg,label){var b=el("button",cls);b.type="button";b.innerHTML=svg;b.appendChild(document.createTextNode(label));return b;};
  // renderC(focusIdx, scrollToCid, highlightCid): focusIdx focuses a draft's
  // textarea; scrollToCid scrolls a comment into view; highlightCid paints the
  // selected state (deep links and pin jumps — NOT reply-opens).
  var renderC=function(focusIdx,scrollToCid,highlightCid){
    cpanel.innerHTML="";
    var head=el("div","__cc_phdr");
    head.appendChild(el("span","__cc_pht","Discussion"));
    if(saved.length>0)head.appendChild(el("span","__cc_phn",String(saved.length)));
    head.appendChild(el("span","__cc_sp"));
    if(me){
      var mh=el("span","__cc_meid");mh.title="Commenting as "+me.name;
      mh.appendChild(avatarNode(me));
      mh.appendChild(el("span","__cc_mename",me.name.split(" ")[0]));
      head.appendChild(mh);
    }else if(meLoaded){
      var sa=document.createElement("a");sa.className="__cc_signin";sa.href=signinUrl();
      sa.textContent="Sign in";sa.title="Comment with your codecast profile \\u2014 hops to codecast.sh and comes right back";
      head.appendChild(sa);
    }
    cpanel.appendChild(head);
    var body=el("div","__cc_pbody");
    cpanel.appendChild(body);
    if(!drafts.length&&!saved.length){
      var em=el("div","__cc_empty");
      var ei=el("div");ei.innerHTML=bigBubbleSvg;em.appendChild(ei);
      em.appendChild(el("div","__cc_e1","No comments yet"));
      em.appendChild(el("div","__cc_e2","Pin a note on the page, or select text to comment on it."));
      body.appendChild(em);
    }
    drafts.forEach(function(d,i){
      var card=el("div","__cc_draft");card.setAttribute("data-i",String(i));
      var top=el("div","__cc_dtop");
      if(hasSpot(d)){
        top.appendChild(el("span","__cc_dnum",String(i+1)));
        if(d.anchor&&d.anchor.snippet)top.appendChild(el("span","__cc_dsnip","\\u201C"+d.anchor.snippet.slice(0,60)+(d.anchor.snippet.length>60?"…":"")+"\\u201D"));
        else top.appendChild(el("span","__cc_dlabel","Pinned"));
      }else if(d.anchor&&d.anchor.snippet){
        top.appendChild(el("span","__cc_dsnip","\\u201C"+d.anchor.snippet.slice(0,60)+(d.anchor.snippet.length>60?"…":"")+"\\u201D"));
      }else{
        top.appendChild(el("span","__cc_dlabel","Note"));
      }
      top.appendChild(el("span","__cc_sp"));
      var rm=el("button","__cc_x","×");rm.type="button";rm.title="Remove this draft";
      rm.addEventListener("click",function(){drafts.splice(i,1);renderPins();renderC();});
      top.appendChild(rm);
      card.appendChild(top);
      if(d.anchor&&d.anchor.t!=null&&TL.has()){
        var tb=el("button","__cc_tat","at "+TL.fmt(d.anchor.t));tb.type="button";tb.title="Seek the page's timeline here";
        tb.addEventListener("click",function(e){e.stopPropagation();TL.seek(d.anchor.t);});
        top.insertBefore(tb,top.lastChild.previousSibling);
      }
      var ta=document.createElement("textarea");ta.className="__cc_ta";ta.placeholder="Write your comment…";ta.value=d.text;ta.rows=2;
      ta.addEventListener("input",function(){d.text=ta.value;syncSend();});
      wireMentions(ta);
      card.appendChild(ta);
      if(steerRole()){
        var lab=el("label","__cc_toagent"+(d.agent?" __cc_on":""));
        var cb=document.createElement("input");cb.type="checkbox";cb.checked=!!d.agent;
        cb.addEventListener("change",function(){d.agent=cb.checked;d.agentSet=true;lab.classList.toggle("__cc_on",cb.checked);syncSend();});
        lab.appendChild(cb);lab.appendChild(document.createTextNode("Send to agent"));
        lab.title=steerRole()==="owner"?"Deliver this comment to the session that made the page"
          :"Deliver this comment to the owner's agent, marked as your request as their teammate";
        card.appendChild(lab);
      }
      body.appendChild(card);
    });
    var addrow=el("div","__cc_addrow");
    var pinB=iconBtn("__cc_btn",pinSvg,"Pin on page");
    pinB.title="Tap a spot on the page and comment on it";
    pinB.addEventListener("click",function(){enterPin();});
    var genB=iconBtn("__cc_btn",noteSvg,"General note");
    genB.title="A comment about the whole page";
    genB.addEventListener("click",function(){var tt=TL.now();newDraft(tt!=null?{t:tt}:null);renderC(drafts.length-1);});
    addrow.appendChild(pinB);addrow.appendChild(genB);
    body.appendChild(addrow);
    if(drafts.length){
      var nm={value:sGet("__cc_name")||(gateEmail?gateEmail.split("@")[0]:"")};
      if(me){
        // Verified identity: comments post under the account's name/avatar.
        var as=el("div","__cc_asme");
        as.appendChild(avatarNode(me));
        as.appendChild(el("span",null,"Commenting as "+me.name));
        body.appendChild(as);
      }else{
        var who=el("div","__cc_who");
        var nmi=document.createElement("input");nmi.type="text";nmi.className="__cc_in2";nmi.placeholder="Your name";
        nmi.value=nm.value;
        nmi.addEventListener("input",function(){nm.value=nmi.value;sSet("__cc_name",nmi.value);});
        who.appendChild(nmi);body.appendChild(who);
      }
      body.appendChild(el("div","__cc_cerr",""));
      // Every comment posts to the page's discussion; the ones marked "Send
      // to agent" also go to the publishing session as one message.
      var actions=el("div","__cc_actions");
      var post=el("button","__cc_send","Comment");post.type="button";post.id="__cc_sendbtn";
      post.title=steerRole()?"Post to the discussion; the marked comments also go to the agent":"Post to this page's discussion";
      post.addEventListener("click",function(){doSend(nm.value);});
      actions.appendChild(post);
      body.appendChild(actions);
    }
    // Owner call to action: comments from people who may steer the agent
    // (the owner, teammates) that have not reached it yet.
    var pend=pendingCount();
    if(pend>0&&ownerKey&&CC.hasAgent){
      var pr=el("div","__cc_pendrow");
      pr.style.display="flex";pr.style.alignItems="center";pr.style.gap="8px";pr.style.color="var(--cc-dim)";
      pr.appendChild(el("span",null,pend+" not sent to the agent"));
      pr.appendChild(el("span","__cc_sp"));
      var sa2=el("button","__cc_sendall","Send all");sa2.type="button";
      sa2.title="Deliver yours and your teammates' unsent comments to the agent as one batch";
      sa2.addEventListener("click",function(){sendAll(sa2);});
      pr.appendChild(sa2);
      body.appendChild(pr);
    }
    if(saved.length){
      // Threads: top-level comments newest-first, replies chronological
      // under their comment. A reply whose thread got resolved away renders
      // as its own top-level row instead of vanishing.
      var topIds={};
      saved.forEach(function(c){if(!c.parent_id)topIds[c.id]=1;});
      var tops=[],repl={};
      saved.forEach(function(c){
        if(c.parent_id&&topIds[c.parent_id]){(repl[c.parent_id]=repl[c.parent_id]||[]).push(c);}
        else tops.push(c);
      });
      var jumpTo=function(c){
        seekTo(c);
        var p=posFor(parseAnchor(c));
        if(p)window.scrollTo({top:Math.max(0,p.y-140),behavior:"smooth"});
        var pin=pinLayer&&pinLayer.querySelector('[data-cid="'+c.id+'"]');
        if(pin){pin.classList.remove("__cc_flash");void pin.offsetWidth;pin.classList.add("__cc_flash");}
      };
      // One comment (or reply) as an avatar-column grid row.
      var cmtRow=function(c,isReply){
        var row=el("div","__cc_cmt2");
        row.appendChild(avatarNode({name:c.author_name,avatar:c.author_avatar}));
        var hd=el("div","__cc_cmhead");
        hd.appendChild(el("span","__cc_cname",c.author_name));
        if(c.verified){var ck=el("span","__cc_vck","\\u2713");ck.title="Signed-in codecast user";hd.appendChild(ck);}
        hd.appendChild(el("span","__cc_ctime",rel(c.created_at)));
        var an0=parseAnchor(c);
        if(an0&&typeof an0.t==="number"&&TL.has()){
          var tb=el("button","__cc_tat","at "+TL.fmt(an0.t));tb.type="button";tb.title="Seek the page's timeline here";
          tb.addEventListener("click",function(e){e.stopPropagation();TL.seek(an0.t);});
          hd.appendChild(tb);
        }
        // A comment the agent got says so, and once a version newer than the
        // one it was made on exists, which version answered it. Unsent is
        // the owner's bookkeeping, shown only where "Send all" can carry it.
        if(c.delivered){
          var fixedIn=answeredIn(c);
          var st=el("span","__cc_stag "+(fixedIn?"__cc_done":"__cc_sent"),fixedIn?"addressed in v"+fixedIn:"sent to agent");
          st.title=fixedIn?"Sent to the agent on v"+c.version+"; v"+fixedIn+" was published after it":"Sent to the agent that made this page";
          hd.appendChild(st);
        }else if(ownerKey&&CC.hasAgent&&c.role){hd.appendChild(el("span","__cc_stag __cc_pend","unsent"));}
        row.appendChild(hd);
        if(!isReply&&posFor(parseAnchor(c))){
          var jb=el("button","__cc_jump");jb.type="button";jb.innerHTML=jumpSvg;
          jb.title="Jump to this comment's spot on the page";
          jb.addEventListener("click",function(e){e.stopPropagation();jumpTo(c);});
          row.appendChild(jb);
        }
        var bd=el("div","__cc_cbody");
        var an=parseAnchor(c);
        if(an&&an.snippet)bd.appendChild(el("div","__cc_csnip","\\u201C"+String(an.snippet).slice(0,72)+(String(an.snippet).length>72?"…":"")+"\\u201D"));
        bd.appendChild(el("div","__cc_ctext",c.text));
        row.appendChild(bd);
        return row;
      };
      var replyComposer=function(tid){
        var wrap=el("div","__cc_rwrap");
        if(!me){
          var rw=el("div","__cc_who");
          var rn=document.createElement("input");rn.type="text";rn.className="__cc_in2";rn.placeholder="Your name";
          rn.value=sGet("__cc_name")||(gateEmail?gateEmail.split("@")[0]:"");
          rn.addEventListener("input",function(){sSet("__cc_name",rn.value);});
          rw.appendChild(rn);wrap.appendChild(rw);
        }
        var ta=document.createElement("textarea");ta.className="__cc_ta";ta.rows=2;ta.placeholder="Reply\\u2026";
        ta.value=replyState.text[tid]||"";
        ta.addEventListener("input",function(){replyState.text[tid]=ta.value;});
        wireMentions(ta);
        wrap.appendChild(ta);
        var acts=el("div","__cc_actions");
        var cx=el("button","__cc_ghost","Cancel");cx.type="button";
        cx.addEventListener("click",function(){replyState.open=null;renderC();});
        var rb=el("button","__cc_send","Reply");rb.type="button";
        rb.addEventListener("click",function(){
          var txt=(replyState.text[tid]||"").trim();
          if(!txt)return;
          rb.disabled=true;rb.textContent="Posting\\u2026";
          api("/cli/artifacts/comment",{slug:CC.slug,
            author_name:me?me.name:(sGet("__cc_name")||"anonymous"),
            author_email:gateEmail||undefined,version:CC.version,
            k:gateK||undefined,e:gateE||undefined,
            deliver:false,owner_key:ownerKey||undefined,identity_token:idTok||undefined,
            parent_id:tid,comments:[{text:txt}]})
          .then(function(r){
            if(!r||r.error){rb.disabled=false;rb.textContent="Reply";return;}
            replyState.open=null;delete replyState.text[tid];
            refreshSaved(function(){if(!cpanel.hidden)renderC(null,tid);});
          },function(){rb.disabled=false;rb.textContent="Reply";});
        });
        acts.appendChild(cx);acts.appendChild(rb);
        wrap.appendChild(acts);
        return wrap;
      };
      var threads=el("div","__cc_threads");
      tops.slice().reverse().forEach(function(c){
        var card=el("div","__cc_thread"+(highlightCid===c.id?" __cc_sel":""));
        card.setAttribute("data-cid",c.id);
        card.appendChild(cmtRow(c,false));
        var kids=repl[c.id]||[];
        if(kids.length){
          var rlist=el("div","__cc_replies");
          kids.sort(function(a,b){return a.created_at-b.created_at;}).forEach(function(k){
            var rc=el("div","__cc_reply");
            rc.setAttribute("data-cid",k.id);
            rc.appendChild(cmtRow(k,true));
            rlist.appendChild(rc);
          });
          card.appendChild(rlist);
        }
        if(replyState.open===c.id){
          card.appendChild(replyComposer(c.id));
        }else{
          var rbn=el("button","__cc_rbtn","Reply");rbn.type="button";
          rbn.addEventListener("click",function(e){e.stopPropagation();replyState.open=c.id;renderC(null,c.id);
            var t2=cpanel.querySelector('[data-cid="'+c.id+'"] textarea');if(t2)t2.focus();});
          card.appendChild(rbn);
        }
        threads.appendChild(card);
      });
      body.appendChild(threads);
    }
    syncSend();
    if(focusIdx!=null){var t=cpanel.querySelector('[data-i="'+focusIdx+'"] textarea');if(t)t.focus();}
    if(scrollToCid){var sc=cpanel.querySelector('[data-cid="'+scrollToCid+'"]');if(sc)sc.scrollIntoView({block:"nearest"});}
  };
  var openC=function(focusIdx,scrollToCid,highlight){
    if(draftEd){draftEd=null;NL.draw();}
    show(cpanel);renderC(focusIdx,scrollToCid,highlight?scrollToCid:null);
    // First open: the saved list may not be loaded yet (count of 0 skips the
    // boot fetch). Refresh, then re-render only if nothing is being typed.
    if(!savedLoaded)refreshSaved(function(){if(!cpanel.hidden&&!drafts.length)renderC(null,scrollToCid,highlight?scrollToCid:null);});
  };
  if(cbtn&&cpanel){
    cbtn.addEventListener("click",function(e){
      e.stopPropagation();
      if(!cpanel.hidden){closeAll();return;}
      // A live text selection becomes an anchored draft immediately.
      var s="";try{s=String(window.getSelection()||"").trim();}catch(x){}
      if(s){
        var a={snippet:s.slice(0,120)};
        var tt=TL.now();if(tt!=null)a.t=tt;
        try{
          var r0=window.getSelection().getRangeAt(0).getBoundingClientRect();
          var docH=Math.max(document.documentElement.scrollHeight,1);
          var docW=Math.max(document.documentElement.scrollWidth,1);
          a.y=Math.round((r0.top+r0.height/2+window.pageYOffset)/docH*1000)/1000;
          a.x=Math.round((r0.left+r0.width/2+window.pageXOffset)/docW*1000)/1000;
          newDraft(a);
        }catch(x){newDraft(a);}
        renderPins();
        openC(drafts.length-1);
      }else{
        openC();
      }
    });
  }
  // --- manage sheet (owner key only) ---
  var mgr=document.getElementById("__cc_mgr");
  var mgrPw=false;
  var mnote=function(msg){mgr.innerHTML="";mgr.appendChild(el("div","__cc_note",msg));};
  var mreq=function(extra){
    var b={slug:CC.slug,owner_key:ownerKey},k;
    for(k in extra)b[k]=extra[k];
    api("/cli/artifacts/manage",b).then(function(j){
      if(!j||j.error){mnote((j&&j.error)||"Failed to load");return;}
      renderMgr(j);
    },function(){mnote("Network error");});
  };
  var mset=function(setObj){mreq({set:setObj});};
  var renderMgr=function(j){
    mgr.innerHTML="";
    var ac=j.access||{},st=j.stats||{};
    var head=el("div","__cc_ph");head.appendChild(el("span","__cc_pht","Manage sharing"));mgr.appendChild(head);
    var views=st.views||0;
    mgr.appendChild(el("div","__cc_note",views+" view"+(views===1?"":"s")+(st.last_viewed_at?" · last viewed "+rel(st.last_viewed_at):"")));

    mgr.appendChild(el("div","__cc_h2","Access"));
    var pw=el("div","__cc_kv");
    pw.appendChild(el("span","__cc_k","Password"));
    pw.appendChild(el("span","__cc_v"+(ac.has_password?" __cc_on":""),ac.has_password?"required":"off"));
    pw.appendChild(el("span","__cc_sp"));
    if(!mgrPw){
      var setb=el("button","__cc_btn",ac.has_password?"Change":"Set");setb.type="button";
      setb.addEventListener("click",function(){mgrPw=true;renderMgr(j);});
      pw.appendChild(setb);
      if(ac.has_password){
        var rmb=el("button","__cc_btn __cc_danger","Remove");rmb.type="button";rmb.title="Anyone with the link will be able to view";
        rmb.addEventListener("click",function(){rmb.disabled=true;mset({password:null});});
        pw.appendChild(rmb);
      }
    }
    mgr.appendChild(pw);
    if(mgrPw){
      var pr=el("div","__cc_kv");
      var pin=document.createElement("input");pin.type="text";pin.className="__cc_in2";pin.placeholder="New password";
      pin.setAttribute("autocapitalize","off");pin.setAttribute("autocomplete","off");
      var sv=el("button","__cc_btn","Save");sv.type="button";
      var commit=function(){if(pin.value){mgrPw=false;mset({password:pin.value});}};
      sv.addEventListener("click",commit);
      pin.addEventListener("keydown",function(e){if(e.key==="Enter")commit();});
      var cx=el("button","__cc_btn","Cancel");cx.type="button";
      cx.addEventListener("click",function(){mgrPw=false;renderMgr(j);});
      pr.appendChild(pin);pr.appendChild(sv);pr.appendChild(cx);
      mgr.appendChild(pr);
      pin.focus();
    }
    var eg=el("div","__cc_kv");
    eg.appendChild(el("span","__cc_k","Email gate"));
    eg.appendChild(el("span","__cc_v"+(ac.email_gate?" __cc_on":""),ac.email_gate?"on":"off"));
    eg.appendChild(el("span","__cc_sp"));
    var tg=el("button","__cc_btn"+(ac.email_gate?" __cc_danger":""),ac.email_gate?"Turn off":"Turn on");tg.type="button";
    tg.title=ac.email_gate?"Viewers will no longer have to identify themselves":"Viewers must enter their email to view";
    tg.addEventListener("click",function(){tg.disabled=true;mset({email_gate:!ac.email_gate});});
    eg.appendChild(tg);
    mgr.appendChild(eg);
    if(j.session_short_id){
      var sl=el("div","__cc_kv");
      sl.appendChild(el("span","__cc_k","Session link"));
      sl.appendChild(el("span","__cc_v"+(ac.show_session?" __cc_on":""),ac.show_session?"shown":"hidden"));
      sl.appendChild(el("span","__cc_sp"));
      var sb=el("button","__cc_btn",ac.show_session?"Hide":"Show");sb.type="button";
      sb.title=ac.show_session?"Remove the link to your session from the page":"Let viewers open the session that published this page";
      sb.addEventListener("click",function(){sb.disabled=true;mset({show_session:!ac.show_session});});
      sl.appendChild(sb);
      mgr.appendChild(sl);
    }
    var co=el("div","__cc_kv");
    co.appendChild(el("span","__cc_k","Comments"));
    co.appendChild(el("span","__cc_v"+(ac.comments_enabled?" __cc_on":""),ac.comments_enabled?"on":"off"));
    co.appendChild(el("span","__cc_sp"));
    var cb2=el("button","__cc_btn"+(ac.comments_enabled?" __cc_danger":""),ac.comments_enabled?"Turn off":"Turn on");cb2.type="button";
    cb2.title=ac.comments_enabled?"Viewers can no longer comment; the existing discussion is hidden":"Let viewers discuss this page";
    cb2.addEventListener("click",function(){cb2.disabled=true;mset({comments:!ac.comments_enabled});});
    co.appendChild(cb2);
    mgr.appendChild(co);
    var ex=el("div","__cc_kv");
    ex.appendChild(el("span","__cc_k","Expires"));
    ex.appendChild(el("span","__cc_v",ac.expires_at?inFmt(ac.expires_at):"never"));
    mgr.appendChild(ex);
    var chips=el("div","__cc_chips");
    [["1h",3600e3],["24h",86400e3],["7d",604800e3],["30d",2592e6],["never",null]].forEach(function(p){
      var b=el("button","__cc_chip2",p[0]);b.type="button";
      b.addEventListener("click",function(){b.disabled=true;mset({expires_in_ms:p[1]});});
      chips.appendChild(b);
    });
    mgr.appendChild(chips);

    mgr.appendChild(el("div","__cc_h2","Editing"));
    var seg=el("div","__cc_chips");
    ["owner","link","team"].forEach(function(m){
      var b=el("button","__cc_chip2"+((ac.edit_mode||"owner")===m?" __cc_segon":""),m);b.type="button";
      b.addEventListener("click",function(){if((ac.edit_mode||"owner")!==m){b.disabled=true;mset({edit_mode:m});}});
      seg.appendChild(b);
    });
    mgr.appendChild(seg);
    mgr.appendChild(el("div","__cc_note",
      {owner:"Only you can publish edits.",
       link:"Anyone with the edit link can publish new versions — and read the source, password or not.",
       team:"Your teammates can publish edits — and read the source, password or not."}[ac.edit_mode||"owner"]||""));

    mgr.appendChild(el("div","__cc_h2","Links"));
    var lr=el("div","__cc_chips");
    var base=CC.shareUrl||location.href.split("#")[0];
    var cm=el("button","__cc_btn","Copy manage link");cm.type="button";
    cm.addEventListener("click",function(){copyText(base+"#o="+ownerKey,function(){flashLabel(cm,"Copied","Copy manage link");});});
    lr.appendChild(cm);
    if(j.edit_url){
      var ce=el("button","__cc_btn","Copy edit link");ce.type="button";
      ce.addEventListener("click",function(){copyText(j.edit_url,function(){flashLabel(ce,"Copied","Copy edit link");});});
      lr.appendChild(ce);
    }
    mgr.appendChild(lr);

    var openC2=(j.comments||[]).filter(function(c){return c.status==="open";});
    CC.comments=openC2.length;setCount();
    if(openC2.length){
      mgr.appendChild(el("div","__cc_h2","Open comments ("+openC2.length+")"));
      openC2.forEach(function(c){
        var row=el("div","__cc_cmt");
        row.appendChild(el("div","__cc_cmeta",c.author_name+(c.verified?" \\u2713":"")+(c.author_email?" <"+c.author_email+">":"")+" · v"+c.version+" · "+rel(c.created_at)));
        var an=null;try{an=c.anchor?JSON.parse(c.anchor):null;}catch(e){}
        if(an&&an.snippet)row.appendChild(el("div","__cc_dsnip","\\u201C"+String(an.snippet).slice(0,80)+"\\u201D"));
        row.appendChild(el("div","__cc_ctext",c.text));
        var rb=el("button","__cc_btn","Resolve");rb.type="button";
        rb.addEventListener("click",function(){rb.disabled=true;rb.textContent="Resolving…";mreq({resolve_comment_id:c.id});});
        row.appendChild(rb);
        mgr.appendChild(row);
      });
    }
    if((j.viewers||[]).length){
      mgr.appendChild(el("div","__cc_h2","Seen by"));
      j.viewers.forEach(function(v){
        var row=el("div","__cc_kv");
        row.appendChild(el("span","__cc_k",v.email));
        row.appendChild(el("span","__cc_sp"));
        row.appendChild(el("span","__cc_v",(v.view_count||1)+"× · first "+rel(v.first_seen)+" · last "+rel(v.last_seen)));
        mgr.appendChild(row);
      });
    }
  };
  var openManage=function(){show(mgr);mnote("Loading…");mreq({});};
  // --- overflow menu: source, views, edit, manage (owner) ---
  var menuBtn=document.getElementById("__cc_menu");
  var menu=document.getElementById("__cc_menupanel");
  if(menuBtn&&menu){
    menuBtn.addEventListener("click",function(e){
      e.stopPropagation();
      if(!menu.hidden){closeAll();return;}
      menu.innerHTML="";
      var add=function(label,fn){var a=document.createElement("a");a.className="__cc_row";a.href="#";
        var s=document.createElement("span");s.textContent=label;a.appendChild(s);
        a.addEventListener("click",function(ev){ev.preventDefault();fn();});menu.appendChild(a);return a;};
      // Copy moved off the bar into this menu; the row flashes in place.
      var cp=add("Copy link",function(){});
      cp.addEventListener("click",function(){
        var s=cp.querySelector("span");
        copyText(CC.shareUrl||location.href.split("#")[0],function(){if(s)flashLabel(s,"Copied","Copy link");setTimeout(closeAll,900);});
      });
      add("View source",function(){var x={src:1};if(CC.version!==CC.currentVersion)x.v=CC.version;location.href=withQ(x);});
      if(ownerKey||editKey||CC.editMode==="link"){
        add("Edit this page",function(){location.href=withQ({edit:1});});
      }
      if(ownerKey){
        add("Manage sharing…",openManage);
      }
      if(CC.views){menu.appendChild(el("div","__cc_note",CC.views+" view"+(CC.views===1?"":"s")));}
      show(menu);
    });
  }
  // --- new-version badge / live reload (also refreshes the comment count) ---
  if(CC.version===CC.currentVersion){
    var badge=document.getElementById("__cc_new");
    var poll=function(){
      fetchMeta(function(m){
        if(!m)return;
        if(typeof m.comment_count==="number"&&m.comment_count!==CC.comments){CC.comments=m.comment_count;setCount();}
        // Keep saved comments (and their pins) live so another viewer's
        // comments show up without a reload. Re-render only on real change —
        // and never redraw the panel itself mid-typing.
        if(m.comments){
          var sig=function(list){return list.map(function(c){return c.id+(c.delivered?"+":"-");}).join(",");};
          if(sig(m.comments)!==sig(saved)){saved=m.comments;savedLoaded=true;renderPins();}
        }
        applyMeta(m);
        if(m.version>CC.version){
          if(CC.live){location.href=verUrl(m.version,true);return;}
          if(badge){
            badge.textContent="v"+m.version+" published — reload";
            badge.hidden=false;
            badge.onclick=function(){location.href=verUrl(m.version,true);};
          }
        }
      });
    };
    var pollT=null;
    var schedule=function(){clearInterval(pollT);pollT=setInterval(poll,CC.live?5e3:3e4);};
    schedule();
    goLive=function(){if(CC.live)return;CC.live=true;schedule();};
    // The agent chip's first state, when no comment fetch is already coming.
    if(CC.hasAgent&&!focusCid&&!(CC.comments>0))poll();
  }
})();</script>`;
}

function ogMeta(o: BrandOpts): string {
  const author = o.author ? ` by ${escAttr(o.author)}` : "";
  const image =
    o.hasThumb && o.apiBase && o.slug && !(o.gated?.password || o.gated?.email)
      ? `\n<meta property="og:image" content="${escAttr(`${o.apiBase}/cli/a/${o.slug}?thumb=1`)}">\n<meta name="twitter:card" content="summary_large_image">`
      : `\n<meta name="twitter:card" content="summary">`;
  return `
<meta property="og:title" content="${escAttr(o.title)}">
<meta property="og:description" content="A page published${author} with codecast">
<meta property="og:url" content="${escAttr(o.shareUrl)}">
<meta property="og:site_name" content="codecast">
<meta property="og:type" content="article">${image}
<meta name="robots" content="noindex">`;
}

/**
 * Inject the codecast header bar (after <body>, else prepended) and og meta
 * (after <head>, when one exists) into an artifact's HTML. The artifact's own
 * markup — including its <title> — is never modified, only added to.
 */
export function brandArtifactHtml(html: string, opts: BrandOpts): string {
  let out = html;
  const headMatch = out.match(/<head[^>]*>/i);
  if (headMatch) {
    const at = out.indexOf(headMatch[0]) + headMatch[0].length;
    out = out.slice(0, at) + ogMeta(opts) + out.slice(at);
  }
  const bar = barHtml(opts);
  const bodyMatch = out.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const at = out.indexOf(bodyMatch[0]) + bodyMatch[0].length;
    return out.slice(0, at) + bar + out.slice(at);
  }
  return bar + out;
}

// ---------------------------------------------------------------------------
// Standalone pages (gates, source, diff, editor, markdown theme, expired).
// One shared shell keeps them visually coherent with the bar.
// ---------------------------------------------------------------------------

function pageShell(title: string, body: string, extra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escHtml(title)}</title>
<style>
  @import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap");
  /* Solarized tokens from the web app's globals.css; follows OS scheme. */
  :root { --ink: #002b36; --mut: #586e75; --dim: rgba(0,43,54,.45); --coral: #e86c5d; --blue: #268bd2; --bg: #fbf5e2; --card: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #fdf6e3; --mut: #93a1a1; --dim: rgba(253,246,227,.45); --blue: #268bd2; --bg: #002b36; --card: #08404e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--mut);
    font: 400 14px/1.5 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased; }
  ::selection { background: rgba(232,108,93,.25); }
  .shell { max-width: 860px; margin: 0 auto;
    padding: 20px calc(16px + env(safe-area-inset-right)) calc(60px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left)); }
  .top { display: flex; align-items: center; gap: 10px; padding: 4px 0 18px; }
  .top a.brand { color: #444; display: inline-flex; }
  .top .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
  .top a.back { color: var(--blue); text-decoration: none; white-space: nowrap; padding: 6px 0; }
  .top a.back:hover { text-decoration: underline; }
  .card { background: var(--card); border-radius: 12px; box-shadow: 0 1px 6px rgba(0,0,0,.08); padding: 20px;
    animation: __rise .4s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes __rise { from { opacity: 0; transform: translateY(10px); } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  button.primary { all: unset; cursor: pointer; background: var(--coral); color: #fff; font: inherit; font-weight: 600;
    padding: 10px 18px; border-radius: 8px; text-align: center; -webkit-tap-highlight-color: transparent;
    transition: background .12s ease, transform .06s ease; }
  button.primary:hover { background: #d85b4c; }
  button.primary:active { transform: translateY(1px); }
  button.primary:disabled { opacity: .55; cursor: default; }
  button.primary:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  button.ghost { all: unset; cursor: pointer; font: inherit; padding: 6px 12px; border-radius: 7px; color: var(--ink);
    background: rgba(0,0,0,.05); -webkit-tap-highlight-color: transparent; }
  button.ghost:hover { background: rgba(0,0,0,.1); }
  input[type=password], input[type=email], input[type=text] { font: inherit; padding: 10px 12px; border: 1px solid var(--dim);
    border-radius: 8px; width: 100%; background: var(--bg); color: var(--ink); transition: border-color .12s ease, box-shadow .12s ease; }
  input:focus { outline: none; border-color: var(--coral); box-shadow: 0 0 0 3px rgba(232,108,93,.15); }
  .err { color: #b3372a; min-height: 1.2em; }
  .glyph { width: 44px; height: 44px; border-radius: 12px; background: rgba(232,108,93,.1); display: flex;
    align-items: center; justify-content: center; margin: 0 0 14px; }
  ${extra}
</style>
</head>
<body>
<div class="shell">
${body}
</div>
<script>(function(){
  // Rewrite nav links to stay on THIS origin and carry the gate tokens
  // (k/e) and live flag: server-built links point at the canonical share
  // host, which re-runs the gates, and dropping the tokens lands an
  // unlocked viewer back on the password wall. Each link's own mode params
  // (edit=1, src=raw) are merged, not replaced, and links without a
  // fragment inherit location.hash so #o/#ed keys survive into the editor.
  var q=new URLSearchParams(location.search);
  document.querySelectorAll("a.back").forEach(function(a){
    var href=a.getAttribute("href")||"";
    if(!href||href.charAt(0)==="#")return;
    var hashAt=href.indexOf("#");
    var hash=hashAt>=0?href.slice(hashAt):(location.hash||"");
    var base=hashAt>=0?href.slice(0,hashAt):href;
    var qAt=base.indexOf("?");
    var params=new URLSearchParams(qAt>=0?base.slice(qAt+1):"");
    ["k","e","live"].forEach(function(p){var v=q.get(p);if(v)params.set(p,v);});
    var qs=params.toString();
    a.href=location.pathname+(qs?"?"+qs:"")+hash;
  });
})();</script>
</body>
</html>`;
}

function topRow(title: string, shareUrl: string, backLabel = "← Back to page"): string {
  return `<div class="top">
  <a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a>
  <span class="t">${escHtml(title)}</span>
  <a class="back" href="${escAttr(shareUrl)}">${escHtml(backLabel)}</a>
</div>`;
}

const GATE_ICON = { sw: 1.8, stroke: "#e86c5d" };
const LOCK_SVG = iconSvg(22, `<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>`, GATE_ICON);
const MAIL_SVG = iconSvg(22, `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>`, GATE_ICON);
const CLOCK_SVG = iconSvg(22, `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>`, GATE_ICON);

export function passwordGatePage(o: { slug: string; title: string; apiBase: string; shareUrl: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a><span class="t">${escHtml(o.title)}</span></div>
<div class="card" style="max-width:420px;margin:12vh auto 0">
  <div class="glyph">${LOCK_SVG}</div>
  <h1 style="font-size:16px;color:var(--ink);margin:0 0 6px">This page is password protected</h1>
  <p style="margin:0 0 18px;opacity:.7">Enter the password to view <b>${escHtml(o.title)}</b>.</p>
  <form id="f" style="display:flex;flex-direction:column;gap:10px">
    <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password">
    <div class="err" id="err" role="alert"></div>
    <button class="primary" id="go" type="submit">Unlock</button>
  </form>
</div>
<script>(function(){
  var f=document.getElementById("f"),pw=document.getElementById("pw"),err=document.getElementById("err"),go=document.getElementById("go");
  f.addEventListener("submit",function(e){
    e.preventDefault();err.textContent="";
    if(!pw.value)return;
    go.disabled=true;go.textContent="Unlocking…";
    var reset=function(msg){go.disabled=false;go.textContent="Unlock";err.textContent=msg;pw.select();};
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/unlock",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},password:pw.value})})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&j.k){var u=new URL(location.href);u.searchParams.set("k",j.k);location.replace(u.pathname+u.search+location.hash);}
        else reset("Wrong password");
      },function(){reset("Network error — try again");});
  });
})();</script>`;
  return pageShell(o.title, body);
}

export function emailGatePage(o: { slug: string; title: string; apiBase: string; shareUrl: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a><span class="t">${escHtml(o.title)}</span></div>
<div class="card" style="max-width:420px;margin:12vh auto 0">
  <div class="glyph">${MAIL_SVG}</div>
  <h1 style="font-size:16px;color:var(--ink);margin:0 0 6px">Enter your email to view</h1>
  <p style="margin:0 0 18px;opacity:.7">The author of <b>${escHtml(o.title)}</b> asks viewers to identify themselves.</p>
  <form id="f" style="display:flex;flex-direction:column;gap:10px">
    <input type="email" id="em" placeholder="you@example.com" autofocus autocomplete="email" autocapitalize="off" autocorrect="off" inputmode="email" required>
    <div class="err" id="err" role="alert"></div>
    <button class="primary" id="go" type="submit">Continue</button>
  </form>
</div>
<script>(function(){
  var f=document.getElementById("f"),em=document.getElementById("em"),err=document.getElementById("err"),go=document.getElementById("go");
  f.addEventListener("submit",function(e){
    e.preventDefault();err.textContent="";
    var email=em.value.trim().toLowerCase();
    if(!email)return;
    go.disabled=true;go.textContent="One moment…";
    var reset=function(msg){go.disabled=false;go.textContent="Continue";err.textContent=msg;};
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/email-unlock",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},email:email})})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&j.e){var u=new URL(location.href);u.searchParams.set("e",j.e);
          var h=new URLSearchParams(location.hash.replace(/^#/,""));h.set("em",email);
          location.replace(u.pathname+u.search+"#"+h.toString());}
        else reset((j&&j.error)||"Something went wrong");
      },function(){reset("Network error — try again");});
  });
})();</script>`;
  return pageShell(o.title, body);
}

export function expiredPage(o: { title: string }): string {
  const body = `
<div class="top"><a class="brand" href="https://codecast.sh" target="_blank" rel="noopener noreferrer">${logoSvg(22)}</a></div>
<div class="card" style="max-width:420px;margin:16vh auto 0;text-align:center">
  <div class="glyph" style="margin:0 auto 14px">${CLOCK_SVG}</div>
  <h1 style="font-size:16px;color:var(--ink);margin:0 0 6px">This link has expired</h1>
  <p style="margin:0;opacity:.7">The author set an expiry on <b>${escHtml(o.title)}</b> and it has passed.</p>
  <p style="margin:14px 0 0;opacity:.55">If you need access, ask the author to republish or extend the expiry.</p>
</div>`;
  return pageShell(o.title, body);
}

export function sourcePage(o: {
  slug: string;
  title: string;
  source: string;
  kind: string;
  version: number;
  apiBase: string;
  shareUrl: string;
  canEdit: boolean;
}): string {
  const editBtn = o.canEdit
    ? `<a class="back" style="margin-left:12px" href="${escAttr(o.shareUrl.split("#")[0])}?edit=1${o.shareUrl.includes("#") ? "#" + o.shareUrl.split("#")[1] : ""}">Edit ↗</a>`
    : "";
  const lines = o.source.split("\n");
  const rows = lines
    .map((ln, i) => `<div class="ln"><span class="no">${i + 1}</span><span class="lc">${escHtml(ln)}</span></div>`)
    .join("");
  const extra = `
  .tools { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid rgba(0,0,0,.07);
    position: sticky; top: 0; background: var(--card); z-index: 2; border-radius: 12px 12px 0 0; }
  .ln { display: flex; font-size: 12px; line-height: 1.55; color: var(--ink); }
  .ln:hover { background: rgba(0,0,0,.03); }
  .ln .no { flex: 0 0 46px; text-align: right; padding-right: 12px; opacity: .35; user-select: none; -webkit-user-select: none; }
  .ln .lc { white-space: pre-wrap; word-break: break-word; flex: 1; min-width: 0; padding-right: 12px; }
  .ln .lc:empty::before { content: "\\00a0"; }
  @media (max-width: 640px) { .ln .no { flex-basis: 34px; padding-right: 8px; } .ln { font-size: 11px; } }`;
  const body = `
${topRow(`${o.title} — source (v${o.version})`, o.shareUrl)}
<div class="card" style="padding:0">
  <div class="tools">
    <span style="opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${escHtml(o.kind)} · v${o.version} · ${lines.length.toLocaleString()} lines · ${o.source.length.toLocaleString()} chars</span>
    <span style="flex:1"></span>
    <a class="back" id="raw" href="#">Raw</a>
    <button class="primary" id="cp" style="padding:5px 12px;font-size:12px">Copy source</button>${editBtn}
  </div>
  <div id="src" style="padding:8px 0;overflow-x:auto">${rows}</div>
</div>
<script>(function(){
  var raw=document.getElementById("raw");
  try{var u=new URL(location.href);u.searchParams.set("src","raw");raw.href=u.pathname+u.search;}catch(e){raw.style.display="none";}
  var b=document.getElementById("cp");
  var text=function(){return Array.prototype.map.call(document.querySelectorAll("#src .lc"),function(n){return n.textContent;}).join("\\n");};
  b.addEventListener("click",function(){
    var t=text();
    var done=function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy source"},1500);};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){});}
  });
})();</script>`;
  return pageShell(`${o.title} — source`, body, extra);
}

export function diffPage(o: {
  slug: string;
  title: string;
  a: number;
  b: number;
  ops: Array<{ t: "eq" | "add" | "del"; line: string }>;
  apiBase: string;
  shareUrl: string;
}): string {
  const fmt = (op: { t: string; line: string }, a: number | null, b: number | null) => {
    const cls = op.t === "add" ? "add" : op.t === "del" ? "del" : "eq";
    const sign = op.t === "add" ? "+" : op.t === "del" ? "−" : " ";
    return `<div class="ln ${cls}"><span class="no">${a ?? ""}</span><span class="no">${b ?? ""}</span><span class="sg">${sign}</span><span class="tx">${escHtml(op.line) || " "}</span></div>`;
  };
  // Number both sides, then fold long unchanged runs (>8 lines) behind an
  // expander that keeps 3 lines of context on each edge.
  let aN = 0;
  let bN = 0;
  const rendered: string[] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (run.length > 8) {
      rendered.push(...run.slice(0, 3));
      const hidden = run.slice(3, run.length - 3);
      rendered.push(
        `<button class="unfold" type="button">⋯ ${hidden.length} unchanged lines</button><div class="fold" hidden>${hidden.join("")}</div>`,
      );
      rendered.push(...run.slice(run.length - 3));
    } else {
      rendered.push(...run);
    }
    run = [];
  };
  for (const op of o.ops) {
    if (op.t === "eq") {
      aN++;
      bN++;
      run.push(fmt(op, aN, bN));
    } else {
      flushRun();
      if (op.t === "add") {
        bN++;
        rendered.push(fmt(op, null, bN));
      } else {
        aN++;
        rendered.push(fmt(op, aN, null));
      }
    }
  }
  flushRun();
  const added = o.ops.filter((x) => x.t === "add").length;
  const removed = o.ops.filter((x) => x.t === "del").length;
  const extra = `
  .tools { display: flex; align-items: baseline; gap: 10px; padding: 10px 14px; border-bottom: 1px solid rgba(0,0,0,.07);
    position: sticky; top: 0; background: var(--card); z-index: 2; border-radius: 12px 12px 0 0; }
  .ln { display: flex; font-size: 12px; line-height: 1.5; color: var(--ink); }
  .ln .no { flex: 0 0 38px; text-align: right; padding-right: 8px; opacity: .35; user-select: none; -webkit-user-select: none; }
  .ln .sg { flex: 0 0 18px; text-align: center; opacity: .5; user-select: none; -webkit-user-select: none; }
  .ln .tx { white-space: pre-wrap; word-break: break-word; flex: 1; min-width: 0; padding-right: 10px; }
  .ln.add { background: rgba(61,138,61,.12); }
  .ln.del { background: rgba(179,55,42,.10); opacity: .85; }
  .ln.eq { opacity: .8; }
  .unfold { all: unset; cursor: pointer; display: block; width: 100%; box-sizing: border-box; text-align: center;
    padding: 6px 10px; color: var(--blue); background: rgba(26,99,196,.05); font-size: 11px;
    -webkit-tap-highlight-color: transparent; }
  .unfold:hover { background: rgba(26,99,196,.1); }
  @media (max-width: 640px) { .ln .no { flex-basis: 28px; } .ln { font-size: 11px; } }`;
  const body = `
${topRow(`${o.title} — v${o.a} → v${o.b}`, o.shareUrl)}
<div class="card" style="padding:0">
  <div class="tools">
    <b style="color:var(--ink)">v${o.a} → v${o.b}</b>
    <span style="color:#3d8a3d">+${added}</span>
    <span style="color:#b3372a">−${removed}</span>
  </div>
  <div style="padding:8px 0;overflow-x:auto">${rendered.join("")}</div>
</div>
<script>(function(){
  document.addEventListener("click",function(e){
    var b=e.target&&e.target.closest?e.target.closest(".unfold"):null;
    if(!b)return;
    var f=b.nextElementSibling;
    if(f&&f.classList.contains("fold")){f.hidden=false;b.remove();}
  });
})();</script>`;
  return pageShell(`${o.title} — diff`, body, extra);
}

export function editorPage(o: {
  slug: string;
  title: string;
  kind: string;
  source: string;
  version: number;
  apiBase: string;
  shareUrl: string;
}): string {
  const isMd = o.kind === "markdown";
  const previewEl = isMd
    ? `<style>${MD_THEME_CSS}</style><div id="pv" class="md" aria-label="Preview"></div>`
    : `<iframe id="pv" sandbox="allow-scripts" title="Preview"></iframe>`;
  const extra = `
  .edcard { padding: 0; display: flex; flex-direction: column; height: calc(100vh - 130px); min-height: 420px; overflow: hidden; }
  .edbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid rgba(0,0,0,.07); flex-wrap: wrap; }
  .edbar .st { opacity: .6; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dirty { color: var(--coral); font-weight: 600; white-space: nowrap; }
  .split { display: flex; flex: 1; min-height: 0; }
  #ed { flex: 1; min-width: 0; border: 0; outline: none; resize: none; padding: 14px;
    font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, monospace; color: var(--ink); background: var(--card); }
  #pv { flex: 1; min-width: 0; border: 0; border-left: 1px solid rgba(0,0,0,.08); background: var(--bg); }
  div#pv.md { overflow-y: auto; padding: 24px 28px; background: var(--md-bg); font-size: 15px; }
  #nm { width: 140px; padding: 6px 9px; font-size: 12px; }
  #tgl { display: none; }
  @media (max-width: 900px) {
    #tgl { display: inline-block; }
    .split.showpv #ed { display: none; }
    .split:not(.showpv) #pv { display: none; }
    #pv { border-left: 0; }
    .edcard { height: calc(100vh - 150px); }
    #nm { width: 110px; }
  }`;
  const body = `
${topRow(`${o.title} — edit`, o.shareUrl, "← Back")}
<div class="card edcard">
  <div class="edbar">
    <span class="st">v${o.version} (${escHtml(o.kind)}) · publish mints a new version · Cmd/Ctrl+S</span>
    <span id="dirty" class="dirty" hidden>● unsaved</span>
    <span style="flex:1"></span>
    <button class="ghost" id="tgl" type="button">Preview</button>
    <input type="text" id="nm" placeholder="Your name" autocomplete="name">
    <button class="primary" id="save" type="button" style="padding:6px 14px;font-size:12px">Publish</button>
  </div>
  <div class="err" id="err" style="padding:0 14px" role="alert"></div>
  <div class="split" id="split">
    <textarea id="ed" spellcheck="false" autocapitalize="off">${escHtml(o.source)}</textarea>
    ${previewEl}
  </div>
</div>
<script>(function(){
  var IS_MD=${JSON.stringify(isMd)};
  var frag=new URLSearchParams(location.hash.replace(/^#/,""));
  var key=frag.get("o")||frag.get("ed")||"";
  var ed=document.getElementById("ed"),err=document.getElementById("err");
  var save=document.getElementById("save"),nm=document.getElementById("nm");
  var pv=document.getElementById("pv"),tgl=document.getElementById("tgl"),split=document.getElementById("split");
  var dirtyEl=document.getElementById("dirty");
  var initial=ed.value;
  var mem={};
  var sGet=function(k){try{var v=localStorage.getItem(k);if(v!=null)return v;}catch(e){}return mem[k]||"";};
  var sSet=function(k,v){mem[k]=v;try{localStorage.setItem(k,v);}catch(e){}};
  nm.value=sGet("__cc_name")||(frag.get("em")?frag.get("em").split("@")[0]:"");
  nm.addEventListener("input",function(){sSet("__cc_name",nm.value);});
  var dirty=function(){return ed.value!==initial;};
  var syncDirty=function(){dirtyEl.hidden=!dirty();};
  window.addEventListener("beforeunload",function(e){if(dirty()){e.preventDefault();e.returnValue="";}});
  // Minimal markdown approximation for LIVE PREVIEW ONLY — the server render
  // (marked) is authoritative and happens on publish.
  var mdr=function(src){
    var esc=function(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");};
    var inline=function(s){
      s=esc(s);
      s=s.replace(/\`([^\`]+)\`/g,"<code>$1</code>");
      s=s.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>");
      s=s.replace(/(^|[^*])\\*([^*]+)\\*/g,"$1<em>$2</em>");
      s=s.replace(/!?\\[([^\\]]*)\\]\\(([^)]+)\\)/g,'<a href="$2">$1</a>');
      return s;
    };
    var lines=src.split(/\\r?\\n/);
    var out=[],i,inCode=false,codeBuf=[],listMode="";
    var closeList=function(){if(listMode){out.push(listMode==="ul"?"</ul>":"</ol>");listMode="";}};
    for(i=0;i<lines.length;i++){
      var L=lines[i];
      if(/^\\s*\`\`\`/.test(L)){
        if(inCode){out.push("<pre><code>"+esc(codeBuf.join("\\n"))+"</code></pre>");codeBuf=[];inCode=false;}
        else{closeList();inCode=true;}
        continue;
      }
      if(inCode){codeBuf.push(L);continue;}
      var h=L.match(/^(#{1,6})\\s+(.*)$/);
      if(h){closeList();out.push("<h"+h[1].length+">"+inline(h[2])+"</h"+h[1].length+">");continue;}
      if(/^\\s*(---+|\\*\\*\\*+|___+)\\s*$/.test(L)){closeList();out.push("<hr>");continue;}
      var q=L.match(/^>\\s?(.*)$/);
      if(q){closeList();out.push("<blockquote>"+inline(q[1])+"</blockquote>");continue;}
      var ul=L.match(/^\\s*[-*+]\\s+(.*)$/);
      if(ul){if(listMode!=="ul"){closeList();out.push("<ul>");listMode="ul";}out.push("<li>"+inline(ul[1])+"</li>");continue;}
      var ol=L.match(/^\\s*\\d+[.)]\\s+(.*)$/);
      if(ol){if(listMode!=="ol"){closeList();out.push("<ol>");listMode="ol";}out.push("<li>"+inline(ol[1])+"</li>");continue;}
      if(!L.trim()){closeList();continue;}
      closeList();out.push("<p>"+inline(L)+"</p>");
    }
    if(inCode)out.push("<pre><code>"+esc(codeBuf.join("\\n"))+"</code></pre>");
    closeList();
    return out.join("\\n");
  };
  var render=function(){
    if(IS_MD){pv.innerHTML=mdr(ed.value);}
    else{pv.srcdoc=ed.value;}
  };
  var rt=null;
  ed.addEventListener("input",function(){
    syncDirty();
    if(rt)clearTimeout(rt);
    rt=setTimeout(render,IS_MD?150:400);
  });
  render();
  if(tgl)tgl.addEventListener("click",function(){
    var showing=split.classList.toggle("showpv");
    tgl.textContent=showing?"Edit":"Preview";
    if(showing)render();
  });
  var doSave=function(){
    err.textContent="";
    if(!key){err.textContent="No edit key in the URL — ask the author for an edit link";return;}
    if(save.disabled)return;
    save.textContent="Publishing…";save.disabled=true;
    fetch(${JSON.stringify(o.apiBase)}+"/cli/artifacts/edit",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug:${JSON.stringify(o.slug)},key:key,content:ed.value,editor_name:nm.value||undefined})})
      .then(function(r){return r.json();})
      .then(function(j){
        save.disabled=false;save.textContent="Publish";
        if(j&&j.version){
          initial=ed.value;syncDirty();
          var u=new URL(location.href);u.searchParams.delete("edit");u.searchParams.set("r",j.version);
          location.href=u.pathname+u.search+location.hash;
        }
        else err.textContent=(j&&j.error)||"Publish failed";
      },function(){save.disabled=false;save.textContent="Publish";err.textContent="Network error";});
  };
  save.addEventListener("click",doSave);
  document.addEventListener("keydown",function(e){
    if((e.metaKey||e.ctrlKey)&&(e.key==="s"||e.key==="S")){e.preventDefault();doSave();}
  });
})();</script>`;
  return pageShell(`${o.title} — edit`, body, extra);
}
