import { finiteNumber, MONSTER_ZH_NAMES } from "./data-model.js";

export const STYLE_DEFINITIONS = [
  { id: "stab", hrid: "/combat_styles/stab", evasion: "stabEvasionRating", accuracy: "stabAccuracyRating", zh: "刺击" },
  { id: "slash", hrid: "/combat_styles/slash", evasion: "slashEvasionRating", accuracy: "slashAccuracyRating", zh: "斩击" },
  { id: "smash", hrid: "/combat_styles/smash", evasion: "smashEvasionRating", accuracy: "smashAccuracyRating", zh: "重击" },
  { id: "ranged", hrid: "/combat_styles/ranged", evasion: "rangedEvasionRating", accuracy: "rangedAccuracyRating", zh: "远程" },
  { id: "magic", hrid: "/combat_styles/magic", evasion: "magicEvasionRating", accuracy: "magicAccuracyRating", zh: "魔法" },
];

export const DAMAGE_DEFINITIONS = [
  { id: "physical", hrid: "/damage_types/physical", resistance: "totalArmor", zh: "物理" },
  { id: "water", hrid: "/damage_types/water", resistance: "totalWaterResistance", zh: "水" },
  { id: "nature", hrid: "/damage_types/nature", resistance: "totalNatureResistance", zh: "自然" },
  { id: "fire", hrid: "/damage_types/fire", resistance: "totalFireResistance", zh: "火" },
];

const OFFENSIVE_BUFF_TYPES = new Set([
  "/buff_types/damage",
  "/buff_types/attack_speed",
  "/buff_types/cast_speed",
  "/buff_types/critical_rate",
  "/buff_types/critical_damage",
  "/buff_types/accuracy",
  "/buff_types/ability_damage",
  "/buff_types/armor_penetration",
  "/buff_types/water_penetration",
  "/buff_types/nature_penetration",
  "/buff_types/fire_penetration",
  "/buff_types/physical_amplify",
  "/buff_types/water_amplify",
  "/buff_types/nature_amplify",
  "/buff_types/fire_amplify",
]);

const COUNTER_DAMAGE_BUFF_TYPES = new Set([
  "/buff_types/physical_thorns",
  "/buff_types/elemental_thorns",
  "/buff_types/retaliation",
]);

const DEFENSIVE_BUFF_PATTERN = /(armor|resistance|evasion|damage_taken|tenacity|parry|healing|hitpoints|hp_regen)/;

const MIMIC_SPECIAL_STRATEGY = Object.freeze({
  id: "retaliation_thorns",
  zh: "反伤·荆棘",
  presetZh: "盾",
  coreZh: ["反伤", "物理荆棘", "元素荆棘"],
});

export function hitChance(accuracy, evasion) {
  const a = Math.max(1, finiteNumber(accuracy, 1));
  const e = Math.max(1, finiteNumber(evasion, 1));
  const poweredAccuracy = a ** 1.4;
  return poweredAccuracy / (poweredAccuracy + e ** 1.4);
}

export function mitigationMultiplier(resistance) {
  const value = finiteNumber(resistance, 0);
  return value >= 0 ? 100 / (100 + value) : (100 - value) / 100;
}

function scaledMonsterEvasion(details, definition, roomLevel) {
  const scale = roomLevel / 100;
  const defenseLevel = Number(details?.defenseLevel);
  const combatStats = details?.combatStats || {};
  const bonusKey = `${definition.id}Evasion`;
  const styleBonus = Number(combatStats[bonusKey]);
  // Labyrinth monsters use the engine's Monster.updateCombatDetails formula:
  // (10 + scaled defense) * (1 + scaled style evasion). The catalog's final
  // rating is only a level-100 snapshot and cannot be scaled as one number.
  if (Number.isFinite(defenseLevel) && Number.isFinite(styleBonus)) {
    return Math.max(1, (10 + defenseLevel * scale) * (1 + styleBonus));
  }
  return Math.max(1, finiteNumber(details?.[definition.evasion], 1) * scale);
}

