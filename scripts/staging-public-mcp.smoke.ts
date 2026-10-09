/** Read-only Staging Cloudflare MCP OAuth transport reachability.
 * Never logs real public URL, OAuth client, private chat or token.
 */
const local="http://127.0.0.1:8788";
const get=async(url:string,init:RequestInit={})=>fetch(url,{
 ...init,redirect:"manual",signal:AbortSignal.timeout(8000),
});
const results:Record<string,boolean|number|string>={
 productionMutated:false,requestedOAuthConsent:false,authenticated:false,
};
try{
 const response=await get(local+"/health");
 results.stagingLocalHealth=response.status===200;
 const resourceResponse=await get(local+"/.well-known/oauth-protected-resource/mcp");
 if(resourceResponse.status!==200)throw new Error("staging resource discovery failed");
 const body=await resourceResponse.json() as {resource?:string};
 const resource=body.resource;
 if(typeof resource!=="string" || !/^https:\/\/[^/?#]+\/mcp$/.test(resource))
   throw new Error("staging public protected resource missing");
 const origin=new URL(resource).origin;
 if(!/^https:\/\/[a-z0-9.-]+$/.test(origin)||
   /localhost|127\.0\.0\.1/.test(origin))
   throw new Error("non-public transport identity");
 const productionMeta=await get("http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp");
 if(productionMeta.status!==200)throw new Error("production read-only metadata inaccessible");
 const productionResource=(await productionMeta.json() as {resource?:string}).resource;
 results.distinctProductionResource=productionResource!==resource;
 if(productionResource===resource)throw new Error("OAuth resources must be distinct");
 const externalHealth=await get(origin+"/health");
 results.externalHealth200=externalHealth.status===200;
 const protectedMeta=await get(origin+"/.well-known/oauth-protected-resource/mcp");
 results.externalResource200=protectedMeta.status===200;
 const external=(await protectedMeta.json() as {resource?:string}).resource;
 results.externalResourceMatchesLocal=external===resource;
 const oauth=await get(origin+"/.well-known/oauth-authorization-server");
 results.oauthDiscovery200=oauth.status===200;
 const auth=oauth.status===200?await oauth.json() as Record<string,unknown>:null;
 results.oauthPKCE=Array.isArray(auth?.code_challenge_methods_supported) &&
    auth.code_challenge_methods_supported.includes("S256");
 const challenge=await get(resource,{method:"POST",
    headers:{"content-type":"application/json"},body:"{}"});
 results.unauthenticatedMcp401=challenge.status===401;
 results.httpsTunnel=true;
 const good=Object.entries(results).every(([k,v])=>
   ["productionMutated","requestedOAuthConsent","authenticated"].includes(k)?
      v===false:v===true);
 results.probeResult=good?"pass_transport_only":"blocked";
 console.log(JSON.stringify(results));
 if(!good)process.exitCode=2;
}catch(error){
 const msg=String(error instanceof Error?error.message:error);
 results.probeResult="blocked";
 results.blocker=/timeout|aborted/i.test(msg)?"network_timeout":
   /fetch|connect|dns|tls/i.test(msg)?"remote_connectivity":
   "protocol_mismatch";
 console.log(JSON.stringify(results));
 process.exitCode=2;
}
