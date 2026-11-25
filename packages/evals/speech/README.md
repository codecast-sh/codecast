# Speech lab

Measures how well a recording comes back as words and speakers, so changes to transcription and speaker attribution are chosen by numbers. Plan pl-1081; design in `docs/architecture/speaker-attribution.md`.

Audio and labels are real meetings and never enter git. Everything lives under `SPEECH_LAB_HOME` (default `~/.codecast/diarize-lab`): items, model files, caches, runs.

## Setup

```bash
cd packages/evals/speech
uv venv -p 3.12 ~/.codecast/diarize-lab/venv && VIRTUAL_ENV=~/.codecast/diarize-lab/venv uv pip install -r lab/requirements.txt
# models (sherpa-onnx releases): pyannote segmentation 3.0, CAM++ / ResNet34 / TitaNet embeddings, silero VAD, parakeet v3
```

## Sets

| Set | Input | Speaker truth | Words truth |
|---|---|---|---|
| `ami` | AMI ES2004a-d, far-field `Array1-01`: one room mic, like a phone on the table | AMI manual annotation | gold, word level |
| `calls` | our recorded huddles' composite file | each line's own LiveKit track | silver (the live recognizer's words); lines anchored to the audio by word alignment |

```bash
bun lab/fetch_calls.ts cl-180 cl-137 cl-147       # pull calls (CLI auth)
python lab/datasets.py calls cl-180 cl-137 cl-147 && python lab/datasets.py align
python lab/datasets.py ami ES2004a ES2004b ES2004c ES2004d   # after downloading AMI audio + annotations
```

Enrollment never uses the item being scored: AMI enrolls from the same people's headsets (or room mic) in the series' other meetings, calls from the other calls.

## Run and score

```bash
cd lab
python lab.py run ami "asr=whisper-1:chunk_min=5:language=en,diar=vdiar:accept=0.3,id=voiceprint:enroll=headset"
python lab.py show <run> --items
python sweep.py 0/3 & python sweep.py 1/3 & python sweep.py 2/3   # tune vdiar's cheap stage on DEV, report HELD
```

OpenAI stacks need `cast vault run openai-api-key -- python ...`.

A stack is `asr=…,diar=…,id=…`:
- `asr`: `whisper-1`, `gpt-transcribe`, `parakeet` (local), `live` (replays the browser's Realtime session), `scribe_v3`
- `diar`: `vdiar` (voice-aware: names windows against enrolled voices, clusters the rest), `sherpa` (plain clustering), `oracle` (true turns, names hidden: isolates identification)
- `id`: `voiceprint` (CAM++ embeddings, one-to-one matching with threshold and margin)

## Metrics

| Column | Meaning |
|---|---|
| WER | words only |
| cpWER | words and speakers, best speaker mapping (meeteval) |
| DER / conf | diarization error, overlap counted; `conf` is the speaker-confusion part (calls' DER is not meaningful: silver lines miss speech) |
| named / wrong / unnamed | share of reference words whose time the output covers with the right person / a wrong person / no name |
| w-right / w-wrong | of the words the transcript prints, the share on the right / a wrong person: what a reader sees |

Tuning objective: `w-right - 2 x w-wrong`. A confident wrong name costs more than an honest "Speaker 2".

## Findings that shaped production

- gpt-transcribe on a whole 17 min file returned 163 of 2,533 words. Cut the file at quiet points into ~1 min pieces.
- No language pin: whisper-1 translated accented English into Welsh. Pin the room's languages.
- The live gpt-live-transcribe mint 400s whenever `turn_detection` is set, so production fell back to gpt-4o-mini-transcribe with no language limit: 1,029 "Ja." lines in 60 calls.
- With true turns, CAM++ voiceprints name everyone right (right person 0.85-0.96, others < 0.5). The hard part is splitting the audio into turns.
- Naming each 10 s window against enrolled voices, then naming leftover clusters as wholes, beats clustering first and naming after. Giving each word the speaker with the most frame activity over the word (not the turn it falls in) took words on the right person from 88.6% to 94.0%.
- Tuning with everyone enrolled hid the dangerous case: a stranger's words went to a teammate (47-94% of them). Tuned with one person left out (sweep `SCENARIOS`), wrong names stay at 2.6-4.2% on the untouched IS1009 series, at the cost of 88% (not 95%) right when everyone is enrolled. 10 s of enrolled voice works as well as 2 min.
