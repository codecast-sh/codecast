"""Name diarized speakers by voice.

Enrollment: each person's clean speech from OTHER recordings (their own headset
or huddle track, or room-mic lines a person already confirmed) becomes a set of
embeddings. Matching: each cluster in the new recording gets an embedding from
its turns that overlap nobody else; clusters and people are paired one-to-one by
cosine score, a pair stands only above a threshold and clear of the runner-up,
and anything else stays unnamed rather than guessed.
"""
from __future__ import annotations

import hashlib
import os

import numpy as np

from common import CACHE, MODELS, read_wav
from diarize import EMBED, THREADS

_EXTRACTORS = {}


def extractor(model):
    if model not in _EXTRACTORS:
        import sherpa_onnx
        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(MODELS / EMBED[model]), num_threads=THREADS)
        _EXTRACTORS[model] = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    return _EXTRACTORS[model]


_AUDIO = {}


def audio_of(path):
    if path not in _AUDIO:
        if len(_AUDIO) > 6:
            _AUDIO.clear()
        _AUDIO[path] = read_wav(path)
    return _AUDIO[path]


def embed(model, path, start, end):
    key = hashlib.sha1(f"{model}|{path}|{start:.2f}|{end:.2f}".encode()).hexdigest()
    p = CACHE / "emb" / model / f"{key}.npy"
    if p.exists():
        return np.load(p)
    a = audio_of(path)[int(start * 16000):int(end * 16000)]
    ex = extractor(model)
    st = ex.create_stream()
    st.accept_waveform(16000, a)
    st.input_finished()
    v = np.array(ex.compute(st), dtype=np.float32)
    v /= np.linalg.norm(v) + 1e-9
    p.parent.mkdir(parents=True, exist_ok=True)
    np.save(p, v)
    return v


def clean_windows(turns, key, min_len=1.0, max_len=8.0, pad=0.1):
    """Spans of each speaker's turns that overlap no other speaker's turn, cut to <= max_len."""
    out = {}
    for t in turns:
        s, e = t["start"] + pad, t["end"] - pad
        others = [(u["start"], u["end"]) for u in turns if u[key] != t[key] and u["end"] > s and u["start"] < e]
        pieces = [(s, e)]
        for (a, b) in others:
            nxt = []
            for (x, y) in pieces:
                if b <= x or a >= y:
                    nxt.append((x, y))
                else:
                    if a > x:
                        nxt.append((x, a))
                    if b < y:
                        nxt.append((b, y))
            pieces = nxt
        for (x, y) in pieces:
            while y - x >= min_len:
                z = min(y, x + max_len)
                if y - z < min_len:
                    z = y
                out.setdefault(t[key], []).append((x, z))
                x = z
    return out


def _budget(windows, seconds):
    ws = sorted(windows, key=lambda w: w[0] - w[1])  # longest first
    out, tot = [], 0.0
    for w in ws:
        if tot >= seconds:
            break
        out.append(w)
        tot += w[1] - w[0]
    return out


def enroll(model, sources, seconds=60.0):
    """sources: {person: [(audio_path, start, end), ...]} -> {person: (n, d) array}"""
    prints = {}
    for person, spans in sources.items():
        spans = sorted(spans, key=lambda w: w[1] - w[2])
        vs, tot = [], 0.0
        for (path, a, b) in spans:
            if tot >= seconds:
                break
            vs.append(embed(model, path, a, b))
            tot += b - a
        if vs:
            prints[person] = np.stack(vs)
    return prints


def cluster_prints(model, audio_path, turns, seconds=90.0):
    wins = clean_windows(turns, "speaker")
    out = {}
    for spk, ws in wins.items():
        ws = _budget(ws, seconds)
        if ws:
            out[spk] = np.stack([embed(model, audio_path, a, b) for (a, b) in ws])
    return out


def similarity(A, B, how="centroid"):
    if how == "centroid":
        a, b = A.mean(0), B.mean(0)
        return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
    S = A @ B.T  # rows: cluster windows, cols: enrollment windows
    if how == "topk":
        k = max(1, min(5, S.shape[1]))
        return float(np.sort(S, axis=1)[:, -k:].mean())
    raise KeyError(how)


def match(clusters, prints, threshold=0.5, margin=0.05, how="centroid", reuse=None):
    """-> ({cluster: person|None}, score matrix). One-to-one by Hungarian; a pair stands when its score
    clears `threshold` and beats this cluster's next-best person by `margin`. With `reuse`, a cluster
    left over may take an already-matched person when its score clears `reuse` (diarizer split one voice)."""
    from scipy.optimize import linear_sum_assignment
    cs, ps = list(clusters), list(prints)
    if not cs or not ps:
        return {c: None for c in cs}, {}
    S = np.array([[similarity(clusters[c], prints[p], how) for p in ps] for c in cs])
    rows, cols = linear_sum_assignment(-S)
    out = {c: None for c in cs}
    for r, k in zip(rows, cols):
        s = S[r, k]
        second = np.max(np.delete(S[r], k)) if len(ps) > 1 else -1
        if s >= threshold and s - second >= margin:
            out[cs[r]] = ps[k]
    if reuse is not None:
        for r, c in enumerate(cs):
            if out[c] is None:
                k = int(np.argmax(S[r]))
                srt = np.sort(S[r])
                if S[r, k] >= reuse and (len(ps) == 1 or srt[-1] - srt[-2] >= margin):
                    out[c] = ps[k]
    scores = {cs[r]: {ps[k]: float(S[r, k]) for k in range(len(ps))} for r in range(len(cs))}
    return out, scores
