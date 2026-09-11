// One compact diagnostic per discarded candidate; no attacks or per-fight replays.
export function diagnosticResult(r) {
 if(!r)return null;
 return Object.fromEntries(['successes','trials','failedByDeath','failedByTimeout','clearRate',
  'totalSpentSeconds','successfulSpentSeconds','averageClearSeconds'].map(k=>[k,
   k==='clearRate'?r.successes/r.trials:Number.isFinite(r[k])?r[k]:null]));
}
export function eliminationRecord(c,bestLevel,removalReason,monsterHrid) {
 return {recordType:'eliminated-candidate',monsterHrid,candidate:c.index,plan:c.plan,bestLevelAtRemoval:bestLevel,
  removalReason,stopReason:c.stopReason||'search-ended',highestPass:c.highestPass,
  criticalLevel:c.criticalLevel,firstFailure:c.firstFailure,lastCheck:c.lastCheck||null,
  levels:Object.fromEntries(Object.entries(c.levels).map(([level,v])=>[level,{status:v.status,
   result:diagnosticResult(v.result),interval:v.interval,boundary:v.boundary||null,
   confirmation:v.confirmation?{status:v.confirmation.status,result:diagnosticResult(v.confirmation.result)}:null}]))};
}
