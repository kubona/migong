import { COMBAT_EQUIPMENT_TYPES, finiteNumber, monsterLevelToFloorRange, resolveReferenceMonsterLevel } from "./data-model.js";
import { classifyMonster } from "./classifier.js";
import { buildSearchSpace } from "./candidate-planner.js";
import { chineseName } from "./localization.js";
import { buildSimulationInput } from "./player-dto.js";
import { mergeSimulationRuns, wilsonInterval } from "./statistics.js";
import { evaluateUpgradeSuggestions } from "./recommendations.js";
import { balancedMetrics, compareBalancedResults, meetsTargetRate, selectBalancedPlans } from "./balanced-search.js";
import { createSimulationAuditRecorder } from "./simulation-audit.js";

const HAND_TYPES = new Set([
  "/equipment_types/main_hand",
  "/equipment_types/off_hand",
  "/equipment_types/two_hand",
]);

const FIXED_ACTIVE_HRIDS = {
  elementalAffinity: "/abilities/elemental_affinity",
  frenzy: "/abilities/frenzy",
  berserk: "/abilities/berserk",
  retribution: "/abilities/retribution",
  spikeShell: "/abilities/spike_shell",
};

function planKey(equipmentCandidate, abilityOrder) {
  const gear = Object.entries(equipmentCandidate?.equipment || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, item]) => `${slot}:${item.hrid}@${item.enhancementLevel || 0}`)
    .join("|");
  const abilities = (abilityOrder?.abilities || []).map((entry) => entry.hrid).join(",");
  const triggerMap = abilityOrder?.combatContext?.abilityCombatTriggersMap || {};
  const triggers = (abilityOrder?.abilities || []).map((entry) => {
    const configured = triggerMap[entry.hrid];
    return `${entry.hrid}:${Array.isArray(configured) ? JSON.stringify(configured) : "default"}`;
  }).join("|");
  return `${gear}::${abilities}::${triggers}`;
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException("模拟已取消", "AbortError");
}

function mergeAttackSummaries(runs) {
  const summary = { hits: 0, misses: 0, total: 0, hitRate: 0, byAbility: {} };
  for (const run of runs || []) {
    const source = run?.attackSummary || {};
    summary.hits += Math.max(0, finiteNumber(source.hits, 0));
    summary.misses += Math.max(0, finiteNumber(source.misses, 0));
    for (const [ability, values] of Object.entries(source.byAbility || {})) {
      const target = summary.byAbility[ability] || { hits: 0, misses: 0 };
      target.hits += Math.max(0, finiteNumber(values?.hits, 0));
      target.misses += Math.max(0, finiteNumber(values?.misses, 0));
      summary.byAbility[ability] = target;
    }
  }
  summary.total = summary.hits + summary.misses;
  summary.hitRate = summary.total > 0 ? summary.hits / summary.total : 0;
  return summary;
}

function mergeDamageSummaries(runs) {
  const summary = { totalDamage: 0, counterDamage: 0, byAbility: {} };
  for (const run of runs || []) {
    const source = run?.damageSummary || {};
    summary.totalDamage += Math.max(0, finiteNumber(source.totalDamage, 0));
    summary.counterDamage += Math.max(0, finiteNumber(source.counterDamage, 0));
    for (const [ability, values] of Object.entries(source.byAbility || {})) {
      const target = summary.byAbility[ability] || { damage: 0, hits: 0 };
      target.damage += Math.max(0, finiteNumber(values?.damage, 0));
      target.hits += Math.max(0, finiteNumber(values?.hits, 0));
      summary.byAbility[ability] = target;
    }
  }
  return summary;
}

function normalizedRuns(runs) {
  const merged = mergeSimulationRuns(runs);
  const last = runs?.at(-1) || {};
  return {
    ...merged,
    attackSummary: mergeAttackSummaries(runs),
    damageSummary: mergeDamageSummaries(runs),
    combatStats: last?.combatStats || null,
    debug: {
      ...(last?.debug || {}),
      requestedTrials: merged.trials,
      attemptCount: merged.trials,
      independentTrials: (runs || []).every((run) => run?.debug?.independentTrials !== false),
      adaptiveBatches: Math.max(0, (runs || []).length - 1),
    },
  };
}

function normalizedResult(run) {
  return normalizedRuns([run]);
}

