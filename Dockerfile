# Build the admin console, then run the server with only production dependencies.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
COPY packages/admin/package.json packages/admin/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build -w @lite-sync/admin

FROM node:24-alpine
ENV NODE_ENV=production \
    LITE_SYNC_DATA_DIR=/data \
    LITE_SYNC_ADMIN_DIR=/app/packages/admin/dist \
    PORT=28470
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
COPY packages/admin/package.json packages/admin/
RUN npm ci --omit=dev -w @lite-sync/server -w @lite-sync/core && npm cache clean --force
COPY packages/core/src packages/core/src
COPY packages/server/src packages/server/src
COPY --from=build /app/packages/admin/dist packages/admin/dist
COPY docker/lite-sync /usr/local/bin/lite-sync
RUN chmod +x /usr/local/bin/lite-sync && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 28470
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["lite-sync"]
