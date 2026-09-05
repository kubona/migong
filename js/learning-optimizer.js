import { classifyMonster } from './classifier.js';
import { monsterLevelToFloorRange } from './data-model.js';
import { prepareDirection, directionProfile, resolveSimulationDirections, resultMetrics } from './exhaustive-optimizer.js';
import { activeOrderPermutations } from './component-planner.js';
import { buildSimulationInput } from './player-dto.js';
import { fingerprint } from './run-storage.js';
import { LearningLibrary, batchSeed, normalizeEvidence } from './learning-library.js';
import { randomGenerator, planFeatures, predictForest, ModelTrainer } from './learning-model.js';
import { sequentialInterval } from './sequential-confidence.js';
import { mergeRoomResults } from './engine-adapter.js';
import { wilsonInterval } from './statistics.js';

async function guard(o) {
  if (o.signal?.aborted) throw new DOMException('模拟已取消', 'AbortError');
  await o.pauseController?.waitIfPaused(o.signal);
  if (o.signal?.aborted) throw new DOMException('模拟已取消', 'AbortError');
}
const merge = (a, b) => normalizeEvidence(a ? mergeRoomResults([a, b]) : b);
const number = (v, fallback, min, max) => Math.max(min, Math.min(max, Math.floor(Number(v) || fallback)));
function compactPlan(p) {
  return {key:p.key,baseKey:p.baseKey,zeroCooldownHrid:p.zeroCooldownHrid,sourcePreset:p.sourcePreset,
    equipmentCandidate:{equipment:Object.fromEntries(Object.entries(p.equipmentCandidate.equipment).map(([k,i])=>[k,{hrid:i.hrid,enhancementLevel:i.enhancementLevel||0}]))},
    abilityOrder:{abilities:p.abilityOrder.abilities.map(a=>({hrid:a.hrid,level:a.level||1}))}};
}
function rememberLevel(c, level, result, looks, target) {
  c.levels[level] = { result: {trials:result.trials,successes:result.successes,clearRate:result.clearRate}, looks };
  const entries = Object.entries(c.levels);
  if (entries.length > 32) {
    // A bounded working cache only; full evidence remains on disk.
    const priority = ([l,v]) => (+l === level ? 1e9 : v.result.clearRate >= target ? 1e6 + +l : -Math.abs(+l-level));
    c.levels = Object.fromEntries(entries.sort((a,b)=>priority(b)-priority(a)).slice(0,32));
  }
}

// Sampling changes ordering/coverage, never the legal component pool. Reservoir
// selection covers the full stream instead of only a prefix of the product.
export async function sampleLegalPlans(iterate, limit, rng, o = {}, wanted = new Set()) {
  const reservoir = [], historical = []; let count = 0;
  for (const p of iterate()) {
    count++;
    if (wanted.has(p.key)) historical.push(p);
    if (reservoir.length < limit) reservoir.push(p);
    else { const j = Math.floor(rng() * count); if (j < limit) reservoir[j] = p; }
    if (count % 512 === 0) { await guard(o); await new Promise(r => setTimeout(r, 0)); }
  }
  const bases = [...new Map([...historical, ...reservoir].map(p => [p.key, p])).values()];
  const plans = [];
  for (const base of bases) {
    const orders = activeOrderPermutations(base);
    // All orders for small spaces; several independent orders for large ones.
    const chosen = orders;
    if (count > 64) for (let i = chosen.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }
    for (const plan of chosen.slice(0, count <= 64 ? chosen.length : 3)) plans.push({ ...plan, baseKey: base.key });
  }
  return { plans: [...new Map(plans.map(p => [p.key, p])).values()], totalBasePlans: count };
}

