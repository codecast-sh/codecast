"""The live path, replayed: the same Realtime transcription session the browser opens
(shared/contracts/transcribeLanguage.ts asrTranscriptionSession), fed a file as 24 kHz PCM16,
committing on speech_stopped (vad=server) or where the shipped client endpointer closes a turn (vad=client). Lines take the
server's own audio_start_ms/audio_end_ms, so timing is the audio's, not a client clock.

  asr=live[:model=gpt-live-transcribe:languages=en:speed=4]
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import time
import urllib.request

PRICE_PER_MIN = {"gpt-live-transcribe": 1.02 / 60, "gpt-4o-mini-transcribe": 0.003, "gpt-4o-transcribe": 0.006}


def session_body(model, languages, prompt=None, keywords=None, vad=True):
    transcription = {"model": model}
    if languages:
        transcription["languages"] = languages
    if prompt:
        transcription["prompt"] = prompt
    if keywords:
        transcription["keywords"] = keywords
    inp = {"format": {"type": "audio/pcm", "rate": 24000}, "transcription": transcription}
    if vad:
        inp["turn_detection"] = {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 600}
    return {"type": "transcription", "audio": {"input": inp}}


def mint(body):
    req = urllib.request.Request("https://api.openai.com/v1/realtime/client_secrets",
                                 data=json.dumps({"session": body}).encode(),
                                 headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"mint {e.code}: {e.read().decode()[:400]}")
    return d.get("value") or d["client_secret"]["value"]


def endpoints(pcm):
    """Client-side turn ends from the PCM itself, decided by the endpointer the browser and phone
    ship (shared/contracts/asrEndpointer.ts via endpoints.ts), so the replay commits where they would.
    -> [(start_s, end_s, commit_at_byte)]"""
    here = os.path.dirname(os.path.abspath(__file__))
    r = subprocess.run(["bun", os.path.join(here, "endpoints.ts")], input=pcm, capture_output=True, check=True)
    return [tuple(x) for x in json.loads(r.stdout)]


async def _stream(pcm, secret, model, speed, client_vad=False):
    import websockets
    url = "wss://api.openai.com/v1/realtime?intent=transcription"
    lines, starts, errors = [], {}, []
    pending = []  # client-committed spans, answered in order
    commit_on_stop = model == "gpt-live-transcribe" and not client_vad
    async with websockets.connect(url, subprotocols=["realtime", f"openai-insecure-api-key.{secret}"],
                                  max_size=None) as ws:
        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                t = m.get("type")
                if t == "input_audio_buffer.speech_started":
                    starts[m.get("item_id")] = m.get("audio_start_ms", 0)
                elif t == "input_audio_buffer.speech_stopped":
                    starts.setdefault(m.get("item_id"), m.get("audio_start_ms", 0))
                    starts[(m.get("item_id"), "end")] = m.get("audio_end_ms", 0)
                    if commit_on_stop:
                        await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                elif t == "conversation.item.input_audio_transcription.completed":
                    iid = m.get("item_id")
                    text = (m.get("transcript") or "").strip()
                    if client_vad:
                        span = pending.pop(0) if pending else (0, 0)
                        if text:
                            lines.append({"start": span[0], "end": span[1], "text": text, "item": iid})
                    elif text:
                        lines.append({"start": starts.get(iid, 0) / 1000, "end": starts.get((iid, "end"), 0) / 1000,
                                      "text": text, "item": iid})
                elif t == "error":
                    errors.append(m.get("error", {}).get("message", ""))

        rt = asyncio.create_task(reader())
        step = 24000 * 2 // 10  # 100 ms of PCM16
        cuts = endpoints(pcm) if client_vad else []
        ci = 0
        sent = 0
        for i in range(0, len(pcm), step):
            chunk = pcm[i:i + step]
            await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(chunk).decode()}))
            sent += len(chunk)
            while ci < len(cuts) and cuts[ci][2] <= sent:
                pending.append(cuts[ci][:2])
                await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                ci += 1
            await asyncio.sleep(0.1 / speed)
        sil = bytes(step)
        for _ in range(15):
            await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(sil).decode()}))
            await asyncio.sleep(0.1 / speed)
        n = -1
        for _ in range(90):
            await asyncio.sleep(1)
            if len(lines) == n and not (client_vad and pending):
                break
            n = len(lines)
        rt.cancel()
    return lines, errors


def live(item, model="gpt-live-transcribe", languages="en", speed=4, prompt=None, keywords=None, vad="server"):
    langs = [x for x in str(languages or "").split("+") if x]
    kws = [x for x in str(keywords or "").split("+") if x] or None
    pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", item["audio"], "-ac", "1", "-ar", "24000",
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    secret = mint(session_body(model, langs, prompt, kws, vad=(vad == "server")))
    t = time.time()
    lines, errors = asyncio.run(_stream(pcm, secret, model, float(speed), client_vad=(vad == "client")))
    lines.sort(key=lambda l: l["start"])
    return {"segments": lines, "words": None, "errors": errors[:20], "seconds": time.time() - t,
            "cost_usd": PRICE_PER_MIN.get(model, 0.017) * item["duration"] / 60}
