import assert from "node:assert/strict";
import test from "node:test";
import {parseDevosResult} from "../src/result.js";
import {stagingQaPrompt,verifyStagingQaAnswer} from "./qa-transport-contract.js";

test("Staging QA prompts request the canonical terminal worker result for DOM/SSE fallback",()=>{
 const marker="DEVOS_STAGING_QA_ROUNDTRIP_ONE";
 const prompt=stagingQaPrompt(marker);
 assert.ok(prompt.includes(marker));
 assert.match(prompt,/DEVOS_RESULT \{"status":"done"\}/);
 const answer=marker+'\nDEVOS_RESULT {"status":"done"}';
 assert.equal(parseDevosResult(answer).status,"done");
 assert.equal(verifyStagingQaAnswer(answer,marker),true);
 assert.equal(verifyStagingQaAnswer(marker,marker),false);
 assert.equal(verifyStagingQaAnswer(answer+'\nextra',marker),false);
 assert.throws(()=>stagingQaPrompt("DEVOS_BIND_PRIVATE"),/Invalid/);
});
