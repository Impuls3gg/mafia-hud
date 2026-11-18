FROM node:24-alpine
WORKDIR /app
COPY judge/server.js judge/game.js judge/store.js judge/mu.js judge/judge.html mafia-hud.html ./
COPY hud/ ./hud/
RUN mkdir /data && chown node /data
ENV DATA_DIR=/data
USER node
CMD ["node", "server.js"]
