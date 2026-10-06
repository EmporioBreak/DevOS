import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export interface OwnedBrowserProcess {
  pid: number;
  identity: string;
}
/** Only a new browser root with the exact private profile is eligible for cleanup. */
export async function profileProcesses(profile: string): Promise<OwnedBrowserProcess[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    return [];
  try {
    const { stdout } = await execute('ps', ['-axo', 'pid=,lstart=,command='], {
      timeout: 1000, maxBuffer: 4 * 1024 * 1024
    });
    return stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match)
        return [];
      const identity = match[2]!;
      const marker = `--user-data-dir=${profile}`;
      if (!identity.includes(marker + ' ') && !identity.endsWith(marker))
        return [];
      // ps command text cannot prove argument boundaries for whitespace profiles.
      if (/\s/.test(profile))
        return [];
      if (!/(?:^|\/)(?:Google Chrome(?: for Testing)?|Chromium|chrome|chromium|chromium-browser)(?: --|$)/.test(identity) || /--type=/.test(identity))
        return [];
      return [{
          pid: Number(match[1]), identity
        }];
    });
  }
  catch {
    throw new Error('Owned browser process inspection unavailable');
  }
}
export async function terminateOwnedBrowser(owned: OwnedBrowserProcess, profile: string): Promise<boolean> {
  if (process.platform !== 'darwin' && process.platform !== 'linux' || /\s/.test(profile))
    return false;
  try {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const current = (await profileProcesses(profile)).find(candidate => candidate.pid === owned.pid);
      if (!current)
        return true;
      if (current.identity !== owned.identity)
        return false;
      try {
        process.kill(owned.pid, signal);
      }
      catch {
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return !(await profileProcesses(profile)).some(candidate => candidate.pid === owned.pid);
  }
  catch {
    return false;
  }
}
