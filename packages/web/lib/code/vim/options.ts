// The `:set` options a vimrc can name, and what each becomes here.
//
// editor:   honored by the CodeMirror side (tab size, wrap, gutter flags...).
// engine:   handed to codemirror-vim or to our key layer.
// fixed:    the engine always behaves one way; matching is "applied",
//           asking for the other behavior is "skipped" with the reason.
// n/a:      known options that have no meaning in a browser editor.

import type { VimOptionValues } from "./types";

type Kind = "bool" | "number" | "string";
type Value = boolean | number | string;

interface OptionSpec {
  name: string;
  kind: Kind;
  role: "editor" | "engine" | "fixed" | "na";
  default: Value;
  /** fixed: the value the engine always has, and what that means. */
  fixed?: Value;
  note?: string;
}

const specs = new Map<string, OptionSpec>();

function def(names: string, kind: Kind, role: OptionSpec["role"], dflt: Value, extra: Partial<OptionSpec> = {}) {
  const [name, ...aliases] = names.split(" ");
  const spec: OptionSpec = { name, kind, role, default: dflt, ...extra };
  for (const n of [name, ...aliases]) specs.set(n, spec);
}

// Editor options.
def("tabstop ts", "number", "editor", 8);
def("shiftwidth sw", "number", "editor", 8);
def("softtabstop sts", "number", "editor", 0);
def("expandtab et", "bool", "editor", false);
def("number nu", "bool", "editor", false);
def("relativenumber rnu", "bool", "editor", false);
def("wrap", "bool", "editor", true);
def("linebreak lbr", "bool", "editor", false);
def("scrolloff so", "number", "editor", 0);
def("sidescrolloff siso", "number", "editor", 0);
def("colorcolumn cc", "string", "editor", "");
def("cursorline cul", "bool", "editor", false);
def("list", "bool", "editor", false);
def("listchars lcs", "string", "editor", "eol:$");
def("iskeyword isk", "string", "editor", "@,48-57,_,192-255");
def("textwidth tw", "number", "editor", 0);

// Engine options.
def("langmap lmap", "string", "engine", "");
def("timeoutlen tm", "number", "engine", 1000);
def("timeout to", "bool", "engine", true);
def("clipboard cb", "string", "engine", "");
def("gdefault gd", "bool", "engine", false);

// Behaviors the engine has built in.
def("ignorecase ic", "bool", "fixed", false, { fixed: true, note: "searches ignore case" });
def("smartcase scs", "bool", "fixed", false, { fixed: true, note: "a capital makes a search case-sensitive" });
def("hlsearch hls", "bool", "fixed", false, { fixed: true, note: "matches stay highlighted until :noh" });
def("incsearch is", "bool", "fixed", false, { fixed: true, note: "search moves as you type" });
def("wrapscan ws", "bool", "fixed", true, { fixed: true, note: "search wraps around the file" });
def("magic", "bool", "fixed", true, { fixed: true, note: "patterns use magic" });
def("hidden hid", "bool", "fixed", false, { fixed: true, note: "buffers stay open in tabs" });
def("autoread ar", "bool", "fixed", false, { fixed: true, note: "a clean buffer follows the disk" });
def("compatible cp", "bool", "fixed", false, { fixed: false, note: "this is vim, not vi" });
def("autoindent ai", "bool", "fixed", false, { fixed: true, note: "new lines indent by language" });
def("smartindent si", "bool", "fixed", false, { fixed: true, note: "new lines indent by language" });
def("cindent cin", "bool", "fixed", false, { fixed: true, note: "new lines indent by language" });
def("mouse", "string", "fixed", "", { note: "the mouse always works" });
def("backspace bs", "string", "fixed", "", { note: "Backspace deletes across indent and lines" });
def("joinspaces js", "bool", "fixed", false, { fixed: false, note: "J joins with one space" });
def("showmatch sm", "bool", "fixed", false, { fixed: true, note: "the editor marks matching brackets" });

