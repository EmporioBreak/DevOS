import { readFile, rm } from 'node:fs/promises';
import { Camoufox } from '@camoufox/camoufox';
import type { BrowserContext, Page } from 'playwright-core';
import { loadChatGptBrowserConfig, getChatGptProjectScope } from './browser-config.js';
import { loadOrCreateCamoufoxIdentity } from './camoufox-identity.js';

export const BIND_MARKER = /^DEVOS_BIND_[A-Za-z0-9_-]{12,128}$/;
export const BIND_LIMIT = 30;
export const BIND_PASSES = 3;
export const BIND_DELAY_MS = 1500;

export interface BindingPage {
  goto(url: string): Promise<unknown>;
  url(): string;
  locator(selector: string): { all(): Promise<Array<{ getAttribute(name: string): Promise<string | null> }>> };
  getByText(text: string, options: { exact: boolean }): { count(): Promise<number> };
}

export async function searchBindingPass(page: BindingPage, projectUrl: string, marker: string): Promise<string | null> {
  const scope = getChatGptProjectScope(projectUrl);
  if (!scope) throw new Error('bind_requires_project');
  await page.goto(projectUrl);
  const links = await page.locator(`a[href*="/g/${scope.projectId}/c/"]`).all();
  const seen = new Set<string>();
  for (const link of links) {
    const href = await link.getAttribute('href');
    if (!href) continue;
    const url = new URL(href, scope.origin);
    if (url.origin !== scope.origin || !new RegExp(`^/g/${scope.projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/c/[^/]+/?$`).test(url.pathname)) continue;
    if (seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    if (seen.size > BIND_LIMIT) break;
    await page.goto(url.href);
    if (await page.getByText(marker, { exact: true }).count() > 0) return url.href;
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
  const config = loadChatGptBrowserConfig(process.env, projectUrlOverride);
  const marker = (await readFile(markerFile, 'utf8')).trim();
  if (!BIND_MARKER.test(marker)) throw new Error('bind_invalid_marker');
  const identity = await loadOrCreateCamoufoxIdentity(config.profileDir);
  let context: BrowserContext | undefined;
  try {
    context = await Camoufox({ user_data_dir: config.profileDir, persistent_context: true, fingerprint_preset: identity.preset, headless: config.headless, timeout: 30000 });
    const page: Page = await context.newPage();
    return await resolveBinding(page, config.projectUrl, marker);
  } finally {
    await context?.close();
    await rm(markerFile, { force: true });
  }
}
