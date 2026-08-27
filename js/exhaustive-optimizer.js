import { finiteNumber, monsterLevelToFloorRange, resolveReferenceMonsterLevel } from "./data-model.js";
import { classifyMonster } from "./classifier.js";
import {
  activeOrderPermutations,
  buildCurrentBaseline,
  buildTargetedComponentPool,
  buildUniqueComponentPlans,
} from "./component-planner.js";
import { resolveEquipmentPresetBaselines } from "./equipment-presets.js";
import { buildSimulationInput } from "./player-dto.js";
import { wilsonInterval } from "./statistics.js";

const MAIN_HAND = "/equipment_types/main_hand";
const OFF_HAND = "/equipment_types/off_hand";
const TWO_HAND = "/equipment_types/two_hand";

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException("模拟已取消", "AbortError");
}

function directionProfile(profile, direction) {
  return {
    ...profile,
    selectedStyles: profile.selectedStyles.filter((entry) => entry.hrid === direction.styleHrid),
    selectedStyleHrids: new Set([direction.styleHrid]),
    selectedDirections: [direction],
    preferredDamageTypes: profile.damageTypes.filter((entry) => entry.hrid === direction.damageTypeHrid),
  };
}

function normalizeSimulation(run, requestedTrials) {
  const trials = Math.max(0, Math.floor(finiteNumber(run?.trials, requestedTrials)));
  const successes = Math.max(0, Math.floor(finiteNumber(run?.successes, 0)));
  const failedByDeath = Math.max(0, Math.floor(finiteNumber(run?.failedByDeath, 0)));
  const failedByTimeout = Math.max(0, Math.floor(finiteNumber(run?.failedByTimeout, 0)));
  const successfulSpentSeconds = Math.max(0, finiteNumber(run?.successfulSpentSeconds, 0));
  const totalSpentSeconds = Math.max(0, finiteNumber(run?.totalSpentSeconds, 0));
  return {
    ...run,
    successes,
    trials,
    failedByDeath,
    failedByTimeout,
    clearRate: trials > 0 ? successes / trials : 0,
    successfulSpentSeconds,
    totalSpentSeconds,
    averageClearSeconds: successes > 0
      ? (Number.isFinite(Number(run?.averageClearSeconds)) ? Number(run.averageClearSeconds) : successfulSpentSeconds / successes)
      : Infinity,
    interval: wilsonInterval(successes, trials, 1.2815515655446004),
  };
}

function resultMetrics(result) {
  const trials = Math.max(1, finiteNumber(result?.trials, 0));
  const totalDamage = Math.max(0, finiteNumber(result?.damageSummary?.totalDamage, 0));
  const totalSeconds = Math.max(0, finiteNumber(result?.totalSpentSeconds, 0));
  return {
    robustSuccessLower: result?.interval?.lower || 0,
    robustSuccessUpper: result?.interval?.upper || 1,
    deathRate: finiteNumber(result?.failedByDeath, 0) / trials,
    timeoutRate: finiteNumber(result?.failedByTimeout, 0) / trials,
    expectedSecondsPerClear: result?.successes > 0 ? totalSeconds / result.successes : Infinity,
    damagePerSecond: totalSeconds > 0 ? totalDamage / totalSeconds : 0,
  };
}

function compareAtHighest(left, right) {
  if (Boolean(left?.targetMet) !== Boolean(right?.targetMet)) return left?.targetMet ? -1 : 1;
  return finiteNumber(right?.highestLevel, 0) - finiteNumber(left?.highestLevel, 0)
    || finiteNumber(right?.result?.clearRate, 0) - finiteNumber(left?.result?.clearRate, 0)
    || finiteNumber(left?.result?.failedByDeath, Infinity) - finiteNumber(right?.result?.failedByDeath, Infinity)
    || finiteNumber(left?.result?.failedByTimeout, Infinity) - finiteNumber(right?.result?.failedByTimeout, Infinity)
    || finiteNumber(left?.result?.averageClearSeconds, Infinity) - finiteNumber(right?.result?.averageClearSeconds, Infinity)
    || String(left?.plan?.key || "").localeCompare(String(right?.plan?.key || ""));
}

