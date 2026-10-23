# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

STALE REFERENCES BODY — the shared section that ten of the eleven snippets
refresh as a side effect of installing. The one that does not (`visual`) leaves
this text exactly as it stands.
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Vault

Credentials come from the team's Vault: never ask a person to paste one into chat. When one is missing, `cast vault request <name> --why "…"` and end your turn dormant naming it; filling it wakes you. A printed value enters the transcript, so prefer `cast vault run [names] -- <cmd>` over `get` (with `[vault]` in workspace.toml, no names or .env needed), and never echo, log or write a value into a tracked file. `cast vault otp <name>` gives a 2FA code. Saved sign-ins load by themselves on `cast browser open`; after signing in somewhere new by hand, `cast vault save-signin <site>`. `cast guide vault` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-vault -->
