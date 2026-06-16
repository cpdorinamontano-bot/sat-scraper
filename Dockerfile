FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY . .

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
