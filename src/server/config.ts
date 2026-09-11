export type FillMode = "market" | "manual";

export function isControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BITBANK_MOCK_CONTROL === "1";
}

export function fillMode(env: NodeJS.ProcessEnv = process.env): FillMode {
  if (env.BITBANK_MOCK_FILL_MODE === "market") return "market";
  if (env.BITBANK_MOCK_FILL_MODE === "manual") return "manual";
  return isControlEnabled(env) ? "manual" : "market";
}

export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BITBANK_MOCK_HOST) return env.BITBANK_MOCK_HOST;
  return isControlEnabled(env) ? "127.0.0.1" : "0.0.0.0";
}

export function controlToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.BITBANK_MOCK_CONTROL_TOKEN;
  return token ? token : undefined;
}
