import { TmuxDeliveryJournal, prepareTmuxDelivery } from "../tmuxDeliveryJournal.js";
import { pasteTextIntoPane } from "../tmuxPaste.js";
import { tmuxRun } from "../tmux.js";

const [target, file, messageId, conversationId, payload] = process.argv.slice(2);
const journal = new TmuxDeliveryJournal(file);
const exec = async (args: string[]) => ({ stdout: tmuxRun(args).stdout });
const delivery = { messageId, conversationId };
const prepared = await prepareTmuxDelivery(target, delivery, exec, async () => false, journal);
journal.begin(delivery, prepared.generation, payload);
await pasteTextIntoPane(exec, target, payload, true);
process.exit(86);
