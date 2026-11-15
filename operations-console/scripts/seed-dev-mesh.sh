#!/usr/bin/env bash
# Seed a local `consul agent -dev` with a small, representative service mesh
# for developing and integration-testing the Operations Console.
#
# The scenario deliberately exercises every relationship provenance that
# Consul's topology API reports:
#   proxy-registration  frontend -> api, api -> payments/inventory, ...
#   routing-config      frontend -> checkout (virtual service: a resolver
#                       redirect with no instances of its own)
#   specific-intention  audit -> ledger (transparent proxy + explicit allow)
#   default-allow       audit -> * (transparent proxy, default policy allow)
# plus a mesh gateway, a terminating gateway fronting legacy-billing (which
# payments declares as an upstream), a deny intention (api -> inventory), a failing check (payments) and a
# warning check (inventory), and a service outside the mesh (legacy-billing).
#
# Usage: CONSUL_HTTP_ADDR=http://127.0.0.1:8500 ./seed-dev-mesh.sh
# Never point this at a shared or production cluster: it registers services
# and writes config entries and intentions.
set -euo pipefail

ADDR="${CONSUL_HTTP_ADDR:-http://127.0.0.1:8500}"
case "$ADDR" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    if [[ "${SEED_ALLOW_REMOTE:-}" != "1" ]]; then
      echo "refusing to seed non-local Consul at $ADDR (set SEED_ALLOW_REMOTE=1 to override)" >&2
      exit 1
    fi
    ;;
esac

hdr=(-H "Content-Type: application/json")
if [[ -n "${CONSUL_HTTP_TOKEN:-}" ]]; then
  hdr+=(-H "X-Consul-Token: ${CONSUL_HTTP_TOKEN}")
fi

put() { # put <path> <json>
  curl -sS --fail-with-body --noproxy '*' -X PUT "${hdr[@]}" "$ADDR$1" -d "$2" >/dev/null
}

# register <id> <name> <port> <upstreams-json> [proxy-mode]
register() {
  local id="$1" name="$2" port="$3" ups="$4" mode="${5:-}"
  local proxy="{\"Upstreams\": $ups}"
  if [[ "$mode" == "transparent" ]]; then
    proxy="{\"Mode\": \"transparent\", \"Upstreams\": $ups}"
  fi
  put /v1/agent/service/register "{
    \"ID\": \"$id\", \"Name\": \"$name\", \"Port\": $port,
    \"Tags\": [\"demo\"],
    \"Meta\": {\"team\": \"platform\"},
    \"Check\": {\"CheckID\": \"$id-ttl\", \"Name\": \"$name app\", \"TTL\": \"24h\"},
    \"Connect\": {\"SidecarService\": {
      \"Proxy\": $proxy,
      \"Checks\": [{\"Name\": \"sidecar alias\", \"AliasService\": \"$id\"}]
    }}
  }"
}

ttl() { # ttl <check-id> pass|warn|fail <note>
  put "/v1/agent/check/$2/$1?note=$(printf %s "$3" | sed 's/ /%20/g')" ""
}

echo "seeding $ADDR"

put /v1/config '{"Kind":"proxy-defaults","Name":"global","Config":{"protocol":"http"}}'
for s in payments payments-canary; do
  put /v1/config "{\"Kind\":\"service-defaults\",\"Name\":\"$s\",\"Protocol\":\"http\"}"
done
put /v1/config '{
  "Kind": "service-splitter", "Name": "payments",
  "Splits": [{"Weight": 90, "Service": "payments"}, {"Weight": 10, "Service": "payments-canary"}]
}'

# "checkout" has no instances; it only exists as routing config.
put /v1/config '{"Kind": "service-resolver", "Name": "checkout", "Redirect": {"Service": "payments"}}'

register frontend-1  frontend  8080 '[{"DestinationName":"api","LocalBindPort":9001},{"DestinationName":"checkout","LocalBindPort":9005}]'
register api-1       api       8081 '[{"DestinationName":"payments","LocalBindPort":9002},{"DestinationName":"inventory","LocalBindPort":9003}]'
register api-2       api       8082 '[{"DestinationName":"payments","LocalBindPort":9002},{"DestinationName":"inventory","LocalBindPort":9003}]'
register payments-1  payments  8083 '[{"DestinationName":"ledger","LocalBindPort":9004},{"DestinationName":"legacy-billing","LocalBindPort":9006}]'
register payments-2  payments  8084 '[{"DestinationName":"ledger","LocalBindPort":9004},{"DestinationName":"legacy-billing","LocalBindPort":9006}]'
register inventory-1 inventory 8085 '[]'
register ledger-1    ledger    8086 '[]'
register audit-1     audit     8087 '[]' transparent

# A service outside the mesh (no sidecar).
put /v1/agent/service/register '{
  "ID": "legacy-billing-1", "Name": "legacy-billing", "Port": 9090, "Tags": ["legacy"],
  "Check": {"CheckID": "legacy-billing-1-ttl", "Name": "legacy app", "TTL": "24h"}
}'

# Gateways.
put /v1/agent/service/register '{
  "ID": "mesh-gateway-1", "Name": "mesh-gateway", "Kind": "mesh-gateway", "Port": 8443,
  "Proxy": {}, "Check": {"CheckID": "mesh-gateway-1-ttl", "Name": "gateway alive", "TTL": "24h"}
}'
put /v1/config '{"Kind": "terminating-gateway", "Name": "legacy-gateway", "Services": [{"Name": "legacy-billing"}]}'
put /v1/agent/service/register '{
  "ID": "legacy-gateway-1", "Name": "legacy-gateway", "Kind": "terminating-gateway", "Port": 8444,
  "Proxy": {}, "Check": {"CheckID": "legacy-gateway-1-ttl", "Name": "gateway alive", "TTL": "24h"}
}'

for id in mesh-gateway-1 legacy-gateway-1 frontend-1 api-1 api-2 payments-1 ledger-1 audit-1 legacy-billing-1; do
  ttl "$id-ttl" pass "seeded healthy"
done
ttl payments-2-ttl fail "seeded failure: connection refused on :8084"
ttl inventory-1-ttl warn "seeded warning: p99 latency above SLO"

# Intentions (default policy in -dev is allow; these add explicit decisions).
put /v1/connect/intentions/exact?source=api\&destination=inventory '{"Action":"deny","Description":"seeded deny"}'
put /v1/connect/intentions/exact?source=audit\&destination=ledger '{"Action":"allow","Description":"seeded allow"}'
put /v1/connect/intentions/exact?source=frontend\&destination=api '{"Action":"allow"}'

echo "done: $(curl -sS --noproxy '*' "$ADDR/v1/catalog/services" | tr -d '\n' | head -c 300)"
