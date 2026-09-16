import { describe, expect, it } from "bun:test";
import { remarkChatMentions } from "../remarkChatMentions";

// A one-paragraph mdast tree, the shape remark-parse hands the plugin; built by
// hand so the test needs no parser.
function render(text: string, opts: Parameters<typeof remarkChatMentions>[0]) {
  const tree: any = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] };
  remarkChatMentions(opts)(tree);
  return JSON.stringify(tree.children[0].children);
}

describe("remarkChatMentions roles and sessions", () => {
  const roles = new Map([["infra-lead", { kind: "role" as const, role_id: "r1", short_id: "or-7", handle: "infra-lead" }]]);
  const sessions = new Set(["jx7c6zk"]);
  it("turns a role handle into a link to the role page", () => {
    const out = render("ping @infra-lead now", { known: new Set(), roles, sessions });
    expect(out).toContain('"url":"/org/or-7"');
    expect(out).toContain("mention-role");
    expect(out).toContain('"@infra-lead"');
  });
  it("turns a session short id into the entity pill payload, @ folded in", () => {
    const out = render("cc @jx7c6zk", { known: new Set(), roles, sessions });
    expect(out).toContain('"url":"entity://jx7c6zk"');
    expect(out).not.toContain('"value":"@"');
  });
  it("leaves an unresolved handle as text", () => {
    const out = render("cc @jx7zzzzz and @nobody", { known: new Set(), roles, sessions });
    expect(out).toBe(JSON.stringify([{ type: "text", value: "cc @jx7zzzzz and @nobody" }]));
  });
});

describe("a session mention stays inline", () => {
  it("is marked as a mention so remarkEntityCards does not card it", () => {
    const tree: any = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "cc @jx7c6zk" }] }] };
    remarkChatMentions({ sessions: new Set(["jx7c6zk"]) })(tree);
    const link = tree.children[0].children.find((c: any) => c.type === "link");
    expect(link.data.hProperties["data-mention"]).toBe("jx7c6zk");
  });
});

describe("a Slack-only person", () => {
  const slack = new Map([["erin", { kind: "slack" as const, user: "UERIN", handle: "erin", name: "Erin" }]]);
  it("renders as a person chip wearing the Slack mark, named from the snapshot", () => {
    const tree: any = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "cc @erin" }] }] };
    remarkChatMentions({ known: new Set(), slack })(tree);
    const chip = tree.children[0].children.find((c: any) => c.type === "emphasis");
    expect(chip.data.hProperties.className).toContain("ch-mention-slack");
    expect(chip.data.hChildren[0].tagName).toBe("svg");
    expect(chip.data.hChildren[1]).toEqual({ type: "text", value: "@Erin" });
  });
});
