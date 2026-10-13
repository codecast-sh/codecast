import { oauthApprovalCode } from "@codecast/shared/contracts";
import { pasteTextIntoPane, type TmuxExec } from "./tmuxPaste.js";

export class MintFlowControl {
  generation = 0;
  startedAt: number | undefined;
  active = false;
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }

  begin(startedAt: number | undefined, force: boolean): number | null {
    if (startedAt !== undefined && this.startedAt !== undefined && startedAt <= this.startedAt) return null;
    if (this.active && !force) return null;
    this.startedAt = startedAt;
    this.active = true;
    return ++this.generation;
  }

  cancel(startedAt: number): boolean {
    if (this.startedAt !== undefined && this.startedAt > startedAt) return false;
    this.startedAt = startedAt;
    ++this.generation;
    this.active = false;
    return true;
  }

  current(generation: number): boolean {
    return this.active && generation === this.generation;
  }
}

/** Type a pasted approval code into a sign-in pane waiting at "Paste code here if prompted >" (login and mint alike). */
export async function submitApprovalCode(exec: TmuxExec, target: string, value: string): Promise<void> {
  const code = oauthApprovalCode(value);
  await pasteTextIntoPane(async args => {
    if (args[0] === "send-keys") throw new Error("Could not send approval code. Try again.");
    return exec(args);
  }, target, code, false);
  await exec(["send-keys", "-t", target, "Enter"]);
}
