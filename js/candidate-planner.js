import { COMBAT_EQUIPMENT_TYPES, finiteNumber } from "./data-model.js";
import { classifyAbility, classifyEquipment } from "./classifier.js";
import { chineseName } from "./localization.js";

const HAND_TYPES = new Set([
  "/equipment_types/main_hand",
  "/equipment_types/off_hand",
  "/equipment_types/two_hand",
]);

const RETALIATION_THORNS_BUFF_TYPES = new Set([
  "/buff_types/physical_thorns",
  "/buff_types/elemental_thorns",
  "/buff_types/retaliation",
]);

function usesRetaliationThorns(profile) {
  return profile?.specialStrategy?.id === "retaliation_thorns";
}

function equipmentSpecialStrategyMatches(itemClass, profile) {
  return usesRetaliationThorns(profile) && itemClass.counterDamage;
}

function abilitySpecialStrategyMatches(classification, profile) {
  return usesRetaliationThorns(profile)
    && [...(classification?.buffTypes || [])].some((type) => RETALIATION_THORNS_BUFF_TYPES.has(type));
}

function levelMap(character) {
  return Object.fromEntries((character.characterSkills || []).map((entry) => [entry.skillHrid, finiteNumber(entry.level, 1)]));
}

function requirementsMet(item, levels) {
  return (item?.equipmentDetail?.levelRequirements || []).every(
    (entry) => finiteNumber(levels[entry.skillHrid], 1) >= finiteNumber(entry.level, 0),
  );
}

function hasCombatContribution(item) {
  const detail = item?.equipmentDetail || {};
  return Object.keys(detail.combatStats || {}).length > 0 || Object.keys(detail.combatEnhancementBonuses || {}).length > 0;
}

function profileDirections(profile) {
  if (Array.isArray(profile?.selectedDirections) && profile.selectedDirections.length > 0) return profile.selectedDirections;
  const damages = (profile?.preferredDamageTypes || []).map((entry) => entry.hrid);
  return [...(profile?.selectedStyleHrids || [])].flatMap((styleHrid) => {
    if (styleHrid === "/combat_styles/magic") {
      return damages.filter((damageTypeHrid) => damageTypeHrid !== "/damage_types/physical")
        .map((damageTypeHrid) => ({ styleHrid, damageTypeHrid }));
    }
    return [{ styleHrid, damageTypeHrid: "/damage_types/physical" }];
  });
}

function matchesOneDirection(styles, damageTypes, profile) {
  return profileDirections(profile).some((direction) => (
    (styles.size === 0 || styles.has(direction.styleHrid))
    && (damageTypes.size === 0 || damageTypes.has(direction.damageTypeHrid))
  ));
}

function weaponMatches(itemClass, profile) {
  if (!itemClass.isWeapon && itemClass.type !== "/equipment_types/off_hand") return true;
  return matchesOneDirection(itemClass.styles, itemClass.damageTypes, profile);
}

function equipmentOffenseMatches(itemClass, profile) {
  if (itemClass.isWeapon) return weaponMatches(itemClass, profile);
  const hasSpecificDirection = itemClass.offensiveStyles.size > 0 || itemClass.offensiveDamageTypes.size > 0;
  if (hasSpecificDirection) return matchesOneDirection(itemClass.offensiveStyles, itemClass.offensiveDamageTypes, profile);
  return itemClass.genericOffense;
}

function targetedDefenseKeys(profile) {
  if (profile?.defenseTargets?.statKeys instanceof Set) return profile.defenseTargets.statKeys;
  const keys = new Set(["maxHitpoints"]);
  for (const styleHrid of profile?.incomingStyleHrids || []) {
    const style = String(styleHrid).split("/").pop();
    if (style) keys.add(`${style}Evasion`);
  }
  const damageType = String(profile?.incomingDamageType || "").split("/").pop();
  if (damageType === "physical") keys.add("armor");
  else if (damageType) keys.add(`${damageType}Resistance`);
  return keys;
}

export function equipmentDefenseMatches(itemClass, profile) {
  const targets = targetedDefenseKeys(profile);
  return [...(itemClass?.positiveStatKeys || [])].some((key) => targets.has(key));
}

function abilityOffenseMatches(classification, profile) {
  if (classification.hasDamage) return matchesOneDirection(classification.styles, classification.damageTypes, profile);
  if (!classification.offensiveSupport) return false;
  if (classification.supportDamageTypes.size > 0) {
    return profileDirections(profile).some((direction) => classification.supportDamageTypes.has(direction.damageTypeHrid));
  }
  if (classification.styles.size > 0) {
    return profileDirections(profile).some((direction) => classification.styles.has(direction.styleHrid));
  }
  return true;
}

function sortEntries(entries) {
  return entries.sort((left, right) => left.hrid.localeCompare(right.hrid) || finiteNumber(left.enhancementLevel, 0) - finiteNumber(right.enhancementLevel, 0));
}

