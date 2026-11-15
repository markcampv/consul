# Consul Operations Console: web UI + read-only Consul API proxy.
# Build from operations-console/:  docker build -t consul-ops-console .

FROM node:22-alpine AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.26-alpine AS server
ARG VERSION=dev
WORKDIR /src/server
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/consul-ops-console .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/consul-ops-console /usr/local/bin/consul-ops-console
COPY --from=web /src/web/dist /srv/console
# Listening on all interfaces inside the container: set CONSOLE_ALLOWED_HOSTS
# to the host names users browse to (DNS-rebinding protection).
ENV CONSOLE_WEB_DIR=/srv/console \
    CONSOLE_LISTEN_ADDR=0.0.0.0:9500
EXPOSE 9500
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/consul-ops-console"]
