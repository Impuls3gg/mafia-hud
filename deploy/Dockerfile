FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ ./src/
RUN mkdir /data && chown node /data
ENV DATA_DIR=/data BIND_HOST=0.0.0.0
USER node
CMD ["node", "src/server/server.js"]
