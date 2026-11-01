# Single container: builds the web app, then serves it and the monitoring API from one origin.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Release gate: a leaked credential or a failing test stops the image from being built.
RUN bun run check:secrets && bun test server src && bun run build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production PORT=7860 DATA_DIR=/data TRUST_PROXY=1
COPY --from=build /app /app
# The app files stay root-owned and read-only; only /data is writable by the unprivileged user.
# Monitoring state lives on a volume mounted at /data. Without one it is rebuilt from chain events on restart.
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.PORT||7860)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
