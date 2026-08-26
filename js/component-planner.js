import { COMBAT_EQUIPMENT_TYPES, finiteNumber } from "./data-model.js";
import { classifyAbility, classifyEquipment } from "./classifier.js";
import { chineseName } from "./localization.js";
import { NEVER_SELECTABLE_ABILITY_HRIDS, normalizeFixedAbilityRules } from "./fixed-skill-options.js";

const MAIN_HAND = "/equipment_types/main_hand";
const OFF_HAND = "/equipment_types/off_hand";
const TWO_HAND = "/equipment_types/two_hand";
const HAND_TYPES = new Set([MAIN_HAND, OFF_HAND, TWO_HAND]);
const COMBAT_SKILLS = new Set([
  "/skills/attack", "/skills/melee", "/skills/ranged", "/skills/magic",
  "/skills/defense", "/skills/stamina", "/skills/intelligence",
]);
const EXCLUDED_ABILITIES = NEVER_SELECTABLE_ABILITY_HRIDS;
const UNIVERSAL_ACTIVES = new Set([
  "/abilities/toughness", "/abilities/elusiveness", "/abilities/precision",
]);
const PHYSICAL_COUNTER_ACTIVES = new Set([
  "/abilities/berserk", "/abilities/frenzy", "/abilities/vampirism",
]);
const MAGIC_ACTIVES = new Set([
  "/abilities/elemental_affinity", "/abilities/quick_aid",
]);
const COUNTER_ACTIVES = new Set([
  "/abilities/retribution", "/abilities/spike_shell",
]);
const CATEGORY_RESTRICTED_ACTIVES = new Set([
  ...PHYSICAL_COUNTER_ACTIVES,
  ...MAGIC_ACTIVES,
  ...COUNTER_ACTIVES,
]);
const COUNTER_BUFFS = new Set([
  "/buff_types/physical_thorns", "/buff_types/elemental_thorns", "/buff_types/retaliation",
]);

function directionCategory(direction, monsterHrid) {
  if (monsterHrid === "/monsters/mimic" || direction?.strategyId === "retaliation_thorns") return "mimic";
  return direction?.styleHrid === "/combat_styles/magic" ? "magic" : "physical";
}

function characterSkillLevels(character) {
  return new Map((character?.characterSkills || []).map((entry) => [entry.skillHrid, finiteNumber(entry.level, 1)]));
}

function requirementsMet(item, skillLevels) {
  return (item?.equipmentDetail?.levelRequirements || []).every((entry) => (
    finiteNumber(skillLevels.get(entry.skillHrid), 1) >= finiteNumber(entry.level, 0)
  ));
}

export function combatRequirementLevel(item) {
  const levels = (item?.equipmentDetail?.levelRequirements || [])
    .filter((entry) => COMBAT_SKILLS.has(entry?.skillHrid))
    .map((entry) => Math.max(0, Math.floor(finiteNumber(entry.level, 0))));
  return levels.length ? Math.max(...levels) : 0;
}

function enhancedStats(item, enhancementLevel, catalog) {
  const detail = item?.equipmentDetail || {};
  const multiplier = finiteNumber(catalog?.enhancementLevelTotalBonusMultiplierTable?.[enhancementLevel], 0);
  const keys = new Set([
    ...Object.keys(detail.combatStats || {}),
    ...Object.keys(detail.combatEnhancementBonuses || {}),
  ]);
  const result = {};
  for (const key of keys) {
    const base = Number(detail.combatStats?.[key]);
    const bonus = Number(detail.combatEnhancementBonuses?.[key]);
    if (!Number.isFinite(base) && !Number.isFinite(bonus)) continue;
    result[key] = finiteNumber(base, 0) + finiteNumber(bonus, 0) * multiplier;
  }
  return result;
}

function profileDirections(profile) {
  return Array.isArray(profile?.selectedDirections) && profile.selectedDirections.length
    ? profile.selectedDirections
    : [];
}

function matchesDirection(styles, damages, direction) {
  return (styles.size === 0 || styles.has(direction.styleHrid))
    && (damages.size === 0 || damages.has(direction.damageTypeHrid));
}

