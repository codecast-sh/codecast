"""Speaker turns. Each returns {"turns": [{speaker, start, end}], "cost_usd", "seconds"}."""
from __future__ import annotations

import os

from asr import cached
from common import MODELS, read_wav

EMBED = {
    "campplus": "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
    "resnet34": "wespeaker_en_voxceleb_resnet34_LM.onnx",
    "titanet": "nemo_en_titanet_large.onnx",
    "eres2net": "3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx",
}
THREADS = int(os.environ.get("LAB_THREADS", "4"))


def sherpa(item, embed="campplus", threshold=0.5, clusters=-1, min_on=0.3, min_off=0.5):
    import sherpa_onnx
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx")),
            num_threads=THREADS),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(MODELS / EMBED[embed]), num_threads=THREADS),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=clusters, threshold=threshold),
        min_duration_on=min_on, min_duration_off=min_off)
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    audio = read_wav(item["audio"])
    res = sd.process(audio).sort_by_start_time()
    return {"turns": [{"speaker": f"S{r.speaker}", "start": r.start, "end": r.end} for r in res], "cost_usd": 0.0}


def oracle(item):
    """The reference turns with names hidden: isolates identification from diarization."""
    names = {p: f"S{i}" for i, p in enumerate(sorted(item["people"]))}
    return {"turns": [{"speaker": names[s["person"]], "start": s["start"], "end": s["end"]} for s in item["ref"]],
            "cost_usd": 0.0}


def run(item, name, **params):
    if name == "oracle":
        return oracle(item)
    if name == "sherpa":
        return cached("diar-sherpa", item, sherpa, **params)
    if name == "pyannoteai":
        from vendors import pyannoteai_diarize
        return cached("diar-pyannoteai", item, pyannoteai_diarize, **params)
    raise KeyError(name)
