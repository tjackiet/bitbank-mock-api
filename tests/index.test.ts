import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStateLock, StateLockedError, stateLockPath } from "../src/store/lock.ts";
import {
  collectStderr,
  freePort,
  spawnServer,
  waitForExit,
  waitUntilListening,
} from "./server-process.ts";

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
