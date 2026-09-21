import Link from "next/link";
import { Chrome, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { BROWSER_EXTENSION_SETUP_COMMAND, BROWSER_EXTENSION_STORE_URL } from "@codecast/shared/contracts";
import { copyToClipboard } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsSection } from "./ui";

export function BrowserExtensionSetup() {
  return (
    <SettingsSection
      title="Chrome extension"
      icon={Chrome}
      description="Let agents use the sites you’re signed into, in their own tabs in your Chrome."
      padded
    >
      <ol className="space-y-5 text-sm">
        <li className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sol-text">1. Add Codecast to Chrome</p>
            <p className="mt-1 text-xs text-sol-text-muted">Install in the Chrome profile you want your agents to use.</p>
          </div>
          <Button variant="secondary" size="sm" asChild>
            <a href={BROWSER_EXTENSION_STORE_URL} target="_blank" rel="noopener noreferrer">
              Chrome Web Store <ExternalLink className="ml-1.5 h-3 w-3" />
            </a>
          </Button>
        </li>
        <li>
          <p className="text-sol-text">2. Pair it with the CLI</p>
          <p className="mt-1 text-xs text-sol-text-muted">Run this in a terminal on the same computer, then click Pair in Chrome.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-sol-bg p-3">
            <code className="min-w-0 flex-1 break-words text-xs text-sol-cyan">{BROWSER_EXTENSION_SETUP_COMMAND}</code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Copy browser pairing command"
              onClick={() => void copyToClipboard(BROWSER_EXTENSION_SETUP_COMMAND).then(() => toast.success("Pairing command copied"))}
            >
              <Copy className="mr-1.5 h-3 w-3" />Copy
            </Button>
          </div>
        </li>
      </ol>
      <p className="mt-4 text-xs leading-relaxed text-sol-text-muted">
        Requires desktop Chrome and the Codecast CLI on the same computer. Repeat on each computer you use.
        Chrome updates the extension automatically.{" "}
        <Link href="/documentation/browser" className="text-sol-cyan hover:underline">Setup guide</Link>
      </p>
    </SettingsSection>
  );
}
