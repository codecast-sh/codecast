# Agent browser appearance on macOS

The compiled macOS CLI gives its separate agent browser a Cast icon. It prepares a local `Cast Agent Chrome.app` from the installed Google Chrome and launches it with the existing agent profile. The browser connected through the Cast extension remains the person's own Chrome.

The app keeps Google's signed executable, frameworks, bundle identifier and internal name. Finder shows `Cast Agent Chrome`; macOS may still label the running application `Google Chrome`. The custom icon distinguishes it in the Dock and application switcher. No Chrome binary is redistributed or signed by Cast.

## Installation and updates

The CLI embeds the artwork and a universal macOS helper compiled during the release build. The helper is signed with the CLI's Developer ID identity; users need neither Xcode nor Swift. A source checkout without a compiled helper uses ordinary Chrome.

Copies live under `~/.codecast/browser/applications`, or the corresponding directory under `CODECAST_DIR`. Preparation uses a process lock, macOS clone copying and an atomic directory rename. A Chrome version or artwork revision change creates a new copy. Active older copies remain until a later preparation finds they have exited. Interrupted copies are removed under the lock.

The copied application passes full code signature validation and macOS launch assessment before use. Preparation or assessment failure falls back to installed Chrome with an explanation. Cast does not disable Gatekeeper, remove quarantine or change Google's signed resources.

Agent launches disable Chrome's updater scheduler; the installed Chrome remains responsible for updates. Cast registers the original application after its copy to preserve normal Chrome routing. Existing agent sessions continue running until their usual restart.

Headless launches, explicit `CODECAST_CHROMIUM` overrides, other Chrome channels, Linux and Windows keep their existing appearance and launch behavior.

## Verification

The release workflow runs native installer tests and the compiled CLI browser test before publishing:

```bash
cd packages/cli
bun test src/browser/appIdentity.test.ts src/browser/appIdentity.native.test.ts --timeout 30000
bun scripts/test-browser-branding.ts ../web/binaries/codecast-darwin-arm64
```

The native tests cover reuse, version and icon refresh, concurrent preparation, interrupted installation, failed preparation and preserving active copies. The end-to-end test uses an isolated profile, checks the actual running executable and signatures, opens a local page, captures a screenshot, and verifies cookies and local storage survive a restart. It prints the temporary evidence directory and closes its browser afterward.