const NA: Array<[string, string]> = [
  [
    "files are read and saved by codecast",
    "backup bk backupdir bdir backupcopy bkc backupext bex writebackup wb swapfile swf directory dir undofile udf undodir udir undolevels ul undoreload ur viminfo vi viminfofile vif shada sd shadafile history hi sessionoptions ssop viewoptions vop viewdir vdir autowrite aw autowriteall awa encoding enc fileencoding fenc fileencodings fencs fileformat ff fileformats ffs fixendofline fixeol endofline eol bomb modeline ml modelines mls modelineexpr exrc ex secure confirm cf autochdir acd tags tag path pa suffixesadd sua binary bin cdpath cd",
  ],
  [
    "not applicable in the browser",
    "ttyfast tf lazyredraw lz ttymouse ttym term t_Co t_vb t_ut t_8f t_8b termguicolors tgc ttimeout ttimeoutlen ttm ttyscroll tsl termencoding tenc esckeys ek redrawtime rdt regexpengine re maxmempattern mmp synmaxcol smc shell sh shellcmdflag shcf shellpipe sp shellredir srr shellslash ssl grepprg gp grepformat gfm makeprg mp errorformat efm keywordprg kp belloff bo visualbell vb errorbells eb updatetime ut inccommand icm guicursor gcr title titlestring titleold icon iconstring ttybuiltin tbi packpath pp runtimepath rtp loadplugins lpl verbose vbs verbosefile vfile pyxversion pyx pythonthreedll pythonthreehome perldll rubydll luadll emoji emo ambiwidth ambw spell spelllang spl spellfile spf spellcapcheck spc spelloptions spo spellsuggest sps paste pastetoggle pt",
  ],
  [
    "the app's theme and font style the editor",
    "guifont gfn guifontwide gfw guioptions go guitablabel gtl guitabtooltip gtt guiheadroom ghr winaltkeys wak lines columns co linespace lsp transparency transp macmeta mmta fullscreen fu antialias anti background bg macligatures macthinstrokes blurradius",
  ],
  [
    "codecast draws its own UI",
    "laststatus ls statusline stl showmode smd showcmd sc showcmdloc ruler ru rulerformat ruf cmdheight ch wildmenu wmnu wildmode wim wildignore wig wildignorecase wic wildoptions wop wildchar wc wildcharm wcm showtabline stal tabline tal shortmess shm report numberwidth nuw signcolumn scl foldcolumn fdc fillchars fcs pumheight ph pumwidth pw pumblend pb winblend winbl completeopt cot splitbelow sb splitright spr splitkeep spk equalalways ea winheight wh winwidth wiw winminheight wmh winminwidth wmw helpheight hh previewheight pvh cmdwinheight cwh display dy more termwinsize",
  ],
  [
    "not supported here",
    "showbreak sbr breakindent bri breakindentopt briopt conceallevel cole concealcursor cocu cursorcolumn cuc cursorlineopt culopt matchtime mat matchpairs mps foldmethod fdm foldlevel fdl foldlevelstart fdls foldenable fen foldnestmax fdn foldexpr fde foldtext fdt foldminlines fml foldopen fdo foldclose fcl foldmarker fmr formatoptions fo formatexpr fex formatprg fp comments com commentstring cms cpoptions cpo nrformats nf startofline sol virtualedit ve whichwrap ww selection sel selectmode slm keymodel km scrolljump sj sidescroll ss scroll scr smarttab sta shiftround sr infercase inf dictionary dict thesaurus tsr omnifunc ofu completefunc cfu tagfunc tfu filetype ft syntax syn switchbuf swb tabpagemax tpm jumpoptions jop nostartofline indentexpr inde indentkeys indk cinoptions cino cinkeys cink cinwords cinw lisp textauto ta textmode tx operatorfunc opfunc iminsert imi imsearch ims imdisable imd isfname isf isident isi isprint isp include inc define def wrapmargin wm  modified mod readonly ro modifiable ma write diffopt dip scrollbind scb cursorbind crb winfixheight wfh winfixwidth wfw previewwindow pvw buftype bt bufhidden bh buflisted bl",
  ],
];
const naReasons = new Map<string, string>();
for (const [reason, names] of NA) for (const n of names.split(" ")) naReasons.set(n, reason);

export function isKnownOption(name: string): boolean {
  return specs.has(name) || naReasons.has(name) || name.startsWith("t_");
}

export type OptionState = Map<string, Value>;

export function defaultOptionState(): OptionState {
  const state: OptionState = new Map();
  for (const spec of specs.values()) state.set(spec.name, spec.default);
  return state;
}

export interface SetResult {
  text: string;
  status: "applied" | "translated" | "skipped";
  detail: string;
  /** Set when the option took a value worth recording. */
  name?: string;
  value?: Value;
  role?: OptionSpec["role"];
}

/** Split `:set` arguments on unescaped whitespace, keeping `\ ` in values. */
export function splitSetArgs(text: string): string[] {
  const args: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      cur += c + text[++i];
    } else if (/\s/.test(c)) {
      if (cur) args.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) args.push(cur);
  return args;
}

export function unescapeValue(v: string): string {
  return v.replace(/\\(.)/g, "$1");
}

