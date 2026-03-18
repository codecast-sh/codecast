import { copyToClipboard } from "../lib/utils";

export function CopyInstallButton() {
  return (
    <button
      onClick={() => copyToClipboard("curl -fsSL codecast.sh/install | sh")}
      className="px-3 py-1 bg-black text-white text-xs rounded hover:bg-black/90 transition-colors whitespace-nowrap"
    >
      Copy
    </button>
  );
}
