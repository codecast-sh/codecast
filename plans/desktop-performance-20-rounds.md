# Desktop performance: 20 rounds, October 6, 2026

The changes reduce repeated work in store subscriptions, task progress, workspace enumeration, replication and mention autocomplete. They are local source changes, not a deployed release.

## Measured result

The actual MessageInput component was mounted in the desktop renderer with 44,562 mention candidates and a mocked network client. Two alternating runs per version used the same candidate array. No messages were sent; the temporary draft was cleared.

| Interaction | Before composer changes | After |
| --- | ---: | ---: |
| Extend `@desktop p` | 168–322 ms | 19–25 ms |
| Extend `@desktop pe` | 165–254 ms | 20–23 ms |
| Extend `@desktop per` | 259–299 ms | 10–13 ms |
| First broad `@d` | 203–242 ms | 287–298 ms |
| Ordinary text | 2–9 ms | 5–7 ms |

These are synchronous input-through-React-commit timings in a development renderer, not input-to-paint measurements. The first broad search remains a problem. No ordinary-typing or aggregate frame-rate improvement is claimed from this comparison. Result counts matched for every keystroke; independent filter comparisons checked result identity and order.

## Rounds

| Round | Investigation/change | Evidence/outcome |
| --- | --- | --- |
| 1 | Memoize task context subtask tallies by immutable collection and parent | Leading idle-profile app hotspot. Representative 100 scans 691 ms versus 2.8 ms cached. |
| 2 | Single-pass workspace row filtering | Five paired live runs: median 7.9 to 5.3 ms; same rows/order. |
| 3 | Enumerate pending replication entries once per batch | Representative 100-row batch, 1,722 pending entries: median 23.2 to 2.1 ms. |
| 4 | Skip onboarding work when banner is dismissed/ineligible | 100 selector checks: median 6.3 ms to below timer resolution. |
| 5 | Share cached collection-existence checks in triage UI | 100 checks: median 8.6 ms to below timer resolution. |
| 6 | Reuse repeated React snapshot reads within one render | Mounted regression verifies one selector evaluation, with prop/state invalidation. Representative expensive-selector benchmark 14.3 to 0.1 ms. |
| 7 | Clone-and-patch persistence diff Map | Rejected: median 7.6 to 9.1 ms, slower. |
| 8 | Avoid full Object.values allocation on task-tally cache miss | Live 22,453-row candidate benchmark median 10.8 to 6.4 ms; eligibility/deduplication tests pass. |
| 9 | Cache default-timezone date formatters | Reverted: timezone-change regression. Correct timezone detection erased the speedup. |
| 10 | Cache explicit teammate-timezone formatters | Preserve current local-zone detection; 100 calls median 10.7 to 4.5 ms. |
| 11 | Cache decision enumeration | Rejected: only 22 live decisions, too little work to justify more machinery. |
| 12 | Optimize Convex-id regex | Rejected: hoisting unchanged at 4.8 ms; character loop marginal and changed edge semantics. |
| 13 | Reuse mention corpus while all source refs, scope and personification match | Roughly 280 ms rebuild versus under 0.1 ms reuse. Tests cover edits, workspace switching and visit changes. |
| 14 | Skip rank Map and repeated query trimming for empty mention query | Separate-version comparison: median 164.3 to 130.8 ms; outputs equal. |
| 15 | Reuse mention objects whose viewing timestamp already matches | Separate-version comparison: median 121.2 to 92.1 ms; outputs equal. |
| 16 | Reuse normalized query and tokens across candidate fields | Separate-version comparison: median 88.7 to 81.6 ms; outputs equal, cold outlier retained in raw evidence. |
| 17 | Stop file search after eight results | Rejected for current workload: nine paths, 100 full searches took 1.8 ms. |
| 18 | Memoize query-independent composer candidate preparation | Removes repeated full-list merging/sorting; measured together with round 19 in the real component above. |
| 19 | Search previous matches when a nonempty query is extended | Live filter: `desktop p` 133.1 to 1 ms, `desktop pe` 125.4 to 1.3 ms, `desktop per` 136.8 to 0.6 ms. Backspacing/source changes restart full search. |
| 20 | Integrated input validation; defer chat markdown singleton initialization | Found circular-import initialization crash in browser and composer test. Lazy singleton preserves component identity while avoiding access before initialization. Verification below. |

## Measurement limits

The machine was severely overloaded (load averages above 150 and later 500), so timings are noisy. The installed app and local development renderer are different builds. Idle profile samples cannot be treated as a controlled before/after result. The later 15-second local profile spent 13.68 seconds idle and did not show task tallying among its leading frames.

Initial round 14–16 comparisons used fixed dynamic-import URLs, which can return stale modules after hot reload. Those timings were discarded and replaced by separate source variants. All temporary variant files were removed. Raw profiles and benchmark output remain in the session's temporary evidence directory, not this public repository; no account content is included here.

## Validation

- 111 focused tests passed across 13 files before the final incremental-search change.
- 22 mention tests passed after that change, including extension, deletion, changed queries, chat mode, new candidates, recency and context ranking.
- The actual composer mount suite passed all three tests after the circular-import fix. The default 5-second timeout was exceeded under machine load; rerunning with a 90-second timeout passed without changing assertions.
- Final web typecheck: zero errors. Convex: zero errors. The full multi-project check is not green: mobile reports 345 errors, including existing cross-platform module-resolution problems. Earlier CLI errors were in the concurrently edited org template code.
- Scoped ESLint: zero errors; existing hook warnings remain. The new unnecessary memo dependency warning was removed.
- No dependencies added, no release deployed, no backend changes. Temporary test components and draft were removed, and the profiling browser tab was closed.
