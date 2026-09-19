import { unlinkSync } from "node:fs";
import { type FileHandle, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 状態ファイルの起動時排他。
 *
 * 同じ状態ファイルを 2 プロセスが同時に使うと、各プロセスが独立したメモリ上の状態と
 * `nextOrderSeq` を持つため、**両方が `success: 1` を返しながら**、後から `rename` した側が
 * 相手の注文を丸ごと消す。order id も重複する。書き込みロックでは防げない（採番が
 * プロセスごとに分かれる以上、消失も重複も残る）が、起動時の排他は状況そのものを作らせない。
 *
 * ロックは `<状態ファイル>.lock` で、中身は保持プロセスの pid 1 行。取得は `wx` の原子性に
 * 頼る。`EEXIST` なら pid の生死を `process.kill(pid, 0)` で見て、死んでいれば奪う。
 * 奪わないと `SIGKILL` の後に二度と起動できないという、今より悪い footgun になる。
 *
 * **競合の残り**: 2 プロセスが「同じ stale ロックを見つけて奪う」処理に同時に入ると、
 * 片方が消した直後にもう片方が作る順序で、両方が取得に成功しうる。取得後に pid を
 * 読み直して自分のものか確かめることで窓は狭めているが、消してはいない。防ぎ切るには
 * `flock` が要り、Node は標準で持たない。人が `npm run dev` を 2 回叩く現実の間隔
 * （秒）では起きないが、**「起きない」ではなく「窓が狭い」**である。
 */

/** stale ロックを奪う試行の上限。奪い合いで無限に回らないようにする。 */
const MAX_ATTEMPTS = 3;

export type StateLock = {
  /** ロックファイルのパス。 */
  readonly path: string;
  /**
   * ロックを手放す。既に消せていれば何もしない。
   *
   * **消せなかったときは reject する**（`ENOENT` は消えているので成功扱い）。その場合は
   * 解放済みと記録しないので、もう一度呼べばやり直し、プロセス終了時の保険も残る。
   */
  release(): Promise<void>;
};

/** 状態ファイルに対応するロックファイルのパス。 */
export function stateLockPath(statePath: string): string {
  return `${statePath}.lock`;
}

/** `fs` などが投げるエラーの `code`。エラーでなければ `undefined`。 */
function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * pid が生きているか。シグナル 0 は存在確認だけで、プロセスには何も送らない。
 *
 * **`ESRCH` だけが「居ない」の証拠**で、それ以外はすべて生きている側に倒す。`EPERM` は
 * 「居るが自分に権限が無い」で、残りは判定できなかったということ。どちらも奪う根拠にならない。
 * 倒す先を間違えると、生きているプロセスのロックを奪って二重起動を作る（起動を断るほうの
 * 間違いは、メッセージを読んでロックファイルを消せば直る）。
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) !== "ESRCH";
  }
}

/**
 * ロックファイルの中身から pid を読む。読めない・数として解せない場合は `null`。
 *
 * `null` は**奪わない**（下記 `acquireStateLock` を参照）。空のロックファイルは、
 * 別プロセスが `wx` で作った直後でまだ pid を書いていない瞬間にも現れるので、
 * 「中身が無い＝死んでいる」と扱うと、防ごうとしている二重起動をそこで作ってしまう。
 */
async function readHolderPid(lockPath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * `wx` でロックを作り、自分の pid を書く。既にあれば `false`。
 *
 * **pid を書けなかったときは、作ったロックファイルを消してから投げる。** 残すと中身が
 * 空のロックになり、`readHolderPid()` が `null` を返して以後どの起動も奪わない。つまり
 * ディスクが一杯になった一度きりの失敗で、**手でファイルを消すまで二度と起動できなくなる**。
 * 掃除は best effort で、消せなくても元の例外を返す（そちらが原因だから）。
 */
async function tryCreate(lockPath: string): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await open(lockPath, "wx");
  } catch (e) {
    if (errorCode(e) === "EEXIST") return false;
    throw e;
  }
  try {
    await fh.writeFile(`${process.pid}\n`, "utf8");
  } catch (e) {
    await discard(fh, lockPath);
    throw e;
  }
  try {
    await fh.close();
  } catch (e) {
    await discard(null, lockPath);
    throw e;
  }
  return true;
}

