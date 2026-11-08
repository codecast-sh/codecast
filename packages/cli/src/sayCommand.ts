// `cast say` — what the agent tells the person reading its thread.
//
// The text needs no storage of its own: the command and its text are already
// in the transcript as the tool call that ran it, and the conversation view
// reads them from there (packages/web/components/castCommand.ts sayTextOf).
// A thread in clean mode shows only these and the person's own messages, so
// everything else the agent writes stays working notes. The command checks
// the text and confirms in one line; it never echoes the text back.

import type { Command } from "commander";
import { stdinText } from "./sendBody.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";

export function registerSayCommand(program: Command): void {
  program
    .command("say")
    .argument("[text...]", stdinText("What to tell the person, in markdown"))
    .description(commandGroup("say").description)
    .action((parts: string[]) => {
      const text = (parts ?? []).join(" ").trim();
      if (!text) {
        console.error("Nothing to say: pass the text, or '-' with a heredoc");
        process.exit(1);
      }
      console.log(fmt.muted("shown to the person"));
    });
}
