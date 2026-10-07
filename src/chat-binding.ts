import { readFile, rm } from 'node:fs/promises';
import { Camoufox } from '@camoufox/camoufox';
import type { BrowserContext, Page } from 'playwright-core';
import { loadChatGptBrowserConfig, getChatGptProjectScope } from './browser-config.js';
import { loadOrCreateCamoufoxIdentity } from './camoufox-identity.js';

export const BIND_MARKER = /^DEVOS_BIND_[A-Za-z0-9_-]{12,128}$/;
export const BIND_LIMIT = 30;
export const BIND_PASSES = 3;
export const BIND_DELAY_MS = 1500;
export const BIND_MARKER_WAIT_MS = 750;

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

export async function bindChat(markerFile: string, projectUrlOverride?: string): Promise<string> {
  try {
    const marker = (await readFile(markerFile, 'utf8')).trim();
    if (!BIND_MARKER.test(marker)) throw new Error('bind_invalid_marker');
    const config = loadChatGptBrowserConfig(process.env, projectUrlOverride);
    const identity = await loadOrCreateCamoufoxIdentity(config.profileDir);
    let context: BrowserContext | undefined;
    try {
      context = await Camoufox({ user_data_dir: config.profileDir, persistent_context: true, fingerprint_preset: identity.preset, headless: config.headless, timeout: 30000 });
      const page: Page = await context.newPage();
      return await resolveBinding(page, config.projectUrl, marker);
    } finally {
      await context?.close();
    }
  } finally {
    await rm(markerFile, { force: true });
  }
}
