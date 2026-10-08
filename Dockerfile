# syntax=docker/dockerfile:1
# Build stage: full install, compile TypeScript to dist/.
FROM node:22-slim AS build
# onnxruntime-node would otherwise download CUDA provider binaries (hundreds of MB) at install time.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies only. Debian (glibc) rather than alpine because
# the local embedder (fastembed -> onnxruntime) ships glibc binaries.
FROM node:22-slim
ENV NODE_ENV=production \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip \
    PORT=8002 \
    EMBED_CACHE_DIR=/data/embed-cache
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# onnxruntime-node ships binaries for every platform; keep only what this image can run.
# TARGETARCH is set by BuildKit; when it is not (legacy builder) only the foreign OS dirs are removed.
ARG TARGETARCH
RUN set -e; d=node_modules/onnxruntime-node/bin/napi-v3; \
    for p in darwin win32; do if [ -d "$d/$p" ]; then rm -rf "$d/$p"; fi; done; \
    if [ "$TARGETARCH" = "amd64" ] && [ -d "$d/linux/arm64" ]; then rm -rf "$d/linux/arm64"; fi; \
    if [ "$TARGETARCH" = "arm64" ] && [ -d "$d/linux/x64" ]; then rm -rf "$d/linux/x64"; fi
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /data/embed-cache && chown -R node:node /data /app
USER node
VOLUME /data/embed-cache
EXPOSE 8002
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8002)+'/health').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.js", "http"]
