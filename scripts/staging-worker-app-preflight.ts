/** Read-only worker MCP binding preflight for an explicitly isolated Staging.
 * Reports only coarse status: never output private installed tool IDs, URLs,
 * chat contents, passwords, OAuth state or session identifiers.
 */
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {assessStagingWorkerToolBinding} from '../src/staging-worker-app-preflight.js';

function pinned(root:string):string|undefined{
  try{
    const path=join(root,'.devos/connector/worker-probe-resource-uri');
    const stat=lstatSync(path);
    if(!stat.isFile() || (stat.mode & 0o077)!==0 || stat.size>512)return;
    return readFileSync(path,'utf8').trim();
  }catch{return undefined}
}
const root=realpathSync(process.env.DEVOS_STAGING_ROOT??process.cwd());
if(basename(root)!=='DevOS-staging'){
  console.log(JSON.stringify({status:'blocked',reason:'explicit_staging_checkout_required',
    liveChatGptAppVerified:false,productionMutated:false,stagingMutated:false}));
  process.exitCode=2;
}else{
  const prod=join(dirname(root),'DevOS');
  const result=assessStagingWorkerToolBinding(pinned(prod),pinned(root));
  console.log(JSON.stringify({...result,productionMutated:false,stagingMutated:false}));
  if(result.status==='blocked')process.exitCode=2;
}
