#!/usr/bin/env bash
# Plan A demo: place a limit order, fill it via /_control/, confirm remaining/locked change.
# Requires the mock with BITBANK_MOCK_CONTROL=1 (fillMode defaults to manual).
set -euo pipefail

BASE="${BITBANK_MOCK_URL:-http://127.0.0.1:14000}"

order_json="$(
  curl -sS -X POST "$BASE/v1/user/spot/order" \
    -H "content-type: application/json" \
    -d '{"pair":"btc_jpy","amount":"0.001","price":"5000000","side":"buy","type":"limit"}'
)"
echo "placed: $order_json"

order_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["order_id"])' <<<"$order_json")"

echo "GET order (UNFILLED expected):"
curl -sS "$BASE/v1/user/spot/order?pair=btc_jpy&order_id=${order_id}"
echo

echo "control fill:"
curl -sS -X POST "$BASE/_control/orders/${order_id}/fill" \
  -H "content-type: application/json" \
  -d '{}'
echo

echo "GET order (FULLY_FILLED expected):"
curl -sS "$BASE/v1/user/spot/order?pair=btc_jpy&order_id=${order_id}"
echo

echo "assets:"
curl -sS "$BASE/v1/user/assets"
echo
