# Voice match parity fixtures

`IS1009b.json` and `IS1009b-drop0.json` are derived from meeting IS1009b of the AMI Meeting Corpus
(https://groups.inf.ed.ac.uk/ami/corpus/), licensed CC BY 4.0. They hold Scribe speaker turns, the
clean windows the speech lab chose per speaker, each window's CAM++ embedding, enrolled speakers'
embeddings, and the names the lab's matcher gave. No audio. `-drop0` leaves one speaker unenrolled.

Produced by `packages/evals/speech/lab/export_fixture.py`. Fixtures from real team recordings never go in this repo.
