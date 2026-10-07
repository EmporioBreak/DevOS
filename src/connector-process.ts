import { join } from "node:path";

export function safeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG"])
    if (env[key]) out[key] = env[key];
  return out;
}

export function desktopCommand(root: string) {
  return {
    file: process.execPath,
    args: [
      join(root, "node_modules/@wonderwhy-er/desktop-commander/dist/index.js"),
      "--no-onboarding",
    ],
  };
}
