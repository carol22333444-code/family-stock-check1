FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

CMD ["node", "server.js"]
