import { finiteNumber, structuredCloneSafe } from "./data-model.js";

const COMBAT_SKILLS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"];

function combatLevels(character) {
  const map = Object.fromEntries((character.characterSkills || []).map((entry) => [entry.skillHrid, Math.max(1, Math.floor(finiteNumber(entry.level, 1)))]));
  return Object.fromEntries(COMBAT_SKILLS.map((name) => [name, map[`/skills/${name}`] || 1]));
}

function normalizeBuff(buff) {
  return {
    uniqueHrid: String(buff?.uniqueHrid || ""),
    typeHrid: String(buff?.typeHrid || ""),
    ratioBoost: finiteNumber(buff?.ratioBoost, 0),
    ratioBoostLevelBonus: finiteNumber(buff?.ratioBoostLevelBonus, 0),
    flatBoost: finiteNumber(buff?.flatBoost, 0),
    flatBoostLevelBonus: finiteNumber(buff?.flatBoostLevelBonus, 0),
    startTime: String(buff?.startTime || "0001-01-01T00:00:00Z"),
    duration: Math.max(0, finiteNumber(buff?.duration, 0)),
  };
}

function dedupeBuffs(groups) {
  const result = [];
  const seen = new Set();
  for (const buff of groups.flat()) {
    const normalized = normalizeBuff(buff);
    if (!normalized.typeHrid) continue;
    const key = [normalized.typeHrid, normalized.ratioBoost, normalized.ratioBoostLevelBonus, normalized.flatBoost, normalized.flatBoostLevelBonus, normalized.duration].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function upgradeBuff(key, typeHrid, level, valueKey) {
  const value = Math.max(0, Math.floor(finiteNumber(level, 0))) * 0.01;
  if (value <= 0) return null;
  return normalizeBuff({
    uniqueHrid: `/buff_uniques/labyrinth_upgrade_${key}`,
    typeHrid,
    [valueKey]: value,
  });
}

export function buildLabyrinthCombatBuffs(characterInfo = {}) {
  return [
    upgradeBuff("combat_damage", "/buff_types/damage", characterInfo.labyrinthCombatDamageLevel, "ratioBoost"),
    upgradeBuff("attack_speed", "/buff_types/attack_speed", characterInfo.labyrinthAttackSpeedLevel, "ratioBoost"),
    upgradeBuff("cast_speed", "/buff_types/cast_speed", characterInfo.labyrinthCastSpeedLevel, "flatBoost"),
    upgradeBuff("critical_rate", "/buff_types/critical_rate", characterInfo.labyrinthCriticalRateLevel, "flatBoost"),
  ].filter(Boolean);
}

function buildEquipment(equipmentCandidate) {
  const result = {};
  for (const [type, entry] of Object.entries(equipmentCandidate?.equipment || {})) {
    if (!entry?.hrid) continue;
    result[type] = {
      hrid: String(entry.hrid),
      enhancementLevel: Math.max(0, Math.floor(finiteNumber(entry.enhancementLevel, 0))),
    };
  }
  return result;
}

function buildAbilities(character, catalog, abilityOrder, intelligenceLevel) {
  const learnedLevels = Object.fromEntries((character.characterAbilities || []).map((entry) => [entry.abilityHrid, Math.max(1, Math.floor(finiteNumber(entry.level, 1)))]));
  const requirements = Array.isArray(catalog.abilitySlotsLevelRequirementList)
    ? catalog.abilitySlotsLevelRequirementList
    : [0, 1, 1, 20, 50, 90];
  const result = [];
  for (let index = 0; index < 5; index += 1) {
    const ability = abilityOrder?.abilities?.[index];
    const requiredIntelligence = Math.max(0, finiteNumber(requirements[index + 1], 0));
    if (!ability?.hrid || intelligenceLevel < requiredIntelligence) {
      result.push(null);
      continue;
    }
    const characterConfigured = character.abilityCombatTriggersMap?.[ability.hrid];
    const defaults = catalog.abilityDetailMap?.[ability.hrid]?.defaultCombatTriggers;
    result.push({
      hrid: String(ability.hrid),
      level: Math.max(
        learnedLevels[ability.hrid] || 0,
        Math.max(1, Math.floor(finiteNumber(ability.level, 1))),
      ),
      triggers: structuredCloneSafe(Array.isArray(characterConfigured) ? characterConfigured : Array.isArray(defaults) ? defaults : []),
    });
  }
  return result;
}

export function buildSimulationInput(character, catalog, equipmentCandidate, abilityOrder) {
  const levels = combatLevels(character);
  const houseRooms = {};
  for (const [key, room] of Object.entries(character.characterHouseRoomMap || {})) {
    const hrid = String(room?.houseRoomHrid || key);
    if (hrid) houseRooms[hrid] = Math.max(0, Math.floor(finiteNumber(room?.level, 0)));
  }
  const achievements = {};
  for (const achievement of character.characterAchievements || []) {
    if (achievement?.achievementHrid && achievement.isCompleted) achievements[achievement.achievementHrid] = true;
  }
  const crates = [
    character.labyrinth?.teaCrateItemHrid,
    character.labyrinth?.coffeeCrateItemHrid,
    character.labyrinth?.foodCrateItemHrid,
  ].filter(Boolean).map(String);

  return {
    playerDto: {
      hrid: "player1",
      staminaLevel: levels.stamina,
      intelligenceLevel: levels.intelligence,
      attackLevel: levels.attack,
      meleeLevel: levels.melee,
      defenseLevel: levels.defense,
      rangedLevel: levels.ranged,
      magicLevel: levels.magic,
      equipment: buildEquipment(equipmentCandidate),
      food: [],
      drinks: [],
      abilities: buildAbilities(character, catalog, abilityOrder, levels.intelligence),
      houseRooms,
      achievements,
      debuffOnLevelGap: 0,
    },
    extraBuffs: dedupeBuffs([
      character.buffs?.personal || [],
      character.buffs?.mooPass || [],
      character.buffs?.community || [],
      character.buffs?.guild || [],
    ]),
    labyrinthCombatBuffs: buildLabyrinthCombatBuffs(character.characterInfo),
    mazeCrateItemHrids: [...new Set(crates)],
  };
}
