# Consul Operations Console — developer entry points.
# Run from the repository root with `make -C operations-console <target>`.

VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
IMAGE    ?= consul-ops-console:dev

.PHONY: help deps dev dev-mock test test-web test-server e2e e2e-live build build-web build-server run docker seed fixtures clean

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

deps: ## Install web dependencies
	cd web && pnpm install --frozen-lockfile

dev: ## Vite dev server proxying /v1 to CONSUL_HTTP_ADDR (default http://127.0.0.1:8500)
	cd web && pnpm dev

dev-mock: ## Vite dev server with recorded fixtures (no Consul needed)
	cd web && pnpm dev:mock

test: test-web test-server ## Web typecheck + Vitest, and Go tests

test-web: ## Typecheck and run Vitest
	cd web && pnpm typecheck && pnpm test

test-server: ## gofmt check, go vet and go test -race
	cd server && test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)
	cd server && go vet ./... && go test -race -count=1 ./...

e2e: ## Playwright against the mock dev server
	cd web && pnpm e2e

e2e-live: ## Playwright against a running console server (E2E_BASE_URL, default http://127.0.0.1:9500)
	cd web && E2E_BASE_URL=$${E2E_BASE_URL:-http://127.0.0.1:9500} pnpm e2e

build: build-web build-server ## Production build of web assets and server binary

build-web:
	cd web && pnpm build

build-server:
	cd server && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o ../bin/consul-ops-console .

run: build ## Build and run the console server against CONSUL_HTTP_ADDR
	CONSOLE_WEB_DIR=web/dist ./bin/consul-ops-console

docker: ## Build the container image
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE) .

seed: ## Register the demo mesh in a LOCAL dev agent
	./scripts/seed-dev-mesh.sh

fixtures: ## Re-record mock fixtures from a seeded local dev agent
	node scripts/record-fixtures.mjs

clean: ## Remove build and test output
	rm -rf ./bin ./web/dist ./web/test-results ./web/playwright-report
