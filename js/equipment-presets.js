import { COMBAT_EQUIPMENT_TYPES, finiteNumber } from "./data-model.js";
import { classifyEquipment } from "./classifier.js";
import { chineseName } from "./localization.js";

const MAIN_HAND = "/equipment_types/main_hand";
const OFF_HAND = "/equipment_types/off_hand";
const TWO_HAND = "/equipment_types/two_hand";
const CHARM = "/equipment_types/charm";

export const SIMULATION_DIRECTION_AUTO = "auto";

export const SIMULATION_DIRECTION_OPTIONS = Object.freeze([
  Object.freeze({ value: SIMULATION_DIRECTION_AUTO, label: "自动最优" }),
  Object.freeze({ value: "slash", label: "斩击" }),
  Object.freeze({ value: "smash", label: "钝击" }),
  Object.freeze({ value: "stab", label: "刺击" }),
  Object.freeze({ value: "ranged_bow", label: "弓" }),
  Object.freeze({ value: "ranged_crossbow", label: "弩" }),
  Object.freeze({ value: "water", label: "水" }),
  Object.freeze({ value: "fire", label: "火" }),
  Object.freeze({ value: "nature", label: "自然" }),
  Object.freeze({ value: "counter", label: "反伤" }),
]);

const PRESET_DIRECTION_DEFINITIONS = Object.freeze({
  slash: Object.freeze({ styleId: "slash", styleHrid: "/combat_styles/slash", styleZh: "斩击", damageTypeId: "physical", damageTypeHrid: "/damage_types/physical", damageTypeZh: "物理" }),
  smash: Object.freeze({ styleId: "smash", styleHrid: "/combat_styles/smash", styleZh: "重击", damageTypeId: "physical", damageTypeHrid: "/damage_types/physical", damageTypeZh: "物理" }),
  stab: Object.freeze({ styleId: "stab", styleHrid: "/combat_styles/stab", styleZh: "刺击", damageTypeId: "physical", damageTypeHrid: "/damage_types/physical", damageTypeZh: "物理" }),
  ranged_bow: Object.freeze({ styleId: "ranged", styleHrid: "/combat_styles/ranged", styleZh: "远程", damageTypeId: "physical", damageTypeHrid: "/damage_types/physical", damageTypeZh: "物理" }),
  ranged_crossbow: Object.freeze({ styleId: "ranged", styleHrid: "/combat_styles/ranged", styleZh: "远程", damageTypeId: "physical", damageTypeHrid: "/damage_types/physical", damageTypeZh: "物理" }),
  water: Object.freeze({ styleId: "magic", styleHrid: "/combat_styles/magic", styleZh: "魔法", damageTypeId: "water", damageTypeHrid: "/damage_types/water", damageTypeZh: "水" }),
  fire: Object.freeze({ styleId: "magic", styleHrid: "/combat_styles/magic", styleZh: "魔法", damageTypeId: "fire", damageTypeHrid: "/damage_types/fire", damageTypeZh: "火" }),
  nature: Object.freeze({ styleId: "magic", styleHrid: "/combat_styles/magic", styleZh: "魔法", damageTypeId: "nature", damageTypeHrid: "/damage_types/nature", damageTypeZh: "自然" }),
  counter: Object.freeze({ styleId: "smash", styleHrid: "/combat_styles/smash", styleZh: "重击", damageTypeId: "physical", damageTypeHrid: "/damage_types/physical", damageTypeZh: "物理", strategyId: "retaliation_thorns", strategyZh: "反伤·荆棘" }),
});

const PRESET_LABELS = Object.freeze(Object.fromEntries(
  SIMULATION_DIRECTION_OPTIONS.filter((entry) => entry.value !== SIMULATION_DIRECTION_AUTO)
    .map((entry) => [entry.value, entry.label]),
));

export const EQUIPMENT_PRESET_SOURCE = Object.freeze({
  system: "system",
  personal: "personal",
});

const COMMON_ACCESSORIES = Object.freeze({
  "/equipment_types/neck": "/items/philosophers_necklace",
  "/equipment_types/earrings": "/items/philosophers_earrings",
  "/equipment_types/ring": "/items/philosophers_ring",
  "/equipment_types/pouch": "/items/guzzling_pouch",
});

