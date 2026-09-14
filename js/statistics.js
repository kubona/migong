// Failed attempts receive the full room limit, regardless of death time.
export function averageAttemptSeconds(result, limit=120) {
 const n=Number(result?.trials),wins=Number(result?.successes),seconds=Number(result?.successfulSpentSeconds);
 return n>0 && Number.isFinite(seconds) ? (seconds+(n-wins)*limit)/n : Infinity;
}
export function meetsFinalTarget(result,target) {
 return result?.trials>0 && result.successes>=target*result.trials-1e-9;
}
