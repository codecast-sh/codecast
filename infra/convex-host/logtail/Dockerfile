FROM node:22-slim
# The CLI that streams the backend's function log. Match packages/convex.
RUN npm install -g convex@1.36.1 && npm cache clean --force
WORKDIR /app
COPY logtail.mjs .
CMD ["node", "logtail.mjs"]