function takeWeakestWithinFactor(entries, valueKey, limit = 2, factor = 2) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const sorted = [...entries].sort((left, right) => finiteNumber(left?.[valueKey], 0) - finiteNumber(right?.[valueKey], 0));
  const weakest = Math.max(0, finiteNumber(sorted[0]?.[valueKey], 0));
  return sorted.slice(0, limit).filter((entry, index) => (
    index === 0 || finiteNumber(entry?.[valueKey], 0) <= weakest * factor
  ));
}

function incomingDefenseTargets(details) {
  const incomingStyles = (details.combatStats?.combatStyleHrids || [])
    .map((hrid) => STYLE_DEFINITIONS.find((entry) => entry.hrid === hrid))
    .filter(Boolean);
  const incomingDamageType = String(details.combatStats?.damageType || "");
  const damage = DAMAGE_DEFINITIONS.find((entry) => entry.hrid === incomingDamageType) || null;
  const styleStatKeys = incomingStyles.map((entry) => `${entry.id}Evasion`);
  const mitigationStatKey = damage?.id === "physical" ? "armor" : damage ? `${damage.id}Resistance` : "";
  return {
    incomingStyles,
    incomingDamageType: damage,
    statKeys: new Set([...styleStatKeys, mitigationStatKey, "maxHitpoints"].filter(Boolean)),
    labels: [
      ...incomingStyles.map((entry) => `${entry.zh}闪避`),
      damage ? (damage.id === "physical" ? "护甲" : `${damage.zh}抗性`) : null,
      "生命",
    ].filter(Boolean),
  };
}

export function classifyMonster(monster, options = {}) {
  if (!monster?.combatDetails) throw new Error("怪物缺少 combatDetails");
  const details = monster.combatDetails;
  const roomLevel = Math.max(1, finiteNumber(options.roomLevel, 100));
  const levelScale = roomLevel / 100;
  const playerDetails = options.playerCombatDetails || {};

  const styles = STYLE_DEFINITIONS.map((definition) => {
    const evasion = scaledMonsterEvasion(details, definition, roomLevel);
    const accuracy = finiteNumber(playerDetails[definition.accuracy], 0);
    return {
      ...definition,
      evasion,
      accuracy,
      estimatedHitChance: accuracy > 0 ? hitChance(accuracy, evasion) : null,
    };
  }).sort((left, right) => left.evasion - right.evasion);

  // First retain at most two low-evasion attack methods. A second method is
  // discarded only when its evasion is strictly more than twice the minimum.
  const weakStyleCandidates = takeWeakestWithinFactor(styles, "evasion");

  const damageTypes = DAMAGE_DEFINITIONS.map((definition) => {
    const resistance = finiteNumber(details[definition.resistance], 0) * levelScale;
    return { ...definition, resistance, multiplier: mitigationMultiplier(resistance) };
  }).sort((left, right) => right.multiplier - left.multiplier);

  const elementalDamageTypes = damageTypes.filter((entry) => entry.hrid !== "/damage_types/physical");
  const physicalDamageType = damageTypes.find((entry) => entry.hrid === "/damage_types/physical");
  const compatibleDirections = weakStyleCandidates.flatMap((style) => {
    const compatibleDamageTypes = style.hrid === "/combat_styles/magic" ? elementalDamageTypes : [physicalDamageType].filter(Boolean);
    return compatibleDamageTypes.map((damageType) => ({
      styleId: style.id,
      styleHrid: style.hrid,
      styleZh: style.zh,
      styleEvasion: style.evasion,
      damageTypeId: damageType.id,
      damageTypeHrid: damageType.hrid,
      damageTypeZh: damageType.zh,
      resistance: damageType.resistance,
    }));
  });
  // Then compare the compatible resistances and retain at most two final
  // directions using the same strict "more than twice" rule.
  let selectedDirections = takeWeakestWithinFactor(compatibleDirections, "resistance");
  const specialStrategy = monster.hrid === "/monsters/mimic" ? MIMIC_SPECIAL_STRATEGY : null;
  if (specialStrategy) {
    const smash = styles.find((entry) => entry.hrid === "/combat_styles/smash");
    const physical = damageTypes.find((entry) => entry.hrid === "/damage_types/physical");
    selectedDirections = [{
      styleId: smash.id,
      styleHrid: smash.hrid,
      styleZh: smash.zh,
      styleEvasion: smash.evasion,
      damageTypeId: physical.id,
      damageTypeHrid: physical.hrid,
      damageTypeZh: physical.zh,
      resistance: physical.resistance,
      strategyId: specialStrategy.id,
      strategyZh: specialStrategy.zh,
    }];
  }
  const selectedStyleHrids = new Set(selectedDirections.map((entry) => entry.styleHrid));
  const selectedStyles = styles.filter((entry) => selectedStyleHrids.has(entry.hrid));
  const preferredDamageTypes = [...new Set(selectedDirections.map((entry) => entry.damageTypeHrid))]
    .map((hrid) => damageTypes.find((entry) => entry.hrid === hrid))
    .filter(Boolean);
  const defenseTargets = incomingDefenseTargets(details);

  return {
    monsterHrid: monster.hrid,
    name: MONSTER_ZH_NAMES[monster.hrid] || monster.name || monster.hrid,
    roomLevel,
    styles,
    weakStyleCandidates,
    selectedStyles,
    selectedStyleHrids,
    selectedDirections,
    damageTypes,
    preferredDamageTypes,
    specialStrategy,
    incomingStyleHrids: new Set(details.combatStats?.combatStyleHrids || []),
    incomingDamageType: String(details.combatStats?.damageType || ""),
    defenseTargets,
  };
}