const PHYSICAL_ARMOR = Object.freeze({
  "/equipment_types/off_hand": "/items/knights_aegis",
  "/equipment_types/head": "/items/corsair_helmet",
  "/equipment_types/body": "/items/maelstrom_plate_body",
  "/equipment_types/legs": "/items/maelstrom_plate_legs",
  "/equipment_types/hands": "/items/dodocamel_gauntlets",
  "/equipment_types/feet": "/items/pathbreaker_boots",
  "/equipment_types/back": "/items/sinister_cape",
});

function physicalPreset(mainHand) {
  return Object.freeze({ [MAIN_HAND]: mainHand, ...PHYSICAL_ARMOR, ...COMMON_ACCESSORIES });
}

function magicPreset(element) {
  return Object.freeze({
    [MAIN_HAND]: `/items/${element === "water" ? "rippling" : element === "fire" ? "blazing" : "blooming"}_trident`,
    [OFF_HAND]: "/items/bishops_codex",
    "/equipment_types/head": "/items/magicians_hat",
    "/equipment_types/body": `/items/royal_${element}_robe_top`,
    "/equipment_types/legs": `/items/royal_${element}_robe_bottoms`,
    "/equipment_types/hands": "/items/chrono_gloves",
    "/equipment_types/feet": "/items/pathseeker_boots",
    "/equipment_types/back": "/items/enchanted_cloak",
    ...COMMON_ACCESSORIES,
  });
}

export const SYSTEM_EQUIPMENT_PRESETS = Object.freeze({
  slash: physicalPreset("/items/regal_sword"),
  smash: physicalPreset("/items/chaotic_flail"),
  stab: physicalPreset("/items/furious_spear"),
  ranged_bow: Object.freeze({
    [TWO_HAND]: "/items/cursed_bow",
    "/equipment_types/head": "/items/acrobatic_hood",
    "/equipment_types/body": "/items/kraken_tunic",
    "/equipment_types/legs": "/items/kraken_chaps",
    "/equipment_types/hands": "/items/marksman_bracers",
    "/equipment_types/feet": "/items/pathfinder_boots",
    "/equipment_types/back": "/items/chimerical_quiver",
    ...COMMON_ACCESSORIES,
  }),
  ranged_crossbow: Object.freeze({
    [MAIN_HAND]: "/items/sundering_crossbow",
    [OFF_HAND]: "/items/manticore_shield",
    "/equipment_types/head": "/items/acrobatic_hood",
    "/equipment_types/body": "/items/kraken_tunic",
    "/equipment_types/legs": "/items/kraken_chaps",
    "/equipment_types/hands": "/items/marksman_bracers",
    "/equipment_types/feet": "/items/pathfinder_boots",
    "/equipment_types/back": "/items/chimerical_quiver",
    ...COMMON_ACCESSORIES,
  }),
  water: magicPreset("water"),
  fire: magicPreset("fire"),
  nature: magicPreset("nature"),
  counter: Object.freeze({
    [TWO_HAND]: "/items/griffin_bulwark",
    "/equipment_types/head": "/items/corsair_helmet",
    "/equipment_types/body": "/items/anchorbound_plate_body",
    "/equipment_types/legs": "/items/anchorbound_plate_legs",
    "/equipment_types/hands": "/items/dodocamel_gauntlets",
    "/equipment_types/feet": "/items/pathbreaker_boots",
    "/equipment_types/back": "/items/sinister_cape",
    ...COMMON_ACCESSORIES,
  }),
});

export function manualSimulationDirection(selection) {
  const definition = PRESET_DIRECTION_DEFINITIONS[selection];
  if (!definition) return null;
  return { ...definition, presetId: selection, presetLabel: PRESET_LABELS[selection], selectionMode: "manual" };
}

