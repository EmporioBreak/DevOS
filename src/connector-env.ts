import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ConnectorSecrets {
  ownerSecret: string;
  ngrokAuthtoken: string;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function loadConnectorSecrets(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectorSecrets> {
  let file: Record<string, string> = {};
  try {
    file = parseEnvFile(await readFile(join(root, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const ownerSecret =
    env.DEVOS_CONNECTOR_OWNER_SECRET?.trim() ||
    file.DEVOS_CONNECTOR_OWNER_SECRET?.trim() ||
    "";
  const ngrokAuthtoken =
    env.NGROK_AUTHTOKEN?.trim() ||
    file.NGROK_AUTHTOKEN?.trim() ||
    "";

  const missing = [
    !ownerSecret ? "DEVOS_CONNECTOR_OWNER_SECRET" : "",
    !ngrokAuthtoken ? "NGROK_AUTHTOKEN" : "",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing connector credentials: ${missing.join(", ")}; set them in process environment or project .env.`);
  }

  return { ownerSecret, ngrokAuthtoken };
}
