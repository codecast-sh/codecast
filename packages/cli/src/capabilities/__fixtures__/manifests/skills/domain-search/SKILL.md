---
name: domain-search
description: Check domain name availability accurately across TLDs using registry RDAP APIs and registry whois. Use when the user asks to check, find, brainstorm, or verify domain names, or asks whether a domain is available, for sale, or expiring.
---

# Domain search

Check availability against registry data, never against parsed whois text alone. Report only verified results, and say which method verified each one.

## The one rule that prevents false positives

Every check method must pass a control: a domain you know is registered on the same TLD, through the same route. If the control does not read as "taken", the route is broken and its results are worthless. A broken route returns the same answer as "available" (example failures: rdap.org returns 404 for vine.co, greenhouse.io, and notion.so — all registered). Never report a domain as available from a route with no passing control.

Grepping `whois` output for "no match" is the classic trap: registrar boilerplate and rate limit text match those patterns. It once reported showtell.com as available when it had been registered since 1995.

## Method

1. **RDAP first.** RDAP is the registries' official JSON API. HTTP 200 = registered, 404 = available (on a validated route). Prefer direct registry endpoints over the rdap.org proxy, which is slow and misroutes some TLDs.
2. **Find the endpoint** in the IANA bootstrap: `curl -s https://data.iana.org/rdap/dns.json` maps each TLD to its server. A TLD absent from the file has no RDAP; use registry whois.
3. **Registry whois fallback** for TLDs without RDAP. Find the server with `whois -h whois.iana.org <tld>` (the `refer:` line), then `whois -h <server> <domain>`. "Domain Name:" present = taken. Still needs a control.
4. **DNS as a fast signal**: `dig +short NS <domain>` — nameservers present proves registered (absence proves nothing). Parking nameservers (afternic, sedo, bodis, parkingcrew) mean the domain is listed for sale on the aftermarket.

## Known endpoints and quirks

| Registry | TLDs | Endpoint | Quirks |
|---|---|---|---|
| Verisign | .com .net | `https://rdap.verisign.com/com/v1/domain/X` (swap com→net) | Reliable, fast |
| Google | .app .dev .page .new | `https://pubapi.registry.google/rdap/domain/X` | Aggressive rate limits — sleep 5s or more between queries; 429 means retry slower, not "taken" |
| Identity Digital | .ai .studio .video .show .live .media .tools .pub .wtf and many ngTLDs | `https://rdap.identitydigital.services/rdap/domain/X` | Reliable |
| No RDAP | .io .sh .so | `whois -h whois.nic.io` / `whois.nic.sh` / `whois.nic.so` | rdap.org silently 404s these — never use it for them |
| .co | .co | `whois -h whois.registry.co` | Not whois.nic.co; rdap.org misroutes .co |

Distinguish HTTP codes: 404 = available, 200 = taken, 429 = rate limited (retry slowly), 000 = connection failed. Only 404 on a validated route means available.

Helper: `scripts/check-domains.sh domain1.com domain2.app ...` implements routing, controls, and pacing.

## Beyond yes/no

For an interesting taken domain, pull the full RDAP record (registration events, status):

- **Old registration + no real site** — possibly a dormant owner worth approaching.
- **Expiry date near** — the owner may lapse. After expiry: ~30 days grace, then ~30 days redemption, then the drop. Suggest a backorder (DropCatch, SnapNames) as the cheap play versus buying at the ask.
- **Parked at a marketplace** (see DNS signal above) — it has an asking price; check the marketplace.

## Honest reporting

- Available does not mean cheap: registries tier dictionary words as premium and the price shows only at registrar checkout. Say so when recommending a dictionary word domain.
- If a batch was cut short by rate limits or timeouts, list the unchecked names — do not let a partial sweep read as a full one.
- Results are a snapshot; domains get registered every minute. Date the findings.
