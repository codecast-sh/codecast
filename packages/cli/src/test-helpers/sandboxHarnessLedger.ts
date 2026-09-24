// Preloaded before every test module (bunfig.toml). Every codecast write to an
// agent harness appends to the change history (harness.ts), and most tests
// point their files at a temp HOME while the history path would still resolve
// under the real one. Pointing the history at a temp file here means no test
// run can put fake changes into a real machine's history, where the daemon
// would report them to the device page.
import * as os from "os";
import * as path from "path";

if (!process.env.CODECAST_HARNESS_LEDGER) {
  process.env.CODECAST_HARNESS_LEDGER = path.join(os.tmpdir(), `codecast-test-harness-${process.pid}.jsonl`);
}
