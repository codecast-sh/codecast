"""Diarization that knows the voices it expects.

1. pyannote segmentation-3.0 reads 10 s windows (step `step` s) and says, per 17 ms frame, which
   of up to 3 local speakers talks (powerset: at most 2 at once).
2. Each local speaker with enough speech in a window gets an embedding from the frames where it
   talks alone (all its frames when it never does).
3. Those embeddings are named: against enrolled people when there are any (one-to-one inside a
   window, a name only above `accept`), and everything left is clustered agglomeratively with the
   same cannot-link (two local speakers in one window are two people) into Speaker 1..k.
4. Frame activity is averaged over the overlapping windows per global label and binarized into
   turns, with short gaps closed and blips dropped.

Returns {"turns": [{speaker, start, end, person?}], "meta"} with `person` set for named turns.
"""
from __future__ import annotations

import os

import numpy as np

from common import MODELS, read_wav
from identify import extractor

VERSION = 6  # bump when the cheap stage changes: lab caches results by params + this
SR = 16000
WIN = 160000
SHIFT = 270
RF = 991
POWERSET = [(), (0,), (1,), (2,), (0, 1), (0, 2), (1, 2)]
_SEG = None


def _seg():
    global _SEG
    if _SEG is None:
        import onnxruntime as ort
        o = ort.SessionOptions()
        o.intra_op_num_threads = int(os.environ.get("LAB_THREADS", "4"))
        _SEG = ort.InferenceSession(str(MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"), o)
    return _SEG


def segment(audio, step=2.5, batch=16):
    """-> (starts [n], act [n, F, 3] bool)"""
    n = max(1, int(np.ceil((len(audio) - WIN) / (step * SR))) + 1)
    starts = [int(i * step * SR) for i in range(n)]
    chunks = []
    for s in starts:
        c = audio[s:s + WIN]
        if len(c) < WIN:
            c = np.pad(c, (0, WIN - len(c)))
        chunks.append(c)
    sess = _seg()
    outs = []
    for i in range(0, n, batch):
        x = np.stack(chunks[i:i + batch])[:, None, :].astype(np.float32)
        outs.append(sess.run(None, {"x": x})[0])
    y = np.concatenate(outs)  # n, F, 7
    cls = y.argmax(-1)
    F = y.shape[1]
    act = np.zeros((n, F, 3), bool)
    for k, spk in enumerate(POWERSET):
        for s in spk:
            act[:, :, s] |= cls == k
    return np.array(starts) / SR, act


def frame_time(f):
    return (f * SHIFT + RF / 2) / SR


def _embed_frames(audio, w0, frames, model):
    """Embedding from the given frames of window starting at w0 (seconds)."""
    if len(frames) == 0:
        return None
    # contiguous runs of frames -> sample spans
    runs, a = [], frames[0]
    for p, q in zip(frames, frames[1:]):
        if q != p + 1:
            runs.append((a, p))
            a = q
    runs.append((a, frames[-1]))
    pieces = []
    for (x, y) in runs:
        s = int((w0 + frame_time(x) - SHIFT / SR / 2) * SR)
        e = int((w0 + frame_time(y) + SHIFT / SR / 2) * SR)
        pieces.append(audio[max(0, s):max(0, e)])
    sig = np.concatenate(pieces) if pieces else np.zeros(0, np.float32)
    if len(sig) < 0.5 * SR:
        return None
    ex = extractor(model)
    st = ex.create_stream()
    st.accept_waveform(SR, sig)
    st.input_finished()
    v = np.array(ex.compute(st), np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


def _agglomerate(E, groups, threshold):
    """Average-linkage on cosine similarity, never merging two clusters that share a window.
    Lance-Williams on pairwise similarity SUMS; the cannot-link matrix is updated per merge."""
    n = len(E)
    if n == 1:
        return [0]
    S = (E @ E.T).astype(np.float64)
    g = np.asarray(groups)
    conflict = g[:, None] == g[None, :]
    size = np.ones(n)
    alive = np.ones(n, bool)
    label = np.arange(n)
    while True:
        avg = S / np.outer(size, size)
        avg[conflict] = -np.inf
        avg[~alive, :] = -np.inf
        avg[:, ~alive] = -np.inf
        k = int(np.argmax(avg))
        i, j = divmod(k, n)
        if not np.isfinite(avg[i, j]) or avg[i, j] <= threshold:
            break
        S[i, :] += S[j, :]
        S[:, i] += S[:, j]
        size[i] += size[j]
        conflict[i, :] |= conflict[j, :]
        conflict[:, i] |= conflict[:, j]
        alive[j] = False
        label[label == j] = i
    _, out = np.unique(label, return_inverse=True)
    return list(out)


def units_of(audio, model="campplus", step=2.5, min_speech=1.0, cache_key=None):
    """Stage 1 (slow): window activity and one embedding per local speaker per window."""
    from common import CACHE
    p = CACHE / "vdiar-units" / f"{cache_key}-{model}-{step}-{min_speech}.npz" if cache_key else None
    if p and p.exists():
        z = np.load(p)
        return z["starts"], z["act"], [(int(w), int(k), e) for w, k, e in zip(z["uw"], z["uk"], z["ue"])]
    starts, act = segment(audio, step)
    n = act.shape[0]
    fdur = SHIFT / SR
    units = []
    for w in range(n):
        for k in range(3):
            fr = np.where(act[w, :, k])[0]
            if len(fr) * fdur < min_speech:
                continue
            alone = np.where(act[w, :, k] & (act[w].sum(-1) == 1))[0]
            e = _embed_frames(audio, starts[w], alone if len(alone) * fdur >= min_speech else fr, model)
            if e is not None:
                units.append((w, k, e))
    if p:
        p.parent.mkdir(parents=True, exist_ok=True)
        np.savez(p, starts=starts, act=act, uw=np.array([u[0] for u in units]), uk=np.array([u[1] for u in units]),
                 ue=np.stack([u[2] for u in units]) if units else np.zeros((0, 192), np.float32))
    return starts, act, units


def _unit(v):
    return v / (np.linalg.norm(v) + 1e-9)


def _second_pass(E, units, label, prints, accept_cluster, margin, fold_units, merge_unknown=0.55, overlap_max=0.2, self_ref=True):
    """Name or fold the unnamed clusters as wholes.

    A cluster's averaged voice is steadier than any one window's. It is compared with each
    person's enrolled voice and with that person's voice as heard earlier in THIS recording (same
    mic, same room), and takes the name when the better of the two clears `accept_cluster` and
    beats the runner-up by `margin`, unless the cluster often talks in the same window as that
    person (two voices at once are two people). A cluster with fewer than `fold_units` windows is
    too little speech to stand as its own speaker and joins its nearest label by voice."""
    label = list(label)
    win = [u[0] for u in units]

    def members(l):
        return [i for i, x in enumerate(label) if x == l]

    def centroid(l):
        return _unit(E[members(l)].mean(0))

    def overlap(a, b):
        wa, wb = {win[i] for i in members(a)}, {win[i] for i in members(b)}
        return len(wa & wb) / max(1, len(wa))

    people = list(prints or {})
    enrolled = {p: _unit(prints[p].mean(0)) for p in people}
    for _ in range(3):
        changed = False
        named_now = {l for l in set(label) if not l.startswith("U")}
        for u in sorted({l for l in label if l.startswith("U")}, key=lambda l: -len(members(l))):
            c = centroid(u)
            scores = {}
            for p in people:
                s = float(c @ enrolled[p])
                if self_ref and p in named_now:
                    s = max(s, float(c @ centroid(p)))
                scores[p] = s
            if not scores:
                break
            ranked = sorted(scores.items(), key=lambda kv: -kv[1])
            p, s = ranked[0]
            second = ranked[1][1] if len(ranked) > 1 else -1
            if s >= accept_cluster and s - second >= margin and (p not in named_now or overlap(u, p) <= overlap_max):
                for i in members(u):
                    label[i] = p
                changed = True
        if not changed:
            break
    # unnamed clusters that sound alike are one unknown person (looser than the first clustering,
    # which ran on single windows)
    while True:
        us = [l for l in set(label) if l.startswith("U")]
        best, pair = merge_unknown, None
        for a in range(len(us)):
            for b in range(a + 1, len(us)):
                if overlap(us[a], us[b]) > overlap_max:
                    continue
                s = float(centroid(us[a]) @ centroid(us[b]))
                if s > best:
                    best, pair = s, (us[a], us[b])
        if not pair:
            break
        for i in members(pair[1]):
            label[i] = pair[0]
    # fold slivers
    for u in sorted({l for l in label if l.startswith("U")}, key=lambda l: len(members(l))):
        if len(members(u)) >= fold_units:
            continue
        others = [l for l in set(label) if l != u and len(members(l)) >= fold_units and overlap(u, l) <= overlap_max]
        if not others:
            continue
        c = centroid(u)
        best = max(others, key=lambda l: float(c @ centroid(l)))
        for i in members(u):
            label[i] = best
    # renumber unnamed clusters by size: U0 is the biggest unknown voice
    us = sorted({l for l in label if l.startswith("U")}, key=lambda l: -len(members(l)))
    ren = {u: f"U{k}" for k, u in enumerate(us)}
    return [ren.get(l, l) for l in label]


def diarize(audio, prints=None, model="campplus", step=2.5, min_speech=1.0, accept=0.5, margin=0.05,
            cluster=0.45, onset=0.35, min_on=0.25, min_off=0.6, accept_cluster=0.45, fold_units=4,
            merge_unknown=0.65, self_ref=0, cache_key=None):
    """Defaults are the open-set-safe tuning (sweep.py, SCENARIOS with one person unenrolled): on the
    untouched IS1009 series, 88.1% of words on the right person with everyone enrolled and 2.6-3.6%
    on a wrong person when one speaker is a stranger. Comparing leftover clusters with voices named
    earlier in the same recording (self_ref) pulled strangers onto teammates; it stays off."""
    from scipy.optimize import linear_sum_assignment
    starts, act, units = units_of(audio, model, step, min_speech, cache_key)
    n, F, _ = act.shape
    fdur = SHIFT / SR
    if not units:
        return {"turns": [], "meta": {}}
    E = np.stack([u[2] for u in units])
    label = [None] * len(units)
    people = list(prints or {})
    if people:
        C = np.stack([prints[p].mean(0) / np.linalg.norm(prints[p].mean(0)) for p in people])
        S = E @ C.T
        for w in range(n):
            idx = [i for i, u in enumerate(units) if u[0] == w]
            if not idx:
                continue
            r, c = linear_sum_assignment(-S[idx])
            for ri, ci in zip(r, c):
                i = idx[ri]
                row = np.sort(S[i])
                second = row[-2] if len(row) > 1 else -1
                if S[i, ci] >= accept and S[i, ci] - second >= margin:
                    label[i] = people[ci]
    rest = [i for i in range(len(units)) if label[i] is None]
    if rest:
        labs = _agglomerate(E[rest], [units[i][0] for i in rest], cluster)
        for i, l in zip(rest, labs):
            label[i] = f"U{l}"
    label = _second_pass(E, units, label, prints, accept_cluster, margin, fold_units, merge_unknown, self_ref=bool(self_ref))
    # aggregate frame activity per label
    total = int(np.ceil((starts[-1] + WIN / SR) / fdur)) + 2
    names = sorted(set(label))
    score = {l: np.zeros(total) for l in names}
    count = np.zeros(total)
    for w in range(n):
        o = int(round(starts[w] / fdur))
        count[o:o + F] += 1
    for (w, k, _), l in zip(units, label):
        o = int(round(starts[w] / fdur))
        score[l][o:o + F] += act[w, :, k]
    turns = []
    for l in names:
        a = score[l] / np.maximum(count, 1)
        on = a >= onset
        # close short gaps, drop blips
        segs, i = [], 0
        while i < total:
            if on[i]:
                j = i
                while j < total and on[j]:
                    j += 1
                segs.append([frame_time(i), frame_time(j)])
                i = j
            else:
                i += 1
        merged = []
        for s in segs:
            if merged and s[0] - merged[-1][1] < min_off:
                merged[-1][1] = s[1]
            else:
                merged.append(s)
        for s, e in merged:
            if e - s >= min_on:
                turns.append({"speaker": l, "start": float(s), "end": float(e),
                              "person": l if not l.startswith("U") else None})
    turns.sort(key=lambda t: t["start"])
    # frame activity per label at 50 ms, for word-level speaker choice
    hop = max(1, int(round(0.05 / fdur)))
    act50 = {l: [round(float(x), 3) for x in (score[l] / np.maximum(count, 1))[::hop]] for l in names}
    return {"turns": turns, "activity": {"hop": hop * fdur, "labels": act50}, "meta": {"units": len(units), "named_units": sum(1 for l in label if not l.startswith("U")),
                                     "labels": names}}


def run(item, prints=None, **params):
    audio = read_wav(item["audio"])
    return diarize(audio, prints, cache_key=item["id"], **params)
