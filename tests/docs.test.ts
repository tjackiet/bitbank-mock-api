import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `docs/fidelity.md` を名指しする参照が実在するかを機械で見る。
 *
 * CLAUDE.md は「挙動の根拠を確認するときは実装よりまずこの表を読む」と指示する。
 * その指示は、**指した先が実在して初めて意味を持つ**。ところが実際には空振りする参照が
 * 溜まっていた——8 箇所が指す「ペア」節は見出しとして存在せず、
 * `src/schemas/requests.ts` が指す「同じ名前で複数来る値」はどこにも無かった。
 * どちらも読む側からは「探し方が悪いのか、無いのか」が区別できない。
 *
 * 人が見つけるたびに直すのをやめて、ここで落とす。
 */

const FIDELITY = readFileSync("docs/fidelity.md", "utf8");

/** 正規表現に埋めるための退避。 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `#` で始まる見出しの名前。 */
const HEADINGS = new Set([...FIDELITY.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1]));

/**
 * その名前が節・論点の見出しとして実在するか。
 *
 * **見出しだけに絞ると落ちる。** `docs/fidelity.md` には太字の段落を見出し代わりに
 * 使っている論点が 3 つあり（「不変量 5 と \`fillOrder\` のクランプ」「不変量の前提」
 * 「資産キー・ペア名で引く地図」）、そこを指す参照が実在する。実測して確かめた。
 *
 * 逆に**本文のどこかに出るだけ**で通すと、節を消しても語がどこかに残っていれば
 * 「ある」と報告してしまう。だから見出しか行頭の太字か、のどちらかを要求する。
 */
function isAnchor(name: string): boolean {
  return HEADINGS.has(name) || new RegExp(`^\\*\\*${escapeRegExp(name)}`, "m").test(FIDELITY);
}

const README = readFileSync("README.md", "utf8");

/**
 * `src/` が読む環境変数の名前。`process.env.X` と、`env` を引数で受ける形（`env.X`）の両方を拾う。
 * `src/server/config.ts` は既定引数 `env: NodeJS.ProcessEnv = process.env` で受けるので、
 * `process.env.` だけを探すと 9 個中 6 個を取り逃がす（実測した）。
 */
function envNamesInSrc(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of files.filter((x) => x.startsWith("src/"))) {
    for (const m of readFileSync(f, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
      found.set(m[1]!, [...(found.get(m[1]!) ?? []), f]);
    }
  }
  return found;
}

/** README の「環境変数」節に `\`名前\`` として出る語。 */
function envNamesInReadme(): Set<string> {
  const after = README.split("## 環境変数")[1] ?? "";
  const section = after.split("\n## ")[0]!;
  return new Set([...section.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]!));
}

/** 追跡対象のソースとドキュメント。ビルド生成物や node_modules を拾わないよう git に聞く。 */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".md") || f.endsWith(".sh"));
}

/**
 * `docs/fidelity.md` を名指しして節や行の名前を鉤括弧で挙げている箇所から、その名前を抜き出す。
 * 拾う形は下の正規表現そのもの。
 *
 * **このコメントに拾われる形を書いてはいけない。** 走査対象には自分自身も入るので、
 * 説明のつもりで例を書くと、その架空の名前を探しに行って落ちる（実際に CI で落ちた）。
 *
 * **コメントの折り返しは畳んでから拾う。** JSDoc の中では名前が行をまたぐことがあり
 * （`* ` が挟まる）、畳まないと実在するものまで「無い」と報告してしまう。
 */
