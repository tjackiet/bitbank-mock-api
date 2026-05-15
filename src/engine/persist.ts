import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PaperHistoryEntrySchema, PaperStateSchema, type PaperState } from "./state.ts";
import type { Result } from "./types.ts";

const PaperStateSchemaV1 = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  initialJpy: z.number(),
  balances: z.record(z.string(), z.number()),
  history: z.array(PaperHistoryEntrySchema),
});

const PaperStateAnySchema = z.discriminatedUnion("version", [PaperStateSchemaV1, PaperStateSchema]);

function migrateToV2(parsed: z.infer<typeof PaperStateAnySchema>): PaperState {
  if (parsed.version === 2) return parsed;
  return {
    version: 2,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    initialJpy: parsed.initialJpy,
    balances: parsed.balances,
    history: parsed.history,
    lastTickAt: parsed.updatedAt,
    openOrders: [],
  };
}

export function defaultStatePath(sessionId: string): string {
  if (process.env.BITBANK_MOCK_STATE_PATH) return process.env.BITBANK_MOCK_STATE_PATH;
  const root = process.env.BITBANK_MOCK_HOME ?? join(homedir(), ".bitbank-mock");
  return join(root, "sessions", sessionId, "state.json");
}

export async function loadState(path: string): Promise<Result<PaperState | null>> {
  try {
    const buf = await readFile(path, "utf-8");
    const parsed = PaperStateAnySchema.safeParse(JSON.parse(buf));
    if (!parsed.success) {
      return { success: false, error: `invalid paper state: ${parsed.error.message}` };
    }
    return { success: true, data: migrateToV2(parsed.data) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { success: true, data: null };
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `failed to read paper state: ${msg}` };
  }
}

export async function saveState(path: string, state: PaperState): Promise<Result<true>> {
  const data = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    return { success: true, data: true };
  } catch (e) {
    await unlink(tmp).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `failed to write paper state: ${msg}` };
  }
}

export async function deleteState(path: string): Promise<Result<true>> {
  try {
    await unlink(path);
    return { success: true, data: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { success: true, data: true };
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `failed to delete paper state: ${msg}` };
  }
}
