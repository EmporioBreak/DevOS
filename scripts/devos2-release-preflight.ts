/** Read-only release diagnostic. NEVER merges, deploys or copies secrets. */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {explainCurrentReleaseBlockers} from "../src/devos2-release-readiness.js";

const root=process.cwd();
const git=promisify(execFile);
try{
 const {stdout}=await git("git",["-C",root,"rev-parse","HEAD"],{
  timeout:5000,maxBuffer:4096,
 });
 const report=await explainCurrentReleaseBlockers(root,stdout.trim());
 // No production URL, process ID, OAuth state or credential is read.
 console.log(JSON.stringify(report,null,2));
 if(report.status!=="ready_for_owner_release_decision")process.exitCode=2;
}catch(error){
 console.log(JSON.stringify({status:"blocked",
   reason:"release_preflight_unavailable",manualReleaseDecisionRequired:true,
   mayMerge:false,mayTouchProduction:false,mayCloseEpic:false}));
 process.exitCode=2;
}
