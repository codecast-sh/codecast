import { describe, expect, test } from "bun:test";
import type { VimConfigReport, VimDirectiveReport } from "../../../../lib/code/vim/types";
import { countRows, filterRows, lineCount, reportRows, toggleStatus } from "../vimReportRows";

// Synthetic config shapes (the repo is public: never a real vimrc).
const d = (line: number, text: string, status: VimDirectiveReport["status"], detail: string): VimDirectiveReport => ({ line, text, status, detail });
const report: Pick<VimConfigReport, "sources"> = {
  sources: [
    {
      path: "/home/u/.vimrc",
      directives: [
        d(1, "let mapleader = ','", "applied", "leader ,"),
        d(3, "set relativenumber", "translated", "relative line numbers"),
        d(4, "nnoremap <leader>f :Files<CR>", "translated", "quick open"),
        d(9, "Plug 'junegunn/fzf'", "skipped", "plugin manager"),
      ],
      counts: { applied: 1, translated: 2, skipped: 1, total: 4 },
    },
    {
      path: "/home/u/.vim/maps.vim",
      sourcedFrom: "/home/u/.vimrc",
      directives: [d(1, "nnoremap H ^", "applied", "map"), d(2, "autocmd BufWritePre * call Strip()", "skipped", "calls a function")],
      counts: { applied: 1, translated: 0, skipped: 1, total: 2 },
    },
  ],
};
const rows = reportRows(report);
const none = new Set<never>();

describe("vim report rows", () => {
  test("every directive of every source, in load order, with unique ids", () => {
    expect(rows.map((r) => r.text)).toEqual(report.sources.flatMap((s) => s.directives.map((x) => x.text)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows[4].sourceIndex).toBe(1);
  });

  test("status chips filter, and an empty set shows all", () => {
    expect(filterRows(rows, { statuses: none, query: "", source: null }).length).toBe(6);
    expect(filterRows(rows, { statuses: new Set(["skipped"]), query: "", source: null }).map((r) => r.line)).toEqual([9, 2]);
    expect(filterRows(rows, { statuses: new Set(["applied", "translated"]), query: "", source: null }).length).toBe(4);
  });

  test("the query matches the directive or what it became, any case", () => {
    expect(filterRows(rows, { statuses: none, query: "QUICK", source: null }).map((r) => r.line)).toEqual([4]);
    expect(filterRows(rows, { statuses: none, query: "nnoremap", source: null }).length).toBe(2);
    expect(filterRows(rows, { statuses: none, query: "  ", source: null }).length).toBe(6);
  });

  test("a source narrows to its own file", () => {
    expect(filterRows(rows, { statuses: none, query: "", source: 1 }).map((r) => r.text)).toEqual(["nnoremap H ^", "autocmd BufWritePre * call Strip()"]);
  });

  test("counts follow the query and source, never the status filter", () => {
    expect(countRows(rows, { query: "", source: null })).toEqual({ applied: 2, translated: 2, skipped: 2, total: 6 });
    expect(countRows(rows, { query: "nnoremap", source: null })).toEqual({ applied: 1, translated: 1, skipped: 0, total: 2 });
    expect(countRows(rows, { query: "", source: 0 })).toEqual(report.sources[0].counts);
  });

  test("toggling a chip adds and removes it", () => {
    const a = toggleStatus(none, "skipped");
    expect([...a]).toEqual(["skipped"]);
    expect([...toggleStatus(a, "applied")].sort()).toEqual(["applied", "skipped"]);
    expect(toggleStatus(a, "skipped").size).toBe(0);
  });

  test("line counts", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\n\nb\n")).toBe(3);
  });
});
