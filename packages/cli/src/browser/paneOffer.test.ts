import { describe, expect, test } from "bun:test";
import { planPaneOffer, paneOfferLines } from "./paneOffer.js";

/** Output carries ANSI when the terminal takes colour; the words are the test. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("planPaneOffer", () => {
  test("a bare host and port is a dev server, so http", () => {
    const plan = planPaneOffer("localhost:3000", {}, "sess-1");
    expect(plan).toMatchObject({ ok: true, url: "http://localhost:3000/", session: "sess-1" });
  });

  test("a public name keeps https", () => {
    const plan = planPaneOffer("github.com/codecast-sh/codecast", {}, "sess-1");
    expect(plan).toMatchObject({ ok: true, url: "https://github.com/codecast-sh/codecast" });
  });

  test("an explicit scheme is left alone", () => {
    const plan = planPaneOffer("http://127.0.0.1:8765/report.html", {}, "sess-1");
    expect(plan).toMatchObject({ ok: true, url: "http://127.0.0.1:8765/report.html" });
  });

  test("a scheme an iframe must never load is refused", () => {
    for (const bad of ["javascript://alert(1)", "file:///etc/passwd", "not a url", ""]) {
      const plan = planPaneOffer(bad, {}, "sess-1");
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.message).toContain("not a web address");
    }
  });

  test("no session and no --for: nothing to offer it in", () => {
    const plan = planPaneOffer("localhost:3000", {}, null);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.hint).toContain("--for");
  });

  test("--for names the session when the shell has none", () => {
    const plan = planPaneOffer("localhost:3000", { for: "jx7c6zk" }, null);
    expect(plan).toMatchObject({ ok: true, session: "jx7c6zk" });
  });

  test("an empty --title is no title at all", () => {
    expect(planPaneOffer("localhost:3000", { title: "   " }, "s")).toMatchObject({ title: undefined });
    expect(planPaneOffer("localhost:3000", { title: " Docs " }, "s")).toMatchObject({ title: "Docs" });
  });
});

describe("paneOfferLines", () => {
  test("names the address and the session it landed in", () => {
    const [line, note] = paneOfferLines("http://localhost:3000/", { short_id: "jx7c6zk" }).map(plain);
    expect(line).toContain("Offered http://localhost:3000/ as a pane in jx7c6zk");
    expect(note).toContain("opens it beside");
  });

  test("a backend that named no session still reads honestly", () => {
    expect(plain(paneOfferLines("http://localhost:3000/", {})[0])).toContain("as a pane in the viewer");
  });
});
