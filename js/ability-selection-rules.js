import { finiteNumber } from "./data-model.js";
import { classifyAbility } from "./classifier.js";

const COMBAT_SKILLS = new Set([
  "/skills/attack", "/skills/melee", "/skills/ranged", "/skills/magic",
  "/skills/defense", "/skills/stamina", "/skills/intelligence",
]);

const requirementMapCache = new WeakMap();

function requirementMap(catalog) {
  if (!catalog || typeof catalog !== "object") return new Map();
  if (requirementMapCache.has(catalog)) return requirementMapCache.get(catalog);
  const result = new Map();
  for (const item of Object.values(catalog.itemDetailMap || {})) {
    const abilityHrid = String(item?.abilityBookDetail?.abilityHrid || "");
    if (!abilityHrid) continue;
    const level = Math.max(0, ...(item.abilityBookDetail.levelRequirements || [])
      .filter((entry) => COMBAT_SKILLS.has(entry?.skillHrid))
      .map((entry) => Math.max(0, Math.floor(finiteNumber(entry?.level, 0)))));
    result.set(abilityHrid, Math.max(level, result.get(abilityHrid) || 0));
  }
  requirementMapCache.set(catalog, result);
  return result;
}

export function abilityCombatRequirementLevel(catalog, abilityHrid) {
  return requirementMap(catalog).get(String(abilityHrid || "")) || 0;
}

export function isMagicZeroCooldownActive(ability, direction = null) {
  if (!ability || ability.isSpecialAbility || finiteNumber(ability.cooldownDuration, -1) !== 0) return false;
  const classification = classifyAbility(ability);
  if (!classification.styles.has("/combat_styles/magic")) return false;
  if (direction?.styleHrid && direction.styleHrid !== "/combat_styles/magic") return false;
  return !direction?.damageTypeHrid || classification.damageTypes.has(direction.damageTypeHrid);
}

export function blocksLevelOneActive(catalog, ability, direction = null) {
  if (!ability || ability.isSpecialAbility) return false;
  const hrid = String(ability.hrid || "");
  return abilityCombatRequirementLevel(catalog, hrid) === 1
    && !isMagicZeroCooldownActive(ability, direction);
}
