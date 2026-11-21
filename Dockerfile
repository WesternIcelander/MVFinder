FROM node:26-alpine

# youtubei.js version policy, used for the baked-in baseline and runtime updates alike.
ARG YTJS_VERSION=latest
ARG YTJS_MIN_RELEASE_AGE_HOURS=24

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    YTJS_BASELINE_DIR=/opt/ytjs \
    YTJS_VERSION=${YTJS_VERSION} \
    YTJS_MIN_RELEASE_AGE_HOURS=${YTJS_MIN_RELEASE_AGE_HOURS}

WORKDIR /app
COPY package.json ./
COPY src ./src

# Baseline youtubei.js so the container works even if npm is unreachable at startup.
# Newer versions are installed at runtime into /data/ytjs/<version>.
RUN node src/ytjs-package.js install /opt/ytjs \
    && rm -rf /root/.npm \
    && mkdir -p /data && chown node:node /data

USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
    CMD wget -qO /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "src/server.js"]