/** 作りかけのロックを片付ける。どの失敗も握り潰す（呼び出し元が元の例外を返す）。 */
async function discard(fh: FileHandle | null, lockPath: string): Promise<void> {
  if (fh) {
    try {
      await fh.close();
    } catch {
      /* 閉じられなくても消しにいく */
    }
  }
  try {
    await unlink(lockPath);
  } catch {
    /* 消せなくても元の例外を返す */
  }
}

export class StateLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holderPid: number | null,
  ) {
    const who =
      holderPid === null
        ? "保持プロセスを特定できません（ロックファイルに pid がありません）"
        : `pid ${holderPid} が使用中です`;
    super(
      `状態ファイルは他のプロセスが使用中です: ${lockPath}\n` +
        `${who}。\n` +
        "同じ状態ファイルを 2 プロセスから使うと、両方が成功を返しながら片方の注文が" +
        "丸ごと消え、order id も重複します。\n" +
        "並列にシナリオを流すときは BITBANK_MOCK_STATE_PATH を分けてください。\n" +
        "保持プロセスが既に居ないことが確かなら、このファイルを消してから起動してください。",
    );
    this.name = "StateLockedError";
  }
}

/**
 * 状態ファイルの排他を取る。取れなければ `StateLockedError` を投げる（起動しない）。
 *
 * `loadOrInitDefault()` ではなく呼び出し側（`src/index.ts`）から呼ぶ。防ぎたいのは
 * 「サーバが 2 つ動く」ことで、`loadOrInitDefault()` は状態ファイルを読み直すだけの
 * 用途でも使われる（テストが同じパスに対して何度も呼ぶ）。ロックの寿命はサーバの
 * 寿命と同じなので、シグナル処理と同じ場所に置く。
 */
export async function acquireStateLock(statePath: string): Promise<StateLock> {
  const lockPath = stateLockPath(statePath);
  // 状態ファイルの階層は saveState() が最初の書き込みで作るので、初回起動ではまだ無い。
  // 耐久性は要らない（ロックは残っても次の起動が stale として奪う）ので fsync はしない。
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await tryCreate(lockPath)) {
      // 書いた直後に読み直す。stale の奪い合いで別プロセスに消され作り直されていたら、
      // ここで自分の pid ではなくなる。窓を狭めるだけで、消してはいない（冒頭の注記）。
      if ((await readHolderPid(lockPath)) === process.pid) return makeLock(lockPath);
      continue;
    }

    const holder = await readHolderPid(lockPath);
    // pid が読めない間は奪わない。相手が `wx` で作った直後かもしれない。
    if (holder === null || isAlive(holder)) throw new StateLockedError(lockPath, holder);

    // 死んだ pid のロックは奪う。消せなければ次の周回で取り直す。
    try {
      await unlink(lockPath);
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
  }

  throw new StateLockedError(lockPath, await readHolderPid(lockPath));
}

/** 取得済みのロックに、手放す口と「落ちても置き去りにしない」保険を付ける。 */
function makeLock(lockPath: string): StateLock {
  let removed = false;

  // 例外で落ちる経路でも置き去りにしない。同期でしか動けないので unlinkSync を使う。
  // 残っても次の起動が stale として奪うので、ここは best effort でよい。
  const onExit = () => {
    if (removed) return;
    removed = true;
    try {
      unlinkSync(lockPath);
    } catch {
      /* 消せなくても停止は妨げない */
    }
  };
  process.once("exit", onExit);

  return {
    path: lockPath,
    async release() {
      if (removed) return;
      try {
        await unlink(lockPath);
      } catch (e) {
        if (errorCode(e) !== "ENOENT") throw e;
      }
      // **消せてから**印を付け、exit の保険を外す。先に外すと、unlink が失敗した回に
      // 保険まで無効になって、ロックが確実に残る。
      removed = true;
      process.removeListener("exit", onExit);
    },
  };
}
