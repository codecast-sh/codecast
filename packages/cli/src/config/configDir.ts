// The one answer to "where does codecast keep its state on this machine?"
//
// Every restatement of this expression was a chance for two code paths to
// disagree, and they did: readAuthConfig built `$HOME + "/.codecast"` while
// browser/autoShot read CODECAST_DIR first, so under the CODECAST_DIR
// isolation the tests use, the auth reader and the browser settings read
// different directories (ct-49869).
//
// Both halves of the order are load-bearing:
//  - CODECAST_DIR wins, because that variable is how a test, a worktree or a
//    second machine identity moves the whole state tree somewhere else. A
//    reader that ignores it silently escapes the isolation around it.
//  - $HOME is preferred over os.homedir(), because bun caches os.homedir() at
//    startup and does not see later writes to the variable, which is what
//    breaks $HOME-sandboxed tests. os.homedir() remains the fallback for the
//    rare process started with no HOME at all.
//
// Deliberately a leaf: two node builtins, nothing first-party. The
// stable-context fast path reaches it through config/readAuthConfig.js on
// every agent spawn, and that graph must stay small.

import * as os from "node:os";
import * as path from "node:path";

export function defaultConfigDir(): string {
  return process.env.CODECAST_DIR || path.join(process.env.HOME || os.homedir(), ".codecast");
}
