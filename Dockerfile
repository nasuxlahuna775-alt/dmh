FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js music.js server-features.js register-commands.js ./

CMD ["npm", "start"]
