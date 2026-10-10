/**
 * Browser-only repair policy, inspired by Chat On Steroids' per-turn recovery.
 * Classification is not authorization: only an independently proven pre-Send
 * browser failure can trigger a navigation retry. Never re-send a user turn.
 */
export type BrowserRepairAction = "retry" | "human" | "stop";
export interface BrowserRepairDecision { action:BrowserRepairAction; reason:string }

/** Known provider denials take precedence over incidental words like "challenge". */
export function classifyBrowserFailure(error:unknown):BrowserRepairDecision {
  const message=error instanceof Error?error.message:String(error);
  if (/explicit provider policy|account (?:restricted|suspended)|usage limit|quota exceeded|rate.limit|HTTP 429|access denied by policy/i.test(message))
    return {action:"stop",reason:"provider_denial"};
  if (/verify you are human|captcha|turnstile|interactive challenge|security check.*action required/i.test(message))
    return {action:"human",reason:"interactive_verification"};
  if (/authentication\/challenge|cloudflare challenge|passive challenge|temporary.*interstitial|checking your browser|just a moment|cf-mitigated/i.test(message))
    return {action:"retry",reason:"page_interstitial"};
  if (/authentication required|authentication\/access|sign in|log in|HTTP (?:401|403|404|410)\b|conversation unavailable|conversation (?:not found|changed)|escaped the configured Project|identity changed|different conversation|invalid|certificate|net::ERR_CERT/i.test(message))
    return {action:"stop",reason:"identity_or_access"};
  if (/Timeout|net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|NAME_NOT_RESOLVED|EMPTY_RESPONSE)|NS_ERROR_(?:NET_TIMEOUT|UNKNOWN_HOST|CONNECTION_REFUSED|NET_RESET|OFFLINE)|Execution context was destroyed|Cannot find context with specified id|Target (?:page|browser|context).*closed|(?:page|browser).*crashed|browser.*disconnected|Transient (?:navigation|backend) HTTP (?:5\d\d|408|425)|(?:temporary|transient) (?:network|page|browser) error/i.test(message))
    return {action:"retry",reason:"transient_transport"};
  return {action:"stop",reason:"unclassified"};
}

/** Backoff cannot overrun the existing preparation deadline. */
export function browserRecoveryDelayMs(attempt:number,remainingMs:number):number {
  if (!Number.isFinite(attempt)||attempt<1||!Number.isFinite(remainingMs)||remainingMs<=1) return 0;
  return Math.max(0,Math.min(remainingMs-1,2500,350*2**Math.min(attempt-1,3)));
}