export function classifyAbility(ability) {
  // The first combat slot is the single special-ability slot. Auras, Insanity,
  // Invincible, and Revive all share it according to the client field and real
  // character presets; none of them may also enter the four normal active slots.
  const isAura = Boolean(ability?.isSpecialAbility);
  const styles = new Set();
  const damageTypes = new Set();
  const supportDamageTypes = new Set();
  const buffTypes = new Set();
  let directDamageScore = 0;
  let hasDirectDamage = false;
  let hasHealing = false;
  let hasControl = false;
  let hasSustain = false;
  let hasSurvival = false;
  let hasResourceSustain = false;
  let defensive = false;
  let offensiveSupport = false;

  for (const effect of ability?.abilityEffects || []) {
    const effectType = String(effect?.effectType || "");
    const hasBaseDamage = finiteNumber(effect?.baseDamageFlat, 0) > 0 || finiteNumber(effect?.baseDamageRatio, 0) > 0;
    const isDamageEffect = effectType.includes("/damage") || (!effectType.includes("heal") && hasBaseDamage);
    if (effect?.combatStyleHrid) styles.add(effect.combatStyleHrid);
    if (effect?.damageType) damageTypes.add(effect.damageType);
    if (isDamageEffect) {
      directDamageScore += Math.max(0, finiteNumber(effect?.baseDamageFlat, 0));
      directDamageScore += 100 * Math.max(0, finiteNumber(effect?.baseDamageRatio, 0));
      hasDirectDamage = true;
    }
    if (String(effect?.effectType || "").includes("heal")) {
      hasHealing = true;
      hasSurvival = true;
    }
    if (finiteNumber(effect?.hpDrainRatio, 0) > 0) {
      hasSustain = true;
      hasSurvival = true;
    }
    if (
      finiteNumber(effect?.blindChance, 0) > 0 ||
      finiteNumber(effect?.silenceChance, 0) > 0 ||
      finiteNumber(effect?.stunChance, 0) > 0
    ) hasControl = true;
    for (const buff of effect?.buffs || []) {
      const type = String(buff?.typeHrid || "");
      if (!type) continue;
      buffTypes.add(type);
      const supportDamage = type.match(/^\/buff_types\/(physical|water|nature|fire)_(?:amplify|penetration)$/)?.[1];
      if (supportDamage) supportDamageTypes.add(`/damage_types/${supportDamage}`);
      if (OFFENSIVE_BUFF_TYPES.has(type)) offensiveSupport = true;
      if (DEFENSIVE_BUFF_PATTERN.test(type) || COUNTER_DAMAGE_BUFF_TYPES.has(type)) defensive = true;
      if (/life_steal|hp_regen/.test(type)) {
        hasSustain = true;
        hasSurvival = true;
      }
      if (/mana_leech|mp_regen/.test(type)) {
        hasSustain = true;
        hasResourceSustain = true;
      }
    }
  }

  const hasDamage = hasDirectDamage || directDamageScore > 0;
  return {
    isAura,
    styles,
    damageTypes,
    supportDamageTypes,
    buffTypes,
    directDamageScore,
    hasDamage,
    offensiveSupport,
    defensive,
    hasHealing,
    hasControl,
    hasSustain,
    hasSurvival,
    hasResourceSustain,
    stage: hasDamage || offensiveSupport ? "offense" : defensive || hasHealing || hasControl || hasSustain ? "counter" : "utility",
  };
}

