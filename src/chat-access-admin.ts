import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatAccessRegistry } from "./chat-access.js";
import { parseEnvFile } from "./connector-env.js";

export type ChatAccessCommand =
  | { action: "list" }
  | { action: "approve"; fingerprint: string; url: string }
  | { action: "revoke"; fingerprint: string };

/** Local terminal only: this function must never be exposed as an MCP tool. */
export async function runChatAccessAdmin(
  root: string,
  command: ChatAccessCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  let file: Record<string, string> = {};
  try { file = parseEnvFile(await readFile(join(root, ".env"), "utf8")); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const secret = env.DEVOS_CONNECTOR_OWNER_SECRET?.trim() ||
    file.DEVOS_CONNECTOR_OWNER_SECRET?.trim() || "";
  const registry = new ChatAccessRegistry(root, secret);
  if (command.action === "approve") {
    registry.approve(command.fingerprint, command.url);
    return "Chat approved. Existing connector runtimes read updated grants on their next call.\n";
  }
  if (command.action === "revoke") {
    return registry.revoke(command.fingerprint)
      ? "Chat revoked.\n"
      : "Chat reference was not approved.\n";
  }
  const entries = registry.list();
  return entries.length
    ? entries.map(b => b.fingerprint + " " + b.url).join("\n") + "\n"
    : "No approved ChatGPT chats.\n";
}
