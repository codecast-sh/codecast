# CAM++ voice vectors for audio spans (server.py). One request computes at a
# time; the README has the contract.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# The lab's model: k2-fsa/sherpa-onnx release "speaker-recongition-models" (sic).
ARG MODEL=3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx
ARG MODEL_SHA256=98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5
RUN mkdir /models && curl -fsSL -o /models/$MODEL \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/$MODEL \
    && echo "$MODEL_SHA256  /models/$MODEL" | sha256sum -c -
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py ./
ENV MODEL_PATH=/models/$MODEL PYTHONUNBUFFERED=1
CMD ["python", "server.py"]
