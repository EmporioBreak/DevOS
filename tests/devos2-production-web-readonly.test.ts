import assert from 'node:assert/strict';
import test from 'node:test';
import {assessProductionWeb,type WebNavigationSnapshot} from '../scripts/devos2-production-web-readonly.smoke.js';
const ready=():WebNavigationSnapshot=>({http:200,chatGptHttps:true,
 projectScope:true,loginRedirect:false,challenge:false,editorVisible:true,
 fingerprintUnchanged:true,browserCleanupConfirmed:true});

test('real read-only Project navigation is not worker completion or iPhone acceptance',()=>{
 const r=assessProductionWeb(ready());
 assert.equal(r.status,'web_navigation_pass');
 assert.equal(r.chatMessageSent,false);
 assert.equal(r.workerStarted,false);
 assert.equal(r.ownerAuthorizationRequested,false);
 assert.equal(r.fullProductAcceptance,false);
 assert.deepEqual(r.independentlyVerifiedE2e,[]);
});

test('redirect to actual ChatGPT login blocks Web E2E even with HTTP 200',()=>{
 const r=assessProductionWeb({...ready(),loginRedirect:true,projectScope:false,editorVisible:false});
 assert.equal(r.status,'blocked_login_required');
 assert.equal(r.fullProductAcceptance,false);
});

test('Web smoke refuses challenged, wrong-project, missing composer, or changed identity',()=>{
 for(const [patch,expected] of [
  [{projectScope:false},'blocked_project_scope'],
  [{editorVisible:false},'blocked_composer'],
  [{challenge:true},'blocked_navigation_or_challenge'],
  [{http:403},'blocked_navigation_or_challenge'],
  [{fingerprintUnchanged:false},'blocked_cleanup_or_identity'],
  [{browserCleanupConfirmed:false},'blocked_cleanup_or_identity'],
 ] as const){
  assert.equal(assessProductionWeb({...ready(),...patch}).status,expected);
 }
});
