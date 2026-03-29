FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY app.js .
COPY lib/ ./lib/

CMD ["node", "app.js"]
