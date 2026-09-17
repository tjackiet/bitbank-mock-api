#!/usr/bin/env bash
# プラン A のデモ: 指値を発注し、/_control/ で約定させ、残高の三段（発注前 → 拘束 → 約定後）を見る。
#
# 前提: BITBANK_MOCK_CONTROL=1 でモックを起動しておくこと（fillMode の既定が manual になる）。
# 依存は curl だけ。JSON の取り出しは sed / grep で済ませている。
set -euo pipefail

BASE="${BITBANK_MOCK_URL:-http://127.0.0.1:14000}"

# /_control/ は非ループバックからの要求で X-Control-Token の一致を求める。
control_headers=(-H "content-type: application/json")
if [[ -n "${BITBANK_MOCK_CONTROL_TOKEN:-}" ]]; then
  control_headers+=(-H "X-Control-Token: ${BITBANK_MOCK_CONTROL_TOKEN}")
fi

# jpy 残高の 3 つの値だけを取り出す。assets の応答で jpy は先頭の要素で、
# free_amount / onhand_amount / locked_amount はいずれも withdrawal_fee の
# 入れ子より前にあるので、"asset":"jpy" から最初の } までを切れば足りる。
jpy_balance() {
  curl -sS "$BASE/v1/user/assets" \
    | sed -E 's/.*"asset":"jpy"//; s/\}.*//' \
    | grep -oE '"(free_amount|onhand_amount|locked_amount)":"[^"]*"' \
    | tr '\n' ' '
  echo
}

# 何度流しても同じ値が出るように、毎回まっさらな状態から始める。
echo "reset:"
curl -sS -X POST "$BASE/_control/reset" "${control_headers[@]}" -d '{}'
echo

echo "発注前の jpy:"
jpy_balance

order_json="$(
  curl -sS -X POST "$BASE/v1/user/spot/order" \
    -H "content-type: application/json" \
    -d '{"pair":"btc_jpy","amount":"0.001","price":"5000000","side":"buy","type":"limit"}'
)"
echo "placed: $order_json"

order_id="$(printf '%s' "$order_json" | sed -E 's/.*"order_id":([0-9]+).*/\1/')"
if [[ ! "$order_id" =~ ^[0-9]+$ ]]; then
  echo "発注に失敗したので中止する: $order_json" >&2
  exit 1
fi

echo "GET order（UNFILLED を期待）:"
curl -sS "$BASE/v1/user/spot/order?pair=btc_jpy&order_id=${order_id}"
echo

# 発注の時点で free が減り、同額が locked に移る。onhand はまだ動かない。
# 拘束額には手数料が含まれる（詳細は docs/fidelity.md の「拘束額」の行）。
echo "発注後の jpy（free が減り locked へ移る）:"
jpy_balance

echo "control fill:"
curl -sS -X POST "$BASE/_control/orders/${order_id}/fill" \
  "${control_headers[@]}" \
  -d '{}'
echo

echo "GET order（FULLY_FILLED を期待）:"
curl -sS "$BASE/v1/user/spot/order?pair=btc_jpy&order_id=${order_id}"
echo

# 約定すると locked が解け、onhand が free と同じところまで減る。
echo "約定後の jpy（locked が解け onhand が減る）:"
jpy_balance
