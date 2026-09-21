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

export function mintApprovalCode(value: string): string {
  const code = value.trim();
  if (!/^[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?$/.test(code) || code.length > 4096) {
    throw new Error("Paste the approval code shown by Claude, without any extra text.");
  }
  return code;
}

export async function submitMintApprovalCode(exec: TmuxExec, target: string, value: string): Promise<void> {
  const code = mintApprovalCode(value);
  await pasteTextIntoPane(async args => {
    if (args[0] === "send-keys") throw new Error("Could not send approval code. Try again.");
    return exec(args);
  }, target, code, false);
  await exec(["send-keys", "-t", target, "Enter"]);
}
