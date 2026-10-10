import assert from 'node:assert/strict';
import test from 'node:test';
import {checkedPublicBase,classifyBaseline} from '../scripts/devos2-production-postrelease.smoke.mjs';

const sha='a'.repeat(40);
const healthy=()=>({head:sha,remoteHead:sha,branch:'main',checkoutClean:true,
 stagingPortOccupied:false,profilePresent:true,localHealth:200,publicHealth:200,
 localOAuth:200,publicOAuth:200,localAnonymous:401,localInvalid:401,
 publicAnonymous:401,publicInvalid:401});

test('Production baseline never claims Web/iPhone or browser-worker acceptance',()=>{
 const result=classifyBaseline(healthy());
 assert.equal(result.status,'baseline_pass');
 assert.equal(result.productionSha,sha);
 assert.equal(result.fullProductAcceptance,false);
 assert.deepEqual(result.independentlyVerifiedE2e,[]);
 assert.equal(result.pendingRealE2e.length,9);
 assert.equal(result.browserWorkersStarted,false);
 assert.equal(result.productionMutated,false);
 assert.ok(Object.values(result.checks).every(Boolean));
});

test('Production post-release baseline fails closed on absent or incorrect bearer refusal',()=>{
 for(const field of ['localAnonymous','localInvalid','publicAnonymous','publicInvalid'] as const){
  const result=classifyBaseline({...healthy(),[field]:200});
  assert.equal(result.status,'blocked',field);
  assert.equal(result.checks[field==='localAnonymous'?'anonymous_local_denied':
   field==='localInvalid'?'invalid_local_denied':
   field==='publicAnonymous'?'anonymous_public_denied':'invalid_public_denied'],false);
 }
});

test('Production baseline refuses moved Git head, dirty checkout, stale repo, live Staging or absent profile',()=>{
 for(const patch of [{remoteHead:'b'.repeat(40)},{branch:'release'},
  {checkoutClean:false},{stagingPortOccupied:true},{profilePresent:false},
  {localHealth:500},{publicOAuth:404}]){
  assert.equal(classifyBaseline({...healthy(),...patch}).status,'blocked',JSON.stringify(patch));
 }
});

test('Production public URL must be exact HTTPS ngrok origin without embedded credentials or route',()=>{
 assert.equal(checkedPublicBase({publicUrl:'https://prod-connector.ngrok-free.dev/'}),
  'https://prod-connector.ngrok-free.dev');
 for(const url of ['http://prod-connector.ngrok-free.dev/',
  'https://evil.invalid/','https://prod-connector.ngrok-free.dev/private',
  'https://owner:secret@prod-connector.ngrok-free.dev/',
  'https://prod-connector.ngrok-free.dev/?token=private',
  'https://prod-connector.ngrok-free.dev/#private'])
  assert.throws(()=>checkedPublicBase({publicUrl:url}));
});
