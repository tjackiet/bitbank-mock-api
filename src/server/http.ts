import Fastify, { type FastifyInstance } from "fastify";
import { activeOrdersRoutes } from "../routes/active-orders.ts";
import { assetsRoutes } from "../routes/assets.ts";
import { cancelOrderRoutes } from "../routes/cancel-order.ts";
import { controlRoutes } from "../routes/control.ts";
import { createOrderRoutes } from "../routes/create-order.ts";
import { orderInfoRoutes } from "../routes/order-info.ts";
import { tradeHistoryRoutes } from "../routes/trade-history.ts";
import { controlToken, isControlEnabled } from "./config.ts";
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

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: opts.logger ?? false });
  fastify.decorate("store", opts.store);
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
