import { finiteNumber } from "./data-model.js";
import { wilsonInterval } from "./statistics.js";

// This module is the search seam: the combat engine supplies observations, while
// this implementation decides which statistically credible plans stay alive.
export function balancedMetrics(result, options = {}) {
  const confidenceZ = finiteNumber(options.confidenceZ, 1.2815515655446004);
  const interval = wilsonInterval(result?.successes, result?.trials, confidenceZ);
  const trials = Math.max(1, Math.floor(finiteNumber(result?.trials, 1)));
  const deaths = Math.min(trials, Math.max(0, finiteNumber(result?.failedByDeath, 0)));
  const timeouts = Math.min(trials, Math.max(0, finiteNumber(result?.failedByTimeout, 0)));
  const successes = Math.min(trials, Math.max(0, finiteNumber(result?.successes, 0)));
  const averageClearSeconds = Number.isFinite(result?.averageClearSeconds)
    ? result.averageClearSeconds
    : successes > 0 ? finiteNumber(result?.successfulSpentSeconds, 0) / successes : Number.POSITIVE_INFINITY;
  const expectedSecondsPerClear = successes > 0
    ? finiteNumber(result?.totalSpentSeconds, 0) / successes
    : Number.POSITIVE_INFINITY;
  const totalDamage = Math.max(0, finiteNumber(result?.damageSummary?.totalDamage, 0));
  const totalSpentSeconds = Math.max(0, finiteNumber(result?.totalSpentSeconds, 0));
  return {
    robustSuccessLower: Math.abs(finiteNumber(interval.lower, 0)) < 1e-12
      ? 0
      : Math.max(0, Math.min(1, finiteNumber(interval.lower, 0))),
    clearRate: successes / trials,
    deathRate: deaths / trials,
    timeoutRate: timeouts / trials,
    averageClearSeconds,
    expectedSecondsPerClear,
    damagePerSecond: totalSpentSeconds > 0 ? totalDamage / totalSpentSeconds : 0,
    targetDeficit: Math.max(0, finiteNumber(options.targetRate, 0.7) - finiteNumber(interval.lower, 0)),
  };
}

function noWorse(left, right) {
  return left.robustSuccessLower >= right.robustSuccessLower
    && left.deathRate <= right.deathRate
    && left.timeoutRate <= right.timeoutRate
    && left.damagePerSecond >= right.damagePerSecond
    && left.expectedSecondsPerClear <= right.expectedSecondsPerClear;
}

function strictlyBetter(left, right) {
  return left.robustSuccessLower > right.robustSuccessLower
    || left.deathRate < right.deathRate
    || left.timeoutRate < right.timeoutRate
    || left.damagePerSecond > right.damagePerSecond
    || left.expectedSecondsPerClear < right.expectedSecondsPerClear;
}

function ascendingNumber(left, right) {
  const a = Number.isNaN(left) ? Number.POSITIVE_INFINITY : left;
  const b = Number.isNaN(right) ? Number.POSITIVE_INFINITY : right;
  if (a === b) return 0;
  if (a === Number.POSITIVE_INFINITY) return 1;
  if (b === Number.POSITIVE_INFINITY) return -1;
  return a - b;
}

export function dominatesBalancedResult(leftResult, rightResult, options = {}) {
  const left = balancedMetrics(leftResult, options);
  const right = balancedMetrics(rightResult, options);
  return noWorse(left, right) && strictlyBetter(left, right);
}

export function paretoFront(plans, options = {}) {
  const result = [];
  for (const plan of plans || []) {
    if (!plan?.result) continue;
    if (result.some((other) => dominatesBalancedResult(other.result, plan.result, options))) continue;
    const survivors = result.filter((other) => !dominatesBalancedResult(plan.result, other.result, options));
    survivors.push(plan);
    result.splice(0, result.length, ...survivors);
  }
  return result;
}

