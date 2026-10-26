# Techtie Hub: imagem do HUB para servidor (VPS / Coolify).
# Só o hub: guarda os escritórios e serve a interface. Não roda o Claude nem acessa
# pastas; os PCs se conectam a ele com o conector.js. Por isso não precisa de
# node_modules: o SDK do Claude só é carregado pelo conector.
FROM node:24-slim

WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    PORT=4321 \
    HUB_HOST=0.0.0.0 \
    HUB_SEM_CONECTOR=1 \
    HUB_TRUST_PROXY=1 \
    HUB_DATA=/data/state.json

# dados (contas, escritórios, conversas, sessões) ficam no volume /data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4321/api/auth/status').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
