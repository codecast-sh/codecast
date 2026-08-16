#!/usr/bin/env python3
"""The huddle ringtone — source of truth for the bundled sound assets.

    python3 scripts/ringtone.py            # writes ring_a/b/c.wav here
    afconvert -f m4af -d aac -b 96000 ring_a.wav ../assets/sounds/huddle-ring.m4a
    # 24s cut for the closed-app push (iOS caps notification sounds at 30s):
    #   concatenate 8 cells of ring_a.wav, then
    afconvert -f caff -d LEI16 huddle-ring-long.wav ../assets/sounds/huddle-ring.caf

Candidate A ("doorbell, reimagined") is what ships: a friendly knock
(G#5→E5) then a brighter answer (B5→E6) over a soft low E, struck-bell
timbre. Web plays the SAME motif synthesized live in
packages/web/lib/sounds.ts (soundCallRing) — keep the two in step. One cell
is CALL_RING_PERIOD_MS (3.0s, packages/shared/contracts/callPush.ts).

Design goals: warm, friendly, technical-clean (Solarized/terminal brand),
instantly recognizable, pleasant on a loop, phone-speaker friendly.
Pure Python (no numpy) so it runs anywhere.
"""
import math
import wave
import struct

SR = 48000
TWO_PI = 2 * math.pi


def bell(freq, dur, amp=1.0, decay=5.0,
         partials=((1.0, 1.0), (2.0, 0.35), (2.76, 0.18), (4.07, 0.06))):
    """Struck-bell / marimba hybrid: harmonic + slightly inharmonic partials,
    exponential decay, soft 4 ms attack to avoid clicks."""
    n = int(SR * dur)
    out = [0.0] * n
    for ratio, pamp in partials:
        w = TWO_PI * freq * ratio / SR
        for i in range(n):
            t = i / SR
            out[i] += pamp * math.sin(w * i) * math.exp(-decay * t)
    for i in range(min(n, int(0.004 * SR))):
        out[i] *= i / (0.004 * SR)
    return [amp * x for x in out]


def thump(freq, dur, amp=0.5):
    """Soft felt-mallet low accent under beat one."""
    n = int(SR * dur)
    w = TWO_PI * freq / SR
    out = [amp * math.sin(w * i) * math.exp(-9.0 * (i / SR)) for i in range(n)]
    for i in range(min(n, int(0.005 * SR))):
        out[i] *= i / (0.005 * SR)
    return out


def place(bufL, bufR, sound, at, pan=0.0):
    i0 = int(at * SR)
    lg = math.sqrt(0.5 * (1 - pan))
    rg = math.sqrt(0.5 * (1 + pan))
    for j, s in enumerate(sound):
        i = i0 + j
        if i >= len(bufL):
            break
        bufL[i] += s * lg
        bufR[i] += s * rg


def render(name, total, events, master=0.85):
    n = int(SR * total)
    L = [0.0] * n
    R = [0.0] * n
    for ev in events:
        place(L, R, ev["snd"], ev["at"], ev.get("pan", 0.0))
    peak = max(max(abs(x) for x in L), max(abs(x) for x in R)) or 1.0
    g = master / peak
    fade = int(0.05 * SR)
    frames = bytearray()
    for i in range(n):
        f = (n - i) / fade if i > n - fade else 1.0
        l = int(max(-1, min(1, L[i] * g * f)) * 32767)
        r = int(max(-1, min(1, R[i] * g * f)) * 32767)
        frames += struct.pack("<hh", l, r)
    with wave.open(name, "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(frames))
    print("wrote", name)


N = {
    "E4": 329.63, "G#4": 415.30, "B4": 493.88, "C#5": 554.37,
    "E5": 659.25, "F#5": 739.99, "G#5": 830.61, "B5": 987.77,
    "C#6": 1108.73, "E6": 1318.51,
}

# ── Candidate A: "doorbell, reimagined" ──────────────────────────────────
render("ring_a.wav", 3.0, [
    {"at": 0.00, "snd": thump(N["E4"], 0.5, 0.5)},
    {"at": 0.00, "snd": bell(N["G#5"], 1.2, 0.9, 4.5), "pan": -0.25},
    {"at": 0.18, "snd": bell(N["E5"], 1.4, 0.8, 4.0), "pan": 0.10},
    {"at": 0.72, "snd": bell(N["B5"], 1.1, 0.65, 5.0), "pan": 0.30},
    {"at": 0.90, "snd": bell(N["E6"], 1.5, 0.55, 4.5), "pan": -0.10},
    {"at": 0.72, "snd": thump(N["E4"] * 0.75, 0.4, 0.30)},
])

# ── Candidate B: "the ascent" ────────────────────────────────────────────
render("ring_b.wav", 3.0, [
    {"at": 0.00, "snd": thump(N["E4"], 0.5, 0.45)},
    {"at": 0.00, "snd": bell(N["E5"], 0.9, 0.80, 6.0), "pan": -0.30},
    {"at": 0.14, "snd": bell(N["F#5"], 0.9, 0.70, 6.0), "pan": -0.10},
    {"at": 0.28, "snd": bell(N["G#5"], 0.9, 0.72, 6.0), "pan": 0.10},
    {"at": 0.42, "snd": bell(N["B5"], 1.0, 0.75, 5.0), "pan": 0.30},
    {"at": 0.62, "snd": bell(N["C#6"], 1.8, 0.85, 3.2)},
    {"at": 0.62, "snd": bell(N["C#5"], 1.8, 0.30, 3.2)},
])

# ── Candidate C: "old phone, new voice" ──────────────────────────────────
def pulse(at, events):
    events.append({"at": at, "snd": bell(N["E5"], 0.55, 0.85, 7.0), "pan": -0.15})
    events.append({"at": at, "snd": bell(N["B5"], 0.55, 0.55, 7.0), "pan": 0.15})
    events.append({"at": at + 0.02, "snd": bell(N["E6"], 0.4, 0.18, 8.0)})

evs = [{"at": 0.0, "snd": thump(N["E4"], 0.4, 0.4)}]
pulse(0.00, evs)
pulse(0.28, evs)
pulse(1.05, evs)
pulse(1.33, evs)
render("ring_c.wav", 3.0, evs)
