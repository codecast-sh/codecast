import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import "../chat/ChatMessage";
import { ASSISTANT_MD_REMARK, MESSAGE_MD_COMPONENTS } from "../messageMarkdown";
import { EntityFixtureContext } from "../../lib/entityDisplay";
import { ConvexProvider } from "convex/react";
import { MemoryRouter } from "react-router";
import { heroConvexStub } from "../../app/(marketing)/heroFly/convexStub";

const d = (n: number, status: string, question: string) => ({
  type: "decision" as const,
  entity: { _id: `jd7${n}abcdefghijkmnpqrstvwxyz2345`, short_id: `sd-${n}`, question, status, options: [{ label: "Yes" }, { label: "No" }], answer_index: status === "answered" ? 0 : undefined, created_at: Date.now() - 3600e3, blocking: true },
});
const fixtures = {
  "sd-901": d(901, "pending", "Unlink the two calling projects from the org"),
  "sd-902": d(902, "answered", "Exponential or fixed backoff for retries"),
  "sd-903": d(903, "withdrawn", "Rename the Chief of Staff role"),
};
const md = "Step 3 of `.org-routing-fixes-brief.md` is built. Still waiting on sd-901 before the unlink. Retries follow sd-902 as answered, and sd-903 no longer applies.";
const render = () =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ConvexProvider client={heroConvexStub}>
        <EntityFixtureContext.Provider value={fixtures as any}>
          <ReactMarkdown remarkPlugins={ASSISTANT_MD_REMARK as any} components={MESSAGE_MD_COMPONENTS as any}>{md}</ReactMarkdown>
        </EntityFixtureContext.Provider>
      </ConvexProvider>
    </MemoryRouter>,
  );
test("shots", () => {
  const out: Record<string, string> = {};
  for (const v of ["A", "B", "C"]) { (globalThis as any).__decisionPillVariant = v; out[v] = render(); }
  writeFileSync("/tmp/decpill/variants.json", JSON.stringify(out));
});