function referencedNames(text: string): string[] {
  const names: string[] = [];
  const re = /fidelity\.md`?\s*の\s*「([^」]+)」/g;
  for (const m of text.matchAll(re)) {
    names.push(m[1].replace(/\s*\n\s*\*\s*/g, ""));
  }
  return names;
}

/** 対応表の小節（`### ` の見出し）。 */
function matrixItems(): string[] {
  const lines = FIDELITY.split("\n");
  const start = lines.indexOf("## 対応表");
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## ") && l !== "## 対応表");
  return lines
    .slice(start, end)
    .filter((l) => l.startsWith("### "))
    .map((l) => l.slice(4).trim());
}

describe("docs/fidelity.md への参照", () => {
  const files = trackedFiles();

  it("参照を拾えている（正規表現が空振りしていない）", () => {
    const total = files.reduce((n, f) => n + referencedNames(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it("名指しした節・行がすべて実在する", () => {
    const missing: string[] = [];
    for (const f of files) {
      for (const name of referencedNames(readFileSync(f, "utf8"))) {
        if (!isAnchor(name)) missing.push(`${f}: 「${name}」`);
      }
    }
    expect(missing, `docs/fidelity.md に無い: ${missing.join(" / ")}`).toEqual([]);
  });

  /**
   * 対応表の項目を指すときは「行」ではなく「節」と呼ぶ。1 項目 1 行の表をやめて
   * 小節へ移したので、「行」のままだと読み手が表を探して見つからない。
   */
  it("対応表の項目を「行」と呼んでいる参照が残っていない", () => {
    const items = matrixItems();
    const stale: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const item of items) {
        const re = new RegExp(`「${escapeRegExp(item)}」[^。、）\\n]{0,6}行`);
        if (re.test(text)) stale.push(`${f}: 「${item}」…行`);
      }
    }
    expect(stale, `「節」へ直す: ${stale.join(" / ")}`).toEqual([]);
  });
});

describe("docs/fidelity.md 対応表の形", () => {
  /**
   * 小節の本文（「モックの挙動」）に続けて、4 つのラベルを箇条書きで持つ。
   * 表だったころは列が揃っていることを Markdown が保証していたが、小節にすると
   * **書き足す人が 1 つ落としても気づけない**。そこをここで見る。
   */
  const REQUIRED = ["根拠", "本物との差異", "推測", "利用側への含意"];

  /** 「推測」の下の確認先の区分。意味は `docs/fidelity.md` の「確認先」の段落。 */
  const CONFIRM_KINDS = ["実 API", "利用側と合意", "モックの設計判断"];

  const sections = (() => {
    const lines = FIDELITY.split("\n");
    const start = lines.indexOf("## 対応表");
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## ") && l !== "## 対応表");
    const out: Array<{ item: string; body: string[] }> = [];
    for (const l of lines.slice(start, end)) {
      if (l.startsWith("### ")) out.push({ item: l.slice(4).trim(), body: [] });
      else if (out.length > 0) out[out.length - 1].body.push(l);
    }
    return out;
  })();

  it("小節が並んでいる", () => {
    expect(sections.length).toBeGreaterThan(40);
  });

  it("どの小節も 4 つのラベルを持ち、本文が空でない", () => {
    const broken: string[] = [];
    for (const { item, body } of sections) {
      const labels = body
        .map((l) => /^- \*\*(.+?)\*\*: /.exec(l)?.[1])
        .filter((x): x is string => x !== undefined);
      for (const need of REQUIRED) {
        if (!labels.includes(need)) broken.push(`${item}: 「${need}」が無い`);
      }
      // ラベル行より前が「モックの挙動」。ここが空だと項目名しか無い小節になる。
      const lead = body
        .slice(
          0,
          body.findIndex((l) => l.startsWith("- **")),
        )
        .join("")
        .trim();
      if (lead === "") broken.push(`${item}: 本文が空`);
    }
    expect(broken, broken.join(" / ")).toEqual([]);
  });

  /**
   * 「推測」の値が空でないこと**だけ**を見る。
   *
   * 当初は「はい / いいえ で始まる」を要求したが、実際の語彙はそれだけではない——
   * 「一部はい（…）」や「発注経路だけ外挿（推測）。照会 4 経路は実測」のように、
   * **どこまでが実測でどこからが推測かを書き分けている項目がある**。語彙を狭めると
   * その書き分けを潰す側に働くので、空でないことだけを見る。
   */
  it("「推測」の値が空でない", () => {
    const empty: string[] = [];
    for (const { item, body } of sections) {
      const line = body.find((l) => l.startsWith("- **推測**: "));
      if ((line?.replace("- **推測**: ", "") ?? "").trim() === "") empty.push(item);
    }
    expect(empty, `推測かどうかが書かれていない: ${empty.join(" / ")}`).toEqual([]);
  });

  /**
   * 「推測」の下の確認先の箇条（区分の意味は `docs/fidelity.md` の「確認先」の段落が持つ）。
   *
   * **何を数えるか**を先に決めておく。ここが曖昧だと、書き足した人が形を少し崩しただけで
   * 黙って数から漏れる。
   *
   * - **小節**は `## 対応表` の中の `### ` 見出し 1 つ（上の `sections`）。`## ペア` や
   *   `## 状態の不変量（PaperState v3）` の下は対応表の小節ではないので見ない
   * - **確認先の箇条**は、`- **推測**: ` の行の**直後に続く**、字下げ 2 つの箇条
   *   （行頭が空白 2 つと `- `）。別の行が挟まったところで終わる
   * - 箇条は `確認先 **<区分>**: <文>` の形だけを認め、区分は `CONFIRM_KINDS` の 3 つに限る
   * - 「推測」の値が `いいえ` で始まる小節は確認先を持たなくてよい。それ以外は 1 つ以上持つ
   */
  const confirmItems = sections.flatMap(({ item, body }) => {
    const at = body.findIndex((l) => l.startsWith("- **推測**: "));
    const block: string[] = [];
    for (let i = at + 1; at >= 0 && i < body.length && body[i].startsWith("  - "); i++) {
      block.push(body[i]);
    }
    return block.map((line) => {
      const m = /^ {2}- 確認先 \*\*(.+?)\*\*: (.+)$/.exec(line);
      return { item, line, kind: m?.[1], text: m?.[2] };
    });
  });

  it("確認先の箇条を拾えている（導出が空振りしていない）", () => {
    expect(confirmItems.filter((c) => c.kind === "実 API").length).toBeGreaterThan(20);
    for (const kind of CONFIRM_KINDS) {
      expect(
        confirmItems.some((c) => c.kind === kind),
        `${kind} が 1 つも無い`,
      ).toBe(true);
    }
  });

  it("確認先の箇条は決めた形と 3 つの区分に収まっている", () => {
    const bad = confirmItems
      .filter((c) => c.kind === undefined || !CONFIRM_KINDS.includes(c.kind))
      .map((c) => `${c.item}: ${c.line.trim()}`);
    expect(bad, `形か区分が違う: ${bad.join(" / ")}`).toEqual([]);
  });

  it("確認先は「推測」の直下にだけ置いている", () => {
    // 直下の外に置くと上の `confirmItems` から漏れ、数えられない確認先になる。
    const counted = new Set(confirmItems.map((c) => `${c.item}\u0000${c.line}`));
    const stray = sections.flatMap(({ item, body }) =>
      body
        .filter((l) => /^\s*- 確認先 /.test(l) && !counted.has(`${item}\u0000${l}`))
        .map((l) => `${item}: ${l.trim()}`),
    );
    expect(stray, `「推測」の直下へ移す: ${stray.join(" / ")}`).toEqual([]);
  });

  it("「推測」が いいえ で始まらない小節は確認先を持つ", () => {
    const withConfirm = new Set(confirmItems.map((c) => c.item));
    const missing = sections
      .filter(({ body }) => {
        const value = body.find((l) => l.startsWith("- **推測**: "))?.replace("- **推測**: ", "");
        return !(value ?? "").startsWith("いいえ");
      })
      .map(({ item }) => item)
      .filter((item) => !withConfirm.has(item));
    expect(missing, `誰が答えられるかが書かれていない: ${missing.join(" / ")}`).toEqual([]);
  });

  /**
   * 実 API への確認は、答える人がその場で答えられる**問い**にする。「…を推測で決めた」の形だと
   * 何を聞かれているかが分からない。形の近似として、文が「か」で終わることを見る。
   */
  it("確認先が実 API の箇条は問いの形で終わる", () => {
    const notQuestion = confirmItems
      .filter((c) => c.kind === "実 API" && !c.text?.endsWith("か"))
      .map((c) => `${c.item}: ${c.text}`);
    expect(notQuestion, `問いの形にする: ${notQuestion.join(" / ")}`).toEqual([]);
  });
});

/**
 * CLAUDE.md は「環境変数の一覧は `README.md` の「環境変数」節」と指示する。
 * その一覧が実際に全部を載せているかを見る。
 *
 * 一覧が欠けても**誰も落ちない**——コードは読めるし、README は間違っていないように見える。
 * 気づくのは、設定したのに効かないと悩んだ人が `src/` を grep したときになる。
 * `docs/fidelity.md` の参照を機械で見るのと同じ理由でここに置く。
 */
describe("README.md の環境変数一覧", () => {
  const files = trackedFiles();
  const inSrc = envNamesInSrc(files);
  const inReadme = envNamesInReadme();

  it("導出が空振りしていない", () => {
    // 見出しを変えたり読み方を変えたりすると、両方が空になって全部通ってしまう。
    expect(inSrc.size).toBeGreaterThan(5);
    expect(inReadme.size).toBeGreaterThan(5);
  });

  it("`src/` が読む環境変数がすべて載っている", () => {
    const missing = [...inSrc]
      .filter(([name]) => !inReadme.has(name))
      .map(([name, where]) => `${name}（${where.join(", ")}）`);
    expect(missing, `README.md の「環境変数」節へ追記する: ${missing.join(" / ")}`).toEqual([]);
  });
});

/**
 * 改訂一覧（`docs/fidelity.md` の「v0.1.0 からの改訂」）をはじめ、`docs/fidelity.md` の見出しを
 * 指す内部リンクが実在するかを機械で見る。
 *
 * 一覧は索引なので、**一覧だけが古くなる**のが一番起きやすい壊れ方である。小節の名前を変えても、
 * 小節を消しても、一覧は何も言わずに残る。読む側からは「リンクが死んでいる」ことが
 * クリックするまで分からない。`tests/structure.test.ts` の許可リストと同じ考え方でここに置く。
 *
 * 対象は `docs/fidelity.md` の中のリンクだけではない。**他のドキュメントから対応表の節を指す
 * リンクも同じように腐る**ので、追跡対象の Markdown から一律に拾う。
 *
 * 見ているのは 3 方向。
 *
 * 1. リンク先（`#...`）が実在する見出しのアンカーであること
 * 2. リンクの**文字列**がその見出しの名前を含むこと（見出しだけ改名しても落ちる）
 * 3. アンカーの計算が GitHub と一致すると言い切れる見出しにだけリンクしていること
 */
describe("docs/fidelity.md の見出しを指すリンク", () => {
  /**
   * GitHub の見出しアンカー（github-slugger）の規則。小文字化 → 記号の除去 → 空白をハイフンへ。
   * ハイフンと下線は残る。
   *
   * `・`（U+30FB）は記号として落ちる。これは推測ではなく、GitHub が描画した
   * `docs/fidelity.md` の HTML から確かめた（`数量・価格の精度` → `user-content-数量価格の精度`）。
   */
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[\u2000-\u206F\u2E00-\u2E7F\u30FB\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, "")
      .replace(/ /g, "-");

  /**
   * 上の `slug()` が GitHub と**確実に同じ結果になる**文字だけを並べた集合。
   *
   * github-slugger が落とす記号の一覧は長く、ここに写すと写し間違いが起きる。かといって
   * 近似で通すと、アンカーが GitHub 側でだけ違う値になってリンクが黙って死ぬ。そこで
   * 「判断が付く文字だけを許す」側に倒し、外れる見出し（全角括弧を含むものなど）へ
   * リンクしようとしたらここで落とす。そのときは GitHub の描画でアンカーを確かめてから、
   * その文字を `slug()` とこの集合の両方へ足すこと（`・` はそうやって足した）。
   */
  const ANCHOR_SAFE = /^[0-9A-Za-z_\-./` \u3005\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+$/;

  /** アンカー → 見出しの名前。 */
  const headingOf = new Map([...HEADINGS].map((h) => [`#${slug(h)}`, h]));

  /**
   * `docs/fidelity.md` の見出しを指すリンク。ファイル内リンク（`](#...)`）は
   * `docs/fidelity.md` 自身のものだけを拾う（README の目次まで巻き込まないため）。
   */
  function fidelityLinks(files: string[]) {
    const re = /\[([^\]]+)\]\(((?:\.{0,2}\/)*(?:docs\/)?fidelity\.md)?(#[^)]+)\)/g;
    const out: Array<{ file: string; text: string; frag: string }> = [];
    for (const f of files.filter((x) => x.endsWith(".md"))) {
      for (const m of readFileSync(f, "utf8").matchAll(re)) {
        if (m[2] === undefined && f !== "docs/fidelity.md") continue;
        out.push({ file: f, text: m[1]!, frag: m[3]! });
      }
    }
    return out;
  }

  /** リンクの文字列が見出しを名指ししているか。鉤括弧で引用する書き方も許す。 */
  const namesHeading = (text: string, heading: string) =>
    text === heading || text.includes(`「${heading}」`);

  const links = fidelityLinks(trackedFiles());

  it("導出が空振りしていない", () => {
    expect(links.length).toBeGreaterThan(20);
    expect(headingOf.size).toBeGreaterThan(40);
  });

  it("リンク先の見出しが実在する", () => {
    const dead = links
      .filter((l) => !headingOf.has(l.frag))
      .map((l) => `${l.file}: 「${l.text}」→ ${l.frag}`);
    expect(dead, `指す先の見出しが無い: ${dead.join(" / ")}`).toEqual([]);
  });

  it("リンクの文字列が見出しの名前を含む", () => {
    const wrong = links
      .filter((l) => {
        const h = headingOf.get(l.frag);
        return h !== undefined && !namesHeading(l.text, h);
      })
      .map((l) => `${l.file}: 「${l.text}」→ ${l.frag}`);
    expect(wrong, `見出しの名前とリンクの文字列が食い違う: ${wrong.join(" / ")}`).toEqual([]);
  });

  it("アンカーの計算が GitHub と一致すると言い切れる見出しにだけリンクしている", () => {
    const risky = [...new Set(links.map((l) => headingOf.get(l.frag)))]
      .filter((h): h is string => h !== undefined)
      .filter((h) => !ANCHOR_SAFE.test(h));
    expect(risky, `GitHub の描画でアンカーを確かめること: ${risky.join(" / ")}`).toEqual([]);
  });
});
