import { finiteNumber } from "./data-model.js";
import { chineseName } from "./localization.js";
import { mergeSimulationRuns } from "./statistics.js";

const GEAR_PRIORITY = [
  "/equipment_types/two_hand",
  "/equipment_types/main_hand",
  "/equipment_types/off_hand",
  "/equipment_types/head",
  "/equipment_types/body",
  "/equipment_types/legs",
  "/equipment_types/hands",
  "/equipment_types/feet",
  "/equipment_types/back",
  "/equipment_types/neck",
  "/equipment_types/earrings",
  "/equipment_types/ring",
  "/equipment_types/pouch",
  "/equipment_types/charm",
];

const GEAR_NAMES = {
  "/equipment_types/two_hand": "双手武器",
  "/equipment_types/main_hand": "主手",
  "/equipment_types/off_hand": "副手",
  "/equipment_types/head": "头部",
  "/equipment_types/body": "上衣",
  "/equipment_types/legs": "下装",
  "/equipment_types/hands": "手套",
  "/equipment_types/feet": "鞋子",
  "/equipment_types/back": "背部",
  "/equipment_types/neck": "项链",
  "/equipment_types/earrings": "耳饰",
  "/equipment_types/ring": "戒指",
  "/equipment_types/pouch": "口袋",
  "/equipment_types/charm": "护符",
};

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function styleLevelFields(profile) {
  const styles = profile?.selectedStyleHrids || new Set();
  const fields = [];
  if (["/combat_styles/stab", "/combat_styles/slash", "/combat_styles/smash"].some((style) => styles.has(style))) fields.push(["meleeLevel", "近战等级"]);
  if (styles.has("/combat_styles/ranged")) fields.push(["rangedLevel", "远程等级"]);
  if (styles.has("/combat_styles/magic")) fields.push(["magicLevel", "魔法等级"]);
  return fields;
}

export function buildUpgradeCandidates(plan, profile, options = {}) {
  const maxCandidates = Math.max(1, Math.floor(finiteNumber(options.maxCandidates, 8)));
  const baseInput = plan.simulationInput;
  const equipmentCandidates = [];
  const abilityCandidates = [];
  const skillCandidates = [];
  const equipment = plan.equipmentCandidate?.equipment || {};

  for (const slot of GEAR_PRIORITY) {
    const item = equipment[slot];
    if (!item || !baseInput.playerDto.equipment?.[slot]) continue;
    const input = clone(baseInput);
    const from = Math.max(0, Math.floor(finiteNumber(input.playerDto.equipment[slot].enhancementLevel, 0)));
    input.playerDto.equipment[slot].enhancementLevel = from + 1;
    equipmentCandidates.push({
      type: "equipment",
      key: `equipment:${slot}`,
      label: `${GEAR_NAMES[slot] || slot}：${chineseName(item.hrid, item.name)} +${from} → +${from + 1}`,
      input,
    });
  }

  for (let index = 0; index < (baseInput.playerDto.abilities || []).length; index += 1) {
    const ability = baseInput.playerDto.abilities[index];
    if (!ability) continue;
    const input = clone(baseInput);
    input.playerDto.abilities[index].level += 1;
    const display = plan.abilityOrder?.abilities?.[index];
    abilityCandidates.push({
      type: "ability",
      key: `ability:${ability.hrid}`,
      label: `${chineseName(ability.hrid, display?.name)} 等级 ${ability.level} → 等级 ${ability.level + 1}`,
      input,
    });
  }

  const skillFields = [
    ["attackLevel", "攻击等级"],
    ...styleLevelFields(profile),
    ["defenseLevel", "防御等级"],
    ["staminaLevel", "耐力等级"],
    ["intelligenceLevel", "智力等级"],
  ];
  const seenFields = new Set();
  for (const [field, label] of skillFields) {
    if (seenFields.has(field)) continue;
    seenFields.add(field);
    const input = clone(baseInput);
    const from = Math.max(1, Math.floor(finiteNumber(input.playerDto[field], 1)));
    input.playerDto[field] = from + 1;
    skillCandidates.push({
      type: "skill",
      key: `skill:${field}`,
      label: `${label} ${from} → ${from + 1}`,
      input,
    });
  }
  // A fully equipped player often has more equipment entries than the default
  // budget. Round-robin the three upgrade kinds so skills and abilities are
  // not silently excluded from the real-simulation comparison.
  const pools = [equipmentCandidates, abilityCandidates, skillCandidates];
  const candidates = [];
  let index = 0;
  while (candidates.length < maxCandidates && pools.some((pool) => index < pool.length)) {
    for (const pool of pools) {
      if (candidates.length >= maxCandidates) break;
      if (pool[index]) candidates.push(pool[index]);
    }
    index += 1;
  }
  return candidates;
}

async function simulate(engine, input, options, context = {}) {
  const request = {
    ...input,
    monsterHrid: options.monsterHrid,
    roomLevel: options.roomLevel,
    roomDurationSeconds: 120,
    trials: options.trials,
    seed: options.seed,
  };
  const run = options.auditRecorder
    ? await options.auditRecorder.simulate(engine, request, {
      stage: options.auditStage || "recommendation",
      direction: options.direction || null,
      sourcePreset: options.plan?.sourcePreset || null,
      ...context,
    })
    : await engine.simulateRoom(request);
  return mergeSimulationRuns([run]);
}

function improvementText(clearRateDelta, secondsDelta) {
  if (clearRateDelta >= 0.005) return `同怪物等级胜率约提升 ${(clearRateDelta * 100).toFixed(1)} 个百分点`;
  if (Number.isFinite(secondsDelta) && secondsDelta <= -0.05) return `平均每次通关约缩短 ${Math.abs(secondsDelta).toFixed(2)} 秒`;
  if (clearRateDelta < -0.005) return "本轮随机样本未显示正收益，暂不优先";
  return "当前怪物等级收益很小，优先级低于上方项目";
}

export async function evaluateUpgradeSuggestions(options) {
  const trials = Math.max(1, Math.floor(finiteNumber(options.trials, 24)));
  const seed = Math.floor(finiteNumber(options.seed, 20260819));
  const candidates = buildUpgradeCandidates(options.plan, options.profile, { maxCandidates: options.maxCandidates || 8 });
  const baseline = await simulate(options.engine, options.plan.simulationInput, { ...options, trials, seed }, {
    reason: "提升建议基准方案复测",
    candidateKind: "recommendation_baseline",
    expectedRetest: true,
  });
  let simulations = 1;
  const suggestions = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) throw new DOMException("模拟已取消", "AbortError");
    const result = await simulate(options.engine, candidate.input, { ...options, trials, seed }, {
      reason: `提升建议实测：${candidate.label}`,
      candidateKind: `recommendation_${candidate.type}`,
      changedDimensions: [candidate.key],
    });
    simulations += 1;
    const clearRateDelta = result.clearRate - baseline.clearRate;
    const secondsDelta = result.averageClearSeconds - baseline.averageClearSeconds;
    suggestions.push({
      type: candidate.type,
      key: candidate.key,
      label: candidate.label,
      clearRateDelta,
      secondsDelta,
      text: improvementText(clearRateDelta, secondsDelta),
      result,
    });
    options.onProgress?.({ completed: suggestions.length, total: candidates.length });
  }
  const selected = suggestions.sort((left, right) => right.clearRateDelta - left.clearRateDelta || left.secondsDelta - right.secondsDelta)
    .slice(0, Math.max(1, Math.floor(finiteNumber(options.keep, 3))));
  selected.evaluations = simulations;
  selected.candidateCount = candidates.length;
  return selected;
}
