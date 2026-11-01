# Single container: builds the web app, then serves it and the monitoring API from one origin.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production PORT=7860 DATA_DIR=/data TRUST_PROXY=1
COPY --from=build /app /app
# Monitoring state lives on a volume mounted at /data. Without one it is rebuilt from chain events on restart.
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.PORT||7860)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