export function compareBalancedResults(leftResult, rightResult, options = {}) {
  const left = balancedMetrics(leftResult, options);
  const right = balancedMetrics(rightResult, options);
  return right.robustSuccessLower - left.robustSuccessLower
    || right.clearRate - left.clearRate
    || left.targetDeficit - right.targetDeficit
    || left.deathRate - right.deathRate
    || left.timeoutRate - right.timeoutRate
    || ascendingNumber(left.expectedSecondsPerClear, right.expectedSecondsPerClear)
    || ascendingNumber(left.averageClearSeconds, right.averageClearSeconds);
}

export function meetsTargetRate(result, options = {}) {
  const targetRate = Math.max(0.01, Math.min(0.99, finiteNumber(options.targetRate, 0.7)));
  if (options.feasibilityMode === "confidence") {
    return balancedMetrics(result, options).robustSuccessLower >= targetRate;
  }
  return finiteNumber(result?.clearRate, 0) >= targetRate;
}

export function retainedPlanLimit(planCount, options = {}) {
  const count = Math.max(0, Math.floor(finiteNumber(planCount, 0)));
  if (count === 0) return 0;
  const explicitBeamWidth = Number(options.beamWidth);
  if (Number.isFinite(explicitBeamWidth) && explicitBeamWidth > 0) {
    return Math.min(count, Math.max(1, Math.floor(explicitBeamWidth)));
  }
  const retentionRatio = Math.max(0.001, Math.min(1, finiteNumber(options.retentionRatio, 0.1)));
  const minimumRetainedPlans = Math.max(1, Math.floor(finiteNumber(options.minimumRetainedPlans, 10)));
  const maximumRetainedPlans = Math.max(minimumRetainedPlans, Math.floor(finiteNumber(options.maximumRetainedPlans, 50)));
  return Math.min(count, maximumRetainedPlans, Math.max(minimumRetainedPlans, Math.ceil(count * retentionRatio)));
}

export function selectBalancedPlans(plans, options = {}) {
  const seenKeys = new Set();
  const candidates = (plans || []).filter((plan) => {
    if (!plan?.key) return true;
    if (seenKeys.has(plan.key)) return false;
    seenKeys.add(plan.key);
    return true;
  });
  const beamWidth = retainedPlanLimit(candidates.length, options);
  if (beamWidth === 0) return [];
  const front = paretoFront(candidates, options);
  const pool = front.length ? front : [...candidates];
  const selected = [];
  const exploratorySlots = beamWidth > 1 && candidates.some((plan) => !front.includes(plan)) ? 1 : 0;
  const frontierLimit = beamWidth - exploratorySlots;
  const addFrontier = (plan) => {
    if (plan && !selected.includes(plan) && selected.length < frontierLimit) selected.push(plan);
  };
  const add = (plan) => {
    if (plan && !selected.includes(plan) && selected.length < beamWidth) selected.push(plan);
  };
  addFrontier([...pool].sort((left, right) => compareBalancedResults(left.result, right.result, options))[0]);
  addFrontier([...pool].sort((left, right) => {
    const a = balancedMetrics(left.result, options); const b = balancedMetrics(right.result, options);
    return a.deathRate - b.deathRate || b.robustSuccessLower - a.robustSuccessLower || a.timeoutRate - b.timeoutRate;
  })[0]);
  addFrontier([...pool].sort((left, right) => {
    const a = balancedMetrics(left.result, options); const b = balancedMetrics(right.result, options);
    return b.damagePerSecond - a.damagePerSecond || b.robustSuccessLower - a.robustSuccessLower || a.deathRate - b.deathRate;
  })[0]);
  for (const plan of [...pool].sort((left, right) => compareBalancedResults(left.result, right.result, options))) addFrontier(plan);
  const dominated = candidates.filter((plan) => !front.includes(plan))
    .sort((left, right) => compareBalancedResults(left.result, right.result, options));
  add(dominated[0]);
  for (const plan of [...pool, ...candidates]) add(plan);
  return selected;
}
