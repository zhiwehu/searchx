ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build

ARG APT_MIRROR=""
ARG BUILD_APT_PACKAGES="ca-certificates cmake g++ make python3"

WORKDIR /app

RUN if [ -n "$APT_MIRROR" ]; then \
    find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -print0 \
      | xargs -0 sed -i \
        -e "s|http://deb.debian.org/debian|$APT_MIRROR/debian|g" \
        -e "s|http://security.debian.org/debian-security|$APT_MIRROR/debian-security|g" \
        -e "s|http://archive.ubuntu.com/ubuntu|$APT_MIRROR/ubuntu|g" \
        -e "s|http://security.ubuntu.com/ubuntu|$APT_MIRROR/ubuntu|g"; \
  fi \
  && if [ -n "$BUILD_APT_PACKAGES" ]; then \
    apt-get update && apt-get install -y --no-install-recommends $BUILD_APT_PACKAGES; \
  fi \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
ARG NPM_BUILD_FROM_SOURCE=0
ARG NPM_REGISTRY=""
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
  && if [ "$NPM_BUILD_FROM_SOURCE" = "1" ]; then npm_config_build_from_source=true npm ci; else npm ci; fi

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build
RUN npm prune --omit=dev

FROM ${RUNTIME_IMAGE} AS runtime

ARG APT_MIRROR=""
ARG INSTALL_DOCLING=0
ARG PIP_INDEX_URL=""
ARG RUNTIME_APT_PACKAGES="ca-certificates curl ffmpeg fonts-noto-cjk libmagic1 libreoffice-calc libreoffice-impress libreoffice-writer poppler-utils python3 python3-venv tesseract-ocr tesseract-ocr-chi-sim tini"

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    SEARCHX_HOST=0.0.0.0 \
    SEARCHX_PORT=7310 \
    SEARCHX_DATA_DIR=/app/.searchx \
    XDG_CACHE_HOME=/app/.searchx/cache \
    SEARCHX_PYTHON=/opt/searchx-venv/bin/python \
    SEARCHX_QMD_EMBED_ON_INGEST=1 \
    SEARCHX_ALLOW_RAW_FILE_ACCESS=0 \
    QMD_FORCE_CPU=1

RUN if [ -n "$APT_MIRROR" ]; then \
    find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -print0 \
      | xargs -0 sed -i \
        -e "s|http://deb.debian.org/debian|$APT_MIRROR/debian|g" \
        -e "s|http://security.debian.org/debian-security|$APT_MIRROR/debian-security|g" \
        -e "s|http://archive.ubuntu.com/ubuntu|$APT_MIRROR/ubuntu|g" \
        -e "s|http://security.ubuntu.com/ubuntu|$APT_MIRROR/ubuntu|g"; \
  fi \
  && if [ -n "$RUNTIME_APT_PACKAGES" ]; then \
    apt-get update && apt-get install -y --no-install-recommends $RUNTIME_APT_PACKAGES; \
  fi \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt requirements-docling.txt ./
RUN python3 -m venv /opt/searchx-venv \
  && if [ -n "$PIP_INDEX_URL" ]; then /opt/searchx-venv/bin/python -m pip config set global.index-url "$PIP_INDEX_URL"; fi \
  && /opt/searchx-venv/bin/python -m pip install --upgrade pip setuptools wheel \
  && /opt/searchx-venv/bin/python -m pip install --no-cache-dir -r requirements.txt \
  && if [ "$INSTALL_DOCLING" = "1" ]; then /opt/searchx-venv/bin/python -m pip install --no-cache-dir -r requirements-docling.txt; fi

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/bin/npm /usr/local/bin/npm
COPY --from=build /usr/local/bin/npx /usr/local/bin/npx
COPY --from=build /usr/local/bin/corepack /usr/local/bin/corepack
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY public ./public
COPY python ./python
COPY package.json package-lock.json ./

RUN mkdir -p /app/.searchx \
  && chown -R 1000:1000 /app /opt/searchx-venv

USER 1000:1000

EXPOSE 7310
VOLUME ["/app/.searchx", "/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${SEARCHX_PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/src/server.js"]