export function buildSearchSpace(character, catalog, profile, options = {}) {
  const levels = levelMap(character);
  const equipmentPools = {};
  const counterEquipmentPools = {};
  const seenVariants = new Set();
  const selectedEquipmentTypes = options.selectedEquipmentTypes ? new Set(options.selectedEquipmentTypes) : null;

  for (const owned of character.characterItems || []) {
    const item = catalog.itemDetailMap?.[owned.itemHrid];
    const type = item?.equipmentDetail?.type;
    if (selectedEquipmentTypes && !selectedEquipmentTypes.has(type)) continue;
    if (!item || !COMBAT_EQUIPMENT_TYPES.has(type) || !requirementsMet(item, levels) || !hasCombatContribution(item)) continue;
    const key = `${owned.itemHrid}@${owned.enhancementLevel}`;
    if (seenVariants.has(key)) continue;
    seenVariants.add(key);
    const classification = classifyEquipment(item);
    if (!weaponMatches(classification, profile)) continue;
    const matchesSpecialStrategy = equipmentSpecialStrategyMatches(classification, profile);
    const matchesOffense = equipmentOffenseMatches(classification, profile) || matchesSpecialStrategy;
    const matchesCounter = equipmentDefenseMatches(classification, profile) || matchesSpecialStrategy;
    if (!matchesOffense && !matchesCounter) continue;
    const entry = {
      hrid: owned.itemHrid,
      name: chineseName(owned.itemHrid, item.name || owned.itemHrid),
      type,
      enhancementLevel: Math.max(0, Math.floor(finiteNumber(owned.enhancementLevel, 0))),
      count: Math.max(1, Math.floor(finiteNumber(owned.count, 1))),
      isCounter: matchesSpecialStrategy || (!matchesOffense && matchesCounter),
      specialStrategyMatch: matchesSpecialStrategy,
      targetedDefenseStats: [...classification.positiveStatKeys].filter((key) => targetedDefenseKeys(profile).has(key)),
      classification,
    };
    if (matchesOffense) (equipmentPools[type] ||= []).push(entry);
    if (matchesOffense || matchesCounter) (counterEquipmentPools[type] ||= []).push(entry);
  }
  for (const pools of [equipmentPools, counterEquipmentPools]) {
    for (const [type, entries] of Object.entries(pools)) pools[type] = sortEntries(entries);
  }

  const auraAbilities = [];
  const activeAbilities = [];
  const counterAuraAbilities = [];
  const counterActiveAbilities = [];
  const survivalAuraAbilities = [];
  const survivalActiveAbilities = [];
  const allAuraAbilities = [];
  const allActiveAbilities = [];
  const learnedLevels = Object.fromEntries((character.characterAbilities || []).map((entry) => [
    entry.abilityHrid,
    Math.max(1, Math.floor(finiteNumber(entry.level, 1))),
  ]));
  for (const abilityHrid of Object.keys(learnedLevels)) {
    const ability = catalog.abilityDetailMap?.[abilityHrid];
    if (!ability) continue;
    const classification = classifyAbility(ability);
    const learnedLevel = Math.max(1, Math.floor(finiteNumber(learnedLevels[abilityHrid], 1)));
    const matchesSpecialStrategy = abilitySpecialStrategyMatches(classification, profile);
    const matchesOffense = abilityOffenseMatches(classification, profile) || matchesSpecialStrategy;
    const matchesCounter = classification.defensive || classification.hasHealing || classification.hasControl || classification.hasSustain;
    const matchesSurvival = classification.hasSurvival || classification.defensive || classification.hasControl;
    const entry = {
      hrid: abilityHrid,
      name: chineseName(abilityHrid, ability.name || abilityHrid),
      level: learnedLevel,
      learnedLevel,
      cooldownDuration: finiteNumber(ability.cooldownDuration, 0),
      classification,
      isCounter: matchesSpecialStrategy || (!matchesOffense && matchesCounter),
      specialStrategyMatch: matchesSpecialStrategy,
    };
    if (classification.isAura) allAuraAbilities.push(entry);
    else allActiveAbilities.push(entry);
    if (!matchesOffense && !matchesCounter) continue;
    if (classification.isAura) {
      if (matchesOffense) auraAbilities.push(entry);
      if (matchesOffense || matchesCounter) counterAuraAbilities.push(entry);
      if (matchesOffense || matchesSurvival) survivalAuraAbilities.push(entry);
    } else {
      if (matchesOffense) activeAbilities.push(entry);
      if (matchesOffense || matchesCounter) counterActiveAbilities.push(entry);
      if (matchesOffense || matchesSurvival) survivalActiveAbilities.push(entry);
    }
  }
  for (const entries of [
    auraAbilities,
    activeAbilities,
    counterAuraAbilities,
    counterActiveAbilities,
    survivalAuraAbilities,
    survivalActiveAbilities,
    allAuraAbilities,
    allActiveAbilities,
  ]) sortEntries(entries);

  return {
    equipmentPools,
    counterEquipmentPools,
    auraAbilities,
    activeAbilities,
    offensiveAbilities: activeAbilities,
    counterAuraAbilities,
    counterActiveAbilities,
    counterAbilities: counterActiveAbilities,
    survivalAuraAbilities,
    survivalActiveAbilities,
    allAuraAbilities,
    allActiveAbilities,
    diagnostics: {
      ownedEquipmentVariants: seenVariants.size,
      retainedEquipmentVariants: Object.values(equipmentPools).reduce((sum, entries) => sum + entries.length, 0),
      retainedCounterEquipmentVariants: Object.values(counterEquipmentPools).reduce((sum, entries) => sum + entries.length, 0),
      retainedSpecialStrategyEquipmentVariants: Object.values(equipmentPools).flat().filter((entry) => entry.specialStrategyMatch).length,
      targetedDefenseStats: [...targetedDefenseKeys(profile)],
      retainedAuraAbilities: auraAbilities.length,
      retainedActiveAbilities: activeAbilities.length,
      retainedCounterAuraAbilities: counterAuraAbilities.length,
      retainedCounterAbilities: counterActiveAbilities.length,
      retainedSurvivalAuraAbilities: survivalAuraAbilities.length,
      retainedSurvivalAbilities: survivalActiveAbilities.length,
      retainedSpecialStrategyAbilities: [...auraAbilities, ...activeAbilities].filter((entry) => entry.specialStrategyMatch).length,
    },
  };
}

