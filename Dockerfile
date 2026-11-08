# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    bun install --frozen-lockfile && bun run typecheck && bun test && \
    bun install --production --frozen-lockfile

FROM oven/bun:1.4.4
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app /app
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/newspulse.sqlite
EXPOSE 3000
CMD ["bun", "src/main.ts"]
