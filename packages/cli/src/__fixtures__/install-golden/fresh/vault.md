
## Vault

Take credentials from the team's Vault; never ask a person to paste one. A value you see lands in the transcript, so hand it to the command: `cast vault run [names] -- <cmd>`, `vault://<name>` in an `--env-file`, or its stdin with `< <(cast vault get <name>)`. Never pass one as an argument, `$(cast vault get …)` included: other local users can read a command's arguments. Never print one or write it to a tracked file. Missing one: `cast vault request <name> --why "…"`. A read that exits 3 names the decision it waits on. Either way, end the turn dormant naming it. `cast vault otp <name>` gives a 2FA code. Saved sign-ins load on `cast browser open`; after signing in by hand, `cast vault save-signin <site>`. `cast guide vault` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-vault -->
