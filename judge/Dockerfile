FROM node:24-alpine
WORKDIR /app
COPY judge/server.js judge/judge.html mafia-hud.html win-civilians.html win-mafia.html ./
USER node
CMD ["node", "server.js"]
