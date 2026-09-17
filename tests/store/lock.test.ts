import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 書き込み・削除の失敗は実際には起こせない（ディスクを埋めるわけにいかず、root では
// パーミッションも効かない）ので、この 2 つだけ差し替える。既定は素通し。
const fsFail = vi.hoisted(() => ({ write: false, unlink: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fh = await actual.open(...args);
      if (!fsFail.write) return fh;
      return new Proxy(fh, {
        get(target, prop, receiver) {
          if (prop === "writeFile") {
            return async () => {
              throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (fsFail.unlink) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return actual.unlink(...args);
    },
  };
});

import {
  acquireStateLock,
  StateLockedError,
  stateLockPath,
  type StateLock,
} from "../../src/store/lock.ts";

/**
 * 確実に死んでいる pid を作る。
 *
 * 大きな数を決め打ちにすると、たまたま実在する pid を「死んでいる」前提で使うことになり、
 * 奪う側のテストが環境次第で落ちる。子を産んで看取れば、その pid は確実に空いている
 * （再利用されるまでは）。
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("子プロセスの pid を取れなかった");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

describe("acquireStateLock", () => {
  let dir: string;
  let statePath: string;
  const held: StateLock[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-lock-"));
    statePath = join(dir, "state.json");
  });

  afterEach(async () => {
    fsFail.write = false;
    fsFail.unlink = false;
    vi.restoreAllMocks();
    for (const lock of held.splice(0)) await lock.release();
    await rm(dir, { recursive: true, force: true });
  });

  it("ロックファイルを作り、自分の pid を書く", async () => {
    const lock = await acquireStateLock(statePath);
    held.push(lock);

    expect(lock.path).toBe(stateLockPath(statePath));
    expect(lock.path).toBe(`${statePath}.lock`);
    expect((await readFile(lock.path, "utf8")).trim()).toBe(String(process.pid));
  });

  it("状態ファイルの階層がまだ無くても取れる", async () => {
    // 階層は saveState() が最初の書き込みで作るので、初回起動の時点では存在しない。
    const nested = join(dir, "sessions", "default", "state.json");
    expect(existsSync(join(dir, "sessions"))).toBe(false);

    const lock = await acquireStateLock(nested);
    held.push(lock);
    expect(existsSync(lock.path)).toBe(true);
  });

  it("生きているプロセスが持っている間は取れない", async () => {
    const lock = await acquireStateLock(statePath);
    held.push(lock);

    // 同じプロセスからの 2 回目。自分の pid は当然生きているので弾かれる。
    await expect(acquireStateLock(statePath)).rejects.toThrow(StateLockedError);
    await expect(acquireStateLock(statePath)).rejects.toThrow(String(process.pid));
  });

  it("解放したら取り直せる", async () => {
    const first = await acquireStateLock(statePath);
    await first.release();
    expect(existsSync(first.path)).toBe(false);

    const second = await acquireStateLock(statePath);
    held.push(second);
    expect((await readFile(second.path, "utf8")).trim()).toBe(String(process.pid));
  });

  it("release は 2 回呼んでも落ちない", async () => {
    const lock = await acquireStateLock(statePath);
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("死んだ pid のロックは奪う", async () => {
    // これが無いと SIGKILL の後に二度と起動できない、という別の footgun になる。
    const pid = await deadPid();
    await writeFile(stateLockPath(statePath), `${pid}\n`, "utf8");

    const lock = await acquireStateLock(statePath);
    held.push(lock);
    expect((await readFile(lock.path, "utf8")).trim()).toBe(String(process.pid));
  });

  it("pid が読めないロックは奪わない", async () => {
    // 空のロックファイルは、別プロセスが wx で作った直後でまだ pid を書いていない
    // 瞬間にも現れる。「中身が無い＝死んでいる」と扱うと、防ぎたい二重起動をここで作る。
    for (const content of ["", "   \n", "not-a-pid", "-1", "0", "1.5"]) {
      await writeFile(stateLockPath(statePath), content, "utf8");
      await expect(acquireStateLock(statePath)).rejects.toThrow(StateLockedError);
    }
  });

  it("生死を判定できないときは奪わない", async () => {
    // `ESRCH` だけが「居ない」の証拠。EPERM やそれ以外の失敗で奪うと、生きている
    // プロセスのロックを取り上げて二重起動を作る。
    const pid = await deadPid();
    await writeFile(stateLockPath(statePath), `${pid}\n`, "utf8");
    for (const code of ["EPERM", "EACCES", undefined]) {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("判定できない"), code ? { code } : {});
      });
      await expect(acquireStateLock(statePath)).rejects.toThrow(StateLockedError);
      vi.restoreAllMocks();
    }
    // 判定できる（死んでいる）ときだけ奪う。
    const lock = await acquireStateLock(statePath);
    held.push(lock);
  });

  it("pid を書けなかったら、作りかけのロックを残さない", async () => {
    // 残すと中身が空のロックになり、以後どの起動も「奪わない」側に落ちる。
    // つまり一度きりの書き込み失敗で、手でファイルを消すまで起動できなくなる。
    fsFail.write = true;
    await expect(acquireStateLock(statePath)).rejects.toThrow(/ENOSPC|no space/);
    expect(existsSync(stateLockPath(statePath))).toBe(false);

    fsFail.write = false;
    const lock = await acquireStateLock(statePath);
    held.push(lock);
  });

  it("消せなかった release は失敗として返り、次の release がやり直す", async () => {
    const lock = await acquireStateLock(statePath);

    fsFail.unlink = true;
    await expect(lock.release()).rejects.toThrow(/EACCES|permission/);
    expect(existsSync(lock.path)).toBe(true);

    // 失敗を「解放済み」と記録してしまうと、ここが素通りしてロックが残り続ける。
    fsFail.unlink = false;
    await lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it("弾くときは、状態ファイルを分ける手立てを示す", async () => {
    const lock = await acquireStateLock(statePath);
    held.push(lock);

    const e = await acquireStateLock(statePath).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(StateLockedError);
    const message = (e as StateLockedError).message;
    expect(message).toContain(stateLockPath(statePath));
    expect(message).toContain("BITBANK_MOCK_STATE_PATH");
  });
});
