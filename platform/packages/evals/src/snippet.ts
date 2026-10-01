/**
 * The one page an agent reads before using the CLI: the loop, the
 * vocabulary, and the rules. Stamped into a repo's CLAUDE.md by the app's
 * `<cli> snippet install`, through @platform/snippets, so a re-stamp with
 * unchanged bytes writes nothing and everything around it survives.
 */

export const EVALS_SNIPPET_END = '<!-- /platform-evals -->';

export function evalsSnippet(opts: { name: string; repoNotes?: string }): string {
  const n = opts.name;
  return `
## Conversations, freezes, simulations and evals (\`${n}\`)

\`./${n}\` is how you read what people and the assistant said to each other,
freeze the moment the assistant had to act, replay it against the prompts in
this tree, run a scenario forward with simulated people, and read the score.
Reads never change anything. Every view ends with the exact next commands;
every read takes \`--json\`; colour is off when piped. Ids print as eight
characters and any prefix is a handle. Never read the database directly for
any of this: the CLI is the door, and what it cannot show is a gap to fix in it.

The loop: \`${n} convo inbox\` → pick a moment → \`${n} freeze create <messageId>\`
→ \`${n} freeze judge <id> "the reply must …"\` → \`${n} freeze replay <id> --reps 3\`
(the baseline) → edit the prompt → replay again → \`${n} freeze results <id>\` /
\`${n} freeze diff <id> --run A --run B\`. A judged freeze is a regression guard.

\`\`\`bash
# Conversations: a <ref> is an id or prefix, a phone, an email, a name, or a message id
${n} convo inbox [--since 48h] [--channel imessage] [--unanswered]   # latest inbound; ! = nobody replied
${n} convo show <ref> [--around 12 | --from 5 --to 20 | --last 10] [--channel a,b] [--system] [--full]
${n} convo show <messageId>          # opens the conversation focused on that message
${n} convo msg <id>                  # one message in full, with the run behind it
${n} convo find "<text>" [--contact <ref>] [--since 7d]
${n} convo who <ref>                 # who it is, their addresses, who else is in it
${n} convo show <ref> --html --open  # the page

# Freezes: a durable frozen moment, the world cut at that instant
${n} freeze create <messageId> [--name …] [--judge "…"] [--notes …] [--tag t]
${n} freeze list [-q text] [--tag t] [--contact <ref>]
${n} freeze show <id> [--context 6]   # the moment with a FROZEN HERE marker, the production reply, replays
${n} freeze replay <id> --reps 3 [--model id] [--dry] [--notes "what changed"]
${n} freeze judge <id> "the reply must …" [--rejudge]
${n} freeze results <id>              # every replay side by side with its verdict
${n} freeze diff <id> --run A --run B
${n} freeze sim <id> --horizon 24     # keep going: the other people answer, a day unfolds
${n} freeze html <id> --open

# Runs: every simulation and replay, from the evidence folders
${n} runs [--scenario s] [--since 7d] [--status fail] [--freeze <id>] [-n 30]
${n} runs show <run> [--full]        # who, the score, the story both sides, what the boundary caught
${n} runs story <run> [--channel imessage] [--last 20] [--full]
${n} runs events <run> [--kind send_captured,inbound_injected]
${n} runs score <run>                # every gate with its evidence, every judged check
${n} runs diff <A> <B> · ${n} runs history <scenario>
${n} runs html <run> --open          # the page: cast, timeline, story, rooms, score, events
${n} runs report [--since 24h] --open   # one page over many runs

# Simulations: a scenario against the whole product with simulated people
${n} sim scenarios
${n} sim run <scenario> [--seed 11] [--dry] [--model id] [--open]   # --dry proves the wiring and spends nothing
${n} sim sweep [--only a,b] [--seed 11] [--dry] [--model id] [--parallel 3] --open
\`\`\`

Reading a score: gates are decided in code and any one failing scores the
run zero; the judged checks are the half that needs reading; a gate that
held with nothing to search says so, and is not a pass on the merits.
${opts.repoNotes ? `\n${opts.repoNotes.trim()}\n` : ''}
${EVALS_SNIPPET_END}
`;
}
