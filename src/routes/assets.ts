import type { FastifyPluginAsync } from "fastify";
import { ok } from "./envelope.ts";
import { formatAssets } from "./format.ts";

export const assetsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/assets", async () => {
    await fastify.store.tick();
    // 率は必ず store のものを渡す（既定に落とすと発注ガードと拘束額がずれる）。
    return ok(formatAssets(fastify.store.state(), fastify.store.feeRate));
  });
};
