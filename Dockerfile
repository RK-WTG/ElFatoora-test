# Image de test saveEfact ElFatoora — à déployer via Dokploy (sort par l'IP whitelistée Hetzner)
FROM node:20-alpine

WORKDIR /app

# Dépendances
COPY package.json ./
RUN npm install --omit=dev

# Code + facture signée embarquée
COPY lib.js server.js test-saveefact.js ./
COPY TEIF_FAC_2024_003_signe.xml ./

EXPOSE 3000

# Service HTTP : GET /describe (sans envoi) puis GET /send (envoi)
CMD ["node", "server.js"]