function equipmentOffenseMatches(classification, direction) {
  if (classification.isWeapon) {
    return classification.styles.has(direction.styleHrid)
      && classification.damageTypes.has(direction.damageTypeHrid);
  }
  const hasSpecific = classification.offensiveStyles.size > 0 || classification.offensiveDamageTypes.size > 0;
  return hasSpecific
    ? matchesDirection(classification.offensiveStyles, classification.offensiveDamageTypes, direction)
    : classification.genericOffense;
}

function mimicEquipmentMatches(classification, profile) {
  return profile?.specialStrategy?.id === "retaliation_thorns" && classification.counterDamage;
}

function targetStatKeys(profile) {
  return profile?.defenseTargets?.statKeys instanceof Set
    ? new Set(profile.defenseTargets.statKeys)
    : new Set(["maxHitpoints"]);
}

function equipmentEntry(owned, item, catalog, classification, stats) {
  return {
    hrid: owned.itemHrid,
    name: chineseName(owned.itemHrid, item.name || owned.itemHrid),
    type: item.equipmentDetail.type,
    enhancementLevel: Math.max(0, Math.floor(finiteNumber(owned.enhancementLevel, 0))),
    count: Math.max(1, Math.floor(finiteNumber(owned.count, 1))),
    classification,
    resolvedCombatStats: stats,
    combatRequirementLevel: combatRequirementLevel(item),
  };
}

function abilityOffenseMatches(classification, direction) {
  if (classification.hasDamage) return matchesDirection(classification.styles, classification.damageTypes, direction);
  if (!classification.offensiveSupport) return false;
  if (classification.supportDamageTypes.size) return classification.supportDamageTypes.has(direction.damageTypeHrid);
  if (classification.styles.size) return classification.styles.has(direction.styleHrid);
  return true;
}

function mimicAbilityMatches(classification, profile) {
  return profile?.specialStrategy?.id === "retaliation_thorns"
    && [...classification.buffTypes].some((type) => COUNTER_BUFFS.has(type));
}

function allowedActiveByRule(hrid, category) {
  if (UNIVERSAL_ACTIVES.has(hrid)) return true;
  if ((category === "physical" || category === "mimic") && PHYSICAL_COUNTER_ACTIVES.has(hrid)) return true;
  if (category === "magic" && MAGIC_ACTIVES.has(hrid)) return true;
  if (category === "mimic" && COUNTER_ACTIVES.has(hrid)) return true;
  return false;
}

function sortEntries(entries) {
  return entries.sort((left, right) => left.hrid.localeCompare(right.hrid)
    || finiteNumber(left.enhancementLevel, 0) - finiteNumber(right.enhancementLevel, 0));
}