// Public seam for the search: legal plans + real engine + persistent storage.
export async function searchLearningCandidates(o) {
  if (!o.runStorage || !o.learningFamily) throw new Error('学习式搜索需要本机存储和计算版本标识');
  const store = o.runStorage, lib = new LearningLibrary(store, o.learningFamily);
  const checkpoint = store.key(`learn-state/${o.monsterHrid}`);
  let s = await store.get(checkpoint);
  const minimum = number(o.minMonsterLevel, 200, 1, 5000), maximum = number(o.maxMonsterLevel, 300, minimum, 5000);
  const budget = number(o.learningBudget, 2000, 1, 1000000);
  const trials = number(o.testTrials, 100, 1, 10000), step = number(o.reviewTrials, 300, 1, 10000);
  const maximumValidation = number(o.optimizeTrials, 5000, step, 100000);
  const target = Math.max(0.01, Math.min(0.99, Number(o.targetRate) || 0.7));
  const concurrency = Math.max(1, Math.min(64, o.engine.workerCount || 1));
  // Feature vectors already live in the evidence store; don't rewrite them
  // with every checkpoint wave.
  const save = () => store.put(checkpoint, { ...s, samples: s.samples.map(({x, ...row}) => row) });
  if (s) {
    for (const row of s.samples) {
      const pair = await lib.getPair(row.id);
      if (!pair) throw new Error('学习断点引用的证据已丢失，请开始新任务');
      row.x = pair.x;
    }
  }
  if (!s) {
    const seed = await lib.reserve(1);
    const rng = randomGenerator(seed + 1939);
    const history = await lib.sample(o.monsterHrid, 1024, rng);
    const wanted = new Set(history.rows.map(r => r.plan.baseKey));
    const sampled = o.legalPlans ? { plans: o.legalPlans, totalBasePlans: o.legalPlans.length }
      : await sampleLegalPlans(o.iterate, Math.min(512, Math.max(32, budget)), rng, o, wanted);
    if (!sampled.plans.length) throw new Error('没有合法配装');
    // Historical rows can only restore an order when its legal base still exists.
    const plans = new Map(sampled.plans.map(p => [p.key, p]));
    const baseMap = new Map(sampled.plans.map(p => [p.baseKey, p]));
    for (const row of history.rows) {
      const base = baseMap.get(row.plan.baseKey);
      if (!base) continue;
      const actual = activeOrderPermutations(base).find(p => p.key === row.plan.key);
      if (actual) plans.set(actual.key, { ...actual, baseKey: base.baseKey });
    }
    const candidates = [];
    for (const p of plans.values()) {
      const input = buildSimulationInput(o.character, o.catalog, p.equipmentCandidate, p.abilityOrder);
      const id = await fingerprint({ family: o.learningFamily, monsterHrid: o.monsterHrid, input });
      candidates.push({ plan: compactPlan(p), id, levels: {}, visits: 0 });
    }
    s = { version: 1, seed, candidates, totalBasePlans: sampled.totalBasePlans, phase: 'learn', done: 0, reusedPairs: 0,
      samples: history.rows.map(r => ({ x: r.x, n: r.search.trials, w: r.search.successes, id: r.pairId })),
      model: await lib.model(o.monsterHrid), pending: null, validation: null, validationDone: 0, predictionError: { sum: 0, count: 0 }, trainingMilliseconds: 0 };
    // Restore exact past observations only at current legal plan/level pairs.
    const byKey = new Map(candidates.map(c => [c.plan.key, c]));
    for (const row of history.rows) {
      const c = byKey.get(row.plan.key);
      if (!c || row.level < minimum || row.level > maximum || await pairId(c, row.level) !== row.pairId) continue;
      rememberLevel(c, row.level, row.search, row.searchBatches, target);
      c.visits++;
      s.reusedPairs++;
    }
    await save();
  }
  async function pairId(c, level) { return fingerprint({ family: o.learningFamily, candidate: c.id, level }); }
  const trainer = new ModelTrainer();
  const featureCache = s.candidates.map(c => planFeatures(c.plan, o.catalog, 0));
  const rngForRound = () => randomGenerator(s.seed + s.done * 997 + 7);
  function empiricalBest() {
    let best = minimum - 1;
    for (const c of s.candidates) for (const [level,v] of Object.entries(c.levels))
      if (v.result.clearRate >= target) best = Math.max(best,+level);
    return best;
  }
  function propose(c, rng, exploratory) {
    if (exploratory) return minimum + Math.floor(rng() * (maximum - minimum + 1));
    const pass = Object.entries(c.levels).filter(([, v]) => v.result.clearRate >= target).map(([l]) => +l);
    const fail = Object.entries(c.levels).filter(([, v]) => v.result.clearRate < target).map(([l]) => +l);
    const low = pass.length ? Math.max(...pass) : minimum - 1;
    const high = fail.filter(l => l > low).sort((a, b) => a - b)[0] ?? maximum + 1;
    // Only a proposal heuristic. No level is permanently eliminated.
    return Math.max(minimum, Math.min(maximum, low + 1 >= high ? Math.max(minimum, low) : Math.floor((low + high) / 2)));
  }
  function progress(phase, level) {
    const cap = s.validation?.length || 12;
    const completed = phase === 'learn' ? s.done : s.validationDone;
    const total = phase === 'learn' ? budget : cap;
    o.onProgress?.({ phase, level, learning: true, completedPlans: completed, totalPlans: total,
      currentPlan: completed, phaseCompletedBatches: completed, phaseTotalBatches: total,
      progressFraction: phase === 'learn' ? 0.8 * completed / budget : 0.8 + 0.2 * completed / cap,
      bestObservedLevel: empiricalBest(), sampledPlans: s.candidates.length, reusedPairs: s.reusedPairs,
      phaseComplete: completed >= total });
  }
  async function runTask(task) {
    await guard(o);
    const c = s.candidates[task.candidate];
    const input = { ...buildSimulationInput(o.character, o.catalog, c.plan.equipmentCandidate, c.plan.abilityOrder),
      monsterHrid: o.monsterHrid, roomLevel: task.level, roomDurationSeconds: 120, trials: task.trials,
      seed: batchSeed(task.offset), plannedConcurrency: concurrency };
    const context = { stage: task.purpose === 'search' ? 'learn' : 'validate', planId: `L${task.offset}`,
      reason: task.purpose === 'search' ? task.reason : '独立样本统计验证', candidateKind: task.reason,
      expectedRetest: true, direction: o.direction };
    const result = normalizeEvidence(o.auditRecorder ? await o.auditRecorder.simulate(o.engine, input, context) : await o.engine.simulateRoom(input));
    if (result.trials !== task.trials) throw new Error('战斗引擎返回的场数不完整，不能写入统计证据');
    const id = await pairId(c, task.level);
    const x = planFeatures(c.plan, o.catalog, task.level);
    await lib.add({ family: o.learningFamily, pairId: id, monsterHrid: o.monsterHrid, level: task.level,
      plan: c.plan, x, purpose: task.purpose, offset: task.offset, result });
    return { task, result, id, x };
  }
  async function executePending() {
    // State is committed after the whole wave. An interrupted wave replays
    // persisted audit batches; library.add is idempotent and never adds twice.
    const out = await Promise.allSettled(s.pending.map(runTask));
    const failure = out.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
    for (const { value: { task, result, id, x } } of out) {
      const c = s.candidates[task.candidate];
      if (task.purpose === 'search') {
        // Read the library aggregate, not old checkpoint + result: this also
        // includes reusable evidence absent from the bounded training reservoir.
        const pair = await lib.getPair(id);
        rememberLevel(c, task.level, pair.search, pair.searchBatches, target); c.visits++; s.done++;
        const row = { x, n: pair.search.trials, w: pair.search.successes, id };
        const j = s.samples.findIndex(r => r.id === id);
        if (j >= 0) s.samples[j] = row;
        else if (s.samples.length < 1024) s.samples.push(row);
        else { const k = Math.floor(randomGenerator(task.offset + 1)() * (s.done + 1024)); if (k < 1024) s.samples[k] = row; }
        if (task.prediction != null) { s.predictionError.sum += (task.prediction - result.clearRate) ** 2; s.predictionError.count++; }
      } else {
        const v = s.validation[task.validation];
        v.result = merge(v.result, result); v.looks++;
        v.interval = sequentialInterval(v.result.successes, v.result.trials, v.looks, 0.05 / (Math.max(1, o.certificationMonsterCount || 1) * s.validation.length));
        v.status = v.interval.lower >= target ? 'certified' : v.interval.upper < target ? 'failed' : v.result.trials >= maximumValidation ? 'uncertain' : 'running';
      }
    }
    s.validationDone = s.validation?.filter(v => v.status !== 'running').length || 0;
    s.pending = null; await save();
  }
  try {
    while (s.phase === 'learn' && s.done < budget) {
      await guard(o);
      if (!s.pending) {
        const rng = rngForRound(), best = empiricalBest();
        const unvisited = s.candidates.map((c, i) => ({ c, i })).filter(({ c }) => !c.visits);
        const randomOrder = [...s.candidates.keys()];
        for (let i = randomOrder.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [randomOrder[i], randomOrder[j]] = [randomOrder[j], randomOrder[i]]; }
        const tasks = [], used = new Set();
        const wave = Math.min(concurrency, budget - s.done);
        for (let k = 0; k < wave; k++) {
          const exploratory = (s.done + k) % 4 === 0;
          const cold = s.done < Math.min(64, s.candidates.length) && s.samples.length < 16;
          let chosen;
          if (cold || exploratory) {
            const available = (unvisited.length ? unvisited.map(e => e.i) : randomOrder).filter(i => !used.has(i));
            const i = available.length ? available[Math.floor(rng() * available.length)] : randomOrder.find(i => !used.has(i));
            if (i == null) break;
            chosen = { i, level: propose(s.candidates[i], rng, !cold && exploratory), reason: '全局探索' };
          } else {
            const proposals = randomOrder.filter(i => !used.has(i)).slice(0, 128).map(i => {
              const c = s.candidates[i], level = (s.done + k) % 3 === 0 ? Math.min(maximum, Math.max(minimum, best + 1)) : propose(c, rng, false);
              const pred = predictForest(s.model, { ...featureCache[i], 'monster.level': level });
              const n = c.levels[level]?.result?.trials || 0;
              const uncertainty = pred.disagreement + 1 / Math.sqrt(1 + n / trials);
              // Units are normalized; a high model error reduces exploitation.
              const error = s.predictionError.count ? Math.sqrt(s.predictionError.sum / s.predictionError.count) : 0;
              const score = pred.mean + (0.3 + Math.min(0.7, error)) * uncertainty + 0.15 * (level - minimum) / Math.max(1, maximum - minimum);
              return { i, level, score, prediction: pred.mean, reason: n ? '追加证据' : '模型引导挑战' };
            }).sort((a, b) => b.score - a.score);
            chosen = proposals[0]; if (!chosen) break;
          }
          used.add(chosen.i);
          tasks.push({ candidate: chosen.i, level: chosen.level, trials, offset: await lib.reserve(trials),
            purpose: 'search', reason: chosen.reason, prediction: chosen.prediction });
        }
        s.pending = tasks; await save();
      }
      const trainingAt = s.done;
      // Train concurrently with an already-dispatched battle wave, not on the UI.
      const training = s.samples.length >= 16 && (!s.model || s.done - (s.trainedAt || 0) >= 64)
        ? trainer.train(s.samples, s.seed + s.done) : null;
      if (training) training.catch(() => {});
      await executePending();
      if (training) {
        s.model = await training;
        s.trainedAt = trainingAt; s.trainingMilliseconds += s.model.trainingMilliseconds || 0;
        await lib.model(o.monsterHrid, s.model); await save();
      }
      progress('learn', s.candidates.find(c => c.visits)?.levels ? undefined : minimum);
    }
    if (s.phase === 'learn') {
      if (s.samples.length >= 8 && s.trainedAt !== s.done) {
        s.model = await trainer.train(s.samples, s.seed + s.done);
        s.trainingMilliseconds += s.model.trainingMilliseconds || 0;
        s.trainedAt = s.done; await lib.model(o.monsterHrid, s.model);
      }
      // This lower estimate only prioritizes hypotheses; it is NOT a certificate.
      // Avoid spending every validation slot on noisy peak-level observations.
      const shortlist = s.candidates.map((c, i) => {
        const pairs = Object.entries(c.levels).map(([l, v]) => ({candidate:i,level:+l,observed:v.result,
          support:wilsonInterval(v.result.successes,v.result.trials,1.2815515655446004).lower}));
        const passing = pairs.filter(p=>p.observed.clearRate>=target).sort((a,b)=>b.level-a.level);
        const supported = pairs.filter(p=>p.support>=target).sort((a,b)=>b.level-a.level);
        const fallback = [...pairs].sort((a,b)=>b.support-a.support||b.level-a.level)[0];
        return {candidate:i,challenge:passing[0]||fallback,supported:supported[0]||fallback,
          hasSupport:!!supported.length,fallback};
      }).filter(c=>c.challenge);
      shortlist.sort((a,b)=>Number(b.hasSupport)-Number(a.hasSupport)||b.supported.level-a.supported.level
        ||b.supported.support-a.supported.support||b.challenge.level-a.challenge.level);
      const top=shortlist.slice(0,4);
      s.validation = [];
      for (const p of top) for (const level of new Set([p.challenge.level, p.supported.level,
        Math.max(minimum, Math.min(p.supported.level - 3,p.fallback.level))]))
        s.validation.push({ candidate: p.candidate, level, looks: 0, result: null, status: 'running' });
      if (!s.validation.length) throw new Error('没有完成可验证的搜索样本');
      // All hypotheses are frozen before accessing independent validation data.
      s.phase = 'validate'; await save();
    }
    while (s.phase === 'validate' && s.validation.some(v => v.status === 'running')) {
      await guard(o);
      if (!s.pending) {
        s.pending = [];
        for (const [i, v] of s.validation.entries()) {
          if (v.status !== 'running' || s.pending.length >= concurrency) continue;
          const n = Math.min(step, maximumValidation - (v.result?.trials || 0));
          s.pending.push({ candidate: v.candidate, level: v.level, trials: n, offset: await lib.reserve(n), purpose: 'validation', validation: i });
        }
        await save();
      }
      await executePending(); progress('validate');
    }
    s.phase = 'complete'; await save();
    return { state: s, minimum, maximum, target, budget, maximumValidation };
  } finally { trainer.close(); }
}