function compareWinRate(left, right) {
  return finiteNumber(right?.result?.clearRate, 0) - finiteNumber(left?.result?.clearRate, 0)
    || finiteNumber(right?.result?.interval?.lower, 0) - finiteNumber(left?.result?.interval?.lower, 0)
    || finiteNumber(left?.result?.failedByDeath, Infinity) - finiteNumber(right?.result?.failedByDeath, Infinity)
    || finiteNumber(left?.result?.failedByTimeout, Infinity) - finiteNumber(right?.result?.failedByTimeout, Infinity)
    || finiteNumber(left?.result?.averageClearSeconds, Infinity) - finiteNumber(right?.result?.averageClearSeconds, Infinity)
    || String(left?.plan?.key || "").localeCompare(String(right?.plan?.key || ""));
}

function compareSpeed(left, right) {
  const leftHasWin = finiteNumber(left?.result?.successes, 0) > 0;
  const rightHasWin = finiteNumber(right?.result?.successes, 0) > 0;
  if (leftHasWin !== rightHasWin) return leftHasWin ? -1 : 1;
  return finiteNumber(left?.result?.averageClearSeconds, Infinity) - finiteNumber(right?.result?.averageClearSeconds, Infinity)
    || finiteNumber(right?.result?.clearRate, 0) - finiteNumber(left?.result?.clearRate, 0)
    || String(left?.plan?.key || "").localeCompare(String(right?.plan?.key || ""));
}

async function simulatePlan(options) {
  checkAbort(options.signal);
  await options.pauseController?.waitIfPaused(options.signal);
  checkAbort(options.signal);
  const input = {
    ...options.plan.simulationInput,
    monsterHrid: options.monsterHrid,
    roomLevel: options.roomLevel,
    roomDurationSeconds: 120,
    trials: options.trials,
    seed: options.seed,
  };
  const context = {
    stage: options.stage,
    reason: options.reason,
    candidateKind: options.candidateKind,
    direction: options.direction,
    expectedRetest: Boolean(options.expectedRetest),
    planId: options.planId || null,
  };
  const run = options.auditRecorder
    ? await options.auditRecorder.simulate(options.engine, input, context)
    : await options.engine.simulateRoom(input);
  return normalizeSimulation(run, options.trials);
}

