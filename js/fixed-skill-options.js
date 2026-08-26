import { classifyAbility } from "./classifier.js";

export const DEFAULT_FIXED_ABILITY_RULES = Object.freeze({
  magic: Object.freeze({ aura: "", requiredActives: Object.freeze([]) }),
  physical: Object.freeze({ aura: "", requiredActives: Object.freeze([]) }),
  mimic: Object.freeze({ aura: "", requiredActives: Object.freeze([]) }),
});
export const NEVER_SELECTABLE_ABILITY_HRIDS = new Set([
  "/abilities/taunt", "/abilities/provoke", "/abilities/minor_heal",
  "/abilities/heal", "/abilities/rejuvenate",
]);

function learnedLevelMap(character) {
  return new Map((character?.characterAbilities || [])
    .filter((entry) => entry?.abilityHrid && Number(entry.level) > 0)
    .map((entry) => [entry.abilityHrid, Math.max(1, Math.floor(Number(entry.level)))]));
}

export function learnedFixedAbilityChoices(catalog, character, wantAura) {
  const levels = learnedLevelMap(character);
  return Object.entries(catalog?.abilityDetailMap || {})
    .map(([mapHrid, raw]) => {
      const hrid = String(raw?.hrid || mapHrid || "");
      const learnedLevel = levels.get(hrid);
      return hrid && learnedLevel ? { ...raw, hrid, learnedLevel } : null;
    })
    .filter((entry) => entry && !NEVER_SELECTABLE_ABILITY_HRIDS.has(entry.hrid) && classifyAbility(entry).isAura === wantAura)
    .sort((left, right) => String(left.name || left.hrid).localeCompare(String(right.name || right.hrid), "zh-CN"));
}

function normalizeCategory(raw, defaults) {
  const legacyActives = [1, 2, 3, 4]
    .map((slot) => raw?.[`active${slot}`])
    .filter((value) => value && value !== "__auto_zero__");
  const requiredActives = raw == null
    ? defaults.requiredActives
    : Array.isArray(raw?.requiredActives) ? raw.requiredActives : legacyActives;
  return {
    aura: raw && Object.hasOwn(raw, "aura") ? String(raw.aura || "") : defaults.aura,
    requiredActives: [...new Set(requiredActives
      .map((value) => String(value || ""))
      .filter(Boolean))].slice(0, 4),
  };
}

export function normalizeFixedAbilityRules(rules = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_FIXED_ABILITY_RULES).map(([key, defaults]) => [
    key,
    normalizeCategory(rules?.[key], defaults),
  ]));
}

export function sanitizeFixedAbilityRules(rules, catalog, character) {
  const normalized = normalizeFixedAbilityRules(rules);
  const auraHrids = new Set(learnedFixedAbilityChoices(catalog, character, true).map((entry) => entry.hrid));
  const activeHrids = new Set(learnedFixedAbilityChoices(catalog, character, false).map((entry) => entry.hrid));
  for (const category of Object.values(normalized)) {
    if (category.aura && !auraHrids.has(category.aura)) category.aura = "";
    category.requiredActives = category.requiredActives.filter((hrid) => activeHrids.has(hrid));
  }
  return normalized;
}
