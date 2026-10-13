# Hook for cliEngine.ts (main, uncommitted — jx76a64's engine seam)

Apply in `packages/cli/src/browser/cliEngine.ts` when rebasing:

```ts
import { printTabFooter } from "./tabFooter.js";
import { engineTabs } from "./engine.js";   // already imported there via engine.js

function passthrough(engineVerb: string, args: string[]): never {
  const { session, profile } = ctx();
  const res = runEngine([engineVerb, ...args], { session, profile, inherit: true });
  // Post-action: name the driven tab so the conversation's "open tab" can raise it.
  if (res.status === 0) printTabFooter(engineVerb, () => engineTabs({ session, profile }));
  process.exit(res.status);
}
```

`engineTabs()` rows ({tabId, targetId, active, url}) satisfy `FooterTab` as-is.
The footer is the built-in driver's format (`  <url>` line, then `tab <8-hex>`),
which packages/web/lib/browserFocus.ts parses; the daemon route in focusHttp.ts
matches the id by prefix across every local Chrome CDP port, so agent-browser
tabs need no further plumbing.
