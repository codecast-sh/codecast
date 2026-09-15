// A role wake frame as convex/orgWakes.ts buildFrame writes it, trimmed from a
// real delivery into the Reliability lead's standing session. Shared by the
// parser test and the card's mount test.
export const ROLE_WAKE_FIXTURE = `<role-wake or-8 wake="rw-12" at="2026-09-15T04:01:55.078Z" causes="9" held="2">
## You
Reliability lead (@reliability, or-8) · trust understand · reports to Ashot Petrosian
Scope: project Codecast: Sync & Reliability, plan pl-497 Daemon scaling: unfreezable control plane, plan pl-592 Move Convex backend and Postgres off Railway
Today: 1/40 wakes · 0/6 hands · 0/400000 tokens

## Why you are awake
- task ct-51321 "Investigate repeated iOS crashes and ship an OTA fix" is done
- (held) task ct-51223 "Cloud host stops while a session is mid-turn" is in_progress (changed 4 times)
- (held) (passive) decision sd-31 answered
- plan pl-592 "Move Convex backend and Postgres off Railway" is draft
- task ct-51445 "Trace and fix saved Claude profile identity corruption" is in_progress
- task ct-51448 "Fix dangling cast send awaiting terminal confirmation" is open
- task ct-51473 "Repair the second mislabeled Claude account group" is done
- and 2 more changes

## Your scope now
Tasks: 164 in scope, 57 open · 14 open, 43 in_progress, 107 done
Priority: 4 urgent, 119 high, 38 medium, 3 low
Decisions: 0 open, 0 answered today
Plans:
- plan pl-549 Seamless cloud sessions: mirror the laptop on the Cloud Linux host: 6/11 done, 4 in progress (draft)
- plan pl-592 Move Convex backend and Postgres off Railway: 3/13 done, 3 in progress (draft)
- plan pl-497 Daemon scaling: unfreezable control plane, cheap restarts, bounded fleet, freeze SLO: 5/9 done, 2 in progress (active)
Changed since your last frame:
- task ct-51493 Scratch: wake rail dedupe check (ct-51491), drop me → open
- plan pl-549 Seamless cloud sessions: mirror the laptop on the Cloud Linux host → draft
- task ct-51476 Diagnose cloud reporter delivery blockage without restarting host → in_progress

## Hands say
- jx7hand1 Fix the deploy: working · ct-51448 in_progress — checking CI
- jx7hand2 Trace identity corruption: needs input · ct-51445 in_progress — waiting on a prod key

## Channels
- #releases Ashot Petrosian: 1.1.135 is out (thread k17abc)

## Charter
hash 3f2a91c0 · read it with \`cast brief\`
</role-wake>`;

// A frame from before the wake id and the counts rode the tag.
export const ROLE_WAKE_FIXTURE_LEGACY = `<role-wake or-3 at="2026-09-14T10:00:00.000Z">
## You
Growth lead (@growth, or-3) · trust direct · reports to Ashot Petrosian
Scope: the whole workspace
Today: 2/40 wakes · 1/6 hands · 12000/400000 tokens

## Why you are awake
- a person wrote: ship the blog post
- (passive) decision sd-9 answered

## Your scope now
Tasks: 3 in scope, 1 open · 1 open, 2 done
Priority: 3 medium
Decisions: 0 open, 1 answered today
Nothing in scope changed since your last frame.

## Hands say
- no hands

## Charter
hash 00c0ffee · read it with \`cast brief\`
</role-wake>`;
