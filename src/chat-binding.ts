import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Camoufox } from '@camoufox/camoufox';
import type { BrowserContext, Page } from 'playwright-core';
import { loadChatGptBrowserConfig, getChatGptProjectScope } from './browser-config.js';
import { loadOrCreateCamoufoxIdentity } from './camoufox-identity.js';

export const BIND_MARKER = /^DEVOS_BIND_[A-Za-z0-9_-]{12,128}$/;
export const BIND_LIMIT = 30;
export const BIND_PASSES = 3;
export const BIND_DELAY_MS = 1500;
export const BIND_MARKER_WAIT_MS = 750;
export const BIND_PUBLICATION_DELAY_MS = 3000;

export interface ChatBindingRecord {
  version: 1;
  status: 'pending' | 'resolved' | 'failed';
  projectUrl: string;
  requestedAt: string;
  conversationUrl?: string;
  completedAt?: string;
  error?: string;
}

export function chatBindingStatePath(projectRoot: string): string {
  return join(projectRoot, '.devos', 'chat-binding.json');
}

export async function readChatBinding(projectRoot: string): Promise<ChatBindingRecord | null> {
  try {
    const record = JSON.parse(await readFile(chatBindingStatePath(projectRoot), 'utf8')) as ChatBindingRecord;
    if (!record || record.version !== 1 || !['pending', 'resolved', 'failed'].includes(record.status) ||
      typeof record.projectUrl !== 'string' || !getChatGptProjectScope(record.projectUrl) ||
      typeof record.requestedAt !== 'string' || !Number.isFinite(Date.parse(record.requestedAt)) ||
      (record.status === 'resolved' && (typeof record.conversationUrl !== 'string' || !record.completedAt || !Number.isFinite(Date.parse(record.completedAt)))) ||
      (record.status === 'failed' && (typeof record.error !== 'string' || !record.completedAt || !Number.isFinite(Date.parse(record.completedAt))))) {
      throw new Error('Invalid DevOS chat binding state');
    }
    if (record.status === 'resolved') assertChatBindingUrl(record.projectUrl, record.conversationUrl!);
    return record;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeChatBinding(projectRoot: string, record: ChatBindingRecord): Promise<void> {
  const path = chatBindingStatePath(projectRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function assertChatBindingUrl(projectUrl: string, conversationUrl: string): void {
  const scope = getChatGptProjectScope(projectUrl);
  if (!scope || !new RegExp(`^/g/${scope.projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/c/[^/]+/?$`).test(new URL(conversationUrl).pathname) || new URL(conversationUrl).origin !== scope.origin) {
    throw new Error('Invalid DevOS chat binding URL');
  }
}

export interface BindingPage {
  goto(url: string): Promise<unknown>;
  url(): string;
  locator(selector: string): { all(): Promise<Array<{ getAttribute(name: string): Promise<string | null> }>> };
  getByText(text: string, options: { exact: boolean }): {
    count(): Promise<number>;
    waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
  };
}

export async function searchBindingPass(page: BindingPage, projectUrl: string, marker: string): Promise<string | null> {
  const scope = getChatGptProjectScope(projectUrl);
  if (!scope) throw new Error('bind_requires_project');
  await page.goto(projectUrl);
  // The project sidebar presents conversation links in newest-first order.
  // Preserve that order; optional update timestamps make the ordering explicit
  // when the host exposes them on the link.
  const links = await page.locator(`a[href*="/g/${scope.projectId}/c/"]`).all();
  const rows = await Promise.all(links.map(async (link, index) => ({
    link,
    index,
    updatedAt: await link.getAttribute('data-updated-at'),
  })));
  const hasTimestamps = rows.length > 0 && rows.every(row => row.updatedAt && Number.isFinite(Date.parse(row.updatedAt)));
  if (hasTimestamps) rows.sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!) || a.index - b.index);
  const seen = new Set<string>();
  for (const { link } of rows) {
    const href = await link.getAttribute('href');
    if (!href) continue;
    const url = new URL(href, scope.origin);
    if (url.origin !== scope.origin || !new RegExp(`^/g/${scope.projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/c/[^/]+/?$`).test(url.pathname)) continue;
    if (seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    if (seen.size > BIND_LIMIT) break;
    await page.goto(url.href);
    const markerText = page.getByText(marker, { exact: true });
    try {
      await markerText.waitFor({ state: 'visible', timeout: BIND_MARKER_WAIT_MS });
      if (await markerText.count() > 0) return url.href;
    } catch (error) {
      if (!(error instanceof Error) || !/timeout|timed out/i.test(error.message)) throw error;
    }
  }
  return null;
}

export async function resolveBinding(page: BindingPage, projectUrl: string, marker: string, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<string> {
  if (!BIND_MARKER.test(marker)) throw new Error('bind_invalid_marker');
  for (let pass = 0; pass < BIND_PASSES; pass++) {
    const found = await searchBindingPass(page, projectUrl, marker);
    if (found) return found;
    if (pass + 1 < BIND_PASSES) await wait(BIND_DELAY_MS);
  }
  throw new Error('bind_not_found');
}

export async function bindChat(markerFile: string, projectUrlOverride?: string, onResolved?: (url: string) => Promise<void>): Promise<string> {
  try {
    const marker = (await readFile(markerFile, 'utf8')).trim();
    if (!BIND_MARKER.test(marker)) throw new Error('bind_invalid_marker');
    const config = loadChatGptBrowserConfig(process.env, projectUrlOverride);
    const identity = await loadOrCreateCamoufoxIdentity(config.profileDir);
    let context: BrowserContext | undefined;
    try {
      context = await Camoufox({ user_data_dir: config.profileDir, persistent_context: true, fingerprint_preset: identity.preset, headless: config.headless, timeout: 30000 });
      const page: Page = await context.newPage();
      const url = await resolveBinding(page, config.projectUrl, marker);
      await onResolved?.(url);
      return url;
    } finally {
      await context?.close();
    }
  } finally {
    await rm(markerFile, { force: true });
  }
}

type BindingWorkerSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export async function scheduleChatBinding(
  markerFile: string,
  projectUrl: string,
  projectRoot: string,
  entrypoint: string,
  execArgs: string[] = process.execArgv,
  spawnWorker: BindingWorkerSpawner = spawn,
): Promise<void> {
  try {
    const marker = (await readFile(markerFile, 'utf8')).trim();
    if (!BIND_MARKER.test(marker)) throw new Error('bind_invalid_marker');
    if (!getChatGptProjectScope(projectUrl)) throw new Error('bind_requires_project');
    const requestedAt = new Date().toISOString();
    await writeChatBinding(projectRoot, { version: 1, status: 'pending', projectUrl, requestedAt });
    let child: ChildProcess;
    try {
      child = spawnWorker(process.execPath, [
        ...execArgs,
        entrypoint,
        '--devos-bind-chat-worker',
        markerFile,
        projectUrl,
      ], {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
    } catch (error) {
      await writeChatBinding(projectRoot, {
        version: 1,
        status: 'failed',
        projectUrl,
        requestedAt,
        completedAt: new Date().toISOString(),
        error: 'bind_worker_failed',
      });
      throw error;
    }
    child.once('error', () => {
      void writeChatBinding(projectRoot, {
        version: 1,
        status: 'failed',
        projectUrl,
        requestedAt,
        completedAt: new Date().toISOString(),
        error: 'bind_worker_failed',
      }).catch(() => undefined).finally(() => rm(markerFile, { force: true }).catch(() => undefined));
    });
    child.unref();
  } catch (error) {
    await rm(markerFile, { force: true });
    throw error;
  }
}

export async function runDeferredBindingJob(
  markerFile: string,
  projectUrl: string,
  projectRoot: string,
  dependencies: {
    wait?: (milliseconds: number) => Promise<void>;
    bind?: typeof bindChat;
  } = {},
): Promise<string> {
  const wait = dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const bind = dependencies.bind ?? bindChat;
  let requestedAt = new Date().toISOString();
  try {
    const current = await readChatBinding(projectRoot);
    if (current?.status === 'pending' && current.projectUrl === projectUrl) requestedAt = current.requestedAt;
    await wait(BIND_PUBLICATION_DELAY_MS);
    return await bind(markerFile, projectUrl, async conversationUrl => {
      assertChatBindingUrl(projectUrl, conversationUrl);
      await writeChatBinding(projectRoot, {
        version: 1,
        status: 'resolved',
        projectUrl,
        requestedAt,
        completedAt: new Date().toISOString(),
        conversationUrl,
      });
    });
  } catch (error) {
    const current = await readChatBinding(projectRoot).catch(() => null);
    if (current?.status !== 'resolved') {
      await writeChatBinding(projectRoot, {
        version: 1,
        status: 'failed',
        projectUrl,
        requestedAt,
        completedAt: new Date().toISOString(),
        error: error instanceof Error && /^bind_[a-z_]+$/.test(error.message) ? error.message : 'bind_failed',
      });
    }
    throw error;
  } finally {
    await rm(markerFile, { force: true });
  }
}
