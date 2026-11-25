# Speaker attribution for voice notes

A voice note (`rec:<uuid>` transcript) is one microphone that may hear several people. After it stops, a batch pass turns the stored audio into lines that say who spoke, using people's voices learned from earlier recordings and from corrections. A person can always fix who a speaker is, and every line follows at once.

Huddles keep structural attribution (one LiveKit track is one person) and are untouched by this, except as a future source of voice samples.

Plan: pl-1081. Measurements and the lab that produced them: `packages/evals/speech/lab` (data in `~/.codecast/diarize-lab`, never git).

## Facts and their homes

| Fact | Home | Written by |
|---|---|---|
| Which voice cluster a line belongs to | `transcript_segments.speaker_id` = `spk:<n>` | the batch pass; a person moving one line to another speaker |
| Who a voice cluster is | `transcripts.speakers[]`, one entry per `spk:<n>` | the batch pass (a voice suggestion), a person (an assignment) |
| A person's voice | `voiceprints` rows, one per sample | enrollment, only for people who turned it on |
| Whether a person may be recognized | `users.voice_id_enabled` (absent = off) | that person, in Settings |

`transcript_segments.speaker_name` on a diarized line is always `speakerLabel(speaker_id)` (`Speaker <n+1>`): written with the key, rewritten only when a person moves the line to another key, never the person's name. Every surface shows a line's speaker through `resolveLineSpeaker(segment, call.speakers, roster)` (shared contracts), so an assignment is one write to `transcripts.speakers` and every line, chip, summary prompt, route and CLI print follows. Legacy recordings (`speaker_id` `mic`) and huddles (a user id) resolve to themselves.

### `transcripts.speakers[]`

```
{ key: "spk:0",
  user_id?: Id<"users">,      // a teammate
  name?: string,              // someone outside the team, typed by a person
  source: "voice" | "person", // a voice match suggested it, or a person said so
  score?: number,             // the voice match score, for "voice"
  by?: Id<"users">, at?: number }  // server only: never sent to a client
```

Clients get `WireCallSpeaker` (`key, user_id?, name?, source, score?`, in that key order, built by `wireSpeaker`), so the store's optimistic writes and the server's echo compare equal by value. The batch pass writes one entry for every key its lines use.

An entry with neither `user_id` nor `name` is an unknown voice, shown as `Speaker <n+1>`. So is an entry whose teammate the roster cannot name: whether a speaker is named, and whether a suggestion offers a confirm, is decided from the resolved name (`roster[user_id] ?? name`), never from the ids alone. A `voice` suggestion renders as a name with a quieter treatment and a one-tap confirm; confirming turns it into `person`. Assigning two keys to the same person is how a person says two clusters are one voice; nothing else is needed to merge.

## The batch pass

Runs after a voice note stops and its audio is attached, on a team with the `voice_speakers` feature (in development: only staff turn it on), for every voice note, replacing the live lines (which become a draft that only exists while recording). Every other team keeps the whisper-1 path (`transcribeRecording`) unchanged. The engine is C (Ashot, pl-1081): Scribe v3 for the words and who said them, our CAM++ worker for naming the voices. `transcripts.transcribeVoiceNote` runs it. Steps, each a pure function where it can be:

