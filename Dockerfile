# Beam server. Everything it keeps lives in the /data volume: items, files, devices, sign-ins, settings, logs and
# the app builds it hands out (/data/dist). Multi-arch (amd64, arm64, armv7): only pure-JavaScript dependencies.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV BEAM_DATA=/data BEAM_DIST=/data/dist BEAM_HOST=0.0.0.0 BEAM_PORT=8765
VOLUME /data
EXPOSE 8765
# Runs as uid 1000 unless compose says otherwise (user: PUID:PGID); the data folder must belong to that user.
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.BEAM_PORT||8765)+'/api/hello').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