function automaticPresetKeys(direction, monsterHrid) {
  if (monsterHrid === "/monsters/mimic" || direction?.strategyId === "retaliation_thorns") return "counter";
  const style = String(direction?.styleHrid || "").split("/").pop();
  if (["slash", "smash", "stab"].includes(style)) return style;
  if (style === "ranged") return ["ranged_bow", "ranged_crossbow"];
  if (style === "magic") {
    const damage = String(direction?.damageTypeHrid || "").split("/").pop();
    if (["water", "fire", "nature"].includes(damage)) return damage;
  }
  throw new Error("无法为当前弱点方向确定预设配装");
}

function familyHrid(hrid) {
  return String(hrid || "").replace(/_refined$/, "");
}

function isRefined(hrid) {
  return String(hrid || "").endsWith("_refined");
}

function enhancedStats(item, enhancementLevel, catalog) {
  const detail = item?.equipmentDetail || {};
  const multiplier = finiteNumber(catalog?.enhancementLevelTotalBonusMultiplierTable?.[enhancementLevel], 0);
  const result = {};
  for (const key of new Set([
    ...Object.keys(detail.combatStats || {}),
    ...Object.keys(detail.combatEnhancementBonuses || {}),
  ])) {
    const base = Number(detail.combatStats?.[key]);
    const bonus = Number(detail.combatEnhancementBonuses?.[key]);
    if (!Number.isFinite(base) && !Number.isFinite(bonus)) continue;
    result[key] = finiteNumber(base, 0) + finiteNumber(bonus, 0) * multiplier;
  }
  return result;
}

function statValue(entry, key) {
  const value = finiteNumber(entry?.resolvedCombatStats?.[key], 0);
  return key === "attackInterval" ? -value : value;
}

function compareActualStats(left, right) {
  if (!right) return 1;
  const keys = new Set([
    ...Object.keys(left.resolvedCombatStats || {}),
    ...Object.keys(right.resolvedCombatStats || {}),
  ]);
  let leftBetter = false;
  let rightBetter = false;
  for (const key of keys) {
    const leftValue = statValue(left, key);
    const rightValue = statValue(right, key);
    if (leftValue > rightValue + 1e-12) leftBetter = true;
    if (rightValue > leftValue + 1e-12) rightBetter = true;
  }
  if (leftBetter !== rightBetter) return leftBetter ? 1 : -1;
  const weightedTotal = (entry) => [...keys].reduce((sum, key) => {
    if (key === "attackInterval") return sum;
    return sum + statValue(entry, key);
  }, 0);
  const totalDelta = weightedTotal(left) - weightedTotal(right);
  if (Math.abs(totalDelta) > 1e-12) return totalDelta > 0 ? 1 : -1;
  if (left.enhancementLevel !== right.enhancementLevel) return left.enhancementLevel > right.enhancementLevel ? 1 : -1;
  if (isRefined(left.hrid) !== isRefined(right.hrid)) return isRefined(left.hrid) ? 1 : -1;
  return String(right.hrid).localeCompare(String(left.hrid));
}

function equipmentEntry(owned, item, catalog) {
  const enhancementLevel = Math.max(0, Math.floor(finiteNumber(owned?.enhancementLevel, 0)));
  return {
    hrid: owned.itemHrid,
    name: chineseName(owned.itemHrid, item.name || owned.itemHrid),
    type: item.equipmentDetail.type,
    enhancementLevel,
    count: Math.max(1, Math.floor(finiteNumber(owned?.count, 1))),
    resolvedCombatStats: enhancedStats(item, enhancementLevel, catalog),
  };
}

function strongestOwnedFamily(character, catalog, type, configuredFamily) {
  let best = null;
  for (const owned of character?.characterItems || []) {
    if (finiteNumber(owned?.count, 0) <= 0 || familyHrid(owned?.itemHrid) !== configuredFamily) continue;
    const item = catalog?.itemDetailMap?.[owned.itemHrid];
    if (item?.equipmentDetail?.type !== type) continue;
    const entry = equipmentEntry(owned, item, catalog);
    if (compareActualStats(entry, best) > 0) best = entry;
  }
  return best;
}

