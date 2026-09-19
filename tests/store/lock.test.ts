import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ディスクの失敗は実際には起こせない（埋めるわけにいかず、root ではパーミッションも
// 効かない）ので、失敗させたい口だけを差し替える。**既定はすべて素通し**で、
// 各テストが必要なフラグだけを立てる（`afterEach` が戻す）。
const fsFail = vi.hoisted(() => ({
  /** `fh.writeFile()` が `ENOSPC` で落ちる。 */
  write: false,
  /** `unlink()` が `EACCES` で落ちる。 */
  unlink: false,
  /** `open(path, "wx")` が `EEXIST` 以外（`EACCES`）で落ちる。 */
  open: false,
  /** pid を書いた後の `fh.close()` が `EIO` で落ちる。fd は先に閉じるので漏れない。 */
  close: false,
  /** `readFile()` が `EACCES` で落ちる（ロックファイルの中身を読めない）。 */
  read: false,
  /** `readFile()` が返す中身の差し替え。別プロセスに奪われた状況を作るのに使う。 */
  readPid: null as string | null,
  /** `readPid` を通った `readFile()` の回数。周回が止まることを見るのに使う。 */
  readPidCalls: 0,
  /**
   * `unlink()` が**消した上で** `ENOENT` を投げる。「消そうとしたら既に無かった」
   * ——他のプロセスが先に同じ stale ロックを消した状況で、`unlink` は素で `ENOENT` になる。
   */
  unlinkGone: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fsFail.open) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      const fh = await actual.open(...args);
      if (!fsFail.write && !fsFail.close) return fh;
      return new Proxy(fh, {
        get(target, prop, receiver) {
          if (fsFail.write && prop === "writeFile") {
            return async () => {
              throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
            };
          }
          if (fsFail.close && prop === "close") {
            return async () => {
              // 先に本当に閉じる。投げるだけだと fd が漏れて、テストの後半に効く。
              await target.close();
              throw Object.assign(new Error("input/output error"), { code: "EIO" });
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (fsFail.read) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      if (fsFail.readPid !== null) {
        fsFail.readPidCalls += 1;
        return fsFail.readPid;
      }
      return actual.readFile(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (fsFail.unlink) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      if (fsFail.unlinkGone) {
        // 先に本当に消す。消えていないのに ENOENT を返すと、次の周回が同じ EEXIST に
        // ぶつかって、作りたかった状況と違うものを見ることになる。
        await actual.unlink(...args);
        throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
      }
      return actual.unlink(...args);
    },
  };
});

import {
  acquireStateLock,
  type StateLock,
  StateLockedError,
  stateLockPath,
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
    fsFail.open = false;
    fsFail.close = false;
    fsFail.read = false;
    fsFail.readPid = null;
    fsFail.readPidCalls = 0;
    fsFail.unlinkGone = false;
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

  it("手放したロックは、後から同じパスを取り直したものへ触らない", async () => {
    // 「落ちない」だけでは足りない。解放済みの `release()` が素通りせず `unlink` まで
    // 行くと、**そのパスを取り直した別のロックのファイルを消す**。`removed` の印は
    // そのために立っている（消せてから立てる順序は下の「消せなかった release」が見る）。
    const first = await acquireStateLock(statePath);
    await first.release();

    const second = await acquireStateLock(statePath);
    held.push(second);
    expect(second.path).toBe(first.path);

    await expect(first.release()).resolves.toBeUndefined();
    expect(existsSync(second.path)).toBe(true);
    expect((await readFile(second.path, "utf8")).trim()).toBe(String(process.pid));
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

  it("ロックファイルを作れない失敗は、EEXIST と区別してそのまま投げる", async () => {
    // `EEXIST` は「誰かが持っている」で、それ以外は「ロックの仕組みが働いていない」。
    // 後者を `false` に丸めると、排他を取れていないのに起動してしまう。
    fsFail.open = true;
    await expect(acquireStateLock(statePath)).rejects.toThrow(/EACCES|permission/);
    // StateLockedError ではない——保持プロセスの話ではないので、そう見せてはいけない。
    await expect(acquireStateLock(statePath)).rejects.not.toBeInstanceOf(StateLockedError);
    expect(existsSync(stateLockPath(statePath))).toBe(false);
  });

  it("pid を書いた後の close が失敗しても、作りかけのロックを残さない", async () => {
    // 書き込みの失敗と同じ理由。close で失敗した分を残すと、中身は正しいのに
    // 「取得していないのにロックがある」状態になり、次の起動が生きている自分の pid を
    // 見て永久に弾かれる。
    fsFail.close = true;
    await expect(acquireStateLock(statePath)).rejects.toThrow(/EIO|input\/output/);
    expect(existsSync(stateLockPath(statePath))).toBe(false);

    fsFail.close = false;
    const lock = await acquireStateLock(statePath);
    held.push(lock);
  });

  it("ロックファイルの中身を読めないときも奪わない", async () => {
    // 上の「pid が読めないロックは奪わない」は中身が pid として解せない場合で、
    // こちらは**ファイルそのものが読めない**場合。どちらも「死んでいる」証拠ではないので、
    // 奪うと防ぎたい二重起動を作る。
    const pid = await deadPid();
    await writeFile(stateLockPath(statePath), `${pid}\n`, "utf8");

    fsFail.read = true;
    const e = await acquireStateLock(statePath).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(StateLockedError);
    // pid を特定できないことがメッセージに出る（消していいかを人が判断できるように）。
    expect((e as StateLockedError).message).toContain("保持プロセスを特定できません");
    expect((e as StateLockedError).holderPid).toBeNull();

    // 死んだ pid を持つロックでも、読めない間は消さずに残す。
    fsFail.read = false;
    expect((await readFile(stateLockPath(statePath), "utf8")).trim()).toBe(String(pid));
  });

  it("stale ロックを消せなかったら、起動せずに失敗を返す", async () => {
    // 奪えなかったのに続行すると、排他を取れていないまま起動する。
    const pid = await deadPid();
    await writeFile(stateLockPath(statePath), `${pid}\n`, "utf8");

    fsFail.unlink = true;
    await expect(acquireStateLock(statePath)).rejects.toThrow(/EACCES|permission/);
    // 消せなかったのだから残っている。`ENOENT` なら成功扱いで周回するのと対になる。
    expect(existsSync(stateLockPath(statePath))).toBe(true);
  });

  /**
   * 奪い合いの窓に入ったときの振る舞い。`src/store/lock.ts` の冒頭が「窓を狭めるだけで
   * 消してはいない」と書いている、その狭める側の実装を見る。
   *
   * `readFile` を差し替えて、**取得直後の読み直しが常に他人の pid を返す**状況を作る。
   * 実際には「自分が `wx` で作った直後に、別プロセスが stale と見て消し、作り直した」
   * ときにこうなる。
   *
   * 見たいのは 2 つ。**自分のものでないロックを返さないこと**と、**無限に回らないこと**。
   */
  it("取得直後に自分の pid でなくなっていたら、ロックを返さずに諦める", async () => {
    // 他人かつ死んでいる pid。死んでいるので周回のたびに奪いに行き、そのつど
    // 読み直しで他人だと分かる、という噛み合わない状態が続く。
    const other = await deadPid();
    fsFail.readPid = `${other}\n`;

    const e = await acquireStateLock(statePath).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(StateLockedError);
    expect((e as StateLockedError).holderPid).toBe(other);

    /**
     * 諦めるまでの読み直しは 4 回（`MAX_ATTEMPTS` が 3 で、周回ごとに 1 回 + 最後に
     * メッセージ用の 1 回）。**この数を固定するのは回数そのものが大事だからではなく、
     * 上限を変えたときにここが目に入るようにするため**である。
     */
    expect(fsFail.readPidCalls).toBe(4);
  });

  it("プロセスが落ちてもロックを置き去りにしない", async () => {
    // `release()` を通らない経路（例外で落ちる、SIGKILL 以外の終了）でも残さない保険。
    // 実プロセスを落として見るのが直接的だが、それだとこのテスト自身が死ぬので、
    // 登録されたハンドラを取り出して呼ぶ。
    const before = process.listeners("exit").length;
    const lock = await acquireStateLock(statePath);
    const listeners = process.listeners("exit");
    expect(listeners).toHaveLength(before + 1);

    const onExit = listeners[listeners.length - 1]!;
    expect(existsSync(lock.path)).toBe(true);
    // Node は終了コードを渡す（実装は受け取らない）。型に合わせて 0 を渡す。
    onExit(0);
    expect(existsSync(lock.path)).toBe(false);

    // 2 回走っても落ちない（`removed` の番）。exit は 1 回だけだが、`release()` の後に
    // 残っていた分が走る順序もある。
    expect(() => onExit(0)).not.toThrow();

    // 保険が消した後の `release()` は、消えていることを見て素通りする。
    await expect(lock.release()).resolves.toBeUndefined();
    process.removeListener("exit", onExit);
    expect(process.listeners("exit")).toHaveLength(before);
  });

  it("片付けの失敗で、元の原因を隠さない", async () => {
    // pid を書けず、作りかけを消すのにも失敗したとき。返すべきは書き込みの失敗
    // （ENOSPC）で、片付けの失敗（EACCES）ではない。原因を後片付けで上書きすると、
    // ディスクが一杯なのに「権限の問題」を読むことになる。
    fsFail.write = true;
    fsFail.unlink = true;
    await expect(acquireStateLock(statePath)).rejects.toThrow(/ENOSPC|no space/);
  });

  it("他のプロセスが先に stale ロックを消していても、そのまま取れる", async () => {
    // 2 プロセスが同じ stale ロックを奪いに行く窓（`src/store/lock.ts` の冒頭の注記）。
    // 消そうとしたら既に無い、は正常な成り行きなので、失敗として投げてはいけない。
    const pid = await deadPid();
    await writeFile(stateLockPath(statePath), `${pid}\n`, "utf8");

    fsFail.unlinkGone = true;
    const lock = await acquireStateLock(statePath);
    held.push(lock);
    expect((await readFile(lock.path, "utf8")).trim()).toBe(String(process.pid));
  });

  it("保持中にロックファイルが消えていたら、release は成功として返る", async () => {
    // 人が手で消す・掃除スクリプトが拾う、といった筋で起こる。`release()` がここで
    // 投げると、`src/index.ts` の停止経路が終了コードを 1 にしてしまう。
    const lock = await acquireStateLock(statePath);
    await unlink(lock.path);

    // `removed` はまだ false（保険も release も通っていない）ので、実際に unlink まで行く。
    await expect(lock.release()).resolves.toBeUndefined();
    expect(existsSync(lock.path)).toBe(false);
  });
});
