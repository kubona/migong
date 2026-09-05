import { COMBAT_EQUIPMENT_TYPES, finiteNumber } from "./data-model.js";
import { classifyAbility, classifyEquipment } from "./classifier.js";
import { chineseName } from "./localization.js";
import { NEVER_SELECTABLE_ABILITY_HRIDS, normalizeFixedAbilityRules } from "./fixed-skill-options.js";
import { abilityCombatRequirementLevel, blocksLevelOneActive } from "./ability-selection-rules.js";

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
  if (direction?.strategyId === "retaliation_thorns") return "mimic";
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

function equipmentFamilyHrid(hrid) {
  return String(hrid || "").replace(/_refined$/, "");
}

function isRefinedEquipment(hrid) {
  return String(hrid || "").endsWith("_refined");
}

function preferredOwnedEquipment(candidate, current) {
  if (!current) return true;
  const candidateEnhancement = Math.max(0, Math.floor(finiteNumber(candidate?.enhancementLevel, 0)));
  const currentEnhancement = Math.max(0, Math.floor(finiteNumber(current?.enhancementLevel, 0)));
  if (candidateEnhancement !== currentEnhancement) return candidateEnhancement > currentEnhancement;
  return isRefinedEquipment(candidate?.itemHrid) && !isRefinedEquipment(current?.itemHrid);
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
  const bestOwnedByFamily = new Map();
  let eligibleOwnedVariantCount = 0;

  for (const owned of character?.characterItems || []) {
    const item = catalog?.itemDetailMap?.[owned.itemHrid];
    const type = item?.equipmentDetail?.type;
    if (!item || !COMBAT_EQUIPMENT_TYPES.has(type) || !selectedTypes.has(type)) continue;
    if (combatRequirementLevel(item) < minimumEquipmentLevel || !requirementsMet(item, skillLevels)) continue;
    eligibleOwnedVariantCount += 1;
    const key = `${type}:${equipmentFamilyHrid(owned.itemHrid)}`;
    if (preferredOwnedEquipment(owned, bestOwnedByFamily.get(key))) bestOwnedByFamily.set(key, owned);
  }

  for (const owned of bestOwnedByFamily.values()) {
    const item = catalog.itemDetailMap[owned.itemHrid];
    const type = item.equipmentDetail.type;
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
  const excludedLevelOneActiveHrids = [];
  const category = directionCategory(direction, profile?.monsterHrid);
  for (const [mapHrid, ability] of Object.entries(catalog?.abilityDetailMap || {})) {
    const hrid = String(ability?.hrid || mapHrid || "");
    const level = learnedLevels.get(hrid);
    if (!level || EXCLUDED_ABILITIES.has(hrid)) continue;
    const classification = classifyAbility(ability);
    if (!classification.isAura && blocksLevelOneActive(catalog, { ...ability, hrid }, direction)) {
      excludedLevelOneActiveHrids.push(hrid);
      continue;
    }
    const entry = {
      hrid,
      name: chineseName(hrid, ability.name || hrid),
      level,
      learnedLevel: level,
      combatRequirementLevel: abilityCombatRequirementLevel(catalog, hrid),
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
      discardedLowerEnhancementVariants: eligibleOwnedVariantCount - bestOwnedByFamily.size,
      retainedAuraAbilities: auraAbilities.length,
      retainedActiveAbilities: activeAbilities.length,
      excludedAbilityHrids: [...EXCLUDED_ABILITIES],
      excludedLevelOneActiveHrids: excludedLevelOneActiveHrids.sort(),
    },
  };
}

function currentEquipment(character, catalog) {
  const equipment = {};
  for (const owned of character?.characterItems || []) {
    const item = catalog?.itemDetailMap?.[owned?.itemHrid];
    const type = item?.equipmentDetail?.type;
    const expectedLocation = String(type || "").replace("/equipment_types/", "/item_locations/");
    if (!COMBAT_EQUIPMENT_TYPES.has(type) || owned.itemLocationHrid !== expectedLocation) continue;
    equipment[type] = {
      hrid: owned.itemHrid,
      name: chineseName(owned.itemHrid, item.name || owned.itemHrid),
      type,
      enhancementLevel: Math.max(0, Math.floor(finiteNumber(owned.enhancementLevel, 0))),
      count: 1,
    };
  }
  if (equipment[TWO_HAND]) {
    delete equipment[MAIN_HAND];
    delete equipment[OFF_HAND];
  }
  return equipment;
}

function currentAbilities(character, pool) {
  const slots = new Map((character?.characterAbilities || []).map((entry) => [
    Math.max(0, Math.floor(finiteNumber(entry?.slotNumber, 0))),
    String(entry?.abilityHrid || ""),
  ]));
  const auraHrid = slots.get(1) || "";
  const aura = pool.allAuraAbilities.find((entry) => entry.hrid === auraHrid);
  const actives = [2, 3, 4, 5].map((slot) => pool.allActiveAbilities.find((entry) => entry.hrid === slots.get(slot)) || null);
  return { aura: aura || null, actives };
}

export function buildCurrentBaseline(character, catalog, pool) {
  return {
    equipment: currentEquipment(character, catalog),
    ...currentAbilities(character, pool),
  };
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

function* cartesianEquipment(base, types, pools, index = 0) {
  if (index >= types.length) {
    yield base;
    return;
  }
  const type = types[index];
  const choices = pools[type] || [];
  for (const choice of choices) {
    yield* cartesianEquipment({ ...base, [type]: choice }, types, pools, index + 1);
  }
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
    const paired = fixedOff
      ? mainPool.map((main) => ({ [MAIN_HAND]: main, [OFF_HAND]: fixedOff }))
      : [];
    const twoHanded = twoPool.map((weapon) => ({ [TWO_HAND]: weapon }));
    const generated = [...paired, ...twoHanded];
    if (generated.length) return generated;
  } else if (offSelected) {
    const fixedMain = template.equipment[MAIN_HAND];
    if (fixedMain) {
      const generated = offPool.map((off) => ({ [MAIN_HAND]: fixedMain, [OFF_HAND]: off }));
      if (generated.length) return generated;
    }
    // A two-hand system preset cannot equip an off-hand item. Keep its fixed
    // weapon branch intact when only the off-hand slot is selected.
    if (template.equipment[TWO_HAND]) return [{ [TWO_HAND]: template.equipment[TWO_HAND] }];
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
  const auraChoices = fixed.aura ? [fixed.aura] : options.optimizeAura === false ? (template.aura ? [template.aura] : []) : pool.auraAbilities;
  if (!auraChoices.length) return [];
  if (options.optimizeActives === false) {
    if (!Array.isArray(template.actives) || template.actives.length !== 4 || template.actives.some((entry) => !entry?.hrid)) return [];
    const hrids = new Set(template.actives.map((entry) => entry.hrid));
    if (hrids.size !== 4) return [];
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

export function* iterateUniqueComponentPlans(baseline, pool, direction, monsterHrid, options = {}) {
  const selectedTypes = new Set(options.selectedEquipmentTypes || []);
  const fixed = fixedPresence(pool, direction, monsterHrid, options.fixedAbilityRules);
  const unique = options.seenEquipment || new Set();
  const fixedEquipment = Object.fromEntries(Object.entries(baseline.equipment || {}).filter(([type]) => (
    !selectedTypes.has(type) && !HAND_TYPES.has(type)
  )));
  const otherSelected = [...selectedTypes].filter((type) => !HAND_TYPES.has(type)).sort();
  const abilities = abilitySets(baseline, pool, fixed, options);
  const signature=JSON.stringify(abilities.map(s=>[s.aura.hrid,...s.actives.map(a=>a.hrid)]));
  const groups=options.skillGroups || new Map();
  if(!groups.has(signature))groups.set(signature,groups.size);
  const groupId=groups.get(signature);
  for (const weapons of weaponStates(baseline, pool.equipmentPools, selectedTypes)) {
    for (const equipment of cartesianEquipment({ ...fixedEquipment, ...weapons }, otherSelected, pool.equipmentPools)) {
      // All skill sets in one branch are already unique. Deduplicate equipment
      // before multiplying by skills, including overlapping personal presets.
      const groupKey = JSON.stringify([Object.entries(equipment).sort(([a],[b])=>a.localeCompare(b)).map(([slot,item])=>[slot,item.hrid,item.enhancementLevel||0]),
        groupId]);
      if (unique.has(groupKey)) continue;
      unique.add(groupKey);
      for (const selected of abilities) {
        const plan = {
          direction,
          sourcePreset: baseline.sourcePreset || "",
          sourcePresetId: baseline.sourcePresetId || "",
          zeroCooldownHrid: selected.zeroCooldownHrid,
          equipmentCandidate: { equipment },
          abilityOrder: { abilities: [selected.aura, ...selected.actives] },
        };
        const key = unorderedPlanKey(plan);
        yield { ...plan, key };
      }
    }
  }
}

export function buildUniqueComponentPlans(baseline, pool, direction, monsterHrid, options = {}) {
  return [...iterateUniqueComponentPlans(baseline, pool, direction, monsterHrid, options)];
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