function systemBaseline(character, catalog, key) {
  const preset = SYSTEM_EQUIPMENT_PRESETS[key];
  const equipment = {};
  for (const [type, configuredFamily] of Object.entries(preset)) {
    if (type === CHARM) continue;
    const entry = strongestOwnedFamily(character, catalog, type, configuredFamily);
    if (!entry) throw new Error(`系统预设“${key}”缺少已拥有装备：${configuredFamily}`);
    equipment[type] = entry;
  }
  return { sourcePreset: `系统预设·${PRESET_LABELS[key] || key}`, sourcePresetId: `system:${key}`, equipment };
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

function personalEquipment(loadout, catalog) {
  const equipment = {};
  for (const reference of Object.values(loadout?.wearableMap || {})) {
    const parsed = parseItemReference(reference);
    const item = catalog?.itemDetailMap?.[parsed?.hrid];
    const type = item?.equipmentDetail?.type;
    if (!parsed?.hrid || type === CHARM || !COMBAT_EQUIPMENT_TYPES.has(type)) continue;
    equipment[type] = {
      hrid: parsed.hrid,
      name: chineseName(parsed.hrid, item.name || parsed.hrid),
      type,
      enhancementLevel: parsed.enhancementLevel,
      count: 1,
      resolvedCombatStats: enhancedStats(item, parsed.enhancementLevel, catalog),
    };
  }
  if (equipment[TWO_HAND]) {
    delete equipment[MAIN_HAND];
    delete equipment[OFF_HAND];
  }
  return equipment;
}

function personalPresetMatches(equipment, catalog, direction, monsterHrid) {
  if (monsterHrid === "/monsters/mimic" || direction?.strategyId === "retaliation_thorns") {
    return Object.values(equipment).some((entry) => classifyEquipment(catalog.itemDetailMap?.[entry.hrid]).counterDamage);
  }
  const weapon = equipment[TWO_HAND] || equipment[MAIN_HAND];
  const stats = catalog?.itemDetailMap?.[weapon?.hrid]?.equipmentDetail?.combatStats || {};
  return (stats.combatStyleHrids || []).includes(direction?.styleHrid)
    && String(stats.damageType || "") === String(direction?.damageTypeHrid || "");
}

function equipmentKey(equipment) {
  return Object.entries(equipment).sort(([left], [right]) => left.localeCompare(right))
    .map(([type, entry]) => `${type}:${entry.hrid}@${entry.enhancementLevel}`).join("|");
}

function personalBaselines(character, catalog, direction, monsterHrid) {
  const unique = new Map();
  for (const [id, loadout] of Object.entries(character?.characterLoadoutMap || {})) {
    if (loadout?.actionTypeHrid !== "/action_types/combat") continue;
    const equipment = personalEquipment(loadout, catalog);
    if (!personalPresetMatches(equipment, catalog, direction, monsterHrid)) continue;
    const key = equipmentKey(equipment);
    if (!key || unique.has(key)) continue;
    unique.set(key, {
      sourcePreset: String(loadout.name || `个人预设 ${loadout.id ?? id}`),
      sourcePresetId: String(loadout.id ?? id),
      equipment,
    });
  }
  if (!unique.size) throw new Error("characterdata 中没有与当前弱点方向匹配的个人战斗预设");
  return [...unique.values()];
}

export function resolveEquipmentPresetBaselines(character, catalog, direction, monsterHrid, options = {}) {
  // Manual directions name one of the nine system presets explicitly. The
  // personal-preset source remains available to automatic analysis only.
  const source = !direction?.presetId && options.source === EQUIPMENT_PRESET_SOURCE.personal
    ? EQUIPMENT_PRESET_SOURCE.personal
    : EQUIPMENT_PRESET_SOURCE.system;
  if (source === EQUIPMENT_PRESET_SOURCE.personal) return personalBaselines(character, catalog, direction, monsterHrid);
  const keys = direction?.presetId
    ? [direction.presetId]
    : [automaticPresetKeys(direction, monsterHrid)].flat();
  if (direction?.presetId || keys.length === 1) return keys.map((key) => systemBaseline(character, catalog, key));
  const baselines = [];
  const errors = [];
  for (const key of keys) {
    try {
      baselines.push(systemBaseline(character, catalog, key));
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!baselines.length) throw new Error(errors.join("；"));
  return baselines;
}
