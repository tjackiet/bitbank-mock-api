import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStateLock, StateLockedError, stateLockPath } from "../src/store/lock.ts";

/**
 * `src/index.ts` が状態ファイルの排他を取っていることを、実プロセスで固定する。
 *
 * ロック自体の挙動は `tests/store/lock.test.ts` が見ている。ここで守るのは**配線**である。
 * `acquireStateLock()` の呼び出しを `src/index.ts` から外しても、他の 398 件は 1 件も
 * 落ちない（隔離コピーで実測）。外れると二重起動が黙って戻り、片方の注文が丸ごと消える。
 *
 * サーバを 1 本だけ起こし、ロックはこのテストプロセスから見る。2 本起こして弾かれるのを
 * 見るほうが直接的だが、弾かれた側の標準エラーを読む形になる。「走っているサーバが状態
 * ファイルのロックを持っている」を確かめれば同じことが言える。
 */

const STARTUP_TIMEOUT_MS = 20_000;

/**
 * `npx tsx` や `node_modules/.bin/tsx` ではなく `node --import tsx` で起こす。
 *
 * 前者はラッパが子の node を産むので、`child.pid` はラッパのもので、`SIGKILL` は子へ
 * 届かない。テストが途中で落ちたときに**サーバがポートとロックを握ったまま孤児として
 * 残る**（実際に残り、後続の実行を壊した）。`--import` なら 1 プロセスなので、
 * `child.pid` がそのままサーバの pid になり、後始末も確実に効く。
 */
function spawnServer(env: NodeJS.ProcessEnv, args: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 標準エラーは `pipe` にしたまま誰も読まないと、出力がバッファを埋めた時点で
  // 子が write で止まる。下の `collectStderr()` が必ず読み出す。
  child.stderr?.setEncoding("utf8");
  return child;
}

/** 子プロセスが標準エラーへ出したものを集める。読み捨てずに溜めるので詰まらない。 */
function collectStderr(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.on("data", (chunk: string) => {
    text += chunk;
  });
  return () => text;
}

/** 空いている TCP ポートを 1 つ借りる。固定ポートは他の実行とぶつかる。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("ポートを取れなかった")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * fastify の listen ログが出るまで待つ。
 *
 * HTTP を叩いて待つと、**別のプロセスが同じポートで応答しているだけ**でも先へ進む
 * （固定ポートだった頃に実際に起きた）。自分が起こしたプロセスの標準出力で待てば取り違えない。
 */
function waitUntilListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`起動しなかった: ${out}`)), STARTUP_TIMEOUT_MS);
    const done = (e?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      if (e) reject(e);
      else resolve(out);
    };
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("Server listening at")) done();
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => done(new Error(`起動前に終了した (code ${code}): ${out}`)));
  });
}

/** 子プロセスが終わるまで待つ。既に終わっていれば即座に解決する。 */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("src/index.ts: 状態ファイルの排他", () => {
  let dir: string | null = null;
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    child = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("走っているサーバがロックを持ち、停止すると手放す", async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-index-"));
    const statePath = join(dir, "state.json");
    const lockPath = stateLockPath(statePath);

    child = spawnServer({
      BITBANK_MOCK_STATE_PATH: statePath,
      BITBANK_MOCK_PORT: String(await freePort()),
      BITBANK_MOCK_CONTROL: "1",
    });
    await waitUntilListening(child);

    // ロックは走っているサーバ自身のもの。--import で起こしているので pid が一致する。
    expect(existsSync(lockPath)).toBe(true);
    expect((await readFile(lockPath, "utf8")).trim()).toBe(String(child.pid));

    // 2 本目に当たるものは取れない。
    await expect(acquireStateLock(statePath)).rejects.toThrow(StateLockedError);

    // SIGTERM で手放す。置き去りにすると、次の起動が stale 判定を通る必要が出る。
    child.kill("SIGTERM");
    await waitForExit(child);
    expect(existsSync(lockPath)).toBe(false);

    const lock = await acquireStateLock(statePath);
    await lock.release();
  }, 40_000);
});

/**
 * 起動引数の契約を固定する。
 *
 * `src/index.ts` は引数の 1 つ目をサブコマンドとして読むので（`serve` 以外は拒否）、
 * **`--port` を単独で渡すと起動しない**。README がこれを「`--port` または
 * `BITBANK_MOCK_PORT`」とだけ書いていて実際と食い違っていたのは、**argv を通る経路に
 * テストが 1 件も無かった**ためである（ポートを渡す既存のテストは環境変数を使う）。
 *
 * ここで固定するのは「どちらが正しいか」ではなく**現在の挙動**で、README はこれに
 * 合わせてある。引数の読み方を変えるなら、このテストが先に落ちる。
 */
describe("src/index.ts: 起動引数", () => {
  let dir: string | null = null;
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    child = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("`--port` を単独で渡すと、状態ファイルに触れる前に終了コード 1 で断る", async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-argv-"));
    const statePath = join(dir, "state.json");

    child = spawnServer({ BITBANK_MOCK_STATE_PATH: statePath }, [
      "--port",
      String(await freePort()),
    ]);
    const stderr = collectStderr(child);

    // 起動してしまった場合にタイムアウトまで待たない。listen ログが先に出たらその場で落とす。
    // `waitUntilListening()` は起動前に終了すると reject するので、そちらも「終了した」に寄せる。
    const outcome = await Promise.race([
      waitForExit(child).then(() => "exited" as const),
      waitUntilListening(child).then(
        () => "listening" as const,
        () => "exited" as const,
      ),
    ]);

    expect(outcome).toBe("exited");
    expect(child.exitCode).toBe(1);
    expect(stderr()).toContain("unknown command: --port");
    // サブコマンドの判定は排他より前なので、ロックも状態ファイルも作られない。
    expect(existsSync(stateLockPath(statePath))).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  }, 40_000);

  it("`serve --port` は渡したポートで listen する", async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-argv-"));
    const port = await freePort();

    child = spawnServer(
      { BITBANK_MOCK_STATE_PATH: join(dir, "state.json"), BITBANK_MOCK_CONTROL: "1" },
      ["serve", "--port", String(port)],
    );
    const out = await waitUntilListening(child);

    // 既定の 14000 ではなく渡した値で上がっていること。
    expect(out).toContain(`:${port}`);
    expect(port).not.toBe(14000);
  }, 40_000);
});
