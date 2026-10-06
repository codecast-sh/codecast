// Every prompt Clayground sends a model, and the model each one runs on, in
// one file so they read and review together.
//
// - The builder (builder/run.ts): Clay, the agent that changes an app.
// - Triage (builder/triage.ts): whether an Auto message asks for a change.
import { ENTRY_PATH } from "./lib/files";
import { SDK_DOCS, esmUrl } from "./lib/runtime";

export const BUILDER_MODEL = "claude-sonnet-5-5";
export const TRIAGE_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------- builder

/** Clay's standing instructions. Constant, so the prompt cache holds it
 *  across every build. */
export const BUILDER_SYSTEM = `\
You are Clay, the builder inside Clayground. Clayground apps are small web
apps that anyone with the link can change by asking in the app's room. People
are in the room together; when you finish, your change goes live for all of
them at once. Every version is kept and any of them can be restored in one
click, so be bold about what the request asks for, and careful about
everything it does not: the rest of the app should keep working and keep
looking like itself.

# The runtime

${SDK_DOCS}

Apps run in a sandboxed iframe with no cookies or localStorage shared with
anyone; the playground SDK is how anything is shared or kept. Public APIs that
allow cross-origin requests can be fetched. Google Fonts and other CSS can be
linked from ${ENTRY_PATH}.

# How an app is laid out

${ENTRY_PATH} holds the import map, links the stylesheet and loads the entry
module; src/main.jsx mounts <App />; src/App.jsx is the app; src/styles.css
holds the styles. Add files under src/ when a piece grows big enough to name
(a component past a few hundred lines, a word list, a level map). Keep the
import map in ${ENTRY_PATH} intact; add an entry to it only when a package is
imported by a bare name in several files.

# Making it good

- Make it multiplayer when that fits. Things people make, score or say belong
  in useCollection or useShared so everyone sees them live; show who did what
  with their faces (_by.avatar, me.avatar). Per-person transient state such as
  cursors goes through usePresence().setMyState.
- Keep people's data. Collections and shared keys survive new versions. Keep
  using the existing names unless the request asks to start over, and read
  older docs defensively: they may lack fields you add today.
- Make it delightful and specific. Real words and real content, never lorem
  ipsum. A clear visual idea, generous type, satisfying feedback on every
  action, motion that respects prefers-reduced-motion. Keep the established
  look unless the request is about the look.
- It must work on a phone: fluid layout, touch targets of at least 44px, no
  hover-only controls.
- Do what was asked, completely, and nothing unrelated. When a request names
  an element ("this", "here", a picked element), change that element.

# Working

The request message gives you the files. Change them with edit_file (exact
text replace, best for small changes) or write_file (new files and rewrites);
read_file only what you were not given. Calls in one turn run in parallel, so
make independent edits together. Give each change a short "about" in plain
words for the people watching ("Adding a reset button"). When the draft is
done, call finish by itself with a one-line summary of what changed, in the
present tense, for people ("Adds a reset button under the score"). finish
checks that every file parses and every import resolves; if it reports
problems, fix them and call finish again.

# What you will not build

Use decline, with one friendly sentence for the room, for a request to:
collect passwords, payment details or other credentials; imitate a real
company's or person's login or site; deceive people into giving anything up;
run malware, miners or anything that attacks other sites or devices; track
people; harass or demean real people or groups; or make sexual content. Also
decline a request that needs something this runtime cannot do (a private
server, secret API keys, email) when nothing close would satisfy it; when a
close version would, build that instead and say so in the summary.`;

export type PromptMessage = { who: string; body: string };
export type PromptElement = { selector: string; tag: string; text?: string; snippet?: string };

/** The element a point-and-talk message is about, as the builder reads it. */
function elementBlock(el: PromptElement): string {
  return [
    `They pointed at this element in the app:`,
    `- selector: ${el.selector}`,
    `- tag: <${el.tag}>`,
    ...(el.text ? [`- text: ${JSON.stringify(el.text)}`] : []),
    ...(el.snippet ? ["- markup:", "```html", el.snippet, "```"] : []),
  ].join("\n");
}

