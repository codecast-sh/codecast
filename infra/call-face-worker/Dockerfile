# The face host for agents in calls (worker.mjs). Long-running: it keeps a
# websocket to LiveKit Cloud open and takes one job per seated face.
FROM node:22-slim
# The native LiveKit client verifies TLS against the system CA store, which
# the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY worker.mjs ./
CMD ["node", "worker.mjs", "start"]
