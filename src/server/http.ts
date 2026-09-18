import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { activeOrdersRoutes } from "../routes/active-orders.ts";
import { assetsRoutes } from "../routes/assets.ts";
import { cancelOrderRoutes } from "../routes/cancel-order.ts";
import { controlRoutes } from "../routes/control.ts";
import { createOrderRoutes } from "../routes/create-order.ts";
import { orderInfoRoutes } from "../routes/order-info.ts";
import { tradeHistoryRoutes } from "../routes/trade-history.ts";
import { controlToken, isControlEnabled } from "./config.ts";
import { assertRouteClassified, degradedResponse, isReadRoute } from "./degraded.ts";
import { err, ErrorCode } from "../routes/envelope.ts";
import type { SessionStore } from "../store/session.ts";

declare module "fastify" {
  interface FastifyInstance {
    store: SessionStore;
  }
}

export type BuildServerOptions = {
  store: SessionStore;
  logger?: boolean;
  controlEnabled?: boolean;
  controlToken?: string;
};

/**
 * 劣化中に断る判定と応答を 1 箇所に置く。**ルートごとには手当てしない。**
 *
 * ルート側へ散らすと、`SessionStore.tick()` が market モードで内部から `persist()` を
 * 呼ぶ経路が抜ける（`docs/plan-lab-mock.md` 10.5 の骨子 4）。フックは 2 本要る。
 *
 * - `preHandler`: 既に劣化しているなら**ハンドラへ入れない**。状態を変えさせないため、
 *   応答を差し替えるだけでは足りない。
 * - `preSerialization`: **この要求の中で劣化した**とき（＝自分の書き込みが失敗した）に
 *   応答を差し替える。ここが無いと、失敗の引き金になった 1 本だけが成功応答で通る。
 *   巻き戻しはしないので、メモリには注文が残ったまま応答は失敗になる（10.5 に記録）。
 *
 * root に足したフックは `register()` したプラグインにも継承されるので、互換ルートと
 * `/_control/` の両方に効く。control の許可判定（403）は `onRequest` なので先に走る。
 */
function registerDegradedGuard(fastify: FastifyInstance, store: SessionStore): void {
  // 分類漏れは起動時に落とす。判定自体は fail-closed だが、読み取り経路を載せ忘れると
  // 劣化中にその口が死ぬので、黙って進ませない。
  fastify.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) assertRouteClassified(method, route.url);
  });

  // 断るべき要求か。経路が決まっていない要求（未登録のパス）は触らない。触ると
  // 劣化中だけ 404 が別の応答に化ける（対応表の「封筒に包まれない応答」の (b)）。
  const shouldRefuse = (request: FastifyRequest): boolean => {
    const url = request.routeOptions.url;
    if (url === undefined) return false;
    return store.isDegraded() && !isReadRoute(request.method, url);
  };

  fastify.addHook("preHandler", async (request, reply) => {
    if (!shouldRefuse(request)) return;
    const { statusCode, body } = degradedResponse(request.routeOptions.url!);
    return reply.code(statusCode).send(body);
  });

  // preHandler が断った応答もここを通るが、同じ url から同じ本文を組み立てるので
  // 差し替えは no-op になる。目印を持ち回る必要はない。
  fastify.addHook("preSerialization", async (request, reply, payload) => {
    if (!shouldRefuse(request)) return payload;
    const { statusCode, body } = degradedResponse(request.routeOptions.url!);
    reply.code(statusCode);
    return body;
  });
}

/**
 * 経路が見つからない要求の応答。**実 API で 3 通りに分かれることを実測した**（2026-09-17）。
 *
 * | パス | 実 API | 観測条件 |
 * | --- | --- | --- |
 * | `/v1/` 直下（`/v1/nonexistent`） | `HTTP 404` + 封筒 `10000`（"Url not found."） | 認証ヘッダ無し |
 * | `/v1/user/` 配下（`/v1/user/spot/ping`） | `HTTP 200` + 封筒 `20003`（"ACCESS-KEY not found."） | 認証ヘッダ無し |
 * | 同上 | `HTTP 200` + 封筒 `20001`（"Authentication failed..."） | 認証ヘッダ有り |
 *
 * `/v1/user/` 配下で経路が見つからないときにパスの誤りではなく認証のコードが返るのは、
 * **実 API が認可をルーティングより先に走らせている**ためと考えられる。その結果、
 * **パスの打ち間違いが認証エラーに見える**。クライアントが `20003` を見て「キーが違う」と判断すると
 * 事故になるので、モックもここを再現する。
 *
 * モックが返すのは `20003` の側（認証ヘッダを検証しないので「キーが無い」状態に当たる）。
 * `20001` との出し分けはヘッダを見ることになり、README の「認証は非目標」に触れるので
 * しない（`docs/fidelity.md` の「封筒に包まれない応答」節に未対応として記録）。
 *
 * **`/_control/` は対象外**（bitbank API に存在しない実験用の口なので、封筒に包まず
 * Fastify の既定 404 のまま）。control を無効にして起動したときの `/_control/state` も
 * ここを通るが、同じ理由で素の 404 を返す。
 *
 * 番号の出典は errors.md。`ErrorCode.INVALID_PARAMETER`（20003）はこのリポジトリでは
 * パラメータエラーに流用しているが、**ここで使っているのは公式どおりの
 * 「ACCESS-KEY not found.」の意味**である（`docs/fidelity.md` のエラーコード行）。
 */
function registerNotFoundHandler(fastify: FastifyInstance): void {
  fastify.setNotFoundHandler(async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (url.startsWith("/_control/")) {
      return reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    }
    if (url.startsWith("/v1/user/")) {
      return reply.code(200).send(err(ErrorCode.INVALID_PARAMETER));
    }
    return reply.code(404).send(err(ErrorCode.URL_NOT_FOUND));
  });
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: opts.logger ?? false });
  fastify.decorate("store", opts.store);
  registerDegradedGuard(fastify, opts.store);
  registerNotFoundHandler(fastify);
  await fastify.register(assetsRoutes);
  await fastify.register(activeOrdersRoutes);
  await fastify.register(tradeHistoryRoutes);
  await fastify.register(createOrderRoutes);
  await fastify.register(orderInfoRoutes);
  await fastify.register(cancelOrderRoutes);
  const enabled = opts.controlEnabled ?? isControlEnabled();
  if (enabled) {
    await fastify.register(controlRoutes, {
      prefix: "/_control",
      token: opts.controlToken ?? controlToken(),
    });
  }
  return fastify;
}
