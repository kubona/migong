export const COMBAT_EQUIPMENT_TYPES = new Set([
  "/equipment_types/head",
  "/equipment_types/body",
  "/equipment_types/legs",
  "/equipment_types/feet",
  "/equipment_types/hands",
  "/equipment_types/main_hand",
  "/equipment_types/two_hand",
  "/equipment_types/off_hand",
  "/equipment_types/pouch",
  "/equipment_types/back",
  "/equipment_types/neck",
  "/equipment_types/earrings",
  "/equipment_types/ring",
]);

export const LABYRINTH_MONSTER_HRIDS = [
  "/monsters/shadow_archer",
  "/monsters/pyre_hunter",
  "/monsters/frost_sniper",
  "/monsters/siren",
  "/monsters/salamander",
  "/monsters/dryad",
  "/monsters/giant_scorpion",
  "/monsters/giant_mantis",
  "/monsters/cyclops",
  "/monsters/mimic",
];

export const MONSTER_ZH_NAMES = {
  "/monsters/shadow_archer": "暗影弓手",
  "/monsters/pyre_hunter": "火焰猎手",
  "/monsters/frost_sniper": "霜冻狙击手",
  "/monsters/siren": "海妖",
  "/monsters/salamander": "火蜥蜴",
  "/monsters/dryad": "树精",
  "/monsters/giant_scorpion": "巨蝎",
  "/monsters/giant_mantis": "巨螳螂",
  "/monsters/cyclops": "独眼巨人",
  "/monsters/mimic": "宝箱怪",
};

const REQUIRED_CLIENT_FIELDS = [
  "itemDetailMap",
  "abilityDetailMap",
  "combatMonsterDetailMap",
  "enhancementLevelTotalBonusMultiplierTable",
  "labyrinthCrateDetailMap",
];

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function positiveInteger(value, fallback = 1) {
  return Math.max(1, Math.floor(finiteNumber(value, fallback)));
}

export const LABYRINTH_MONSTER_LEVELS_PER_FLOOR = 20;

export function monsterLevelToFloorRange(monsterLevel) {
  const level = Math.max(LABYRINTH_MONSTER_LEVELS_PER_FLOOR, Math.floor(finiteNumber(monsterLevel, LABYRINTH_MONSTER_LEVELS_PER_FLOOR)));
  const minimum = Math.max(1, Math.ceil((level - LABYRINTH_MONSTER_LEVELS_PER_FLOOR) / LABYRINTH_MONSTER_LEVELS_PER_FLOOR));
  const maximum = Math.max(1, Math.floor(level / LABYRINTH_MONSTER_LEVELS_PER_FLOOR));
  return { minimum, maximum, boundary: minimum !== maximum };
}

export function floorRangeText(range) {
  const minimum = Math.max(1, Math.floor(finiteNumber(range?.minimum, 1)));
  const maximum = Math.max(minimum, Math.floor(finiteNumber(range?.maximum, minimum)));
  return minimum === maximum ? `第 ${minimum} 层` : `第 ${minimum}-${maximum} 层边界`;
}

export function monsterLevelBandForFloor(floor) {
  const normalizedFloor = Math.max(1, Math.floor(finiteNumber(floor, 1)));
  const minimum = normalizedFloor * LABYRINTH_MONSTER_LEVELS_PER_FLOOR;
  return { minimum, maximum: minimum + LABYRINTH_MONSTER_LEVELS_PER_FLOOR };
}

export function resolveReferenceMonsterLevel(character) {
  const observedLevels = [];
  for (const row of character?.labyrinth?.roomData || []) {
    if (!Array.isArray(row)) continue;
    for (const room of row) {
      const level = Math.floor(finiteNumber(room?.recommendedLevel, 0));
      if (level > 0) observedLevels.push(level);
    }
  }
  const highestFloor = Math.max(0, Math.floor(finiteNumber(character?.characterInfo?.labyrinthHighestFloor, 0)));
  const historicalMinimum = highestFloor > 0 ? monsterLevelBandForFloor(highestFloor).minimum : 0;
  return Math.max(LABYRINTH_MONSTER_LEVELS_PER_FLOOR, historicalMinimum, ...observedLevels);
}

