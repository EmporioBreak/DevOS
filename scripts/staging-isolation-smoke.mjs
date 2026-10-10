#!/usr/bin/env node
/** Read-only health and OAuth resource isolation smoke.
 * Does not authenticate, restart or mutate either connector.
 */
const targets=[["production",8787],["staging",8788]];
const origins=[];
for(const [name,port] of targets){
  const base="http://127.0.0.1:"+port;
  const health=await fetch(base+"/health",{
    signal:AbortSignal.timeout(4000),redirect:"error",
  });
  if(!health.ok)throw new Error(name+" health endpoint failed");
  const metadata=await fetch(base+"/.well-known/oauth-protected-resource/mcp",{
    signal:AbortSignal.timeout(4000),redirect:"error",
  });
  if(!metadata.ok)throw new Error(name+" OAuth metadata unavailable");
  const resource=(await metadata.json()).resource;
  if(typeof resource!=="string"||!resource.startsWith("https://"))
    throw new Error(name+" has no safe HTTPS OAuth resource");
  origins.push(resource);
  const unauthenticated=await fetch(base+"/mcp",{
    method:"POST",headers:{"content-type":"application/json"},
    body:"{}",redirect:"manual",signal:AbortSignal.timeout(4000),
  });
  if(unauthenticated.status!==401)
    throw new Error(name+" MCP accepted an unauthenticated request");
  // Never log private URL, OAuth issuer path, client ID, sessions or keys.
  process.stdout.write(name+": health 200, protected resource present, unauthenticated MCP 401\n");
}
if(origins[0]===origins[1])
  throw new Error("Production and Staging OAuth resources are not separated");
process.stdout.write("Distinct OAuth resource identities confirmed\n");
