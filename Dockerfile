# Hearth — one Node.js process serving the API (/api) and the built web app.
# See docker-compose.yml for a ready-to-run setup with PostgreSQL.

# ---- build: compile the web app into dist/ ----------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Clinic details for the public landing page are compiled into the web app.
ARG VITE_CLINIC_NAME=""
ARG VITE_CLINIC_SHORT_NAME=""
ARG VITE_CLINIC_PHONE=""
ARG VITE_CLINIC_EMAIL=""
ARG VITE_CLINIC_ADDRESS=""
ARG VITE_CLINIC_HOURS=""
ENV VITE_CLINIC_NAME=$VITE_CLINIC_NAME \
    VITE_CLINIC_SHORT_NAME=$VITE_CLINIC_SHORT_NAME \
    VITE_CLINIC_PHONE=$VITE_CLINIC_PHONE \
    VITE_CLINIC_EMAIL=$VITE_CLINIC_EMAIL \
    VITE_CLINIC_ADDRESS=$VITE_CLINIC_ADDRESS \
    VITE_CLINIC_HOURS=$VITE_CLINIC_HOURS

COPY . .
RUN npm run build

# ---- runtime: production dependencies, API, migrations, web app -------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    UPLOAD_DIR=/data/uploads

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY api ./api
COPY db ./db
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

RUN mkdir -p /data/uploads && chown -R node:node /data

USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "api/server.mjs"]
