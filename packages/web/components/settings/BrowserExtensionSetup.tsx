import Link from "next/link";
import { Chrome, ExternalLink } from "lucide-react";
import { BROWSER_EXTENSION_STORE_URL } from "@codecast/shared/contracts";
import { agentFeatureHref } from "../../lib/agentFeatureHref";
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
        <li className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sol-text">2. Pair it with this computer</p>
            <p className="mt-1 text-xs text-sol-text-muted">Switch on Browser in Agent features, then click Pair on its card.</p>
          </div>
          <Button variant="secondary" size="sm" asChild>
            <Link href={agentFeatureHref("browser")}>Open Agent features</Link>
          </Button>
        </li>
      </ol>
      <p className="mt-4 text-xs leading-relaxed text-sol-text-muted">
        Requires desktop Chrome and codecast on the same computer. Repeat on each computer you use.
        Chrome updates the extension automatically.{" "}
        <Link href="/documentation/browser" className="text-sol-cyan hover:underline">Setup guide</Link>
      </p>
    </SettingsSection>
  );
}
