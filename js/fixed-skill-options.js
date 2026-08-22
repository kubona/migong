import { classifyAbility } from "./classifier.js";

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
    .filter((entry) => entry && classifyAbility(entry).isAura === wantAura)
    .sort((left, right) => String(left.name || left.hrid).localeCompare(String(right.name || right.hrid), "zh-CN"));
}

export function sanitizeFixedAbilityRules(rules, catalog, character) {
  const normalized = structuredClone(rules || {});
  const auraHrids = new Set(learnedFixedAbilityChoices(catalog, character, true).map((entry) => entry.hrid));
  const activeHrids = new Set(learnedFixedAbilityChoices(catalog, character, false).map((entry) => entry.hrid));
  for (const category of Object.values(normalized)) {
    for (const [key, value] of Object.entries(category || {})) {
      if (!value || value === "__auto_zero__") continue;
      const available = key === "aura" ? auraHrids : activeHrids;
      if (!available.has(value)) category[key] = "";
    }
  }
  return normalized;
}