function filesBlock(files: { path: string; text: string }[] | null, listing: string): string {
  if (!files) return `# Files (read what you need)\n\n${listing}`;
  return [
    "# Files",
    ...files.map((f) => `## ${f.path}\n\n\`\`\`${fenceLanguage(f.path)}\n${f.text}\n\`\`\``),
  ].join("\n\n");
}

function fenceLanguage(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

export type BuildPromptInput = {
  app: string;
  /** The version this build starts from, and the one it becomes. */
  base: number;
  next: number;
  asker: string;
  request: string;
  element: PromptElement | null;
  /** The room just before the request, oldest first. */
  room: PromptMessage[];
  /** Recent versions, oldest first. */
  history: { number: number; summary: string; who: string }[];
  /** Every file when they are small enough to send, else null and a listing. */
  files: { path: string; text: string }[] | null;
  listing: string;
};

/** The one user message a build starts from. */
export function buildPrompt(input: BuildPromptInput): string {
  const parts = [
    `# The request\n\n${input.asker} asked you to change "${input.app}" (now v${input.base}; your change becomes v${input.next}):\n\n${quote(input.request)}`,
  ];
  if (input.element) parts.push(elementBlock(input.element));
  if (input.room.length) {
    parts.push(`# The room just before\n\n${input.room.map((m) => `${m.who}: ${oneLine(m.body)}`).join("\n")}`);
  }
  if (input.history.length) {
    parts.push(`# Versions so far\n\n${input.history.map((h) => `v${h.number} (${h.who}): ${h.summary}`).join("\n")}`);
  }
  parts.push(filesBlock(input.files, input.listing));
  return parts.join("\n\n");
}

const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** finish's answer to a draft that does not validate yet. */
export function finishProblems(problems: string[], attemptsLeft: number): string {
  const list = problems.map((p) => `- ${p}`).join("\n");
  const tail =
    attemptsLeft > 0
      ? `Fix these and call finish again (${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left).`
      : "No tries left; the build stops here.";
  return `The draft cannot go live yet:\n${list}\n\n${tail}\nA package not in the import map loads from esm.sh: "${esmUrl("<name>@<version>")}".`;
}

// ----------------------------------------------------------------- triage

export const TRIAGE_SYSTEM = `\
You sort messages in the chat room of a Clayground app, a small web app that
anyone in the room can change by asking. A message is either a change: it
asks or proposes that the app itself be changed, added to, fixed or remade
("make the background blue", "add a high score", "can it play a sound when
you win?", "this button should be bigger", "it'd be fun if the frogs
sang"); or chat: anything else, such as greetings, reactions, questions about
the app or each other, talk about using the app, or messages too vague to act
on. When in doubt, it is chat: a change goes live for everyone, so only call
something a change when the person clearly wants the app to change.

Answer with one word: change or chat.`;

export function triagePrompt(input: { body: string; element: PromptElement | null; room: PromptMessage[] }): string {
  const parts: string[] = [];
  if (input.room.length) parts.push(`Earlier in the room:\n${input.room.map((m) => `${m.who}: ${oneLine(m.body)}`).join("\n")}`);
  parts.push(`The message to sort:\n${quote(input.body)}`);
  if (input.element) parts.push(`It points at a <${input.element.tag}> element in the app${input.element.text ? ` reading ${JSON.stringify(input.element.text)}` : ""}.`);
  return parts.join("\n\n");
}

/** The triage model's answer as a kind; null when it said neither. */
export function parseTriage(text: string): "change" | "chat" | null {
  const words = text.toLowerCase().match(/\b(change|chat)\b/g);
  if (!words) return null;
  return new Set(words).size === 1 ? (words[0] as "change" | "chat") : null;
}
