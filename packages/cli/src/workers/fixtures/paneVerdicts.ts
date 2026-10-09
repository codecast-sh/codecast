import { paneVerdictsForTests } from "../../daemon.js";

// argv: a pane target, then the pid to route. Prints the route verdict.
const [target, pid] = process.argv.slice(2);
console.log(await paneVerdictsForTests.paneRouteVerdict(target, Number(pid)));
process.exit(0);
