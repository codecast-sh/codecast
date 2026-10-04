// The one copy behaviour every Evals copy control shares.

import { useState } from "react";
import { toast } from "sonner";
import { copyToClipboard } from "../../lib/utils";

/** The one copy behaviour every evals copy control shares: the clipboard, a toast, and a check mark for a moment. */
export function useCopy(text: string): [copied: boolean, copy: () => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyToClipboard(text);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 1400);
  };
  return [copied, copy];
}
