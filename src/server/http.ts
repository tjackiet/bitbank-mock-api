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

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: opts.logger ?? false });
  fastify.decorate("store", opts.store);
  registerDegradedGuard(fastify, opts.store);
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
