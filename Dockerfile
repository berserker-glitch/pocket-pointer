FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8765
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

EXPOSE 8765
VOLUME ["/data"]
CMD ["node", "server.js"]
