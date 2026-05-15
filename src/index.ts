import { buildServer } from "./server/http.ts";
import { loadOrInitDefault } from "./store/session.ts";

const DEFAULT_PORT = 14000;
const DEFAULT_INITIAL_JPY = 1_000_000;

function parsePort(argv: string[]): number {
  const isValidPort = (n: number): boolean =>
    Number.isInteger(n) && n >= 1 && n <= 65535;
  const i = argv.indexOf("--port");
  if (i >= 0 && argv[i + 1]) {
    const n = Number(argv[i + 1]);
    if (isValidPort(n)) return n;
  }
  if (process.env.BITBANK_MOCK_PORT) {
    const n = Number(process.env.BITBANK_MOCK_PORT);
    if (isValidPort(n)) return n;
  }
  return DEFAULT_PORT;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "serve";
  if (cmd !== "serve") {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
  const port = parsePort(argv);
  const store = await loadOrInitDefault(DEFAULT_INITIAL_JPY, {
    logger: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
  });
  const fastify = await buildServer({ store, logger: true });
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`bitbank-mock-api listening on http://localhost:${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
