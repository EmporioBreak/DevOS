export interface ProductionBaselineInput {
 head:string;remoteHead:string;branch:string;checkoutClean:boolean;
 stagingPortOccupied:boolean;profilePresent:boolean;
 localHealth:number;publicHealth:number;localOAuth:number;publicOAuth:number;
 localAnonymous:number;localInvalid:number;publicAnonymous:number;publicInvalid:number;
}
export interface BaselineReport {
 status:'baseline_pass'|'blocked';checks:Record<string,boolean>;
 productionSha:string|null;scope:string;independentlyVerifiedE2e:string[];
 pendingRealE2e:string[];browserWorkersStarted:false;productionMutated:false;
 fullProductAcceptance:false;
}
export function classifyBaseline(value:ProductionBaselineInput):BaselineReport;
export function checkedPublicBase(value:{publicUrl?:string}):string;
export function runProductionBaseline(root:string,profileDir?:string):Promise<BaselineReport>;