export function listOp(current: string, op: string, value: string): string {
  const items = current ? current.split(",") : [];
  if (op === "+=") return items.includes(value) ? current : [...items, value].filter(Boolean).join(",");
  if (op === "^=") return [value, ...items.filter((i) => i !== value)].filter(Boolean).join(",");
  if (op === "-=") return items.filter((i) => i !== value).join(",");
  return value;
}

/** Apply one `:set` argument to `state`. */
export function applySetArg(arg: string, state: OptionState, cmd = "set"): SetResult {
  const text = `${cmd} ${arg}`;
  const m = /^(no|inv)?([a-zA-Z_][\w]*)(!|&(?:vim|vi)?|\?)?(?:([-+^]?=|:)([\s\S]*))?$/.exec(arg);
  if (!m) return { text, status: "skipped", detail: "can't read this option" };
  const [, prefix, rawName, suffix, op, rawValue] = m;
  let name = rawName;
  let negate = prefix === "no";
  let invert = prefix === "inv" || suffix === "!";
  let spec = specs.get(name);
  // `noremap`-style names that begin with "no" or "inv" but are options.
  if (!spec && prefix && (specs.has(prefix + rawName) || naReasons.has(prefix + rawName))) {
    name = prefix + rawName;
    spec = specs.get(name);
    negate = false;
    invert = suffix === "!";
  }
  if (suffix === "?") return { text, status: "skipped", detail: "only prints the value" };
  if (!spec) {
    const reason = naReasons.get(name) ?? (name.startsWith("t_") ? "not applicable in the browser" : undefined);
    return { text, status: "skipped", detail: reason ?? "unknown option" };
  }

  let value: Value;
  const current = state.get(spec.name) ?? spec.default;
  if (suffix?.startsWith("&")) {
    value = spec.default;
  } else if (spec.kind === "bool") {
    if (op) return { text, status: "skipped", detail: `${spec.name} takes no value` };
    value = invert ? !current : !negate;
  } else {
    if (negate || invert || !op) return { text, status: "skipped", detail: `${spec.name} needs a value` };
    const v = unescapeValue(rawValue ?? "");
    if (spec.kind === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { text, status: "skipped", detail: `${spec.name} needs a number` };
      const cur = Number(current);
      value = op === "+=" ? cur + n : op === "-=" ? cur - n : op === "^=" ? cur * n : n;
    } else {
      value = op === "=" || op === ":" ? v : listOp(String(current), op, v);
    }
  }
  state.set(spec.name, value);
  return { text, ...describe(spec, value), name: spec.name, value, role: spec.role };
}

function describe(spec: OptionSpec, value: Value): Pick<SetResult, "status" | "detail"> {
  if (spec.role === "fixed") {
    if (spec.fixed === undefined || value === spec.fixed) return { status: "applied", detail: spec.note ?? "" };
    return { status: "skipped", detail: spec.fixed ? `the vim engine always: ${spec.note}` : spec.note ?? "" };
  }
  const shown = typeof value === "boolean" ? (value ? "on" : "off") : value === "" ? "empty" : String(value);
  switch (spec.name) {
    case "softtabstop":
      return { status: "translated", detail: "Backspace removes one indent level" };
    case "linebreak":
      return value ? { status: "translated", detail: "wrapped lines break at words" } : { status: "skipped", detail: "wrapping always breaks at words" };
    case "iskeyword":
      return { status: "translated", detail: "word characters for word selection; w/b keep vim's defaults" };
    case "listchars":
      return { status: "translated", detail: "tabs and trailing spaces are marked when list is on" };
    case "clipboard":
      return /unnamed/.test(String(value))
        ? { status: "translated", detail: "yanks and deletes go to the system clipboard" }
        : { status: "applied", detail: "registers stay inside the editor" };
    case "gdefault":
      return { status: "applied", detail: value ? ":s replaces every match on a line; /g the first" : ":s replaces the first match on a line; /g every one" };
    case "timeout":
    case "timeoutlen":
      return { status: "applied", detail: `ambiguous maps wait ${spec.name === "timeout" && !value ? "until the next key" : shown + (spec.name === "timeoutlen" ? " ms" : "")}` };
    case "number":
    case "relativenumber":
      return { status: "applied", detail: `${spec.name === "number" ? "line numbers" : "relative numbers"} ${shown}` };
    default:
      return { status: "applied", detail: `${spec.name} ${shown}` };
  }
}

/** The editor options a list of set results produced. */
export function editorValues(results: SetResult[], into: VimOptionValues): VimOptionValues {
  for (const r of results) {
    if (r.role === "editor" && r.name && r.value !== undefined) {
      (into as Record<string, Value>)[r.name] = r.value;
    }
  }
  return into;
}
