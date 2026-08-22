export function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function wilsonInterval(successes, trials, z = 1.959963984540054) {
  const n = Math.max(0, Math.floor(Number(trials) || 0));
  if (n === 0) return { lower: 0, upper: 1, center: 0.5, halfWidth: 0.5 };
  const p = clamp01((Number(successes) || 0) / n);
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z / denominator) * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { lower: clamp01(center - halfWidth), upper: clamp01(center + halfWidth), center, halfWidth };
}

export function mergeSimulationRuns(runs) {
  const result = {
    successes: 0,
    trials: 0,
    failedByDeath: 0,
    failedByTimeout: 0,
    totalSpentSeconds: 0,
    successfulSpentSeconds: 0,
    minElapsedSeconds: Infinity,
    maxElapsedSeconds: 0,
  };
  for (const run of runs || []) {
    result.successes += Math.max(0, Math.floor(Number(run?.successes) || 0));
    result.trials += Math.max(0, Math.floor(Number(run?.trials) || 0));
    result.failedByDeath += Math.max(0, Math.floor(Number(run?.failedByDeath) || 0));
    result.failedByTimeout += Math.max(0, Math.floor(Number(run?.failedByTimeout) || 0));
    result.totalSpentSeconds += Math.max(0, Number(run?.totalSpentSeconds) || 0);
    result.successfulSpentSeconds += Math.max(0, Number(run?.successfulSpentSeconds) || 0);
    result.minElapsedSeconds = Math.min(result.minElapsedSeconds, Math.max(0, Number(run?.minElapsedSeconds) || 0));
    result.maxElapsedSeconds = Math.max(result.maxElapsedSeconds, Math.max(0, Number(run?.maxElapsedSeconds) || 0));
  }
  result.clearRate = result.trials > 0 ? result.successes / result.trials : 0;
  result.expectedSecondsPerClear = result.successes > 0 ? result.totalSpentSeconds / result.successes : Infinity;
  result.averageClearSeconds = result.successes > 0 ? result.successfulSpentSeconds / result.successes : Infinity;
  result.interval = wilsonInterval(result.successes, result.trials);
  if (!Number.isFinite(result.minElapsedSeconds)) result.minElapsedSeconds = 0;
  return result;
}

export function compareSimulationResults(left, right) {
  return (
    (right?.interval?.lower || 0) - (left?.interval?.lower || 0) ||
    (right?.clearRate || 0) - (left?.clearRate || 0) ||
    (left?.averageClearSeconds || Infinity) - (right?.averageClearSeconds || Infinity)
  );
}
