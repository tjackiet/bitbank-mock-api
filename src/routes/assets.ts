import type { FastifyPluginAsync } from "fastify";
import { ok } from "./envelope.ts";
import { formatAssets } from "./format.ts";

export const assetsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/assets", async () => {
    await fastify.store.tick();
    return ok(formatAssets(fastify.store.state()));
  });
};
