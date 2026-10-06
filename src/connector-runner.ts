// Private, per-invocation runtime owner. CLI death closes stdin, so the lifetime
// link tears down the group while this process retains its machine-wide mutex.
import { connector } from './connector.js';
try {
  await connector('run',process.argv[2]!,process.argv[3]!,process.stdin);
} catch (error) {
  // Connector diagnostics are fixed messages and never reflect runtime output/key.
  process.stderr.write(`DevOS connector: ${error instanceof Error ? error.message : 'runner failed'}\n`);
  process.exitCode=1;
} finally {
  process.stdin.destroy();
}
