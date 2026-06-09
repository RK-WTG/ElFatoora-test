FROM node:22-alpine AS base

# --- Dependencies (prod) ---
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=appuser:nodejs package.json server.js lib.js test-saveefact.js \
     TEIF_FAC_2024_003_1557686RAM000_v3_signed.xml ./

USER appuser

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Facture signée envoyée par /send (émetteur 1557686RAM000 = matricule complet du compte de test)
ENV XML_PATH="./TEIF_FAC_2024_003_1557686RAM000_v3_signed.xml"

CMD ["node", "server.js"]
