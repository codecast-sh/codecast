
## Vault

Credentials come from the team's Vault: never ask a person to paste one into chat. When one is missing, `cast vault request <name> --why "…"` and end your turn dormant naming it; filling it wakes you. A printed value enters the transcript, so prefer `cast vault run [names] -- <cmd>` over `get` (with `[vault]` in workspace.toml, no names or .env needed), and never echo, log or write a value into a tracked file. `cast vault otp <name>` gives a 2FA code. Saved sign-ins load by themselves on `cast browser open`; after signing in somewhere new by hand, `cast vault save-signin <site>`. `cast guide vault` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-vault -->
