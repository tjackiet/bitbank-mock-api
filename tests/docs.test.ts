import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

/** 追跡対象のソースとドキュメント。ビルド生成物や node_modules を拾わないよう git に聞く。 */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".md") || f.endsWith(".sh"));
}

/**
 * `docs/fidelity.md の「◯◯」` の形の参照から、◯◯ を抜き出す。
 *
 * **コメントの折り返しを畳んでから拾う。** JSDoc の中では名前が
 * `「不変量 5 と \`fillOrder\` の\n * クランプ」` のように行をまたぐので、
 * 畳まないと実在するものまで「無い」と報告してしまう（実際にそう誤判定した）。
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
  return lines.slice(start, end).filter((l) => l.startsWith("### ")).map((l) => l.slice(4).trim());
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
        if (!FIDELITY.includes(name)) missing.push(`${f}: 「${name}」`);
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
        const re = new RegExp(`「${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}」[^。、）\\n]{0,6}行`);
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
      const lead = body.slice(0, body.findIndex((l) => l.startsWith("- **"))).join("").trim();
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
});
