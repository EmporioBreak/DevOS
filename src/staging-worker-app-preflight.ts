/** Strictly a *local* identity-isolation preflight, NOT evidence that a
 * ChatGPT Staging app has been connected or a browser worker authorized. */
const WORKER_RESOURCE=/^\/[^/?#]+\/[^/?#]+\/devos_worker_probe$/;
export type StagingWorkerBindingAssessment={
  status:'blocked'|'local_identity_separate';
  reason:'missing_or_invalid_pin'|'production_tool_identity_reused'|'live_chatgpt_connection_not_verified';
  liveChatGptAppVerified:false;
};

export function assessStagingWorkerToolBinding(
  productionResource:unknown,stagingResource:unknown,
):StagingWorkerBindingAssessment{
  if(typeof productionResource!=='string'||typeof stagingResource!=='string'||
     !WORKER_RESOURCE.test(productionResource)||!WORKER_RESOURCE.test(stagingResource))
    return {status:'blocked',reason:'missing_or_invalid_pin',liveChatGptAppVerified:false};
  if(productionResource===stagingResource)
    return {status:'blocked',reason:'production_tool_identity_reused',liveChatGptAppVerified:false};
  return {status:'local_identity_separate',reason:'live_chatgpt_connection_not_verified',
    liveChatGptAppVerified:false};
}