export async function searchHighestLevelForPlan(options) {
  const minimum = Math.max(1, Math.floor(finiteNumber(options.minLevel, 20)));
  const maximum = Math.max(minimum, Math.floor(finiteNumber(options.maxLevel, minimum)));
  const targetRate = Math.max(0.01, Math.min(0.99, finiteNumber(options.targetRate, 0.7)));
  const cache = new Map();
  const probe = async (level) => {
    if (!cache.has(level)) {
      const result = await simulatePlan({
        ...options,
        roomLevel: level,
        seed: finiteNumber(options.seedBase, 20260826) + level,
        reason: `${options.stage === "review" ? "复核" : "测试"}阶段二分探测 Lv.${level}`,
        candidateKind: "binary_level_probe",
      });
      cache.set(level, result);
      options.onProbe?.({ level, result, probeCount: cache.size });
    }
    return cache.get(level);
  };
  const passes = (result) => finiteNumber(result?.clearRate, 0) >= targetRate;
  let low = minimum;
  let high = maximum;
  let bestLevel = 0;
  let bestResult = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const result = await probe(middle);
    if (passes(result)) {
      bestLevel = middle;
      bestResult = result;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (bestLevel === 0) {
    bestResult = await probe(minimum);
    bestLevel = minimum;
  }
  return {
    plan: options.plan,
    highestLevel: bestLevel,
    targetMet: passes(bestResult),
    result: bestResult,
    metrics: resultMetrics(bestResult),
    probeCount: cache.size,
    testedLevels: [...cache.keys()].sort((left, right) => left - right),
    capped: bestLevel === maximum && passes(bestResult),
  };
}

function enrichPlan(character, catalog, plan) {
  return {
    ...plan,
    simulationInput: buildSimulationInput(character, catalog, plan.equipmentCandidate, plan.abilityOrder),
  };
}

function withRank(entries) {
  return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

async function runDirectionWorkflow(options) {
  const selectedTypes = new Set(options.selectedEquipmentTypes || []);
  const poolTypes = new Set(selectedTypes);
  if (selectedTypes.has(MAIN_HAND) && selectedTypes.has(OFF_HAND)) poolTypes.add(TWO_HAND);
  const pool = buildTargetedComponentPool(options.character, options.catalog, options.profile, options.direction, {
    minimumEquipmentLevel: options.minimumEquipmentLevel,
    selectedEquipmentTypes: poolTypes,
  });
  const abilityBaseline = buildCurrentBaseline(options.character, options.catalog, pool);
  const equipmentBaselines = resolveEquipmentPresetBaselines(
    options.character,
    options.catalog,
    options.direction,
    options.monsterHrid,
    { source: options.equipmentPresetSource, selectedEquipmentTypes: selectedTypes },
  );
  const uniquePlans = new Map();
  for (const equipmentBaseline of equipmentBaselines) {
    const baseline = { ...abilityBaseline, ...equipmentBaseline };
    for (const plan of buildUniqueComponentPlans(baseline, pool, options.direction, options.monsterHrid, {
      selectedEquipmentTypes: selectedTypes,
      optimizeAura: options.optimizeAura,
      optimizeActives: options.optimizeActives,
      fixedAbilityRules: options.fixedAbilityRules,
    })) {
      if (!uniquePlans.has(plan.key)) uniquePlans.set(plan.key, plan);
    }
  }
  const plans = [...uniquePlans.values()].map((plan) => enrichPlan(options.character, options.catalog, plan));
  if (!plans.length) throw new Error(`${options.direction.strategyZh || `${options.direction.styleZh}·${options.direction.damageTypeZh}`}方向没有符合候选池、预设固定栏位和固定技能规则的组合`);

  const testResults = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const result = await searchHighestLevelForPlan({
      ...options,
      plan,
      stage: "test",
      trials: options.testTrials,
      seedBase: options.seedBase + 100000,
      planId: `T${index + 1}`,
      expectedRetest: options.directionIndex > 1,
      onProbe: ({ level, probeCount }) => options.onProgress?.({
        phase: "test",
        direction: options.direction,
        completedPlans: index,
        totalPlans: plans.length,
        currentPlan: index + 1,
        level,
        probeCount,
      }),
    });
    testResults.push(result);
    options.onProgress?.({ phase: "test", direction: options.direction, completedPlans: index + 1, totalPlans: plans.length, currentPlan: index + 1 });
  }

  const bestTestLevel = Math.max(...testResults.filter((entry) => entry.targetMet).map((entry) => entry.highestLevel), 0);
  const reviewFloor = bestTestLevel > 0 ? Math.ceil(bestTestLevel * 0.99) : options.minLevel;
  const reviewCandidates = testResults.filter((entry) => entry.targetMet && entry.highestLevel >= reviewFloor);
  if (!reviewCandidates.length) reviewCandidates.push(...testResults.sort(compareAtHighest).slice(0, 1));
  const reviewResults = [];
  for (let index = 0; index < reviewCandidates.length; index += 1) {
    const candidate = reviewCandidates[index];
    const result = await searchHighestLevelForPlan({
      ...options,
      plan: candidate.plan,
      stage: "review",
      trials: options.reviewTrials,
      seedBase: options.seedBase + 300000,
      planId: `R${index + 1}`,
      expectedRetest: true,
      onProbe: ({ level, probeCount }) => options.onProgress?.({
        phase: "review",
        direction: options.direction,
        completedPlans: index,
        totalPlans: reviewCandidates.length,
        currentPlan: index + 1,
        level,
        probeCount,
      }),
    });
    reviewResults.push(result);
    options.onProgress?.({ phase: "review", direction: options.direction, completedPlans: index + 1, totalPlans: reviewCandidates.length, currentPlan: index + 1 });
  }
  reviewResults.sort(compareAtHighest);
  const finalists = reviewResults.slice(0, 5);
  const optimizationLevel = Math.max(...finalists.filter((entry) => entry.targetMet).map((entry) => entry.highestLevel), finalists[0]?.highestLevel || options.minLevel);

  const orderedMap = new Map();
  for (const finalist of finalists) {
    for (const ordered of activeOrderPermutations(finalist.plan)) {
      if (!orderedMap.has(ordered.key)) orderedMap.set(ordered.key, enrichPlan(options.character, options.catalog, ordered));
    }
  }
  const orderedPlans = [...orderedMap.values()];
  const optimized = [];
  for (let index = 0; index < orderedPlans.length; index += 1) {
    const plan = orderedPlans[index];
    const result = await simulatePlan({
      ...options,
      plan,
      roomLevel: optimizationLevel,
      stage: "optimize",
      trials: options.optimizeTrials,
      seed: options.seedBase + 500000 + optimizationLevel,
      planId: `O${index + 1}`,
      expectedRetest: true,
      reason: `优化阶段固定 Lv.${optimizationLevel} 测试主动技能顺序`,
      candidateKind: "ordered_active_plan",
    });
    optimized.push({ plan, result, metrics: resultMetrics(result), monsterLevel: optimizationLevel, direction: options.direction });
    options.onProgress?.({ phase: "optimize", direction: options.direction, completedPlans: index + 1, totalPlans: orderedPlans.length, currentPlan: index + 1, level: optimizationLevel });
  }
  const winRateRanking = withRank([...optimized].sort(compareWinRate).slice(0, 3));
  const speedRanking = withRank([...optimized].sort(compareSpeed).slice(0, 3));
  return {
    direction: options.direction,
    profile: options.profile,
    poolDiagnostics: pool.diagnostics,
    equipmentPresetSource: options.equipmentPresetSource || "system",
    savedPlanCount: plans.length,
    testResults,
    bestTestLevel,
    reviewFloor,
    reviewCandidateCount: reviewCandidates.length,
    reviewResults,
    finalists,
    optimizationLevel,
    orderedPlanCount: orderedPlans.length,
    optimized,
    rankings: { winRate: winRateRanking, speed: speedRanking },
  };
}

function diagnose(result) {
  const failures = Math.max(1, finiteNumber(result?.failedByDeath, 0) + finiteNumber(result?.failedByTimeout, 0));
  const deathShare = finiteNumber(result?.failedByDeath, 0) / failures;
  const timeoutShare = finiteNumber(result?.failedByTimeout, 0) / failures;
  const issues = [];
  if (deathShare > timeoutShare) issues.push({ type: "survivability", text: `失败中 ${(deathShare * 100).toFixed(1)}% 为角色死亡。` });
  else if (timeoutShare > 0) issues.push({ type: "damage", text: `失败中 ${(timeoutShare * 100).toFixed(1)}% 为超时。` });
  if (!issues.length) issues.push({ type: "stable", text: "未发现明显的死亡或超时瓶颈。" });
  return issues;
}

export async function optimizeMonsterExhaustive(options) {
  const { character, catalog, engine, monsterHrid } = options;
  const referenceLevel = Math.max(20, Math.floor(finiteNumber(options.referenceMonsterLevel, resolveReferenceMonsterLevel(character))));
  const minLevel = Math.max(1, Math.floor(finiteNumber(options.minMonsterLevel ?? options.minLevel, 20)));
  const maxLevel = Math.max(minLevel, Math.floor(finiteNumber(options.maxMonsterLevel ?? options.maxLevel, referenceLevel + 40)));
  const testTrials = Math.max(1, Math.floor(finiteNumber(options.testTrials, 100)));
  const reviewTrials = Math.max(1, Math.floor(finiteNumber(options.reviewTrials, 300)));
  const optimizeTrials = Math.max(1, Math.floor(finiteNumber(options.optimizeTrials, 500)));
  const fullProfile = classifyMonster(catalog?.combatMonsterDetailMap?.[monsterHrid], {
    roomLevel: referenceLevel,
    playerCombatDetails: character?.combatDetails,
  });
  const intelligence = character?.characterSkills?.find((entry) => entry.skillHrid === "/skills/intelligence")?.level || 1;
  const requirements = catalog?.abilitySlotsLevelRequirementList || [0, 1, 1, 20, 50, 90];
  if (intelligence < finiteNumber(requirements[5], 90)) throw new Error(`${fullProfile.name}：尚未解锁 1 个特殊技能和 4 个普通主动技能槽`);

  const directionResults = [];
  for (let index = 0; index < fullProfile.selectedDirections.length; index += 1) {
    const direction = fullProfile.selectedDirections[index];
    const profile = directionProfile(fullProfile, direction);
    const workflow = await runDirectionWorkflow({
      ...options,
      character,
      catalog,
      engine,
      monsterHrid,
      direction,
      profile,
      directionIndex: index + 1,
      minLevel,
      maxLevel,
      minimumEquipmentLevel: options.minimumEquipmentLevel ?? 80,
      selectedEquipmentTypes: options.optimizableEquipmentTypes || options.selectedEquipmentTypes || [],
      equipmentPresetSource: options.equipmentPresetSource || "system",
      optimizeAura: options.optimizeAura !== false,
      optimizeActives: options.optimizeActives !== false,
      testTrials,
      reviewTrials,
      optimizeTrials,
      targetRate: options.targetRate || 0.7,
      seedBase: finiteNumber(options.seedBase, 20260826) + index * 1000000,
      signal: options.signal,
      auditRecorder: options.auditRecorder,
      onProgress: (progress) => options.onProgress?.({ ...progress, monsterHrid, directionIndex: index + 1, directionCount: fullProfile.selectedDirections.length }),
    });
    directionResults.push(workflow);
  }
  directionResults.sort((left, right) => finiteNumber(right.optimizationLevel, 0) - finiteNumber(left.optimizationLevel, 0)
    || compareWinRate(left.rankings.winRate[0], right.rankings.winRate[0]));
  const winner = directionResults[0];
  const best = winner?.rankings?.winRate?.[0];
  if (!winner || !best) throw new Error(`${fullProfile.name} 没有生成可运行的最终方案`);
  const testProbes = directionResults.reduce((sum, entry) => sum + entry.testResults.reduce((inner, result) => inner + result.probeCount, 0), 0);
  const reviewProbes = directionResults.reduce((sum, entry) => sum + entry.reviewResults.reduce((inner, result) => inner + result.probeCount, 0), 0);
  const optimizationPlans = directionResults.reduce((sum, entry) => sum + entry.orderedPlanCount, 0);
  return {
    monsterHrid,
    name: fullProfile.name,
    profile: fullProfile,
    chosenDirection: winner.direction,
    requestedReferenceMonsterLevel: referenceLevel,
    referenceMonsterLevel: referenceLevel,
    referenceLevel,
    referenceFloorRange: monsterLevelToFloorRange(referenceLevel),
    phaseTrials: { test: testTrials, review: reviewTrials, optimize: optimizeTrials },
    trialsPerPlan: optimizeTrials,
    minimumEquipmentLevel: options.minimumEquipmentLevel ?? 80,
    equipmentPresetSource: options.equipmentPresetSource || "system",
    highestMonsterLevel: winner.optimizationLevel,
    highestLevel: winner.optimizationLevel,
    estimatedHighestFloorRange: monsterLevelToFloorRange(winner.optimizationLevel),
    targetMet: best.result.clearRate >= (options.targetRate || 0.7),
    searchCapped: winner.finalists.some((entry) => entry.capped),
    testedUpperBound: maxLevel,
    initialUpperBound: maxLevel,
    bestPlan: best.plan,
    finalResult: best.result,
    finalMetrics: best.metrics,
    rankings: winner.rankings,
    directionWorkflows: directionResults.map((entry) => ({
      direction: entry.direction,
      rankings: entry.rankings,
      optimizationLevel: entry.optimizationLevel,
    })),
    searchDiagnostics: {
      directionResults: directionResults.map((entry) => ({
        direction: entry.direction,
        savedPlans: entry.savedPlanCount,
        testProbes: entry.testResults.reduce((sum, result) => sum + result.probeCount, 0),
        bestTestLevel: entry.bestTestLevel,
        reviewFloor: entry.reviewFloor,
        reviewCandidates: entry.reviewCandidateCount,
        reviewProbes: entry.reviewResults.reduce((sum, result) => sum + result.probeCount, 0),
        finalists: entry.finalists.length,
        optimizationLevel: entry.optimizationLevel,
        orderedPlans: entry.orderedPlanCount,
        ...entry.poolDiagnostics,
      })),
      testProbes,
      reviewProbes,
      optimizationPlans,
      totalEvaluations: testProbes + reviewProbes + optimizationPlans,
    },
    candidateCounts: {
      savedPlans: directionResults.reduce((sum, entry) => sum + entry.savedPlanCount, 0),
      testPlans: directionResults.reduce((sum, entry) => sum + entry.testResults.length, 0),
      testProbes,
      reviewPlans: directionResults.reduce((sum, entry) => sum + entry.reviewResults.length, 0),
      reviewProbes,
      finalistPlans: directionResults.reduce((sum, entry) => sum + entry.finalists.length, 0),
      optimizationPlans,
      simulatedPlans: testProbes + reviewProbes + optimizationPlans,
    },
    simulationAuditSummary: options.auditRecorder?.summary({ monsterHrid }) || null,
    floorScaling: {
      rule: "怪物等级等于房间等级；第1层为20–40级，此后每层整体增加20级",
      source: "游戏迷宫说明",
    },
    searchPolicy: {
      method: "定向组件池 + 唯一全组合 + 两阶段完整二分 + 主动技能顺序优化",
      equipmentPresetSource: options.equipmentPresetSource || "system",
      levelBounds: { minimum: minLevel, maximum: maxLevel },
      targetRate: options.targetRate || 0.7,
      reviewTolerance: "测试最高等级的 1%（向上取整为最低保留等级）",
      finalistsPerDirection: 5,
      leaderboardSize: 3,
    },
    issues: diagnose(best.result),
  };
}
