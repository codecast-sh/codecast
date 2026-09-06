# Session update batching: implementation and delivery guide

`cast send --update` durably collects routine progress messages before handing a bounded batch to normal delivery. It is opt-in and currently supports legacy sessions without an execution-protocol marker. The implementation includes prompt-input protection, kill cancellation and migration refusal. The migration repair is implemented and tested. Both critics pass their reviewed scope with zero open findings. The final backend compiler passed. No batching deployment, client release or activation has occurred; the full repository gate remains unresolved.

The original investigation did not establish what triggered the provider's safety stop. The phrase “The user authorized this inline migration…” came from coordinator jx70p9m's one-off `/tmp/codex-fleet-brief-rest.sh`, paraphrasing [the user's actual instruction](https://codecast.sh/conversation/jx70p9mcb2b6mmzjf1b3zw8w758dsfgc#msg-k17fdz43j4x77c5gzr36h1k0bn8dsn3x), rather than a product template. Nine detached sends lacked `--from`; their historical environment was not retained. The separate sender fix recognizes `CODEX_THREAD_ID`, resolves the caller's own session and refuses unattributed non-raw sends, with server rejection of supplied unresolved native references. Those provenance corrections do not establish the security root cause. Handoffs should cite the source instruction and concrete authorized work; a generated paraphrase is not fresh authorization.

Use updates for routine progress. Use ordinary sends for questions, urgent coordination or blockers requiring an answer. The sender chooses; there is no text classifier converting ordinary sends into updates. Detached scripts should always supply their source explicitly.

```bash
cast send jxtgt01 --from jxsrc01 --update "Review finished."
cast send jxtgt01 --from jxsrc01 --update - <<'EOF'
Typecheck passed.
The remaining issue is the retry timeout.
EOF
cast updates <update_id>
cast updates <update_id> --json
cast updates <update_id> --cancel
cast send jxtgt01 --from jxsrc01 "Please answer before I change the schema."
```

The CLI prints a stable UUID before posting. After a timeout or unconfirmed response, replay the identical intent using that printed ID:

```bash
cast send jxtgt01 --from jxsrc01 --update --request-id 11111111-1111-4111-8111-111111111111 "Review finished."
```

Deduplication is scoped to the authenticated user and request ID. Replay requires identical body bytes and identical trimmed source/target references, even when alternate references would resolve to the same conversation. Changed intent fails; a new ID creates a distinct update. Exact replay returns the existing receipt even after a target protocol change. There is no automatic fallback to ordinary send. `--update --raw` is rejected, and `--request-id` requires `--update`. Admission requires a real, owned source and target send access.

The server applies these fixed limits:

| Limit | Value and meaning |
| --- | --- |
| Initial collection window | 2 seconds from the oldest queued arrival. |
| Maximum batching hold | 15 seconds from that arrival; later arrivals never extend it. |
| Members per batch | At most 8. |
| Encoded batch size | At most 16 KiB, including envelope, metadata and escaping. |
| Individual body | At most 8 KiB of UTF-8; it must also fit in one encoded batch. |
| Free queue per target | At most 128 updates. |
| Free queue byte budget | At most 256 KiB, summed from each update's standalone encoded batch size. |

Idle, completed, stale or unknown targets normally flush after two seconds. Extension requires positive busy evidence: an owned managed session with a positive PID, no hibernation marker, a heartbeat within ninety seconds, and working/thinking status. The query examines at most sixteen linked managed sessions. Busy checks repeat at two-second intervals, capped by the oldest hard deadline. This is a scheduling hint, not proof of a safe model-turn boundary. There is no one-batch-per-turn guarantee.

The fifteen-second limit bounds intended batching delay, not provider delivery. Scheduler outages can delay enqueue; connectivity, terminal readiness and safety holds can delay delivery afterward. Ordinary send routing, payload, wake and mailbox bypass remain unchanged. Eligible offline targets retain normal enqueue/wake behavior: batching introduces neither indefinite offline holding nor a no-wake promise. Existing safety stops remain authoritative.

The additive `session_updates` table stores immutable request identity, source attribution, body, server timestamp and deadlines. Free rows enter the ordinary pending queue only when flushing. Selection follows arrival order and a contiguous prefix from one authenticated sending user; multiple source sessions from that user remain individually attributed. Source ownership, target ownership and send access are checked again before enqueue. Revoked or invalid rows receive a rejection reason.

Each batch receives a deterministic pending-message identifier derived from its first member. Enqueue and member assignment occur in the same transaction. Duplicate callbacks cannot freely reassign already enqueued members; identifier conflicts are checked against existing content and provenance. Remaining free work schedules its next flush. A sixty-second recovery cron scans overdue rows in pages of sixty-four and schedules bounded continuation work with a fixed cutoff. An overdue receipt says recovery is pending. Recovery does not reset deadlines, bodies or delivery identities.

An update's states are `queued`, `enqueued`, `cancelled` and `rejected`. Receipt identity and saved content remain stable while state advances. Once assigned, its receipt joins the canonical pending row for delivery status, echo and completion information; there is no second acknowledgement state machine. `enqueued` means assigned to delivery, not received by a provider. An unavailable pending record yields unknown delivery, not success.

`cast updates --cancel` cancels only a free queued member. Repeating cancellation is harmless. Once assigned, member cancellation reports too late and leaves its parent and siblings intact. An assigned update can therefore remain `enqueued` while its joined canonical delivery becomes cancelled or failed. Do not mint a replacement request ID merely because delivery remains pending.

A pending human decision is different from a live terminal menu. A stored question, permission request or decision does not hold the mailbox, and updates never answer or clear it. At the delivery boundary, however, machine text must not become menu input. The daemon now excludes machine envelopes from human-answer inference, prompt-cache consumption and synthetic-answer handling. This also protects ordinary peer envelopes: the confirmed unsafe conversion of “Do not Deploy yet” into Deploy/Enter is corrected beyond batching.

Terminal delivery checks actual captured screen structure before input. A detected menu, failed capture or empty capture holds the machine message. Once blocked, that attempt cannot escape through fallback. Supported terminal paths guard paste/submit operations; tmux also guards readiness corrections and subsequent key operations. The legacy loop clears provisional dedup state, retries the original content, releases its delivery locks and continues to later rows. An explicit human answer retains its normal path, allowing a held update to retry afterward. Existing retry limits and pre-paste injected/ACK semantics are inherited, not redesigned.

Kill cancellation has an immutable generation boundary. The initial kill cancels the entire free update mailbox within its transaction and advances the conversation's pending generation. New canonical pending rows receive the new generation. Overflow cleanup carries the captured cutoff and cancels only eligible older generations; it never rescans free updates. Delayed, replayed or reversed callbacks cannot cancel later sends based on timestamps. Old callbacks without a cutoff deliberately do nothing. A later explicit send can still use normal wake behavior, while cancelled pre-kill updates cannot be resurrected by recovery. Existing exclusions for started or ambiguous fenced effects remain intact.

Fenced batches are unsupported. Any execution-protocol marker, including quiescing or future states, refuses new update admission. If a marker appears after acceptance, flushing rejects remaining free rows; already assigned parents are not rewritten. The pre-quiescence guard scans pending, injected, failed and undeliverable rows with one total 129-row budget. It rejects a combined unresolved count above 128 or an unresolved batch before any writes. Ordinary nonpending rows below the bound preserve existing activation semantics. Activation also refuses unresolved update envelopes. The repaired boundary is tested and preserves legacy delivery and human-answer handling before migration. No activation-policy or daemon change is included. Per-update cancellation cannot cancel an assigned parent.

The shared envelope preserves each member's source, timestamp and exact decoded body, escaping delimiter-like text as data. Strict parsing enforces bounds and rejects malformed structure without inventing provenance. Web and mobile source render individual members; web uses the existing collapsible markdown body and shows pending, failed and malformed states. Outgoing cards distinguish queued receipts from unknown acceptance. These changes use existing message data and add no global store feeder.

Validation applies to recorded revisions. Overlapping totals are not one clean final-tree run. Earlier CLI/web passes exclude four unrelated ungrafted F3 leaves changed after web release.

| Verification | Recorded result and limit |
| --- | --- |
| Original batching core | 244 cases known passing across overlapping focused-1/focused-2 runs; earlier failures remain preserved. |
| Final backend fixtures | 256 unique passing cases across overlapping phases. Latest sessionUpdates + executionBindings: 129/129, 1,159 assertions, no drift; seven new migration cases. |
| Prompt fixtures | Prompt suite: 91/91, 548 assertions. Disjoint startup fixture: 7/7, 14 assertions. Source-extracted terminal fixtures use stubs. |
| CLI package types | Tool and wrapper PASS, 1,833 actual inputs, no drift or coverage gaps. Earlier eight callback-type errors were repaired in tests. |
| Backend package types | Final compiler and wrapper PASS, 1,213 actual inputs, 22.49 seconds, no drift or coverage gaps. The earlier incomplete inventory is retained separately. |
| Web package types | Tool and wrapper PASS, zero diagnostics, 66.775 seconds; 3,156 actual inputs, no drift or coverage gaps, owned processes gone. |
| Browser fixture | PASS using static, real component slices at desktop and 390px widths: independent expansion, code/Unicode/literal tags, receipt states, light/dark, no page overflow and observed error/CSP counts zero. |
| Owned web lint | Exit 1 retained. Four dedicated files clean; all 35 reported ConversationView diagnostics and five suppressed findings map to unchanged baseline spans. Attribution is not a baseline lint rerun or gate pass. |
| Source review/full gate | Both critics PASS their reviewed scope, zero open findings; security finding CLOSED after migration regressions passed. Full gate unresolved. |

Browser evidence does not cover the authenticated application, store hydration/replication or native mobile devices. Native terminal/provider delivery, screen-render timing and atomic capture-to-input behavior were not verified. A native capture may clip a long composer's opening and conservatively hold quoted menu text; Terminal.app has one pre-effect snapshot because paste/submit is combined. Real Convex scheduling/OCC was not exercised. There is no universal provider-delivery or no-stall guarantee.

Rollout remains coordinator-owned. Complete the shared repository gate first. Deploy additive backend support through `packages/convex/deploy.sh`, observing its whole-tree freshness rules, before distributing clients that call the new endpoints. Coordinate the repaired daemon rollout before enabling use; this feature cannot claim server-only rollout. Preserve accepted rows, receipts and recovery during rollback; removing the table or disabling recovery would strand work. Track oldest queued age, overdue recovery, batch size, canonical outcomes and ordinary-send latency without treating fewer safety flags as proof of the original cause.
