FROM node:20-alpine

WORKDIR /app

# Installer les deps d'abord (cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copier le code
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