export function parseJsonText(text, label = "JSON") {
  let value;
  try {
    value = JSON.parse(String(text || ""));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 顶层必须是对象`);
  }
  return value;
}

function cleanTriggerMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const result = {};
  for (const [hrid, triggers] of Object.entries(raw)) {
    if (!hrid || !Array.isArray(triggers)) continue;
    result[hrid] = triggers.map((trigger) => ({
      dependencyHrid: String(trigger?.dependencyHrid || ""),
      conditionHrid: String(trigger?.conditionHrid || ""),
      comparatorHrid: String(trigger?.comparatorHrid || ""),
      value: finiteNumber(trigger?.value, 0),
    }));
  }
  return result;
}

function cleanWearableMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const result = {};
  for (const [slot, reference] of Object.entries(raw)) {
    if (slot === "charm" || slot === "/item_locations/charm") continue;
    if (typeof reference === "string") {
      result[slot] = reference;
      continue;
    }
    if (reference && typeof reference === "object") {
      result[slot] = {
        itemHrid: String(reference.itemHrid || reference.hrid || ""),
        enhancementLevel: Math.max(0, Math.floor(finiteNumber(reference.enhancementLevel, 0))),
      };
    }
  }
  return result;
}

function cleanLoadouts(raw) {
  if (!raw || typeof raw !== "object") return {};
  const result = {};
  for (const [id, loadout] of Object.entries(raw)) {
    if (!loadout || typeof loadout !== "object") continue;
    result[id] = {
      id: loadout.id ?? id,
      actionTypeHrid: String(loadout.actionTypeHrid || ""),
      name: String(loadout.name || ""),
      isDefault: Boolean(loadout.isDefault),
      useExactEnhancement: Boolean(loadout.useExactEnhancement),
      wearableMap: cleanWearableMap(loadout.wearableMap),
      foodItemHrids: Array.isArray(loadout.foodItemHrids) ? loadout.foodItemHrids.map(String) : [],
      drinkItemHrids: Array.isArray(loadout.drinkItemHrids) ? loadout.drinkItemHrids.map(String) : [],
      abilityMap: { ...(loadout.abilityMap || {}) },
      abilityCombatTriggersMap: cleanTriggerMap(loadout.abilityCombatTriggersMap),
      consumableCombatTriggersMap: cleanTriggerMap(loadout.consumableCombatTriggersMap),
    };
  }
  return result;
}

function combatBuffsFromMap(raw) {
  if (!raw || typeof raw !== "object") return [];
  const combat = raw["/action_types/combat"];
  return Array.isArray(combat) ? structuredCloneSafe(combat) : [];
}

export function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function sanitizeCharacterData(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("init_character_data 顶层必须是对象");
  }
  if (!Array.isArray(raw.characterItems) || !Array.isArray(raw.characterSkills) || !Array.isArray(raw.characterAbilities)) {
    throw new Error("init_character_data 缺少 characterItems、characterSkills 或 characterAbilities");
  }

  const sanitized = {
    type: "sanitized_init_character_data",
    sourceType: String(raw.type || ""),
    currentTimestamp: String(raw.currentTimestamp || ""),
    character: {
      gameMode: String(raw.character?.gameMode || ""),
    },
    characterInfo: {},
    characterSkills: raw.characterSkills.map((entry) => ({
      skillHrid: String(entry?.skillHrid || ""),
      experience: finiteNumber(entry?.experience, 0),
      level: positiveInteger(entry?.level, 1),
    })).filter((entry) => entry.skillHrid),
    characterAbilities: raw.characterAbilities.map((entry) => ({
      abilityHrid: String(entry?.abilityHrid || ""),
      experience: finiteNumber(entry?.experience, 0),
      level: positiveInteger(entry?.level, 1),
      slotNumber: Math.max(0, Math.floor(finiteNumber(entry?.slotNumber, 0))),
    })).filter((entry) => entry.abilityHrid),
    characterItems: raw.characterItems.map((entry) => ({
      itemLocationHrid: String(entry?.itemLocationHrid || ""),
      itemHrid: String(entry?.itemHrid || ""),
      enhancementLevel: Math.max(0, Math.floor(finiteNumber(entry?.enhancementLevel, 0))),
      count: Math.max(0, Math.floor(finiteNumber(entry?.count, 0))),
    })).filter((entry) => entry.itemHrid && entry.count > 0),
    abilityCombatTriggersMap: cleanTriggerMap(raw.abilityCombatTriggersMap),
    consumableCombatTriggersMap: cleanTriggerMap(raw.consumableCombatTriggersMap),
    characterLoadoutMap: cleanLoadouts(raw.characterLoadoutMap),
    characterHouseRoomMap: {},
    characterAchievements: [],
    labyrinth: raw.labyrinth ? {
      currentFloor: Math.max(0, Math.floor(finiteNumber(raw.labyrinth.currentFloor, 0))),
      teaCrateItemHrid: String(raw.labyrinth.teaCrateItemHrid || ""),
      coffeeCrateItemHrid: String(raw.labyrinth.coffeeCrateItemHrid || ""),
      foodCrateItemHrid: String(raw.labyrinth.foodCrateItemHrid || ""),
      roomData: Array.isArray(raw.labyrinth.roomData) ? structuredCloneSafe(raw.labyrinth.roomData) : [],
    } : null,
    combatDetails: raw.combatUnit?.combatDetails ? structuredCloneSafe(raw.combatUnit.combatDetails) : null,
    buffs: {
      personal: combatBuffsFromMap(raw.personalActionTypeBuffsMap),
      mooPass: combatBuffsFromMap(raw.mooPassActionTypeBuffsMap),
      community: combatBuffsFromMap(raw.communityActionTypeBuffsMap),
      guild: combatBuffsFromMap(raw.guildActionTypeBuffsMap),
    },
  };

  const infoKeys = [
    "labyrinthHighestFloor",
    "labyrinthCombatDamageLevel",
    "labyrinthAttackSpeedLevel",
    "labyrinthCastSpeedLevel",
    "labyrinthCriticalRateLevel",
    "labyrinthExperienceLevel",
  ];
  for (const key of infoKeys) {
    sanitized.characterInfo[key] = Math.max(0, Math.floor(finiteNumber(raw.characterInfo?.[key], 0)));
  }

  for (const [hrid, room] of Object.entries(raw.characterHouseRoomMap || {})) {
    if (!hrid) continue;
    sanitized.characterHouseRoomMap[hrid] = {
      houseRoomHrid: String(room?.houseRoomHrid || hrid),
      level: Math.max(0, Math.floor(finiteNumber(room?.level, 0))),
    };
  }
  sanitized.characterAchievements = (raw.characterAchievements || []).map((entry) => ({
    achievementHrid: String(entry?.achievementHrid || ""),
    isCompleted: Boolean(entry?.isCompleted),
  })).filter((entry) => entry.achievementHrid);

  return sanitized;
}

export function validateClientData(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["init_client_data 顶层不是对象"], warnings: [] };
  }
  const errors = REQUIRED_CLIENT_FIELDS.filter((field) => raw[field] == null).map((field) => `缺少 ${field}`);
  const warnings = [];
  for (const hrid of LABYRINTH_MONSTER_HRIDS) {
    if (!raw.combatMonsterDetailMap?.[hrid]) warnings.push(`缺少迷宫怪物 ${hrid}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function summarizeCharacter(character) {
  return {
    timestamp: character.currentTimestamp,
    itemStacks: character.characterItems.length,
    learnedAbilities: character.characterAbilities.length,
    skills: character.characterSkills.length,
    loadouts: Object.keys(character.characterLoadoutMap).length,
    currentFloor: character.labyrinth?.currentFloor || 0,
    highestFloor: character.characterInfo.labyrinthHighestFloor || 0,
  };
}

export function compareCharacterToCatalog(character, catalog) {
  const warnings = [];
  const missingItems = [...new Set(character.characterItems.map((entry) => entry.itemHrid).filter((hrid) => !catalog.itemDetailMap?.[hrid]))];
  const missingAbilities = [...new Set(character.characterAbilities.map((entry) => entry.abilityHrid).filter((hrid) => !catalog.abilityDetailMap?.[hrid]))];
  if (missingItems.length) warnings.push(`${missingItems.length} 个角色物品不在当前游戏数据中`);
  if (missingAbilities.length) warnings.push(`${missingAbilities.length} 个角色技能不在当前游戏数据中`);
  return { missingItems, missingAbilities, warnings };
}