export function abilityMatchesProfile(abilityClass, profile) {
  if (abilityClass.offensiveSupport && abilityClass.styles.size === 0) return true;
  if (abilityClass.styles.size === 0) return false;
  return [...abilityClass.styles].some((style) => profile.selectedStyleHrids.has(style));
}

export function classifyEquipment(item) {
  const detail = item?.equipmentDetail || {};
  const stats = detail.combatStats || {};
  const styles = new Set(detail.combatStats?.combatStyleHrids || []);
  const damageTypes = new Set(detail.combatStats?.damageType ? [detail.combatStats.damageType] : []);
  const statKeys = new Set([...Object.keys(stats), ...Object.keys(detail.combatEnhancementBonuses || {})]);
  const offensiveStyles = new Set();
  const offensiveDamageTypes = new Set(damageTypes);
  const positiveStatKeys = new Set();
  let genericOffense = false;
  let defensive = false;
  let counterDamage = false;
  for (const source of [stats, detail.combatEnhancementBonuses || {}]) {
    for (const [key, value] of Object.entries(source)) {
      const normalized = key.toLowerCase();
      const positive = finiteNumber(value, 0) > 0;
      if (positive) positiveStatKeys.add(key);
      const isCounterDamage = /defensive_?damage|physical_?thorns|elemental_?thorns|retaliation/i.test(normalized);
      if (positive && isCounterDamage) {
        counterDamage = true;
        defensive = true;
      }
      if (positive && !isCounterDamage && /(accuracy|damage|amplif|penetration|attack_speed|cast_speed|critical|haste)/i.test(key)) {
        let hasSpecificOffense = false;
        for (const style of ["stab", "slash", "smash", "ranged", "magic"]) {
          if (normalized.includes(style)) {
            offensiveStyles.add(`/combat_styles/${style}`);
            hasSpecificOffense = true;
          }
        }
        for (const damage of ["physical", "water", "nature", "fire"]) {
          if (normalized.includes(damage)) {
            offensiveDamageTypes.add(`/damage_types/${damage}`);
            hasSpecificOffense = true;
          }
        }
        if (!hasSpecificOffense) genericOffense = true;
      }
      if (positive && /(hitpoints|hp_regen|life_steal|healing|evasion|armor|resistance|tenacity|parry|damage_taken)/i.test(key)) defensive = true;
    }
  }
  return {
    type: String(detail.type || ""),
    styles,
    damageTypes,
    statKeys,
    positiveStatKeys,
    offensiveStyles,
    offensiveDamageTypes,
    genericOffense,
    defensive,
    counterDamage,
    isWeapon: detail.type === "/equipment_types/main_hand" || detail.type === "/equipment_types/two_hand",
  };
}
