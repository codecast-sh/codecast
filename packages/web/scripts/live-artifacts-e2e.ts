// End-to-end check of the live artifact foundation: a person in the browser
// (this session's cast browser tab on the dev server) and an agent session
// (the `cast board` CLI, signed as this session) edit the same board at once.
//
//   bun packages/web/scripts/live-artifacts-e2e.ts [--base http://localhost:3201] [--shots dir]
//
// Steps, each asserted:
//   1. the agent creates a board; the person opens its page
//   2. the person adds a sticky through the UI (double-click); the agent's read sees it
//   3. the agent writes stickies; they appear on the page with the agent's cursor and name tag
//   4. both edit the same sticky at once (person drags, agent writes text); both converge
//   5. the agent writes a draft; the person sees it and Saves; a second draft is Discarded
//   6. a checkpoint, an edit, then a restore from the page's History; the agent reads the restored state
// Screenshots of the key moments land in --shots (default /tmp/live-artifacts/shots).
import { spawnSync } from "bun";
import { mkdirSync } from "fs";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = opt("--base", "http://localhost:3201");
const SHOTS = opt("--shots", "/tmp/live-artifacts/shots");
mkdirSync(SHOTS, { recursive: true });

function sh(cmd: string[], input?: string): string {
  const r = spawnSync(cmd, { stdin: input !== undefined ? new TextEncoder().encode(input) : undefined, env: process.env });
  const out = new TextDecoder().decode(r.stdout);
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode}): ${out}\n${new TextDecoder().decode(r.stderr)}`);
  return out.trim();
}
const cast = (...a: string[]) => sh(["cast", ...a]);
const castIn = (input: string, ...a: string[]) => sh(["cast", ...a], input);
const evalJs = (js: string) => {
  const out = cast("browser", "eval", js);
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
};
const shot = (name: string) => {
  const path = `${SHOTS}/${name}.png`;
  cast("browser", "shot", "--path", path);
  return path;
};

async function until<T>(what: string, fn: () => T | null | undefined | false, timeoutMs = 120_000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = fn();
      if (v) return v as T;
      last = v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(400);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

const readJson = (id: string, flag?: string) => JSON.parse(cast("board", "read", id, "--json", ...(flag ? [flag] : [])));
const elementsOnPage = () => evalJs(`JSON.stringify([...document.querySelectorAll('[data-live-el]')].map(e => ({ key: e.dataset.liveEl, text: e.innerText.trim(), left: parseInt(e.style.left), top: parseInt(e.style.top) })))`) as Array<{ key: string; text: string; left: number; top: number }>;

let step = 0;
const ok = (what: string) => console.log(`✓ ${++step}. ${what}`);

async function main() {
  // 1. The agent creates; the person opens.
  const created = JSON.parse(cast("board", "create", `E2E board ${new Date().toISOString().slice(11, 19)}`, "--json"));
  const id: string = created.id;
  cast("browser", "open", `${BASE}/docs/${id}?view=minimal`);
  await until("the board page", () => evalJs(`!!document.querySelector('[data-live-board]')`) === true, 180_000);
  ok(`board ${id} created by the agent and open in the browser`);

  // 2. The person adds a sticky through the UI.
  evalJs(`(() => { const b = document.querySelector('[data-live-board]'); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 220, clientY: r.top + 180 })); return true; })()`);
  await until("the person's sticky on the page", () => elementsOnPage().length === 1);
  const personKey = elementsOnPage()[0].key;
  await until("the agent to read the person's sticky", () => readJson(id).elements.some((e: any) => e.key === personKey));
  ok(`person added ${personKey} in the UI; the agent reads it`);

  // 3. The agent writes; it appears with the agent's cursor.
  const agentOps = [
    { k: "el_agent1", put: { kind: "sticky", x: 520, y: 120, w: 200, h: 140, text: "Lock pricing", color: "green" } },
    { k: "el_agent2", put: { kind: "sticky", x: 780, y: 120, w: 200, h: 140, text: "Place order", color: "blue" } },
  ];
  castIn(JSON.stringify(agentOps), "board", "apply", id, "--status", "laying out");
  await until("agent stickies on the page", () => {
    const keys = elementsOnPage().map((e) => e.key);
    return keys.includes("el_agent1") && keys.includes("el_agent2");
  });
  const cursor = await until("the agent's cursor", () => evalJs(`(() => { const c = document.querySelector('[data-live-cursor^="s:"]'); return c ? c.innerText.trim() : null; })()`));
  ok(`agent wrote 2 stickies; they render live with its cursor tagged "${cursor}"`);
  shot("1-agent-and-person");

  // 4. Concurrent edits to one sticky: the person drags it, the agent writes its text.
  evalJs(`(() => {
    const el = document.querySelector('[data-live-el="${personKey}"]');
    const r = el.getBoundingClientRect();
    const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }));
    fire('pointerdown', r.left + 10, r.top + 10);
    for (let i = 1; i <= 20; i++) fire('pointermove', r.left + 10 + i * 5, r.top + 10 + i * 3);
    fire('pointerup', r.left + 110, r.top + 70);
    return true;
  })()`);
  castIn(JSON.stringify([{ k: personKey, set: { text: "Written by the agent" } }]), "board", "apply", id);
  const converged = await until("both edits on both sides", () => {
    const server = readJson(id).elements.find((e: any) => e.key === personKey);
    const page = elementsOnPage().find((e) => e.key === personKey);
    return server && page && server.text === "Written by the agent" && page.text === "Written by the agent" && server.x === page.left && server.y === page.top && server.x > 0 ? { server, page } : null;
  });
  ok(`person dragged ${personKey} to (${converged.server.x}, ${converged.server.y}) while the agent set its text; page and server agree`);

  // 5. Drafts: the agent drafts, the person sees it and saves; then a draft is discarded.
  castIn(JSON.stringify([{ k: "el_agent1", set: { text: "Lock pricing (draft)" } }, { k: "el_draft", put: { kind: "sticky", x: 520, y: 320, text: "New in draft" } }]), "board", "apply", id, "--draft");
  await until("the draft bar and the draft on the page", () => evalJs(`!!document.querySelector('[data-live-draft-bar]')`) === true && elementsOnPage().some((e) => e.key === "el_draft"));
  if (readJson(id, "--main").elements.some((e: any) => e.key === "el_draft")) throw new Error("draft leaked into main before save");
  shot("2-draft");
  evalJs(`document.querySelector('[data-live-draft-save]').click()`);
  await until("the draft saved into main", () => {
    const main = readJson(id, "--main");
    return !main.draft && main.elements.some((e: any) => e.key === "el_draft") && main.elements.find((e: any) => e.key === "el_agent1").text === "Lock pricing (draft)";
  });
  castIn(JSON.stringify([{ k: "el_discard", put: { kind: "sticky", x: 800, y: 320, text: "Discard me" } }]), "board", "apply", id, "--draft");
  await until("second draft on the page", () => elementsOnPage().some((e) => e.key === "el_discard"));
  evalJs(`document.querySelector('[data-live-draft-discard]').click()`);
  await until("the discarded draft gone everywhere", () => !elementsOnPage().some((e) => e.key === "el_discard") && !readJson(id).draft && !readJson(id).elements.some((e: any) => e.key === "el_discard"));
  ok("agent's draft held until the person saved it; a second draft discarded");

  // 6. History: checkpoint, change, restore from the page.
  const cp = cast("board", "checkpoint", id, "Before cleanup");
  const rev = Number(cp.match(/r(\d+)/)![1]);
  cast("board", "rm", id, "el_agent2", "el_draft");
  await until("deletes on the page", () => !elementsOnPage().some((e) => e.key === "el_agent2"));
  evalJs(`document.querySelector('button[title="History"]').click()`);
  await until("the version in the list", () => evalJs(`!!document.querySelector('[data-live-version="${rev}"]')`) === true);
  evalJs(`document.querySelector('[data-live-version="${rev}"]').click()`);
  await until("the version open read-only", () => evalJs(`!!document.querySelector('[data-live-version-bar]')`) === true && elementsOnPage().some((e) => e.key === "el_agent2"));
  shot("3-history");
  evalJs(`document.querySelector('[data-live-restore="${rev}"]').click()`);
  await until("the restore on the server", () => readJson(id).elements.some((e: any) => e.key === "el_agent2") && readJson(id).elements.some((e: any) => e.key === "el_draft"), 180_000);
  await until("the restore on the page", () => !evalJs(`!!document.querySelector('[data-live-version-bar]')`) && elementsOnPage().some((e) => e.key === "el_agent2"));
  ok(`restored r${rev} from the page's History; the agent reads it back`);

  const final = readJson(id);
  const page = elementsOnPage();
  const same = final.elements.length === page.length && final.elements.every((e: any) => page.some((p) => p.key === e.key && p.text === String(e.text ?? "")));
  if (!same) throw new Error(`final state differs: server ${JSON.stringify(final.elements.map((e: any) => e.key))} page ${JSON.stringify(page.map((p) => p.key))}`);
  ok(`final state identical on both sides (${page.length} elements)`);
  console.log(`\nboard: ${BASE}/docs/${id}\nshots: ${SHOTS}`);
}

main().catch((e) => {
  console.error(`✗ step ${step + 1}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
