FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci
COPY . .
RUN npm run db:check && npm run build

FROM build AS verify
CMD ["npm","run","verify-e2e"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# Preserve npm's workspace symlinks and any nested production dependencies.
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=production-deps --chown=node:node /app/packages ./packages
COPY --from=production-deps --chown=node:node /app/apps/server ./apps/server
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node
ENV NODE_ENV=production RUN_MODE=all PORT=3000
EXPOSE 3000
CMD ["node","apps/server/dist/main.js"]