1. **Words** (`scribeWordsSource`, `lib/scribe.ts`): ElevenLabs Scribe v3 (`/v1/speech-to-text`, `model_id=scribe_v3`, `diarize=true`, word timestamps, no audio events), through `lib/elevenlabs.ts`, the ElevenLabs chokepoint, so a regulated team without a BAA never reaches it (`lib/vendorGuard`, vendor `elevenlabs`). `language_code` is sent only when the room's languages fold to exactly one; otherwise Scribe detects it. The file goes in the request only up to 8 MB (judged from storage metadata before anything is read); a longer recording goes by its storage URL (`cloud_storage_url`) and is never read into the action, whose runtime has 64 MB. Only entries of type `word` with times count. Scribe labels every word with its speaker: labels become `spk:<n>` in order of first appearance, and consecutive words of one speaker less than 0.5 s apart are one turn (the lab's rule). The whole pass has one deadline, 9 minutes, inside Convex's 10 minute action limit, so it always reaches `finishRecordingTranscript`: Scribe gets at most 5 minutes, naming gets at most 3 and whatever is left (it is skipped under a minute, and the lines are written unnamed), and the whisper fallback runs only with 3 minutes left and audio under 24 MB.
2. **Speakers** (`campplusEngine`, `lib/voiceMatch.ts`): the turns are Scribe's. Each voice's clean windows (each turn trimmed 0.1 s at both ends, minus every other voice's overlapping turn, cut to 1 to 8 s), longest first up to 90 s, are embedded by our speech worker (`lib/speechWorker.ts`: `POST $SPEECH_WORKER_URL/embed`, CAM++, model `campplus-v1`; our own service, not a vendor). Each voice's centroid is scored by cosine against each candidate's centroid, voices and people are paired one to one (Hungarian); candidates arrive as one centroid per person (`candidatesForTeam`), never their raw samples, and a pair stands only at cosine >= 0.40 and at least 0.05 clear of that voice's next-best person. These are ports of the lab's `identify.py` (`clean_windows`, `_budget`, `match` with centroids), checked against fixtures it exported (`packages/convex/test-fixtures/voiceMatch`, AMI only; real team recordings are checked locally from `~/.codecast/diarize-lab/fixtures` and never committed). The interface stays pluggable (`WordsSource`, `SpeakerEngine`).
3. **Lines** (`wordsToLines`, shared contracts). When the engine returns frame activity (`activity: { hop_s, labels: { [key]: number[] } }`, each voice's activity 0..1 per 50 ms hop), each word goes to the key with the highest mean activity over `[start - 0.05, end + 0.05]`, at least 0.15; below that floor it keeps the previous word's key. Without activity, each word goes to the turn that overlaps it most, else the nearest turn edge within 0.5 s. Either way, consecutive words of one key within 1.2 s become a line. The activity rule is the one to use: on AMI room-mic audio it put 94.0% of words on the right person against 88.6% for turn overlap (calls 93.4 vs 89.6), cpWER 32.0 vs 39.9. Both rules have a parity fixture dumped from the lab's `words_to_lines_activity` and `words_to_lines` (`packages/evals/speech/lab/parity_words_to_lines.py`). A line no voice claims joins the voice of the line before it when stored (`linesToSegments`).
4. **Write** (`transcripts.writeSpeechPass`): segments with `speaker_id = spk:<n>`, `transcripts.speakers` with suggestions, then summary and routes as today (`finishRecordingTranscript`). New lines take seq numbers after the draft's, so an old line reference fails plainly instead of pointing at a different line. A route that had delivered the whole draft counts the replacement as delivered, so an agent never hears a note twice; a route that had not (an `after` route) gets the diarized lines. Advancing a route applies only when the draft had lines: a note with none (a phone's, `last_seq` 0) leaves every route owing it. Once a person has said who any voice is (`source: "person"`), the pass refuses to replace the lines: Scribe's keys are not stable across runs, so new lines would carry that name onto another voice. A suggestion is checked again at the write: it stands only for a person who still has recognition on and is still on the recording's team; otherwise the voice is written unknown. Attaching the same audio twice, or audio to a note already diarized, schedules nothing.

`lib/speechPipeline.ts` holds the pass as `runSpeechPipeline(ctx, transcript, { words: WordsSource, speakers: SpeakerEngine })`. A words source that labels its own words (Scribe) puts the key on each word, and `wordsToLines` keeps it; the overlap and activity rules are for sources that don't.

When something fails:

- **The worker does not answer**, or answers in another embedding space: the lines still go on their speakers and every voice stays `Speaker N`; a person can name them.
- **Scribe fails** (no key, a refusal for a regulated team, an error, a timeout, no words): the note gets what it would have had without the feature. A note with live words keeps them; a note with none goes through whisper-1 when time and size allow, and is marked failed otherwise. The log says so.

The summary prompt has three kinds: a huddle (attribution exact), an undiarized recording (voices not separated, attribute only from the words), and a diarized recording (named voices are attributable, a `Speaker N` is never given a guessed name).

Candidates for voice matching are the members of the recording's team who turned recognition on and have at least one voiceprint. A suggestion stands only above the engine's threshold and clear of the runner-up; otherwise the speaker stays `Speaker <n+1>`. A confident wrong name costs more than an honest unknown, and the tuning objective weights it so (`right - 2 x wrong`).

## Enrollment and consent

- `users.voice_id_enabled` is off until the person turns it on (BIPA wants consent before collection). With it off, nothing about their voice is stored, they are never suggested, and an assignment to them stores no sample.
- Enrollment (`voiceprints.enrollFromSpeaker`) embeds the voice's clean windows from the recording's own lines on that key, 60 s at most, and stores each window's vector as a sample (engine `campplus-v1`, newest 50 kept).
- A first sample comes only from the person themselves: naming their own voice in a recording, or a voice note with one speaker that they recorded (their own dictation). Someone else's assignment or confirmation never creates a first sample; it adds one only as a confirmation, when the engine scores the cluster at or above its accept threshold against the person's existing voiceprint. So it is not even scheduled for a person with no samples, and it is scheduled with `match_required`, which `addSamples` enforces by refusing it when the person has no samples of that engine. Huddle tracks are a later source. Enrollment is `voiceprints.enrollFromSpeaker`, a no-op until an engine is chosen; `addSamples` checks consent again at the write and keeps the newest 50 per engine.
- Settings shows the count of samples and when they were last added, a switch, and Delete. Turning the switch off, Delete, and deleting the account all forget the voice (`lib/voiceForget.ts`): every `voiceprints` row goes; any copy an engine holds on its side (a row's `ref`) is deleted through the engine's delete API (`voiceprints.forgetEngineRefs`); and every voice-match suggestion naming the person is scrubbed from their teams' recordings, page by page (`voiceprints.scrubVoiceSuggestions`), so the voice reads `Speaker N` again. A person's word (`source: "person"`) stays: it is what someone said, not something learned from the voice.
- An engine that keeps voiceprints on its side (engine B, pyannoteAI identify) must offer a delete API, which `forgetEngineRefs` calls; otherwise it may only be sent the vectors per request and keep none. This is a requirement on choosing it.
- A voiceprint is readable by its owner alone, and only as counts (`myVoiceprint`). Vectors are read server-side as match candidates (`candidatesForTeam`) and never sent to a client.

## Contract for the UI

Shared (`@codecast/shared/contracts`, `speakers.ts`):

- `resolveLineSpeaker(segment, speakers, roster) => { key, name, user_id?, source?, suggested }`. Build `roster` with `callSpeakerRoster(call, teamMembers)`: the call's own `speaker_names` (sent by `webGetCall` for every teammate its speakers name, whatever workspace the viewer is in) over the viewer's team members for anyone the server has not named yet. Names only, never an email; server names win. Web and phone both use it, so they name a speaker the same way. `suggested` is a voice match nobody confirmed: show the name quieter with a confirm.
- `speakerKey(n)`, `speakerIndex(key)`, `isSpeakerKey(key)`, `speakerLabel(key)`, `nextSpeakerKey(speakers)` (the key "move to a new speaker" uses).
- `SpeakerAssignment = { user_id } | { name } | { clear: true }`, and the writers both sides use: `assignedSpeaker`, `confirmedSpeaker`, `withSpeaker`, `wireSpeaker(s)`.
- Types `CallSpeaker`, `WireCallSpeaker`, `SpeakerRoster`, `ResolvedSpeaker`, `TimedWord`, `SpeakerTurn`, `SpeakerActivity`, `SpeakerLine`.

Server (`transcripts.ts`): `assignSpeaker({ transcript_id, key, user_id? | name? | clear? })` (exactly one; a name is trimmed, 1 to 80 characters), `confirmSpeaker({ transcript_id, key })`, `moveLineSpeaker({ transcript_id, seq, key })` (an existing key or `nextSpeakerKey`, which starts as an unknown voice; refused on a recording with no `speakers`, so a legacy `mic` recording never gains a lone `spk:0` and reads as diarized). Allowed for whoever `canReadCall` admits with the live door closed (the creator, and the team once the recording is shared), on voice notes only (`rec:` rooms). A named teammate must be on the recording's team. `webGetCall` carries `speakers` (wire shape) and `speaker_names` beside the segments as written; expectation grounding counts a voice note's line as the person's only when a person named that voice (`source: "person"`), never on a voice match; the CLI, excerpts, search, route delivery, the digest fallback, the summary, the public share page, the org analysis read (`orgSaid.ts`) and expectation citations (`expectations.ts`) name lines through `lineSpeakerNames` (`lib/callSpeakers.ts`).

Web store (`inboxStore`, each an `asyncAction` that writes the draft first, then dispatches):

- `assignCallSpeaker(transcriptId, key, assignment)`, `confirmCallSpeaker(transcriptId, key)`, `moveCallLineSpeaker(transcriptId, seq, key)`: write `callDetails[id].speakers` / `.segments` whole. `callDetails` is localFirst (routes excepted), so the field locks hold until the echo matches; a refusal releases them. `speakers` and `segments` are deep-compared on sync, so a correction from another device lands even when no scalar on the row changed.
- `setVoiceIdEnabled(enabled)`: writes `currentUser.voice_id_enabled` (the switch's one home; in the currentUser projection) and, when off, zeroes `myVoiceprint`. `deleteMyVoiceprints()` zeroes `myVoiceprint`.
- `myVoiceprint` is a localFirst singleton `{ count, seconds, last_added_at }` fed by `voiceprints.myVoiceprint`; read it with `useMyVoiceprint()` (`hooks/useSyncCalls.ts`).

## Where the code lives

- `packages/shared/contracts/speakers.ts`: `resolveLineSpeaker`, `speakerLabel`, `wordsToLines`, types.
- `packages/convex/convex/transcripts.ts`: `assignSpeaker`, `confirmSpeaker`, `moveLineSpeaker`, `writeSpeechPass`; the batch pass in `lib/speechPipeline.ts`; server-side naming in `lib/callSpeakers.ts`.
- `packages/convex/convex/voiceprints.ts`: the switch, my samples' counts, delete mine, candidates for a team, add samples, enroll.
- `packages/convex/convex/lib/scribe.ts`, `lib/elevenlabs.ts`, `lib/speechWorker.ts`, `lib/voiceMatch.ts`: engine C's words, its vendor chokepoint, the worker client, and the matcher.
- Web: the call page's speaker strip and line menu; Settings › Voice.
- Mobile: the recording screen's speaker strip and line sheet; Settings › Voice.
