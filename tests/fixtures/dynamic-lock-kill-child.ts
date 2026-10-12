import {DynamicAgentStore} from "../../src/dynamic-agent-runtime.js";
const root=process.argv[2];
if(!root)throw Error("Missing test root");
const task={repo:"EmporioBreak/DevOS",issue:246};
const store=new DynamicAgentStore(root,task);
// SIGKILL inside the transaction after the durable OS process identity was
// written and fsynced, but before the accepted JSON state may change.
await store.transact(():never=>{
  process.kill(process.pid,"SIGKILL");
  throw new Error("Unreachable after SIGKILL");
});
