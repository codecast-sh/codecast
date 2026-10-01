import type { Command } from "commander";
import { LAB_FLAGS, LAB_TRIMS, TRIM_REASON } from "@codecast/shared/docs/drafting";
import { stdinText } from "./sendBody.js";

// `cast doc` drafting verbs: the same editing aids the doc page has
// (alternatives, ghosts, the Overflow, the Lab), on the doc's stored markdown,
// so an agent drafts the way a writer does and the writer sees it live: every
// write resets the collab snapshot, and open editors reload with the marks.
// The markup and its transforms live in @codecast/shared/docs (drafting).
// This file only declares the verbs; their bodies (docDraftingActions.ts)
// load when one runs, so the CLI's boot graph carries only this registrar and
// the constants its help text names.

export interface DocDraftingDeps {
  post: (path: string, body: Record<string, any>) => Promise<any>;
  sessionId: () => string | null | undefined;
}

type ActionName = keyof typeof import("./docDraftingActions.js");

function lazy(deps: DocDraftingDeps, name: ActionName) {
  return async (...args: any[]) => {
    const actions: any = await import("./docDraftingActions.js");
    return actions[name](deps, ...args);
  };
}

export function registerDocDraftingCommands(doc: Command, deps: DocDraftingDeps): void {
  doc
    .command("drafts")
    .description(
      "List a document's drafting marks: alternatives (with every version), ghosted text, proposed cuts and Lab marks\n\n" +
        "The marks live in the markdown as <span data-alts|data-ghost|data-flag> and show in the doc page with drafting on.",
    )
    .argument("<id>", "Document ID")
    .option("--json", "Machine-readable output")
    .action(lazy(deps, "drafts"));

  doc
    .command("alt")
    .alias("alts")
    .description(
      "Keep other versions of a word, sentence or paragraph, and choose which one shows\n\n" +
        "The target is the exact text shown now. Versions join its list; the text it had first stays version 0.\n\n" +
        "Examples:\n" +
        '  cast doc alt <id> "tension" "pressure" "struggle"   # add versions\n' +
        '  cast doc alt <id> "tension" --pick 2               # show version 2 in place\n' +
        '  cast doc alt <id> "struggle" --settle              # keep what shows, drop the rest\n' +
        '  cast doc alt <id> "struggle" --drop 1              # drop one version\n' +
        "  cast doc drafts <id>                               # see every set",
    )
    .argument("<id>", "Document ID")
    .argument("<text>", stdinText("The text as it shows now"))
    .argument("[versions...]", "Versions to add")
    .option("--pick <n>", "Show version n (0 is the original)")
    .option("--settle [n]", "Keep the version shown (or version n) as plain text and drop the others")
    .option("--drop <n>", "Drop version n (not the one showing)")
    .option("--nth <n>", "Which occurrence of the text, when it appears more than once")
    .option("--ai", "Mark the added versions as a model's")
    .option("--human", "Mark the added versions as a person's")
    .action(lazy(deps, "alt"));

  doc
    .command("ghost")
    .description(
      "Dim text back without deleting it: it stays in the doc, faded, until revived or cut\n\n" +
        "With --reason trim it is a proposed cut the writer keeps (click) or makes (cast doc cuts).",
    )
    .argument("<id>", "Document ID")
    .argument("<text>", stdinText("Exact text to ghost"))
    .option("--reason <reason>", `Why: "${TRIM_REASON}" marks a proposed cut`)
    .option("--nth <n>", "Which occurrence of the text")
    .action(lazy(deps, "ghost"));

  doc
    .command("revive")
    .description("Bring ghosted text back (one stretch, or every ghost with --all)")
    .argument("<id>", "Document ID")
    .argument("[text]", stdinText("Ghosted text to revive"))
    .option("--all", "Revive every ghost")
    .option("--reason <reason>", `Only ghosts with this reason (e.g. ${TRIM_REASON})`)
    .option("--nth <n>", "Which occurrence of the text")
    .action(lazy(deps, "revive"));

  doc
    .command("cuts")
    .description("Make the proposed cuts: delete text ghosted as a trim (or every ghost with --all)")
    .argument("<id>", "Document ID")
    .option("--all", "Delete every ghosted stretch, not only proposed cuts")
    .action(lazy(deps, "cuts"));

  doc
    .command("flag")
    .description(`Mark text with a finding (${LAB_FLAGS.map((f) => f.flag).join(", ")}); --clear removes marks`)
    .argument("<id>", "Document ID")
    .argument("[text]", stdinText("Exact text to mark"))
    .argument("[kind]", "Kind of finding", "weak")
    .option("--note <text>", "Why, in a few words")
    .option("--nth <n>", "Which occurrence of the text")
    .option("--clear [kind]", "Remove marks (all, or one kind)")
    .action(lazy(deps, "flag"));

  doc
    .command("overflow")
    .description(
      "The Overflow: writing kept beside a doc rather than in it (cuts, notes, words to use later)\n\n" +
        "Examples:\n" +
        "  cast doc overflow <id>                         # print it\n" +
        '  cast doc overflow <id> --append "an aside"     # add a paragraph\n' +
        '  cast doc overflow <id> --stash "exact text"    # move text out of the doc into it\n' +
        "  cast doc overflow <id> --set - <<'EOF'         # replace it\n" +
        "  cast doc overflow <id> --clear",
    )
    .argument("<id>", "Document ID")
    .option("--set <text>", stdinText("Replace the Overflow"))
    .option("--append <text>", stdinText("Add a paragraph to the Overflow"))
    .option("--stash <text>", stdinText("Move this exact text from the doc into the Overflow"))
    .option("--nth <n>", "Which occurrence of the stashed text")
    .option("--clear", "Empty the Overflow")
    .action(lazy(deps, "overflow"));

  doc
    .command("lab")
    .description(
      "Run a Lab tool on a doc with the server's model. Nothing is rewritten: results land as drafting marks\n\n" +
        "Tools:\n" +
        `  trim [--level ${LAB_TRIMS.map((t) => t.level).join("|")}]   ghost what could go (proposed cuts)\n` +
        "  typos                    fixes as versions you can flip back\n" +
        `  flag <${LAB_FLAGS.map((f) => f.flag).join("|")}>   mark findings\n` +
        '  alts "<text>"            suggest versions for one stretch\n\n' +
        "Then: cast doc drafts <id> to read the result, cast doc cuts <id> to make the cuts.",
    )
    .argument("<id>", "Document ID")
    .argument("<tool>", "trim, typos, flag or alts")
    .argument("[arg]", "The flag kind, or the text for alts")
    .option("--level <level>", "Trim level", "slight")
    .option("--nth <n>", "Which occurrence of the text (alts)")
    .action(lazy(deps, "lab"));
}
