// A small Vim script grammar (legacy-modes has none): enough to read a vimrc
// or a plugin file at a glance. Line comments, strings, the command that
// starts each line, key notation (<Leader>, <C-w>), options and scoped
// variables (&tabstop, g:name, $HOME), numbers, and `\` continuation lines.

import type { StreamParser, StringStream } from "@codemirror/language";

interface VimState {
  /** Nothing but whitespace read on this line yet. */
  lineStart: boolean;
}

export const vimscript: StreamParser<VimState> = {
  name: "vim",
  startState: () => ({ lineStart: true }),
  token(stream: StringStream, state: VimState) {
    if (stream.sol()) state.lineStart = true;
    if (stream.eatSpace()) return null;
    const first = state.lineStart;
    state.lineStart = false;
    const ch = stream.peek();
    // `"` opens a comment where a command could start, a string elsewhere.
    if (ch === '"' && first) {
      stream.skipToEnd();
      return "comment";
    }
    if (ch === "\\" && first) {
      stream.next();
      state.lineStart = true;
      return "operator";
    }
    if (ch === '"' || ch === "'") {
      stream.next();
      let escaped = false;
      for (let c = stream.next(); c != null; c = stream.next()) {
        if (c === ch && !escaped) break;
        escaped = ch === '"' && c === "\\" && !escaped;
      }
      return "string";
    }
    if (stream.match(/^<[A-Za-z][\w-]*>/)) return "atom";
    if (stream.match(/^(?:&(?:l:|g:)?\w+|[gbwtslav]:\w[\w#.]*|\$\w+)/)) return "variableName";
    if (stream.match(/^(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)/)) return "number";
    if (stream.match(/^[A-Za-z_][\w#]*!?/)) return first ? "keyword" : null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '"' } },
};
