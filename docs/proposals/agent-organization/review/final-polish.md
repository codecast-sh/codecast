# Final polish record

These ten passes followed restoration, independent architecture/product critique, and chapter-level editing. They are checks of the proposal and its presentation, not proof that the proposed feature has been implemented.

| Pass | Before | After | Why and verification |
|---|---|---|---|
| 1. Source accuracy | Draft language implied provider receipts and cost controls already existed. | Existing transcript/account signals are separated from proposed normalized receipts and admission. | Reconciled the inventory with the source-checked architecture review; removed an unsupported shipped-capability claim. |
| 2. Identity and responsibility | Role generation, worker generation and human ownership could be conflated. | The schema and glossary distinguish role fences, task fences, reporting identity and human owners. | Checked rotation and vacancy flows against schema and briefs. Historical provenance never changes during replacement. |
| 3. Authority and privacy | Scoped principal storage was described in the security chapter but missing from the schema overview. | Added the principal contract to the schema chapter, including server-only storage, issuance and revocation. | Checked isolation, human controls, source audiences, output audiences and replica removal across chapters 3–8. |
| 4. Budgets | Nominal limits could be mistaken for available capacity. | Each ancestor checks settled plus reserved plus requested exposure; unknown pricing stays unknown. | Executable document checks verify the $91/$38/$18 example, sibling refusal at $42, $1.50 release, capacity arithmetic and deduplication explanation. |
| 5. Recovery and review | Receipt, transport acknowledgment and verified completion risked reading as equivalent. | The final flow separates dispatch, external reconciliation, event disposition, independent review and owner acceptance. | Walked crash, expired claim, stale evidence, scope move and zero-budget stop scenarios against the 32-case failure matrix. |
| 6. Agent contract and tasking | CLI/UI enum spelling differed; roadmap IDs were only illustrative. | Documented Observe → observed and request-id → operationId mapping. Filed 16 backlog tasks under pl-529 with dependencies and acceptance criteria. | Checked unique task IDs, dependency ordering and acyclic structure. F16 depends on F14; F15 is additionally required only for plan-lead release. |
| 7. Editorial and example consistency | Some prose read like drafting instructions; the day illustration used different times; the release card omitted its exact target. | Tightened prose, aligned the timeline, and added concrete illustrative release, service, revision, expiry and excluded effects. | Read the concepts against their adjacent contracts. Examples remain labeled illustrative, recommendations are not approvals, and observed roles start no workers. |
| 8. Desktop design | Hero letters touched; a mockup caption background stopped partway across the card. | Loosened heading tracking and made caption backgrounds full width. Preserved clear reading paths and a fixed desktop contents rail. | Viewed hero and project screenshots at 1440px. Checked all ten chapters, seven figures/concepts and 24 tables; strict markup and fragment checks pass. |
| 9. Mobile and access | A shrink-to-fit grid expanded the entire 390px page to 777px; table regions shared labels; scrollable code was not keyboard-focusable. | Constrained the grid and main width, scaled the title down to 320px, named every table region, and made code scroll regions focusable. Removed background gradients that prevented deterministic contrast checks. | Browser measurements show 320/320, 390/390 and 1440/1440 viewport/document widths. Viewed the organization and project concepts on mobile. Initial automated findings were used to make these corrections. |
| 10. Delivery regression | A long smooth scroll and open sticky contents could complicate anchor navigation. | Made document navigation immediate, expanded contents non-sticky, and retained native disclosure controls. Published stable owner-editable version 2. | Final live-page check results are recorded in `browser-verification.md`; publication was opened before handoff. |

## Finishing criteria

- Ten complete, consistent chapters, grounded in the reviewed Codecast primitives.
- Explicit observer-first scope and separate execution safety gates.
- A useful human experience, not merely an organization chart.
- Concrete data/API/runtime/replica contracts, failure tests and rollout decisions.
- Six founder choices remain proposed; no money or implementation authorization inferred.
- Sixteen implementation backlog tasks with acceptance criteria and dependencies.
- Real desktop/mobile inspection, accessible navigation, valid markup and working publication.
- Source and review evidence retained in the repository; no deployment of the proposed feature.

The root repository gate was attempted but is not green. See `repository-gates.md`; do not treat the document's validation as application validation.
