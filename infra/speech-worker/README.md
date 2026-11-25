# speech-worker

A small CPU container that turns spans of a recording into CAM++ voice vectors for Convex's speaker matching (docs/architecture/speaker-attribution.md, plan pl-1081).

It runs the same model with the same math as the speech lab (`packages/evals/speech/lab/identify.py`, `embed`), so production reproduces the lab's numbers: sherpa-onnx 2.0.2 `SpeakerEmbeddingExtractor` with `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` (k2-fsa/sherpa-onnx release `speaker-recongition-models`, sha256 checked at build), fed 16 kHz mono float32, output L2-normalized. The vectors have **512** dimensions; that is what this model emits and what the lab's fixtures hold.

## Contract

`POST /embed` with `Authorization: Bearer $SPEECH_WORKER_SECRET`:

```json
{ "audio_url": "https://...", "spans": [ { "key": "speaker_0", "windows": [[12.3, 19.8], [40.1, 47.0]] } ] }
```

answers 200:

```json
{ "model": "campplus-v1", "vectors": { "speaker_0": [[512 floats], [512 floats]] }, "duration_s": 2052.437 }
```

- One vector per window, in the order sent. A window shorter than 0.5 s (after cutting it to the end of the audio) gets `null`.
- The audio is a recording in webm/opus, m4a/aac, mp4, ogg, wav, mp3 or flac. It is downloaded once and decoded to 16 kHz mono, at most the first 4 hours.
- `audio_url` must be https on a host in `ALLOWED_AUDIO_HOSTS`, and must answer directly: a redirect is refused. ffmpeg reads the file from stdin and may open no other protocol and no playlist or concat demuxer, so an uploaded file cannot make the worker fetch anything else.
- Keys are any non-empty strings, unique within a request. Windows are `[start_s, end_s]` with `0 <= start <= end`.

| Status | When |
|---|---|
| 401 | missing or wrong secret |
| 400 | bad body; the `error` names the field, e.g. `spans[2].windows[0]`, or an `audio_url` host not allowed |
| 413 | audio over 2 GB, more than 600 windows in total, or a body over 4 MB |
| 422 | ffmpeg cannot decode the audio, or it has no audio stream |
| 502 | the download failed, answered non-2xx, or redirected |
| 503 | four requests already waiting; retry later |
| 504 | the request passed its 10 min cap (queue wait included) |

Every error body is `{ "error": "<what>" }`.

`GET /health` answers `{"ok":true,"model":"campplus-v1"}` without auth.

Requests compute one at a time per process; up to four more wait in line.

## Environment

| Variable | Default | |
|---|---|---|
| `SPEECH_WORKER_SECRET` | none, required | the bearer secret; Convex holds the same value |
| `ALLOWED_AUDIO_HOSTS` | none, required | comma-separated hosts `audio_url` may name; production is `convex.codecast.sh` (Convex storage) |
| `PORT` | 8080 | Railway sets it |
| `EMBED_THREADS` | 1 | onnxruntime threads per window; more was slower in measurement |
| `MODEL_PATH` | `/models/3dspeaker_...onnx` | set by the image |
| `ALLOW_HTTP_AUDIO` | off | `1` accepts plain `http://` audio URLs, for local tests only |

## Run locally

With the lab's venv (Python 3.12, sherpa-onnx 2.0.2) and the lab's model:

```bash
SPEECH_WORKER_SECRET=localtest ALLOW_HTTP_AUDIO=1 ALLOWED_AUDIO_HOSTS=127.0.0.1 PORT=8091 \
  MODEL_PATH=~/.codecast/diarize-lab/models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx \
  ~/.codecast/diarize-lab/venv/bin/python server.py
```

Or the image:

```bash
docker build -t speech-worker .
docker run --rm -p 8091:8080 -e SPEECH_WORKER_SECRET=localtest -e ALLOW_HTTP_AUDIO=1 \
  -e ALLOWED_AUDIO_HOSTS=host.docker.internal speech-worker
```

## Parity test

`parity_test.py` sends a lab fixture's `clusters` windows to a running worker, requires every vector to match the fixture's (cosine >= 0.999; the fixture rounds to 4 decimals), and checks the error answers (including a refused redirect, a refused host and an HLS playlist posing as a recording) and the short-window `null`. It serves the audio from this machine:

```bash
SPEECH_WORKER_SECRET=localtest ~/.codecast/diarize-lab/venv/bin/python parity_test.py \
  --worker http://127.0.0.1:8091 \
  --audio ~/.codecast/diarize-lab/ami/IS1009b/IS1009b.sdm16k.wav \
  --fixture ~/.codecast/diarize-lab/fixtures/IS1009b.json
```

Against a container add `--audio-host host.docker.internal`. Against the deployed worker pass `--audio-url <public https URL of the same file>` instead of `--audio` (the local error cases that need the file server are skipped). IS1009b's source is `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/IS1009b/audio/IS1009b.Array1-01.wav`, the same 16 kHz samples as the lab's copy; add `groups.inf.ed.ac.uk` to `ALLOWED_AUDIO_HOSTS` for the run and take it out after.

## Deploy

Railway, project `codecast`, service `speech-worker`, built from this directory's Dockerfile (`railway.json`):

```bash
cd infra/speech-worker
railway link -p codecast -s speech-worker
railway up --service speech-worker --detach
```

The secret is in the vault as `speech-worker-secret`; Convex reads `SPEECH_WORKER_URL` and `SPEECH_WORKER_SECRET` from its env.
