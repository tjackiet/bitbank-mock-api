import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildState } from "../engine/helpers.ts";

/**
 * 経路が見つからない要求の応答。**実 API で 3 通りに分かれることを実測した**
 * （2026-09-17、認証ヘッダ無し / 有りの両方）。根拠と番号の出典は
 * `src/server/http.ts` の `registerNotFoundHandler` の docstring と
 * `docs/fidelity.md` の「封筒に包まれない応答」行。
 */
async function build(controlEnabled: boolean) {
  const store = new SessionStore(buildState(), { path: null, fillMode: "manual" });
  const fastify = await buildServer({ store, logger: false, controlEnabled });
  return { fastify, close: () => fastify.close() };
}

describe("未登録パスの応答", () => {
  it.each([
    ["GET", "/v1/user/spot/ping"],
    ["POST", "/v1/user/spot/ping"],
    ["GET", "/v1/user/nope"],
  ] as const)("%s %s は 200 + 封筒 20003（実 API は認可がルーティングより先）", async (method, url) => {
    const { fastify, close } = await build(false);
    try {
      const res = await fastify.inject({ method, url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: 0, data: { code: 20003 } });
    } finally {
      await close();
    }
  });

  it.each([
    ["GET", "/v1/nonexistent"],
    ["GET", "/foo"],
    ["POST", "/v1/spot/ticker"],
  ] as const)("%s %s は 404 + 封筒 10000（Url not found.）", async (method, url) => {
    const { fastify, close } = await build(false);
    try {
      const res = await fastify.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ success: 0, data: { code: 10000 } });
    } finally {
      await close();
    }
  });

  // `/_control/` は bitbank API に存在しない実験用の口なので封筒に包まない。
  // control を無効にしたときの `/_control/state` もここを通る。
  it.each([[true], [false]])("`/_control/` は封筒に包まない（controlEnabled=%s）", async (enabled) => {
    const { fastify, close } = await build(enabled);
    try {
      const res = await fastify.inject({ method: "GET", url: "/_control/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).not.toHaveProperty("success");
    } finally {
      await close();
    }
  });

  it("control を無効にしたときの /_control/state も素の 404", async () => {
    const { fastify, close } = await build(false);
    try {
      const res = await fastify.inject({ method: "GET", url: "/_control/state" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).not.toHaveProperty("success");
    } finally {
      await close();
    }
  });

  // クエリを付けても判定はパスだけで決まる（`?` より後ろを見ない）。
  it("クエリ付きでも同じ判定になる", async () => {
    const { fastify, close } = await build(false);
    try {
      const compat = await fastify.inject({ method: "GET", url: "/v1/user/nope?pair=btc_jpy" });
      expect(compat.json()).toEqual({ success: 0, data: { code: 20003 } });
      const other = await fastify.inject({ method: "GET", url: "/v1/nope?x=1" });
      expect(other.json()).toEqual({ success: 0, data: { code: 10000 } });
    } finally {
      await close();
    }
  });

  // 登録済みのパスに未登録のメソッドで来た場合も未登録として扱われる。
  it("登録済みパスへの未登録メソッドも同じ扱い", async () => {
    const { fastify, close } = await build(false);
    try {
      const res = await fastify.inject({ method: "DELETE", url: "/v1/user/assets" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: 0, data: { code: 20003 } });
    } finally {
      await close();
    }
  });
});
