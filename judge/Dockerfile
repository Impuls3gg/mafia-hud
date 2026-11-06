FROM node:24-alpine
WORKDIR /app
COPY judge/server.js judge/game.js judge/judge.html mafia-hud.html win-civilians.html win-mafia.html ./
RUN mkdir /data && chown node /data
ENV DATA_DIR=/data
USER node
CMD ["node", "server.js"]
