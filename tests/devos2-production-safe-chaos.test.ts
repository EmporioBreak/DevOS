import assert from 'node:assert/strict';
import test from 'node:test';
import {parseTestSummary,validTestSummary,outcome} from '../scripts/devos2-production-safe-chaos.smoke.js';
const example='ℹ tests 73\nℹ pass 73\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\n';
test('Production chaos summary is correct only for exact no-skip suite evidence',()=>{
 const parsed=parseTestSummary(example);
 assert.deepEqual(parsed,{tests:73,passed:73,failed:0,cancelled:0,skipped:0});
 assert.equal(validTestSummary(parsed),true);
 for(const altered of ['ℹ pass 72','ℹ skipped 1','ℹ failed 1']){
  const changed=example.replace(altered.includes('pass')?'ℹ pass 73':
    altered.includes('skipped')?'ℹ skipped 0':'ℹ fail 0',altered);
  assert.equal(validTestSummary(parseTestSummary(changed)),false);
 }
 assert.equal(validTestSummary(parseTestSummary('')),false);
});
test('synthetic chaos cannot claim ChatGPT E2E or Product acceptance',()=>{
 const report=outcome({production_health_200:true},parseTestSummary(example),true);
 assert.equal(report.status,'pass_non_destructive_only');
 assert.equal(report.liveBrowserWorkersLaunched,false);
 assert.equal(report.currentProductionProfileAccessed,false);
 assert.equal(report.stagingStarted,false);
 assert.equal(report.productionRestarted,false);
 assert.deepEqual(report.independentlyVerifiedE2e,[]);
 assert.equal(report.mayCloseEpic,false);
});
test('chaos baseline fails closed for changed production listener, missing fixture or pending test',()=>{
 const summary=parseTestSummary(example);
 assert.equal(outcome({production_listener_unchanged:false},summary,true).status,'blocked');
 assert.equal(outcome({production_listener_unchanged:true},summary,false).status,'blocked');
 assert.equal(outcome({production_listener_unchanged:true},
   {...summary,skipped:1},true).status,'blocked');
});
