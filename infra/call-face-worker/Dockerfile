# The face host for agents in calls (worker.mjs). Long-running: it keeps a
# websocket to LiveKit Cloud open and takes one job per seated face.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY worker.mjs ./
CMD ["node", "worker.mjs", "start"]