export function compareFullSimulationResults(left, right) {
  return compareBalancedResults(left, right);
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

function parseItemReference(reference) {
  if (reference && typeof reference === "object") {
    return {
      hrid: String(reference.itemHrid || reference.hrid || ""),
      enhancementLevel: Math.max(0, Math.floor(finiteNumber(reference.enhancementLevel, 0))),
    };
  }
  const parts = String(reference || "").split("::");
  const itemIndex = parts.findIndex((part) => part.startsWith("/items/"));
  if (itemIndex < 0) return null;
  return {
    hrid: parts[itemIndex],
    enhancementLevel: Math.max(0, Math.floor(finiteNumber(parts[itemIndex + 1], 0))),
  };
}

function equipmentEntry(catalog, reference) {
  const parsed = parseItemReference(reference);
  const item = catalog.itemDetailMap?.[parsed?.hrid];
  const type = item?.equipmentDetail?.type;
  if (!parsed?.hrid || !COMBAT_EQUIPMENT_TYPES.has(type)) return null;
  return {
    hrid: parsed.hrid,
    name: chineseName(parsed.hrid, item.name || parsed.hrid),
    type,
    enhancementLevel: parsed.enhancementLevel,
    count: 1,
  };
}

function equipmentFromLoadout(loadout, catalog) {
  const equipment = {};
  for (const reference of Object.values(loadout?.wearableMap || {})) {
    const entry = equipmentEntry(catalog, reference);
    if (entry) equipment[entry.type] = entry;
  }
  if (equipment["/equipment_types/two_hand"]) {
    delete equipment["/equipment_types/main_hand"];
    delete equipment["/equipment_types/off_hand"];
  }
  return equipment;
}

function findAbility(entries, hrid) {
  return (entries || []).find((entry) => entry.hrid === hrid) || null;
}

function abilitiesFromLoadout(loadout, searchSpace) {
  const auraHrid = String(loadout?.abilityMap?.[1] || loadout?.abilityMap?.["1"] || "");
  const aura = findAbility(searchSpace.allAuraAbilities || searchSpace.auraAbilities, auraHrid) || searchSpace.auraAbilities[0];
  const actives = [];
  for (let slot = 2; slot <= 5; slot += 1) {
    const hrid = String(loadout?.abilityMap?.[slot] || loadout?.abilityMap?.[String(slot)] || "");
    const entry = findAbility(searchSpace.allActiveAbilities || searchSpace.activeAbilities, hrid);
    if (entry && !actives.some((other) => other.hrid === entry.hrid)) actives.push(entry);
  }
  for (const entry of searchSpace.activeAbilities) {
    if (actives.length >= 4) break;
    if (!actives.some((other) => other.hrid === entry.hrid)) actives.push(entry);
  }
  return aura && actives.length === 4 ? { abilities: [aura, ...actives] } : null;
}

function requiredAbility(searchSpace, hrid, label) {
  const entry = findAbility(searchSpace.allActiveAbilities, hrid);
  if (!entry) throw new Error(`固定技能“${label}”不在当前游戏数据中`);
  return { ...entry, fixedByRule: true };
}

function requiredAura(searchSpace, hrid) {
  if (!hrid) return null;
  const entry = findAbility(searchSpace.allAuraAbilities || searchSpace.auraAbilities, hrid);
  if (!entry) throw new Error(`固定特殊技能“${hrid}”不在当前游戏数据中或不属于特殊技能槽`);
  return { ...entry, fixedByRule: true };
}

export function resolveFixedActiveSlots(searchSpace, direction, monsterHrid, configuredRules = {}) {
  const fixed = new Map();
  const fixedHrids = new Set();
  const category = monsterHrid === "/monsters/mimic"
    ? "mimic"
    : direction?.styleHrid === "/combat_styles/magic" ? "magic" : "physical";
  const defaults = category === "magic"
    ? { aura: "", active1: FIXED_ACTIVE_HRIDS.elementalAffinity, active2: "", active3: "", active4: "__auto_zero__" }
    : category === "mimic"
      ? { aura: "", active1: "", active2: "", active3: FIXED_ACTIVE_HRIDS.retribution, active4: FIXED_ACTIVE_HRIDS.spikeShell }
      : { aura: "", active1: FIXED_ACTIVE_HRIDS.frenzy, active2: FIXED_ACTIVE_HRIDS.berserk, active3: "", active4: "" };
  const rule = { ...defaults, ...(configuredRules?.[category] || {}) };
  for (let slot = 1; slot <= 4; slot += 1) {
    const value = rule[`active${slot}`];
    if (!value) continue;
    let ability;
    if (value === "__auto_zero__") {
      const zeroCooldown = searchSpace.allActiveAbilities.find((entry) => (
        finiteNumber(entry.cooldownDuration, -1) === 0
        && entry.classification?.styles?.has("/combat_styles/magic")
        && entry.classification?.damageTypes?.has(direction.damageTypeHrid)
      ));
      if (!zeroCooldown) throw new Error(`${direction.damageTypeZh || "对应元素"}方向缺少 0CD 主动技能`);
      ability = zeroCooldown;
    } else {
      ability = requiredAbility(searchSpace, value, value);
    }
    if (fixedHrids.has(ability.hrid)) throw new Error(`固定主动技能不能重复：${ability.name || ability.hrid}`);
    fixedHrids.add(ability.hrid);
    fixed.set(slot, { ...ability, fixedByRule: true });
  }
  fixed.activeSlots = fixed;
  fixed.aura = requiredAura(searchSpace, rule.aura);
  return fixed;
}

function applyFixedActiveSlots(abilityOrder, fixedActiveSlots, activePool) {
  const abilities = [...(abilityOrder?.abilities || [])];
  for (const [slot, ability] of fixedActiveSlots) abilities[slot] = ability;
  const used = new Set();
  for (let slot = 1; slot <= 4; slot += 1) {
    const current = abilities[slot];
    if (current && !used.has(current.hrid)) {
      used.add(current.hrid);
      continue;
    }
    const replacement = activePool.find((entry) => !used.has(entry.hrid));
    if (!replacement) throw new Error("固定技能规则后没有足够的不重复主动技能填满四个栏位");
    abilities[slot] = replacement;
    used.add(replacement.hrid);
  }
  return {
    ...abilityOrder,
    abilities,
  };
}

function weaponChoices(pools) {
  const result = [];
  const twoHand = pools["/equipment_types/two_hand"] || [];
  const mainHand = pools["/equipment_types/main_hand"] || [];
  const offHand = pools["/equipment_types/off_hand"] || [];
  for (const weapon of twoHand) result.push({ [weapon.type]: weapon });
  for (const weapon of mainHand) {
    result.push({ [weapon.type]: weapon });
    for (const off of offHand) result.push({ [weapon.type]: weapon, [off.type]: off });
  }
  return result;
}

function weaponMatchesPreset(equipment, pools) {
  const hasOptimizableWeapon = [...HAND_TYPES].some((type) => (pools[type] || []).length > 0);
  if (!hasOptimizableWeapon) return true;
  const weapon = equipment["/equipment_types/two_hand"] || equipment["/equipment_types/main_hand"];
  if (!weapon) return false;
  const candidates = pools[weapon.type] || [];
  return candidates.some((entry) => entry.hrid === weapon.hrid && entry.enhancementLevel === weapon.enhancementLevel);
}

function presetMatchesDirection(equipment, catalog, direction) {
  if (!direction?.styleHrid || !direction?.damageTypeHrid) return true;
  const weapon = equipment["/equipment_types/two_hand"] || equipment["/equipment_types/main_hand"];
  const combatStats = catalog.itemDetailMap?.[weapon?.hrid]?.equipmentDetail?.combatStats || {};
  return (combatStats.combatStyleHrids || []).includes(direction.styleHrid)
    && String(combatStats.damageType || "") === direction.damageTypeHrid;
}

function fallbackEquipmentStarts(searchSpace) {
  const base = {};
  for (const [type, entries] of Object.entries(searchSpace.equipmentPools)) {
    if (HAND_TYPES.has(type) || entries.length === 0) continue;
    base[type] = entries[0];
  }
  return weaponChoices(searchSpace.equipmentPools).map((weapons, index) => ({
    sourcePreset: `自动起点 ${index + 1}`,
    equipmentCandidate: { equipment: { ...base, ...weapons } },
  }));
}

export function buildPresetStarts(character, catalog, searchSpace, options = {}) {
  const starts = [];
  for (const loadout of Object.values(character.characterLoadoutMap || {})) {
    if (loadout?.actionTypeHrid !== "/action_types/combat") continue;
    const equipment = equipmentFromLoadout(loadout, catalog);
    if (!presetMatchesDirection(equipment, catalog, options.direction)) continue;
    if (!weaponMatchesPreset(equipment, searchSpace.equipmentPools)) continue;
    let abilityOrder = abilitiesFromLoadout(loadout, searchSpace);
    if (!abilityOrder) continue;
    if (options.fixedAura) abilityOrder = { ...abilityOrder, abilities: [options.fixedAura, ...abilityOrder.abilities.slice(1)] };
    abilityOrder = applyFixedActiveSlots(abilityOrder, options.fixedActiveSlots || new Map(), searchSpace.allActiveAbilities);
    starts.push({
      sourcePreset: String(loadout.name || `预设 ${loadout.id}`),
      sourcePresetId: loadout.id,
      equipmentCandidate: { equipment },
      abilityOrder: {
        ...abilityOrder,
        combatContext: { abilityCombatTriggersMap: loadout.abilityCombatTriggersMap || {} },
      },
    });
  }
  if (starts.length === 0 && !options.direction) {
    let abilityOrder = abilitiesFromLoadout(null, searchSpace);
    if (abilityOrder) {
      if (options.fixedAura) abilityOrder = { ...abilityOrder, abilities: [options.fixedAura, ...abilityOrder.abilities.slice(1)] };
      abilityOrder = applyFixedActiveSlots(abilityOrder, options.fixedActiveSlots || new Map(), searchSpace.allActiveAbilities || searchSpace.activeAbilities);
    }
    for (const start of fallbackEquipmentStarts(searchSpace)) starts.push({ ...start, abilityOrder });
  }
  const seen = new Set();
  return starts.filter((entry) => {
    if (!entry.abilityOrder) return false;
    const key = planKey(entry.equipmentCandidate, entry.abilityOrder);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function replaceWeaponGroup(equipment, weapons) {
  const next = { ...equipment };
  for (const type of HAND_TYPES) delete next[type];
  return { ...next, ...weapons };
}

function permutations(entries) {
  const result = [];
  const visit = (prefix, remaining) => {
    if (remaining.length === 0) {
      result.push(prefix);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      visit([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  };
  visit([], entries);
  return result;
}

function withAbilities(current, abilities) {
  return {
    abilities,
    ...(current?.abilityOrder?.combatContext ? { combatContext: current.abilityOrder.combatContext } : {}),
  };
}

function equipmentSignature(item) {
  return item ? `${item.hrid}@${item.enhancementLevel || 0}` : "";
}

function changedDimensions(base, candidate) {
  const dimensions = [];
  const baseEquipment = base?.equipmentCandidate?.equipment || {};
  const candidateEquipment = candidate?.equipmentCandidate?.equipment || {};
  const weaponChanged = [...HAND_TYPES].some((type) => (
    equipmentSignature(baseEquipment[type]) !== equipmentSignature(candidateEquipment[type])
  ));
  if (weaponChanged) dimensions.push("weapon");
  const equipmentTypes = new Set([...Object.keys(baseEquipment), ...Object.keys(candidateEquipment)]);
  for (const type of [...equipmentTypes].filter((entry) => !HAND_TYPES.has(entry)).sort()) {
    if (equipmentSignature(baseEquipment[type]) !== equipmentSignature(candidateEquipment[type])) {
      dimensions.push(`equipment:${type}`);
    }
  }
  const baseAbilities = base?.abilityOrder?.abilities || [];
  const candidateAbilities = candidate?.abilityOrder?.abilities || [];
  const abilityCount = Math.max(baseAbilities.length, candidateAbilities.length);
  for (let index = 0; index < abilityCount; index += 1) {
    if (baseAbilities[index]?.hrid !== candidateAbilities[index]?.hrid) {
      dimensions.push(index === 0 ? "aura" : `active:${index}`);
    }
  }
  return dimensions;
}

function dimensionLabel(dimension) {
  if (dimension === "weapon") return "武器组合";
  if (dimension === "aura") return "特殊技能";
  if (dimension.startsWith("active:")) return `主动技能${dimension.slice("active:".length)}`;
  if (dimension.startsWith("equipment:")) {
    const hrid = dimension.slice("equipment:".length);
    return chineseName(hrid, hrid.split("/").pop() || hrid);
  }
  return dimension;
}

async function simulateAudited(options, input, context) {
  if (options.auditRecorder) return options.auditRecorder.simulate(options.engine, input, context);
  return options.engine.simulateRoom(input);
}

function combineSingleChanges(base, left, right) {
  const leftDimensions = changedDimensions(base, left);
  const rightDimensions = changedDimensions(base, right);
  if (leftDimensions.length !== 1 || rightDimensions.length !== 1 || leftDimensions[0] === rightDimensions[0]) return null;
  const equipment = { ...(base?.equipmentCandidate?.equipment || {}) };
  const abilities = [...(base?.abilityOrder?.abilities || [])];
  const apply = (donor, dimension) => {
    if (dimension === "weapon") {
      for (const type of HAND_TYPES) {
        delete equipment[type];
        if (donor.equipmentCandidate.equipment[type]) equipment[type] = donor.equipmentCandidate.equipment[type];
      }
      return;
    }
    if (dimension.startsWith("equipment:")) {
      const type = dimension.slice("equipment:".length);
      if (donor.equipmentCandidate.equipment[type]) equipment[type] = donor.equipmentCandidate.equipment[type];
      else delete equipment[type];
      return;
    }
    const index = dimension === "aura" ? 0 : Number(dimension.slice("active:".length));
    abilities[index] = donor.abilityOrder.abilities[index];
  };
  apply(left, leftDimensions[0]);
  apply(right, rightDimensions[0]);
  const activeHrids = abilities.slice(1).map((entry) => entry?.hrid).filter(Boolean);
  if (new Set(activeHrids).size !== activeHrids.length) return null;
  return {
    ...base,
    equipmentCandidate: { equipment },
    abilityOrder: withAbilities(base, abilities),
  };
}

async function coordinateOptimize(options) {
  options = {
    ...options,
    optimizableEquipmentTypes: new Set(options.optimizableEquipmentTypes || COMBAT_EQUIPMENT_TYPES),
    optimizableActiveSlots: new Set(options.optimizableActiveSlots || [1, 2, 3, 4]),
    fixedActiveSlots: options.fixedActiveSlots || new Map(),
  };
  const cache = options.cache || new Map();
  let evaluations = 0;
  let interactionEvaluations = 0;
  let survivalEvaluations = 0;
  let adaptiveEvaluations = 0;
  let rounds = 0;
  const balanceOptions = {
    targetRate: options.targetRate || 0.7,
    confidenceZ: options.confidenceZ || 1.2815515655446004,
    beamWidth: options.beamWidth,
    retentionRatio: options.retentionRatio ?? 0.1,
    minimumRetainedPlans: options.minimumRetainedPlans ?? 10,
    maximumRetainedPlans: options.maximumRetainedPlans ?? 50,
    adaptiveMaxTrials: options.adaptiveMaxTrials,
    adaptiveContenderLimit: options.adaptiveContenderLimit,
    interactionPairBudget: options.interactionPairBudget,
    interactionPerDimension: options.interactionPerDimension,
    survivalDeathRateThreshold: options.survivalDeathRateThreshold,
  };
  const optimizableGearGroups = Object.keys(options.equipmentPools)
    .filter((type) => options.optimizableEquipmentTypes.has(type) && !HAND_TYPES.has(type)).length
    + ([...HAND_TYPES].some((type) => options.optimizableEquipmentTypes.has(type)) ? 1 : 0);
  const optimizableSkillGroups = (options.optimizeAura && !options.fixedAura ? 1 : 0)
    + [...options.optimizableActiveSlots].filter((slot) => !options.fixedActiveSlots.has(slot)).length;
  const dimensionBound = Math.max(1, optimizableGearGroups + optimizableSkillGroups);
  const maxRounds = Math.max(1, Math.floor(finiteNumber(options.balanceRounds, dimensionBound)));
  const baseTrials = Math.max(1, Math.floor(finiteNumber(options.trials, 100)));
  const adaptiveMaxTrials = Math.max(baseTrials, Math.floor(finiteNumber(
    options.adaptiveMaxTrials,
    baseTrials < 100 ? Math.min(100, baseTrials * 4) : baseTrials,
  )));
  const adaptiveContenderLimit = Math.max(2, Math.floor(finiteNumber(options.adaptiveContenderLimit, balanceOptions.minimumRetainedPlans + 2)));
  const interactionPairBudget = Math.max(0, Math.floor(finiteNumber(options.interactionPairBudget, 36)));
  const interactionPerDimension = Math.max(1, Math.floor(finiteNumber(options.interactionPerDimension, 1)));
  const evaluate = async (candidate, auditContext = {}) => {
    checkAbort(options.signal);
    const key = planKey(candidate.equipmentCandidate, candidate.abilityOrder);
    let result = cache.get(key);
    if (!result) {
      const simulationInput = buildSimulationInput(
        options.character,
        options.catalog,
        candidate.equipmentCandidate,
        candidate.abilityOrder,
        candidate.abilityOrder?.combatContext,
      );
      const simulationRequest = {
        ...simulationInput,
        monsterHrid: options.monsterHrid,
        roomLevel: options.roomLevel,
        roomDurationSeconds: 120,
        trials: options.trials,
        seed: options.seed,
      };
      const run = await simulateAudited(options, simulationRequest, {
        stage: options.auditStage || "offense",
        reason: auditContext.reason || "定向候选实测",
        candidateKind: auditContext.candidateKind || "candidate",
        searchRound: Math.min(maxRounds, rounds + 1),
        direction: options.direction || null,
        sourcePreset: candidate.sourcePreset || options.start?.sourcePreset || null,
        changedDimensions: auditContext.changedDimensions || [],
      });
      result = { result: normalizedResult(run), runs: [run], simulationInput };
      cache.set(key, result);
      evaluations += 1;
      options.onProgress?.({
        evaluations,
        sourcePreset: candidate.sourcePreset || options.start?.sourcePreset,
        roomLevel: options.roomLevel,
        balancedRound: Math.min(maxRounds, rounds + 1),
        balancedMaxRounds: maxRounds,
      });
    }
    if (!result.runs) result.runs = result.run ? [result.run] : [];
    return { ...candidate, key, result: result.result, runs: result.runs, simulationInput: result.simulationInput };
  };

  const refineAmbiguous = async (candidates) => {
    if (adaptiveMaxTrials <= baseTrials || candidates.length < 2) return candidates;
    const unique = [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()]
      .sort((left, right) => compareBalancedResults(left.result, right.result, balanceOptions));
    const best = unique[0];
    const bestInterval = wilsonInterval(best.result.successes, best.result.trials, balanceOptions.confidenceZ);
    const contenders = unique.filter((candidate) => {
      if (candidate.result.trials >= adaptiveMaxTrials) return false;
      const interval = wilsonInterval(candidate.result.successes, candidate.result.trials, balanceOptions.confidenceZ);
      return interval.upper >= bestInterval.lower && bestInterval.upper >= interval.lower;
    }).slice(0, adaptiveContenderLimit);
    for (const candidate of contenders) {
      checkAbort(options.signal);
      const cached = cache.get(candidate.key);
      if (!cached) continue;
      const completedTrials = cached.result.trials;
      const batchTrials = Math.min(baseTrials, adaptiveMaxTrials - completedTrials);
      if (batchTrials <= 0) continue;
      const simulationRequest = {
        ...cached.simulationInput,
        monsterHrid: options.monsterHrid,
        roomLevel: options.roomLevel,
        roomDurationSeconds: 120,
        trials: batchTrials,
        seed: finiteNumber(options.seed, 0) + completedTrials * 2654435761 + cached.runs.length * 1009,
      };
      const run = await simulateAudited(options, simulationRequest, {
        stage: options.auditStage || "offense",
        reason: "低样本 Wilson 区间重叠，追加独立复核",
        candidateKind: "adaptive_retest",
        searchRound: Math.min(maxRounds, rounds + 1),
        direction: options.direction || null,
        sourcePreset: candidate.sourcePreset || options.start?.sourcePreset || null,
        changedDimensions: [],
        expectedRetest: true,
      });
      cached.runs.push(run);
      cached.result = normalizedRuns(cached.runs);
      candidate.runs = cached.runs;
      candidate.result = cached.result;
      evaluations += 1;
      adaptiveEvaluations += 1;
      options.onProgress?.({
        evaluations,
        adaptiveEvaluations,
        sourcePreset: candidate.sourcePreset || options.start?.sourcePreset,
        roomLevel: options.roomLevel,
        balancedRound: Math.min(maxRounds, rounds + 1),
        balancedMaxRounds: maxRounds,
      });
    }
    return unique.map((candidate) => {
      const cached = cache.get(candidate.key);
      return cached ? { ...candidate, result: cached.result, runs: cached.runs } : candidate;
    });
  };

  const neighbors = (current, pools = {}) => {
    const equipmentPools = pools.equipmentPools || options.equipmentPools;
    const auraAbilities = pools.auraAbilities || options.auraAbilities;
    const activeAbilities = pools.activeAbilities || options.activeAbilities;
    const candidates = [];
    if ([...HAND_TYPES].some((type) => options.optimizableEquipmentTypes.has(type))) {
      for (const weapons of weaponChoices(equipmentPools)) {
        candidates.push({
          ...current,
          equipmentCandidate: { equipment: replaceWeaponGroup(current.equipmentCandidate.equipment, weapons) },
        });
      }
    }
    const equipmentTypes = Object.keys(equipmentPools)
      .filter((type) => !HAND_TYPES.has(type) && options.optimizableEquipmentTypes.has(type)).sort();
    for (const type of equipmentTypes) {
      for (const item of equipmentPools[type] || []) {
        candidates.push({
          ...current,
          equipmentCandidate: { equipment: { ...current.equipmentCandidate.equipment, [type]: item } },
        });
      }
    }
    if (options.optimizeAura && !options.fixedAura) {
      for (const aura of auraAbilities) {
        candidates.push({
          ...current,
          abilityOrder: withAbilities(current, [aura, ...current.abilityOrder.abilities.slice(1)]),
        });
      }
    }
    for (let slot = 1; slot <= 4; slot += 1) {
      if (!options.optimizableActiveSlots.has(slot) || options.fixedActiveSlots.has(slot)) continue;
      const otherHrids = new Set(current.abilityOrder.abilities.slice(1).filter((_entry, index) => index !== slot - 1).map((entry) => entry.hrid));
      for (const ability of activeAbilities) {
        if (otherHrids.has(ability.hrid)) continue;
        const abilities = [...current.abilityOrder.abilities];
        abilities[slot] = ability;
        candidates.push({ ...current, abilityOrder: withAbilities(current, abilities) });
      }
    }
    const reorderSlots = [...options.optimizableActiveSlots].filter((slot) => !options.fixedActiveSlots.has(slot)).sort();
    if (reorderSlots.length > 1) {
      const selectedAbilities = reorderSlots.map((slot) => current.abilityOrder.abilities[slot]);
      for (const ordered of permutations(selectedAbilities)) {
        const abilities = [...current.abilityOrder.abilities];
        reorderSlots.forEach((slot, index) => { abilities[slot] = ordered[index]; });
        candidates.push({ ...current, abilityOrder: withAbilities(current, abilities) });
      }
    }
    const seen = new Set();
    return candidates.filter((candidate) => {
      const key = planKey(candidate.equipmentCandidate, candidate.abilityOrder);
      if (key === current.key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const interactionCandidates = (current, evaluatedSingles) => {
    if (interactionPairBudget <= 0) return [];
    const groups = new Map();
    for (const candidate of evaluatedSingles) {
      const dimensions = changedDimensions(current, candidate);
      if (dimensions.length !== 1) continue;
      const group = groups.get(dimensions[0]) || [];
      group.push(candidate);
      groups.set(dimensions[0], group);
    }
    for (const group of groups.values()) {
      group.sort((left, right) => compareBalancedResults(left.result, right.result, balanceOptions));
      group.splice(interactionPerDimension);
    }
    const entries = [...groups.entries()];
    const pairs = [];
    const seen = new Set();
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        for (const left of entries[leftIndex][1]) {
          for (const right of entries[rightIndex][1]) {
            const combined = combineSingleChanges(current, left, right);
            if (!combined) continue;
            const key = planKey(combined.equipmentCandidate, combined.abilityOrder);
            if (key === current.key || seen.has(key)) continue;
            seen.add(key);
            pairs.push(combined);
            if (pairs.length >= interactionPairBudget) return pairs;
          }
        }
      }
    }
    return pairs;
  };

  const shouldOpenSurvivalSearch = (result) => {
    const trials = Math.max(1, finiteNumber(result?.trials, 0));
    const deaths = Math.max(0, finiteNumber(result?.failedByDeath, 0));
    const timeouts = Math.max(0, finiteNumber(result?.failedByTimeout, 0));
    return deaths / trials >= finiteNumber(options.survivalDeathRateThreshold, 0.2) || (deaths > timeouts && deaths > 0);
  };

  const evaluatedStarts = [];
  for (const start of options.starts || [options.start]) {
    const isCounterStart = options.auditStage === "counter";
    evaluatedStarts.push(await evaluate(start, {
      reason: `${isCounterStart ? "反制搜索起点" : "对应预设起点"}：${start.sourcePreset || "未命名预设"}`,
      candidateKind: isCounterStart ? "counter_start" : "preset_start",
    }));
  }
  let beam = selectBalancedPlans(await refineAmbiguous(evaluatedStarts), balanceOptions);
  while (rounds < maxRounds) {
    rounds += 1;
    const before = beam.map((plan) => plan.key).sort().join("||");
    const candidates = [...beam];
    for (const current of beam) {
      const survivalMode = shouldOpenSurvivalSearch(current.result);
      const pools = survivalMode ? {
        equipmentPools: options.survivalEquipmentPools || options.equipmentPools,
        auraAbilities: options.survivalAuraAbilities || options.auraAbilities,
        activeAbilities: options.survivalActiveAbilities || options.activeAbilities,
      } : {};
      const singles = [];
      const survivalBefore = evaluations;
      for (const candidate of neighbors(current, pools)) {
        const dimensions = changedDimensions(current, candidate);
        const labels = dimensions.map(dimensionLabel).join(" + ") || "候选方案";
        const evaluated = await evaluate(candidate, {
          reason: `${survivalMode ? "死亡占优，生存扩展" : "定向单项替换"}：${labels}`,
          candidateKind: survivalMode ? "survival_candidate" : "single_change",
          changedDimensions: dimensions,
        });
        singles.push(evaluated);
        candidates.push(evaluated);
      }
      if (survivalMode) survivalEvaluations += evaluations - survivalBefore;
      const interactionBefore = evaluations;
      for (const candidate of interactionCandidates(current, singles)) {
        const dimensions = changedDimensions(current, candidate);
        candidates.push(await evaluate(candidate, {
          reason: `双项联动实测：${dimensions.map(dimensionLabel).join(" + ")}`,
          candidateKind: "interaction_pair",
          changedDimensions: dimensions,
        }));
      }
      interactionEvaluations += evaluations - interactionBefore;
    }
    beam = selectBalancedPlans(await refineAmbiguous(candidates), balanceOptions);
    const after = beam.map((plan) => plan.key).sort().join("||");
    options.onProgress?.({ evaluations, roomLevel: options.roomLevel, balancedFrontierSize: beam.length, balancedRound: rounds, balancedMaxRounds: maxRounds });
    if (after === before) break;
  }
  beam.sort((left, right) => compareBalancedResults(left.result, right.result, balanceOptions));
  const best = beam[0];
  return {
    bestPlan: { ...best, coordinateRounds: rounds },
    frontier: beam.map((plan) => ({ key: plan.key, metrics: balancedMetrics(plan.result, balanceOptions) })),
    retainedPlans: beam,
    evaluations,
    interactionEvaluations,
    survivalEvaluations,
    adaptiveEvaluations,
    cache,
  };
}

export async function optimizeDirection(options) {
  const auditRecorder = options.auditRecorder || (options.onAuditRecord
    ? createSimulationAuditRecorder({ onRecord: options.onAuditRecord })
    : null);
  const optimizableEquipmentTypes = new Set(options.optimizableEquipmentTypes || COMBAT_EQUIPMENT_TYPES);
  const optimizableActiveSlots = new Set(options.optimizableActiveSlots || [1, 2, 3, 4]);
  const fixedActiveSlots = options.fixedActiveSlots || new Map();
  const starts = buildPresetStarts(options.character, options.catalog, options.searchSpace, {
    optimizableEquipmentTypes,
    fixedActiveSlots,
    fixedAura: options.fixedAura,
    direction: options.direction,
  });
  if (starts.length === 0) throw new Error(`${options.direction.styleZh}${options.direction.damageTypeZh}方向没有可用起点`);
  const cache = new Map();
  const result = await coordinateOptimize({
    ...options,
    start: starts[0],
    starts,
    equipmentPools: options.searchSpace.equipmentPools,
    auraAbilities: options.searchSpace.auraAbilities,
    activeAbilities: options.searchSpace.activeAbilities,
    survivalEquipmentPools: options.searchSpace.counterEquipmentPools || options.searchSpace.equipmentPools,
    survivalAuraAbilities: options.searchSpace.survivalAuraAbilities || options.searchSpace.counterAuraAbilities || options.searchSpace.auraAbilities,
    survivalActiveAbilities: options.searchSpace.survivalActiveAbilities || options.searchSpace.counterActiveAbilities || options.searchSpace.activeAbilities,
    optimizableEquipmentTypes,
    optimizeAura: options.optimizeAura !== false,
    optimizableActiveSlots,
    fixedActiveSlots,
    cache,
    auditRecorder,
  });
  return { ...result, starts: starts.length, startPresets: starts.map((entry) => entry.sourcePreset) };
}

export function compareHighestSearchCandidates(left, right, options = {}) {
  if (Boolean(left?.highest?.targetMet) !== Boolean(right?.highest?.targetMet)) {
    return left?.highest?.targetMet ? -1 : 1;
  }
  const levelDifference = finiteNumber(right?.highest?.level, 0) - finiteNumber(left?.highest?.level, 0);
  if (levelDifference) return levelDifference;
  return compareBalancedResults(left?.highest?.result, right?.highest?.result, options);
}

export function chooseVerifiedHighestCandidate(current, challenger, options = {}) {
  return [current, challenger]
    .filter((entry) => entry?.plan && entry?.highest)
    .sort((left, right) => compareHighestSearchCandidates(left, right, options))[0] || current;
}

async function evaluateSinglePlan(options) {
  checkAbort(options.signal);
  const request = {
    ...options.plan.simulationInput,
    monsterHrid: options.monsterHrid,
    roomLevel: options.roomLevel,
    roomDurationSeconds: 120,
    trials: options.trials,
    seed: options.seed,
  };
  const run = options.auditRecorder
    ? await options.auditRecorder.simulate(options.engine, request, {
      stage: options.auditStage || "level",
      reason: options.reason || "最高等级探测",
      candidateKind: "level_probe",
      direction: options.direction || null,
      sourcePreset: options.plan.sourcePreset || null,
      expectedRetest: Boolean(options.expectedRetest),
    })
    : await options.engine.simulateRoom(request);
  return normalizedResult(run);
}

export async function findHighestRoomLevel(options) {
  const targetRate = Math.max(0.01, Math.min(0.99, finiteNumber(options.targetRate, 0.7)));
  const minimumLevel = Math.max(1, Math.floor(finiteNumber(options.minLevel, 1)));
  const initialUpperBound = Math.max(minimumLevel, Math.floor(finiteNumber(options.maxLevel, 300)));
  const hardMaxLevel = Math.max(initialUpperBound, Math.floor(finiteNumber(options.hardMaxLevel, 5000)));
  const trials = Math.max(1, Math.floor(finiteNumber(options.trials, 100)));
  const boundaryReviewLevels = Math.max(1, Math.floor(finiteNumber(options.boundaryReviewLevels, 3)));
  const feasibilityOptions = {
    targetRate,
    confidenceZ: options.confidenceZ || 1.2815515655446004,
    feasibilityMode: options.feasibilityMode || "observed",
  };
  const passes = (result) => meetsTargetRate(result, feasibilityOptions);
  const probeCache = new Map();
  const probe = async (level, reason = "最高等级探测") => {
    if (!probeCache.has(level)) {
      const result = await evaluateSinglePlan({
        ...options,
        roomLevel: level,
        trials,
        seed: options.seedBase || 20260819,
        reason,
      });
      probeCache.set(level, result);
      options.onProbe?.({ level, result });
    }
    return probeCache.get(level);
  };

  let best = { level: 0, result: null };
  let failedUpperBound = null;
  const initialResult = await probe(initialUpperBound, "最高等级初始探测");
  if (passes(initialResult)) {
    best = { level: initialUpperBound, result: initialResult };
    while (best.level < hardMaxLevel) {
      const nextLevel = Math.min(hardMaxLevel, Math.max(best.level + 1, best.level * 2));
      const nextResult = await probe(nextLevel, "通关后向上扩展等级");
      if (!passes(nextResult)) {
        failedUpperBound = nextLevel;
        break;
      }
      best = { level: nextLevel, result: nextResult };
    }
  } else {
    failedUpperBound = initialUpperBound;
  }

  let low = best.level > 0 ? best.level + 1 : minimumLevel;
  let high = (failedUpperBound ?? hardMaxLevel) - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const result = await probe(middle, "最高等级二分探测");
    if (passes(result)) {
      best = { level: middle, result };
      low = middle + 1;
    } else {
      failedUpperBound = Math.min(failedUpperBound ?? middle, middle);
      high = middle - 1;
    }
  }
  if (best.level === 0) {
    const minimumResult = await probe(minimumLevel, "最低等级可行性复核");
    best = { level: minimumLevel, result: minimumResult };
    if (!passes(minimumResult)) failedUpperBound = minimumLevel;
  }

  // A finite-trial sample is not guaranteed to be monotonic across adjacent
  // levels. Review a small band above the binary boundary so one unlucky level
  // cannot discard an immediately higher passing observation.
  const reviewStart = Math.min(hardMaxLevel + 1, best.level + 1);
  const reviewStop = Math.min(
    hardMaxLevel,
    Math.max(best.level, finiteNumber(failedUpperBound, best.level) + boundaryReviewLevels),
  );
  const reviewedLevels = [];
  for (let level = reviewStart; level <= reviewStop; level += 1) {
    const result = await probe(level, "等级边界相邻复核");
    reviewedLevels.push(level);
    if (passes(result) && level > best.level) best = { level, result };
  }
  const testedLevels = [...probeCache.keys()].sort((left, right) => left - right);
  const nonMonotonic = testedLevels.some((failedLevel) => (
    failedLevel < best.level && !passes(probeCache.get(failedLevel))
  ));
  const firstTestedFailureAbove = testedLevels.find((level) => level > best.level && !passes(probeCache.get(level)));
  const firstFailedLevel = !passes(best.result)
    ? best.level
    : best.level < hardMaxLevel ? (firstTestedFailureAbove || best.level + 1) : null;
  return {
    ...best,
    targetMet: passes(best.result),
    feasibilityMode: feasibilityOptions.feasibilityMode,
    robustMetrics: balancedMetrics(best.result, feasibilityOptions),
    capped: best.level === hardMaxLevel && passes(best.result),
    testedUpperBound: testedLevels.at(-1) || hardMaxLevel,
    firstFailedLevel,
    initialUpperBound,
    probeCount: probeCache.size,
    boundaryReview: {
      radius: boundaryReviewLevels,
      reviewedLevels,
      testedLevels,
      nonMonotonic,
    },
  };
}

export function diagnoseSimulation(result) {
  const failures = Math.max(1, finiteNumber(result?.failedByDeath, 0) + finiteNumber(result?.failedByTimeout, 0));
  const deathShare = finiteNumber(result?.failedByDeath, 0) / failures;
  const timeoutShare = finiteNumber(result?.failedByTimeout, 0) / failures;
  const hitRate = result?.attackSummary?.total > 0 ? result.attackSummary.hitRate : null;
  const issues = [];
  if (hitRate != null && hitRate < 0.75) issues.push({ type: "accuracy", severity: 1 - hitRate, text: `命中率仅 ${(hitRate * 100).toFixed(1)}%，优先补对应流派命中。` });
  if (result?.debug?.ranOutOfMana) issues.push({ type: "mana", severity: 0.8, text: "模拟中出现法力耗尽，技能循环或法力恢复是瓶颈。" });
  if (deathShare > timeoutShare) issues.push({ type: "survivability", severity: deathShare, text: `失败中 ${(deathShare * 100).toFixed(1)}% 为角色死亡，应补对应闪避、抗性、生命或治疗/控制。` });
  else if (timeoutShare > 0) issues.push({ type: "damage", severity: timeoutShare, text: `失败中 ${(timeoutShare * 100).toFixed(1)}% 为超时，主要短板是有效输出。` });
  if (issues.length === 0) issues.push({ type: "stable", severity: 0, text: "未发现明显的命中、续航或超时瓶颈。" });
  return issues.sort((left, right) => right.severity - left.severity);
}

export async function optimizeMonster(options) {
  const { character, catalog, engine, monsterHrid, signal, onProgress = () => {} } = options;
  const auditRecorder = options.auditRecorder || (options.onAuditRecord
    ? createSimulationAuditRecorder({ onRecord: options.onAuditRecord })
    : null);
  const requestedReferenceLevel = Math.max(20, Math.floor(finiteNumber(options.referenceMonsterLevel ?? options.referenceLevel, resolveReferenceMonsterLevel(character))));
  const trialsPerPlan = Math.max(1, Math.floor(finiteNumber(options.trialsPerPlan, 100)));
  const balanceOptions = {
    targetRate: options.targetRate || 0.7,
    confidenceZ: options.confidenceZ || 1.2815515655446004,
    beamWidth: options.beamWidth,
    retentionRatio: options.retentionRatio ?? 0.1,
    minimumRetainedPlans: options.minimumRetainedPlans ?? 10,
    maximumRetainedPlans: options.maximumRetainedPlans ?? 50,
  };
  const phaseTrace = [];
  let previousPhaseSignature = "";
  const emitProgress = (progress) => {
    const directionKey = progress.direction ? `${progress.direction.styleHrid || ""}|${progress.direction.damageTypeHrid || ""}` : "";
    const signature = `${progress.phase || "unknown"}|${directionKey}|${progress.finalistIndex || 0}`;
    if (signature !== previousPhaseSignature) {
      previousPhaseSignature = signature;
      phaseTrace.push({
        sequence: phaseTrace.length + 1,
        phase: progress.phase || "unknown",
        direction: directionKey || null,
        finalistIndex: progress.finalistIndex || null,
        finalistCount: progress.finalistCount || null,
        roomLevel: progress.roomLevel || null,
        level: progress.level || null,
        phaseEvaluations: progress.phaseEvaluations || progress.evaluations || 0,
      });
    }
    onProgress(progress);
  };
  const monster = catalog.combatMonsterDetailMap?.[monsterHrid];
  const fullProfile = classifyMonster(monster, { roomLevel: requestedReferenceLevel, playerCombatDetails: character.combatDetails });
  const intelligence = character.characterSkills.find((entry) => entry.skillHrid === "/skills/intelligence")?.level || 1;
  const slotRequirements = catalog.abilitySlotsLevelRequirementList || [0, 1, 1, 20, 50, 90];
  const slots = [1, 2, 3, 4, 5].filter((slot) => intelligence >= finiteNumber(slotRequirements[slot], 0)).length;
  if (slots < 5) throw new Error(`${fullProfile.name}：当前智力等级只解锁了 ${slots} 个技能槽，无法生成“1 特殊技能 + 4 普通主动技能”的完整方案`);

  let selectionLevel = requestedReferenceLevel;
  let directionResults = [];
  let offenseEvaluations = 0;
  let offenseInteractionEvaluations = 0;
  let offenseSurvivalEvaluations = 0;
  let offenseAdaptiveEvaluations = 0;
  while (selectionLevel >= 20) {
    directionResults = [];
    for (const direction of fullProfile.selectedDirections) {
      const profile = directionProfile(classifyMonster(monster, { roomLevel: selectionLevel, playerCombatDetails: character.combatDetails }), direction);
      const searchSpace = buildSearchSpace(character, catalog, profile, {
        ...(options.searchSpaceOptions || {}),
        selectedEquipmentTypes: options.optimizableEquipmentTypes,
      });
      const fixedRule = resolveFixedActiveSlots(searchSpace, direction, monsterHrid, options.fixedAbilityRules);
      const fixedActiveSlots = fixedRule.activeSlots;
      const result = await optimizeDirection({
        character,
        catalog,
        engine,
        monsterHrid,
        roomLevel: selectionLevel,
        trials: trialsPerPlan,
        seed: (options.seedBase || 20260819) + selectionLevel,
        signal,
        direction,
        profile,
        searchSpace,
        optimizableEquipmentTypes: options.optimizableEquipmentTypes,
        optimizeAura: options.optimizeAura,
        optimizableActiveSlots: options.optimizableActiveSlots,
        fixedActiveSlots,
        fixedAura: fixedRule.aura,
        auditRecorder,
        auditStage: "offense",
        ...balanceOptions,
        onProgress: (progress) => emitProgress({ ...progress, phase: "offense", monsterHrid, direction, phaseEvaluations: offenseEvaluations + progress.evaluations }),
      });
      offenseEvaluations += result.evaluations;
      offenseInteractionEvaluations += result.interactionEvaluations;
      offenseSurvivalEvaluations += result.survivalEvaluations;
      offenseAdaptiveEvaluations += result.adaptiveEvaluations;
      directionResults.push({ direction, profile, searchSpace, ...result });
    }
    const bestAtLevel = directionResults.map((entry) => entry.bestPlan).filter(Boolean)
      .sort((left, right) => compareBalancedResults(left.result, right.result, balanceOptions))[0];
    if (bestAtLevel?.result?.successes > 0 || selectionLevel === 20) break;
    selectionLevel = Math.max(20, selectionLevel - 20);
  }

  const finalistMap = new Map();
  for (const directionResult of directionResults) {
    for (const plan of directionResult.retainedPlans || [directionResult.bestPlan]) {
      if (plan && !finalistMap.has(plan.key)) finalistMap.set(plan.key, { directionResult, plan });
    }
  }
  const finalistSearches = [];
  let highestLevelEvaluations = 0;
  let finalistIndex = 0;
  for (const finalist of finalistMap.values()) {
    finalistIndex += 1;
    const highest = await findHighestRoomLevel({
      engine,
      plan: finalist.plan,
      monsterHrid,
      minLevel: options.minMonsterLevel || options.minLevel || 20,
      maxLevel: options.maxMonsterLevel || options.maxLevel || Math.max(100, requestedReferenceLevel * 2),
      hardMaxLevel: options.hardMaxLevel || 5000,
      targetRate: options.targetRate || 0.7,
      confidenceZ: balanceOptions.confidenceZ,
      feasibilityMode: options.feasibilityMode || "observed",
      trials: trialsPerPlan,
      signal,
      seedBase: (options.seedBase || 20260819) + 300001,
      auditRecorder,
      auditStage: "level",
      direction: finalist.directionResult.direction,
      onProbe: (probe) => emitProgress({
        phase: "level",
        monsterHrid,
        finalistIndex,
        finalistCount: finalistMap.size,
        ...probe,
      }),
    });
    highestLevelEvaluations += finiteNumber(highest?.probeCount, 0);
    finalistSearches.push({ ...finalist, highest });
  }
  finalistSearches.sort((left, right) => compareHighestSearchCandidates(left, right, balanceOptions));
  const winningFinalist = finalistSearches[0];
  const winningDirection = winningFinalist?.directionResult;
  if (!winningFinalist?.plan || !winningDirection) throw new Error(`${fullProfile.name} 没有生成可运行的预设起点`);
  let bestPlan = winningFinalist.plan;
  let highest = winningFinalist.highest;

  let counterEvaluations = 0;
  let counterInteractionEvaluations = 0;
  let counterSurvivalEvaluations = 0;
  let counterAdaptiveEvaluations = 0;
  if (highest.firstFailedLevel && highest.firstFailedLevel <= (options.hardMaxLevel || 5000)) {
    const counterRule = resolveFixedActiveSlots(winningDirection.searchSpace, winningDirection.direction, monsterHrid, options.fixedAbilityRules);
    const counter = await coordinateOptimize({
      character,
      catalog,
      engine,
      monsterHrid,
      roomLevel: highest.firstFailedLevel,
      trials: trialsPerPlan,
      seed: (options.seedBase || 20260819) + 700001,
      signal,
      start: bestPlan,
      equipmentPools: winningDirection.searchSpace.counterEquipmentPools,
      auraAbilities: winningDirection.searchSpace.counterAuraAbilities,
      activeAbilities: winningDirection.searchSpace.counterActiveAbilities,
      optimizableEquipmentTypes: options.optimizableEquipmentTypes,
      optimizeAura: options.optimizeAura,
      optimizableActiveSlots: options.optimizableActiveSlots,
      fixedActiveSlots: counterRule.activeSlots,
      fixedAura: counterRule.aura,
      auditRecorder,
      auditStage: "counter",
      direction: winningDirection.direction,
      ...balanceOptions,
      onProgress: (progress) => emitProgress({ ...progress, phase: "counter", monsterHrid, direction: winningDirection.direction, phaseEvaluations: progress.evaluations }),
    });
    counterEvaluations = counter.evaluations;
    counterInteractionEvaluations = counter.interactionEvaluations;
    counterSurvivalEvaluations = counter.survivalEvaluations;
    counterAdaptiveEvaluations = counter.adaptiveEvaluations;
    if (meetsTargetRate(counter.bestPlan.result, {
      ...balanceOptions,
      feasibilityMode: options.feasibilityMode || "observed",
    })) {
      const counterHighest = await findHighestRoomLevel({
        engine,
        plan: counter.bestPlan,
        monsterHrid,
        minLevel: highest.firstFailedLevel,
        maxLevel: Math.max(highest.firstFailedLevel, options.maxMonsterLevel || highest.firstFailedLevel),
        hardMaxLevel: options.hardMaxLevel || 5000,
        targetRate: options.targetRate || 0.7,
        confidenceZ: balanceOptions.confidenceZ,
        feasibilityMode: options.feasibilityMode || "observed",
        trials: trialsPerPlan,
        signal,
        seedBase: (options.seedBase || 20260819) + 900001,
        auditRecorder,
        auditStage: "level",
        direction: winningDirection.direction,
        onProbe: (probe) => emitProgress({ ...probe, phase: "level", monsterHrid }),
      });
      highestLevelEvaluations += finiteNumber(counterHighest?.probeCount, 0);
      const verified = chooseVerifiedHighestCandidate(
        { plan: bestPlan, highest },
        { plan: counter.bestPlan, highest: counterHighest },
        balanceOptions,
      );
      bestPlan = verified.plan;
      highest = verified.highest;
    }
  }

  const recommendations = await evaluateUpgradeSuggestions({
    engine,
    plan: bestPlan,
    profile: winningDirection.profile,
    monsterHrid,
    roomLevel: highest.level,
    trials: trialsPerPlan,
    maxCandidates: options.recommendationCandidates || 8,
    keep: 3,
    seed: (options.seedBase || 20260819) + 1100001 + highest.level,
    signal,
    auditRecorder,
    auditStage: "recommendation",
    direction: winningDirection.direction,
    onProgress: (progress) => emitProgress({ ...progress, phase: "recommendation", monsterHrid }),
  });

  const recommendationEvaluations = finiteNumber(recommendations?.evaluations, 0);
  const totalEvaluations = offenseEvaluations + counterEvaluations + highestLevelEvaluations + recommendationEvaluations;
  return {
    monsterHrid,
    name: fullProfile.name,
    profile: fullProfile,
    chosenDirection: winningDirection.direction,
    requestedReferenceMonsterLevel: requestedReferenceLevel,
    referenceMonsterLevel: selectionLevel,
    referenceFloorRange: monsterLevelToFloorRange(selectionLevel),
    referenceLevel: selectionLevel,
    searchDiagnostics: {
      directionResults: directionResults.map((entry) => ({
        direction: entry.direction,
        startingPresets: entry.starts,
        startPresetNames: entry.startPresets,
        evaluations: entry.evaluations,
        interactionEvaluations: entry.interactionEvaluations,
        survivalEvaluations: entry.survivalEvaluations,
        adaptiveEvaluations: entry.adaptiveEvaluations,
        retainedPlans: entry.retainedPlans?.length || 0,
        retainedEquipmentVariants: entry.searchSpace.diagnostics.retainedEquipmentVariants,
        retainedCounterEquipmentVariants: entry.searchSpace.diagnostics.retainedCounterEquipmentVariants,
        targetedDefenseStats: entry.searchSpace.diagnostics.targetedDefenseStats,
        retainedAuraAbilities: entry.searchSpace.diagnostics.retainedAuraAbilities,
        retainedActiveAbilities: entry.searchSpace.diagnostics.retainedActiveAbilities,
      })),
      counterEvaluations,
      interactionEvaluations: offenseInteractionEvaluations + counterInteractionEvaluations,
      survivalEvaluations: offenseSurvivalEvaluations + counterSurvivalEvaluations,
      adaptiveEvaluations: offenseAdaptiveEvaluations + counterAdaptiveEvaluations,
      offenseInteractionEvaluations,
      offenseSurvivalEvaluations,
      offenseAdaptiveEvaluations,
      counterInteractionEvaluations,
      counterSurvivalEvaluations,
      counterAdaptiveEvaluations,
      offenseEvaluations,
      highestLevelEvaluations,
      recommendationEvaluations,
      recommendationCandidates: finiteNumber(recommendations?.candidateCount, 0),
      totalEvaluations,
      phaseTrace,
      highestLevelFinalists: finalistSearches.length,
      finalistResults: finalistSearches.map((entry) => ({
        planKey: entry.plan.key,
        direction: entry.directionResult.direction,
        highestMonsterLevel: entry.highest.level,
        targetMet: entry.highest.targetMet,
        finalMetrics: entry.highest.robustMetrics,
        probes: entry.highest.probeCount,
        boundaryReview: entry.highest.boundaryReview,
      })),
    },
    candidateCounts: {
      simulatedPlans: totalEvaluations,
      offensePlans: offenseEvaluations,
      counterPlans: counterEvaluations,
      interactionPlans: offenseInteractionEvaluations + counterInteractionEvaluations,
      survivalPlans: offenseSurvivalEvaluations + counterSurvivalEvaluations,
      adaptiveBatches: offenseAdaptiveEvaluations + counterAdaptiveEvaluations,
      highestLevelProbes: highestLevelEvaluations,
      recommendationSimulations: recommendationEvaluations,
      recommendationCandidates: finiteNumber(recommendations?.candidateCount, 0),
      startingPresets: directionResults.reduce((sum, entry) => sum + entry.starts, 0),
    },
    simulationAuditSummary: auditRecorder?.summary({ monsterHrid }) || null,
    trialsPerPlan,
    bestPlan,
    highestMonsterLevel: highest.level,
    estimatedHighestFloorRange: monsterLevelToFloorRange(highest.level),
    highestLevel: highest.level,
    targetMet: highest.targetMet,
    searchCapped: highest.capped,
    testedUpperBound: highest.testedUpperBound,
    initialUpperBound: highest.initialUpperBound,
    floorScaling: {
      rule: "怪物等级等于房间等级；第1层房间等级为20-40，此后每层的等级区间整体增加20。边界等级同时是前一层上限和后一层下限",
      source: "游戏迷宫说明",
    },
    finalResult: highest.result,
    finalMetrics: highest.robustMetrics,
    searchPolicy: {
      method: "帕累托前沿 + 每方向动态候选束搜索",
      retentionRatio: balanceOptions.retentionRatio,
      minimumRetainedPlans: balanceOptions.minimumRetainedPlans,
      maximumRetainedPlans: balanceOptions.maximumRetainedPlans,
      confidence: "90% 单侧 Wilson 下界",
      feasibilityMode: highest.feasibilityMode,
      targetRate: options.targetRate || 0.7,
      finalObjective: "达到目标胜率的最高怪物等级",
    },
    issues: diagnoseSimulation(highest.result),
    recommendations,
  };
}
