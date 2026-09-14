import { buildServer } from "./server/http.ts";
import { fillMode, isControlEnabled, listenHost, persistFailureMode } from "./server/config.ts";
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
  const control = isControlEnabled();
  const mode = fillMode();
  const persistMode = persistFailureMode();
  const host = listenHost();
  const store = await loadOrInitDefault(DEFAULT_INITIAL_JPY, {
    logger: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
    fillMode: mode,
  });
  const fastify = await buildServer({
    store,
    logger: true,
    controlEnabled: control,
    controlToken: process.env.BITBANK_MOCK_CONTROL_TOKEN,
  });
  await fastify.listen({ port, host });
  // persistFailure は既定が degrade（v0.1.0 からの変更）なので、起動時に見えるようにしておく。
  console.log(
    `bitbank-lab-mock listening on http://${host}:${port} fillMode=${mode} ` +
      `persistFailure=${persistMode}${control ? " control=on" : ""}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