export async function optimizeMonsterLearning(o) {
  const profile = classifyMonster(o.catalog.combatMonsterDetailMap[o.monsterHrid], { roomLevel: 100, playerCombatDetails: o.character.combatDetails });
  const intelligence = o.character.characterSkills.find(s => s.skillHrid === '/skills/intelligence')?.level || 1;
  if (intelligence < (o.catalog.abilitySlotsLevelRequirementList?.[5] || 90)) throw new Error('尚未解锁完整战斗技能槽');
  const direction = resolveSimulationDirections(profile, o.simulationDirection)[0];
  const prepared = prepareDirection({ ...o, direction, profile: directionProfile(profile, direction),
    selectedEquipmentTypes: o.optimizableEquipmentTypes || [], minimumEquipmentLevel: 80 });
  const run = await searchLearningCandidates({ ...o, direction, iterate: prepared.iterate,
    onProgress: p => o.onProgress?.({ ...p, monsterHrid: o.monsterHrid, direction }) });
  const s = run.state;
  const entries = s.validation.map(v => {
    const result = { ...v.result, interval: v.interval };
    return { plan: s.candidates[v.candidate].plan, result, metrics: resultMetrics(result), monsterLevel: v.level,
      direction, targetMet: v.status === 'certified', certification: v.status };
  });
  const certified = entries.filter(e => e.targetMet);
  const level = Math.max(...(certified.length ? certified : entries).map(e => e.monsterLevel));
  const eligible = (certified.length ? certified : entries).filter(e => e.monsterLevel === level);
  const rank = arr => arr.slice(0, 3).map((e, i) => ({ ...e, rank: i + 1 }));
  const rankings = { winRate: rank([...eligible].sort((a, b) => b.result.clearRate - a.result.clearRate)),
    speed: rank([...eligible].sort((a, b) => (a.result.averageClearSeconds ?? Infinity) - (b.result.averageClearSeconds ?? Infinity))) };
  const best = rankings.winRate[0];
  return { monsterHrid: o.monsterHrid, name: profile.name, profile, chosenDirection: direction,
    simulationDirectionSelection: o.simulationDirection || 'auto', simulationDirectionMode: o.simulationDirection === 'auto' || !o.simulationDirection ? 'auto' : 'manual',
    equipmentPresetSource: o.equipmentPresetSource, highestMonsterLevel: level, highestLevel: level,
    estimatedHighestFloorRange: monsterLevelToFloorRange(level), targetMet: !!certified.length,
    searchCapped: !!certified.length && level === run.maximum, bestPlan: best.plan, finalResult: best.result, finalMetrics: best.metrics,
    rankings, learning: true, certification: certified.length ? 'certified' : 'not-certified',
    directionWorkflows: [{ direction, rankings, optimizationLevel: level }],
    candidateCounts: { savedPlans: s.totalBasePlans, sampledOrderedPlans: s.candidates.length, simulatedPlans: s.done, reusedPairs: s.reusedPairs },
    searchDiagnostics: { learningBatches: s.done, validationPairs: entries.length, certifiedPairs: certified.length,
      predictionRMSE: s.predictionError.count ? Math.sqrt(s.predictionError.sum / s.predictionError.count) : null,
      trainingMilliseconds: s.trainingMilliseconds, validations: entries.map(e => ({ key: e.plan.key, level: e.monsterLevel, status: e.certification, trials: e.result.trials, interval: e.result.interval })) },
    searchPolicy: { method: '有界全域抽样 + 整套配装/技能顺序联合学习 + 自适应等级挑战 + 独立统计验证',
      targetRate: run.target, familywiseConfidence: 0.95, confidenceScope: '本次任务所有选中怪物及预先冻结的验证方案',
      globalOptimalityProven: false, monotonicityAssumedForElimination: false, searchBudgetBatches: run.budget,
      validationMaximumTrialsPerPair: run.maximumValidation, levelBounds: { minimum: run.minimum, maximum: run.maximum } },
    issues: [{ type: certified.length ? 'stable' : 'survivability', text: certified.length ? '已通过本次任务95%同时统计验证；为当前找到的最高等级，未证明全局最优。' : '验证预算内没有确认达标的方案；展示的是未认证候选，不能据此认定稳定通关。' }],
    simulationAuditSummary: o.auditRecorder?.summary({ monsterHrid: o.monsterHrid }) || null };
}
