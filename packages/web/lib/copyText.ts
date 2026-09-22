import { toast } from "sonner";
import { copyToClipboard } from "./utils";

/** Copy text and say so: a toast on success, another when the clipboard refuses. */
export async function copyText(text: string, ok = "Copied") {
  try {
    await copyToClipboard(text);
    toast.success(ok);
  } catch {
    toast.error("Couldn't copy");
  }
}
