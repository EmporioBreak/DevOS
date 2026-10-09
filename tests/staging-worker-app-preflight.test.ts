import assert from 'node:assert/strict';
import test from 'node:test';
import {assessStagingWorkerToolBinding} from '../src/staging-worker-app-preflight.js';
const prod='/asdk_app_prod/link_prod/devos_worker_probe';
const staging='/asdk_app_staging/link_staging/devos_worker_probe';

test('rejects the same tool identity shared by Production and Staging',()=>{
  assert.deepEqual(assessStagingWorkerToolBinding(prod,prod),{
    status:'blocked',reason:'production_tool_identity_reused',liveChatGptAppVerified:false,
  });
});
test('missing or malformed pinned identity fails closed',()=>{
  for(const [a,b] of [[prod,undefined],[undefined,staging],['/malformed',staging],[prod,'/asdk_app_staging/link_staging/devos_noop']]){
    const r=assessStagingWorkerToolBinding(a,b);
    assert.equal(r.status,'blocked');
    assert.equal(r.liveChatGptAppVerified,false);
  }
});
test('distinct installed tool identities pass only local separation, never claim live app or worker approval',()=>{
  assert.deepEqual(assessStagingWorkerToolBinding(prod,staging),{
    status:'local_identity_separate',reason:'live_chatgpt_connection_not_verified',liveChatGptAppVerified:false,
  });
});