function equipmentKey(equipment) {
  return Object.entries(equipment).sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, item]) => `${slot}:${item.hrid}@${item.enhancementLevel || 0}`).join("|");
}

export function buildEquipmentLoadouts(pools, options = {}) {
  const requireCounter = Boolean(options.requireCounter);
  const twoHand = pools["/equipment_types/two_hand"] || [];
  const mainHand = pools["/equipment_types/main_hand"] || [];
  const offHand = pools["/equipment_types/off_hand"] || [];
  const bases = [];
  for (const weapon of twoHand) bases.push({ equipment: { [weapon.type]: weapon }, hasCounter: Boolean(weapon.isCounter) });
  for (const weapon of mainHand) {
    bases.push({ equipment: { [weapon.type]: weapon }, hasCounter: Boolean(weapon.isCounter) });
    for (const off of offHand) {
      bases.push({ equipment: { [weapon.type]: weapon, [off.type]: off }, hasCounter: Boolean(weapon.isCounter || off.isCounter) });
    }
  }
  if (bases.length === 0) bases.push({ equipment: {}, hasCounter: false });

  let current = bases;
  const otherTypes = Object.keys(pools).filter((type) => !HAND_TYPES.has(type)).sort();
  for (const type of otherTypes) {
    const choices = pools[type] || [];
    if (choices.length === 0) continue;
    const expanded = [];
    for (const candidate of current) {
      for (const choice of choices) {
        expanded.push({ equipment: { ...candidate.equipment, [type]: choice }, hasCounter: Boolean(candidate.hasCounter || choice.isCounter) });
      }
    }
    current = expanded;
  }
  const seen = new Set();
  return current.filter((entry) => {
    if (requireCounter && !entry.hasCounter) return false;
    const key = equipmentKey(entry.equipment);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildAbilityOrders(abilities, options = {}) {
  const slots = Math.max(0, Math.min(5, Math.floor(finiteNumber(options.slots, 5)), abilities.length));
  const requireCounter = Boolean(options.requireCounter);
  if (slots === 0) return [{ abilities: [], hasCounter: false }];
  const result = [];
  const visit = (ordered, used, hasCounter) => {
    if (ordered.length === slots) {
      if (!requireCounter || hasCounter) result.push({ abilities: ordered, hasCounter });
      return;
    }
    for (const ability of abilities) {
      if (used.has(ability.hrid)) continue;
      const nextUsed = new Set(used);
      nextUsed.add(ability.hrid);
      visit([...ordered, ability], nextUsed, Boolean(hasCounter || ability.isCounter));
    }
  };
  visit([], new Set(), false);
  return result;
}

export function buildCombatAbilityOrders(auraAbilities, activeAbilities, options = {}) {
  const activeSlots = Math.max(1, Math.min(4, Math.floor(finiteNumber(options.activeSlots, 4))));
  const requireCounter = Boolean(options.requireCounter);
  if (!Array.isArray(auraAbilities) || auraAbilities.length === 0 || !Array.isArray(activeAbilities) || activeAbilities.length < activeSlots) return [];
  const activeOrders = buildAbilityOrders(activeAbilities, { slots: activeSlots });
  const combined = [];
  for (const aura of auraAbilities) {
    for (const order of activeOrders) {
      const hasCounter = Boolean(aura.isCounter || order.hasCounter);
      if (requireCounter && !hasCounter) continue;
      combined.push({ abilities: [aura, ...order.abilities], hasCounter });
    }
  }
  return combined;
}
