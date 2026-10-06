// Private stdio bridge: the tunnel runtime key must not reach Desktop Commander
// or tools/processes it launches. Run in the tunnel's owned process group.
import { spawn } from 'node:child_process';
import { desktopCommand, safeEnvironment } from './connector.js';
const command = desktopCommand(process.argv[2]!);
const child = spawn(command.file,command.args, {
  stdio:['inherit','inherit','ignore'],
  env:{...safeEnvironment(process.env),DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1'},
});
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>child.kill(signal));
child.once('error',()=>process.exit(1));
child.once('exit',code=>process.exit(code ?? 1));
