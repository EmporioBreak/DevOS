import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Camoufox } from "@camoufox/camoufox";
import type { BrowserContext } from "playwright-core";
import {
  assertChatBindingUrl,
  readChatBinding,
  setCurrentChatBinding,
  updateChatBinding,
} from "./chat-binding.js";
import {
  createCanonicalBindingClient,
  resolveCanonicalBinding,
} from "./chat-binding-api.js";
import {
  CHAT_BINDING_TOKEN,
} from "./chat-binding-protocol.js";
import {
  getChatGptProjectScope,
  loadChatGptBrowserConfig,
} from "./browser-config.js";
import { loadOrCreateCamoufoxIdentity } from "./camoufox-identity.js";
import { profileProcesses } from "./owned-browser-process.js";
import { resolveBindingWithActiveBrowserRuntime } from "./shared-browser-runtime.js";

export const TOKEN_BIND_INITIAL_DELAY_MS = 1000;

type BindingWorkerSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export async function bindChatByToken(
  token: string,
  projectUrl: string,
  projectRoot: string,
  onResolved?: (url: string) => Promise<void>,
): Promise<string> {
  if (!CHAT_BINDING_TOKEN.test(token)) throw new Error("bind_invalid_token");
  if (!getChatGptProjectScope(projectUrl)) throw new Error("bind_requires_project");

  const shared = await resolveBindingWithActiveBrowserRuntime(
    projectRoot,
    projectUrl,
    token,
  );
  if (shared) {
    assertChatBindingUrl(projectUrl, shared);
    await onResolved?.(shared);
    return shared;
  }

  const config = loadChatGptBrowserConfig(process.env, projectUrl);
  const owners = await profileProcesses(config.profileDir).catch(() => []);
  if (owners.length > 0) throw new Error("bind_profile_busy");

  const identity = await loadOrCreateCamoufoxIdentity(config.profileDir);
  let context: BrowserContext | undefined;
  try {
    context = await Camoufox({
      user_data_dir: config.profileDir,
      persistent_context: true,
      fingerprint_preset: identity.preset,
      headless: config.headless,
      timeout: 30_000,
    });
    const page =
      context.pages().find(candidate => !candidate.isClosed()) ??
      await context.newPage();
    const client = await createCanonicalBindingClient(page, projectUrl);
    const url = await resolveCanonicalBinding(client, projectUrl, token);
    assertChatBindingUrl(projectUrl, url);
    await onResolved?.(url);
    return url;
  } finally {
    await context?.close();
  }
}

export async function scheduleTokenBinding(
  token: string,
  projectUrl: string,
  projectRoot: string,
  entrypoint: string,
  execArgs: string[] = process.execArgv,
  spawnWorker: BindingWorkerSpawner = spawn,
): Promise<void> {
  if (!CHAT_BINDING_TOKEN.test(token)) throw new Error("bind_invalid_token");
  if (!getChatGptProjectScope(projectUrl)) throw new Error("bind_requires_project");

  const requestId = randomUUID();
  const requestedAt = new Date().toISOString();
  await setCurrentChatBinding(projectRoot, {
    version: 1,
    status: "pending",
    projectUrl,
    requestId,
    requestedAt,
  });

  let child: ChildProcess;
  try {
    child = spawnWorker(
      process.execPath,
      [
        ...execArgs,
        entrypoint,
        "--devos-bind-token-worker",
        token,
        projectUrl,
        requestId,
      ],
      {
        cwd: projectRoot,
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
  } catch (error) {
    await updateChatBinding(projectRoot, requestId, {
      version: 1,
      status: "failed",
      projectUrl,
      requestedAt,
      completedAt: new Date().toISOString(),
      error: "bind_worker_failed",
    });
    throw error;
  }

  child.once("error", () => {
    void updateChatBinding(projectRoot, requestId, {
      version: 1,
      status: "failed",
      projectUrl,
      requestedAt,
      completedAt: new Date().toISOString(),
      error: "bind_worker_failed",
    }).catch(() => undefined);
  });
  child.unref();
}

export async function runDeferredTokenBindingJob(
  token: string,
  projectUrl: string,
  projectRoot: string,
  requestId: string,
  dependencies: {
    wait?: (milliseconds: number) => Promise<void>;
    bind?: typeof bindChatByToken;
  } = {},
): Promise<string> {
  if (!CHAT_BINDING_TOKEN.test(token)) throw new Error("bind_invalid_token");
  const wait =
    dependencies.wait ??
    (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const bind = dependencies.bind ?? bindChatByToken;

  let requestedAt = new Date().toISOString();
  try {
    const current = await readChatBinding(projectRoot);
    if (
      current?.requestId !== requestId ||
      current.projectUrl !== projectUrl
    ) {
      throw new Error("bind_superseded");
    }
    requestedAt = current.requestedAt;
    await wait(TOKEN_BIND_INITIAL_DELAY_MS);

    const afterWait = await readChatBinding(projectRoot);
    if (afterWait?.requestId !== requestId) {
      throw new Error("bind_superseded");
    }

    return await bind(
      token,
      projectUrl,
      projectRoot,
      async conversationUrl => {
        assertChatBindingUrl(projectUrl, conversationUrl);
        const saved = await updateChatBinding(projectRoot, requestId, {
          version: 1,
          status: "resolved",
          projectUrl,
          requestedAt,
          completedAt: new Date().toISOString(),
          conversationUrl,
        });
        if (!saved) throw new Error("bind_superseded");
      },
    );
  } catch (error) {
    await updateChatBinding(projectRoot, requestId, {
      version: 1,
      status: "failed",
      projectUrl,
      requestedAt,
      completedAt: new Date().toISOString(),
      error:
        error instanceof Error && /^bind_[a-z_]+$/.test(error.message)
          ? error.message
          : "bind_failed",
    });
    throw error;
  }
}