export function buildTargetedComponentPool(character, catalog, profile, direction, options = {}) {
  const minimumEquipmentLevel = Math.max(0, Math.floor(finiteNumber(options.minimumEquipmentLevel, 80)));
  const selectedTypes = new Set(options.selectedEquipmentTypes || COMBAT_EQUIPMENT_TYPES);
  const skillLevels = characterSkillLevels(character);
  const targets = targetStatKeys(profile);
  const offenseByType = {};
  const defenseByType = {};
  const seen = new Set();

  for (const owned of character?.characterItems || []) {
    const item = catalog?.itemDetailMap?.[owned.itemHrid];
    const type = item?.equipmentDetail?.type;
    if (!item || !COMBAT_EQUIPMENT_TYPES.has(type) || !selectedTypes.has(type)) continue;
    if (combatRequirementLevel(item) < minimumEquipmentLevel || !requirementsMet(item, skillLevels)) continue;
    const key = `${owned.itemHrid}@${Math.max(0, Math.floor(finiteNumber(owned.enhancementLevel, 0)))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const classification = classifyEquipment(item);
    const stats = enhancedStats(item, Math.max(0, Math.floor(finiteNumber(owned.enhancementLevel, 0))), catalog);
    const entry = equipmentEntry(owned, item, catalog, classification, stats);
    const offense = equipmentOffenseMatches(classification, direction) || mimicEquipmentMatches(classification, profile);
    const defense = [...targets].some((stat) => finiteNumber(stats[stat], 0) > 0);
    if (offense) (offenseByType[type] ||= []).push(entry);
    if (defense) (defenseByType[type] ||= []).push(entry);
  }

  const equipmentPools = {};
  for (const type of selectedTypes) {
    const offense = offenseByType[type] || [];
    const defense = defenseByType[type] || [];
    const maximumDefenseStats = Object.fromEntries([...targets].map((stat) => [
      stat,
      Math.max(0, ...defense.map((entry) => finiteNumber(entry.resolvedCombatStats?.[stat], 0))),
    ]));
    const strongestDefense = defense.filter((entry) => [...targets].some((stat) => (
      maximumDefenseStats[stat] > 0
      && finiteNumber(entry.resolvedCombatStats?.[stat], 0) === maximumDefenseStats[stat]
    )));
    const unique = new Map([...offense, ...strongestDefense].map((entry) => [
      `${entry.hrid}@${entry.enhancementLevel}`,
      { ...entry, isTargetedDefense: !offense.some((candidate) => candidate.hrid === entry.hrid && candidate.enhancementLevel === entry.enhancementLevel) },
    ]));
    if (unique.size) equipmentPools[type] = sortEntries([...unique.values()]);
  }

  const learnedLevels = new Map((character?.characterAbilities || []).map((entry) => [
    entry.abilityHrid,
    Math.max(1, Math.floor(finiteNumber(entry.level, 1))),
  ]));
  const allAuras = [];
  const allActives = [];
  const auraAbilities = [];
  const activeAbilities = [];
  const category = directionCategory(direction, profile?.monsterHrid);
  for (const [mapHrid, ability] of Object.entries(catalog?.abilityDetailMap || {})) {
    const hrid = String(ability?.hrid || mapHrid || "");
    const level = learnedLevels.get(hrid);
    if (!level || EXCLUDED_ABILITIES.has(hrid)) continue;
    const classification = classifyAbility(ability);
    const entry = {
      hrid,
      name: chineseName(hrid, ability.name || hrid),
      level,
      learnedLevel: level,
      cooldownDuration: finiteNumber(ability.cooldownDuration, 0),
      classification,
    };
    if (classification.isAura) allAuras.push(entry);
    else allActives.push(entry);
    const offense = abilityOffenseMatches(classification, direction) || mimicAbilityMatches(classification, profile);
    if (classification.isAura) {
      if (offense || classification.defensive || classification.hasSurvival || classification.hasControl) auraAbilities.push(entry);
    } else if (allowedActiveByRule(hrid, category) || (offense && !CATEGORY_RESTRICTED_ACTIVES.has(hrid))) {
      activeAbilities.push(entry);
    }
  }
  [allAuras, allActives, auraAbilities, activeAbilities].forEach(sortEntries);

  return {
    equipmentPools,
    auraAbilities,
    activeAbilities,
    allAuraAbilities: allAuras,
    allActiveAbilities: allActives,
    diagnostics: {
      minimumEquipmentLevel,
      selectedEquipmentTypes: [...selectedTypes],
      targetDefenseStats: [...targets],
      retainedEquipmentVariants: Object.values(equipmentPools).reduce((sum, entries) => sum + entries.length, 0),
      retainedOffensiveEquipmentVariants: Object.values(offenseByType).reduce((sum, entries) => sum + entries.length, 0),
      retainedTargetedDefenseVariants: Object.values(equipmentPools).flat().filter((entry) => entry.isTargetedDefense).length,
      retainedAuraAbilities: auraAbilities.length,
      retainedActiveAbilities: activeAbilities.length,
      excludedAbilityHrids: [...EXCLUDED_ABILITIES],
    },
  };
}

function parseItemReference(reference) {
  if (reference && typeof reference === "object") {
    return { hrid: String(reference.itemHrid || reference.hrid || ""), enhancementLevel: Math.max(0, Math.floor(finiteNumber(reference.enhancementLevel, 0))) };
  }
  const parts = String(reference || "").split("::");
  const index = parts.findIndex((part) => part.startsWith("/items/"));
  return index < 0 ? null : { hrid: parts[index], enhancementLevel: Math.max(0, Math.floor(finiteNumber(parts[index + 1], 0))) };
}

function presetEquipment(loadout, catalog) {
  const equipment = {};
  for (const reference of Object.values(loadout?.wearableMap || {})) {
    const parsed = parseItemReference(reference);
    const item = catalog?.itemDetailMap?.[parsed?.hrid];
    const type = item?.equipmentDetail?.type;
    if (!parsed?.hrid || !COMBAT_EQUIPMENT_TYPES.has(type)) continue;
    equipment[type] = {
      hrid: parsed.hrid,
      name: chineseName(parsed.hrid, item.name || parsed.hrid),
      type,
      enhancementLevel: parsed.enhancementLevel,
      count: 1,
    };
  }
  if (equipment[TWO_HAND]) {
    delete equipment[MAIN_HAND];
    delete equipment[OFF_HAND];
  }
  return equipment;
}

function presetAbilities(loadout, pool) {
  const auraHrid = String(loadout?.abilityMap?.[1] || loadout?.abilityMap?.["1"] || "");
  const aura = pool.allAuraAbilities.find((entry) => entry.hrid === auraHrid);
  const actives = [2, 3, 4, 5].map((slot) => {
    const hrid = String(loadout?.abilityMap?.[slot] || loadout?.abilityMap?.[String(slot)] || "");
    return pool.allActiveAbilities.find((entry) => entry.hrid === hrid);
  });
  return aura && actives.every(Boolean) && new Set(actives.map((entry) => entry.hrid)).size === 4
    ? { aura, actives }
    : null;
}

function presetMatchesDirection(equipment, catalog, direction) {
  const weapon = equipment[TWO_HAND] || equipment[MAIN_HAND];
  const stats = catalog?.itemDetailMap?.[weapon?.hrid]?.equipmentDetail?.combatStats || {};
  return (stats.combatStyleHrids || []).includes(direction.styleHrid)
    && String(stats.damageType || "") === direction.damageTypeHrid;
}

export function buildPresetTemplates(character, catalog, pool, direction) {
  const templates = [];
  for (const loadout of Object.values(character?.characterLoadoutMap || {})) {
    if (loadout?.actionTypeHrid !== "/action_types/combat") continue;
    const equipment = presetEquipment(loadout, catalog);
    if (!presetMatchesDirection(equipment, catalog, direction)) continue;
    const abilities = presetAbilities(loadout, pool);
    if (!abilities) continue;
    templates.push({
      sourcePreset: String(loadout.name || `预设 ${loadout.id || ""}`),
      sourcePresetId: loadout.id || null,
      equipment,
      ...abilities,
    });
  }
  const seen = new Set();
  return templates.filter((template) => {
    const gear = Object.entries(template.equipment).sort(([left], [right]) => left.localeCompare(right))
      .map(([type, item]) => `${type}:${item.hrid}@${item.enhancementLevel}`).join("|");
    const key = `${gear}::${template.aura.hrid}::${template.actives.map((entry) => entry.hrid).sort().join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function combinations(entries, count) {
  if (count === 0) return [[]];
  if (count < 0 || entries.length < count) return [];
  const result = [];
  const visit = (start, chosen) => {
    if (chosen.length === count) {
      result.push(chosen);
      return;
    }
    for (let index = start; index <= entries.length - (count - chosen.length); index += 1) {
      visit(index + 1, [...chosen, entries[index]]);
    }
  };
  visit(0, []);
  return result;
}

function cartesianEquipment(base, types, pools, fallbackEquipment) {
  let current = [base];
  for (const type of types) {
    const choices = pools[type]?.length ? pools[type] : fallbackEquipment[type] ? [fallbackEquipment[type]] : [];
    if (!choices.length) return [];
    current = current.flatMap((equipment) => choices.map((choice) => ({ ...equipment, [type]: choice })));
  }
  return current;
}

function weaponStates(template, pools, selectedTypes) {
  const mainSelected = selectedTypes.has(MAIN_HAND);
  const offSelected = selectedTypes.has(OFF_HAND);
  const mainPool = pools[MAIN_HAND] || [];
  const offPool = pools[OFF_HAND] || [];
  const twoPool = pools[TWO_HAND] || [];
  if (mainSelected && offSelected) {
    const paired = mainPool.flatMap((main) => offPool.map((off) => ({ [MAIN_HAND]: main, [OFF_HAND]: off })));
    const twoHanded = twoPool.map((weapon) => ({ [TWO_HAND]: weapon }));
    const generated = [...paired, ...twoHanded];
    if (generated.length) return generated;
  } else if (mainSelected) {
    const fixedOff = template.equipment[OFF_HAND];
    if (fixedOff) {
      const generated = mainPool.map((main) => ({ [MAIN_HAND]: main, [OFF_HAND]: fixedOff }));
      if (generated.length) return generated;
    }
    return [];
  } else if (offSelected) {
    const fixedMain = template.equipment[MAIN_HAND];
    if (fixedMain) {
      const generated = offPool.map((off) => ({ [MAIN_HAND]: fixedMain, [OFF_HAND]: off }));
      if (generated.length) return generated;
    }
    return [];
  }
  if (template.equipment[TWO_HAND]) return [{ [TWO_HAND]: template.equipment[TWO_HAND] }];
  if (template.equipment[MAIN_HAND] && template.equipment[OFF_HAND]) {
    return [{ [MAIN_HAND]: template.equipment[MAIN_HAND], [OFF_HAND]: template.equipment[OFF_HAND] }];
  }
  return [];
}

function fixedPresence(pool, direction, monsterHrid, configuredRules) {
  const category = directionCategory(direction, monsterHrid);
  const rule = normalizeFixedAbilityRules(configuredRules)[category];
  const aura = rule.aura ? pool.allAuraAbilities.find((entry) => entry.hrid === rule.aura) : null;
  if (rule.aura && !aura) throw new Error(`固定特殊技能 ${rule.aura} 未学习或不存在`);
  const requiredActives = rule.requiredActives.map((hrid) => {
    const entry = pool.allActiveAbilities.find((ability) => ability.hrid === hrid);
    if (!entry) throw new Error(`固定主动技能 ${hrid} 未学习或不存在`);
    return entry;
  });
  const zeroCooldown = category === "magic" ? pool.allActiveAbilities.find((entry) => (
    finiteNumber(entry.cooldownDuration, -1) === 0
    && entry.classification?.styles?.has("/combat_styles/magic")
    && entry.classification?.damageTypes?.has(direction.damageTypeHrid)
  )) : null;
  if (category === "magic" && !zeroCooldown) throw new Error(`${direction.damageTypeZh || "对应元素"}方向缺少 0CD 主动技能`);
  return { category, aura, requiredActives, zeroCooldown };
}

function abilitySets(template, pool, fixed, options) {
  const auraChoices = fixed.aura ? [fixed.aura] : options.optimizeAura === false ? [template.aura] : pool.auraAbilities;
  if (!auraChoices.length) return [];
  if (options.optimizeActives === false) {
    const hrids = new Set(template.actives.map((entry) => entry.hrid));
    if (fixed.requiredActives.some((entry) => !hrids.has(entry.hrid))) return [];
    if (fixed.zeroCooldown && !hrids.has(fixed.zeroCooldown.hrid)) return [];
    const ordered = fixed.zeroCooldown
      ? [...template.actives.filter((entry) => entry.hrid !== fixed.zeroCooldown.hrid), fixed.zeroCooldown]
      : [...template.actives];
    return auraChoices.map((aura) => ({ aura, actives: ordered, zeroCooldownHrid: fixed.zeroCooldown?.hrid || null }));
  }
  const mandatory = new Map(fixed.requiredActives.map((entry) => [entry.hrid, entry]));
  if (fixed.zeroCooldown) mandatory.set(fixed.zeroCooldown.hrid, fixed.zeroCooldown);
  if (mandatory.size > 4) throw new Error("固定主动技能超过四个，无法生成方案");
  const candidates = new Map([...pool.activeAbilities, ...mandatory.values()].map((entry) => [entry.hrid, entry]));
  const optional = [...candidates.values()].filter((entry) => !mandatory.has(entry.hrid));
  const sets = combinations(optional, 4 - mandatory.size).map((chosen) => [...mandatory.values(), ...chosen]);
  return auraChoices.flatMap((aura) => sets.map((actives) => {
    const zero = fixed.zeroCooldown;
    const ordinary = actives.filter((entry) => entry.hrid !== zero?.hrid).sort((left, right) => left.hrid.localeCompare(right.hrid));
    return { aura, actives: zero ? [...ordinary, zero] : ordinary, zeroCooldownHrid: zero?.hrid || null };
  }));
}

export function unorderedPlanKey(plan) {
  const gear = Object.entries(plan?.equipmentCandidate?.equipment || {}).sort(([left], [right]) => left.localeCompare(right))
    .map(([type, item]) => `${type}:${item.hrid}@${item.enhancementLevel || 0}`).join("|");
  const aura = plan?.abilityOrder?.abilities?.[0]?.hrid || "";
  const actives = (plan?.abilityOrder?.abilities || []).slice(1).map((entry) => entry.hrid).sort().join(",");
  return `${gear}::${aura}::${actives}`;
}

export function orderedPlanKey(plan) {
  return `${unorderedPlanKey(plan)}::${(plan?.abilityOrder?.abilities || []).slice(1).map((entry) => entry.hrid).join(",")}`;
}

export function buildUniqueComponentPlans(templates, pool, direction, monsterHrid, options = {}) {
  const selectedTypes = new Set(options.selectedEquipmentTypes || []);
  const fixed = fixedPresence(pool, direction, monsterHrid, options.fixedAbilityRules);
  const all = [];
  for (const template of templates) {
    const fixedEquipment = Object.fromEntries(Object.entries(template.equipment).filter(([type]) => (
      !selectedTypes.has(type) && !HAND_TYPES.has(type)
    )));
    const otherSelected = [...selectedTypes].filter((type) => !HAND_TYPES.has(type)).sort();
    const equipmentCandidates = weaponStates(template, pool.equipmentPools, selectedTypes)
      .flatMap((weapons) => cartesianEquipment({ ...fixedEquipment, ...weapons }, otherSelected, pool.equipmentPools, template.equipment));
    const abilities = abilitySets(template, pool, fixed, options);
    for (const equipment of equipmentCandidates) {
      for (const selected of abilities) {
        all.push({
          sourcePreset: template.sourcePreset,
          sourcePresetId: template.sourcePresetId,
          direction,
          zeroCooldownHrid: selected.zeroCooldownHrid,
          equipmentCandidate: { equipment },
          abilityOrder: { abilities: [selected.aura, ...selected.actives] },
        });
      }
    }
  }
  const unique = new Map();
  for (const plan of all) {
    const key = unorderedPlanKey(plan);
    if (!unique.has(key)) unique.set(key, { ...plan, key });
  }
  return [...unique.values()];
}

export function activeOrderPermutations(plan) {
  const aura = plan.abilityOrder.abilities[0];
  const actives = plan.abilityOrder.abilities.slice(1);
  const fixedLast = plan.zeroCooldownHrid
    ? actives.find((entry) => entry.hrid === plan.zeroCooldownHrid)
    : null;
  const movable = fixedLast ? actives.filter((entry) => entry.hrid !== fixedLast.hrid) : actives;
  const result = [];
  const visit = (prefix, remaining) => {
    if (!remaining.length) {
      const ordered = fixedLast ? [...prefix, fixedLast] : prefix;
      const candidate = { ...plan, abilityOrder: { ...plan.abilityOrder, abilities: [aura, ...ordered] } };
      result.push({ ...candidate, key: orderedPlanKey(candidate) });
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      visit([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  };
  visit([], movable);
  return result;
}

export const componentRules = Object.freeze({
  excludedAbilities: EXCLUDED_ABILITIES,
  universalActives: UNIVERSAL_ACTIVES,
  physicalCounterActives: PHYSICAL_COUNTER_ACTIVES,
  magicActives: MAGIC_ACTIVES,
  counterActives: COUNTER_ACTIVES,
});
