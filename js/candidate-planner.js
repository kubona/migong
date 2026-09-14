import {classifyMonster} from './classifier.js';
import {buildCurrentBaseline,buildTargetedComponentPool,iterateUniqueComponentPlans} from './component-planner.js';
import {SIMULATION_DIRECTION_AUTO,manualSimulationDirection,resolveEquipmentPresetBaselines,presetRotationPool,ROTATION_EQUIPMENT} from './equipment-presets.js';
const MAIN_HAND='/equipment_types/main_hand',TWO_HAND='/equipment_types/two_hand';
function checkAbort(signal){if(signal?.aborted)throw new DOMException('模拟已停止','AbortError');}
export function directionProfile(profile, direction) {
  const specialStrategy = direction?.strategyId === "retaliation_thorns"
    ? { ...(profile.specialStrategy || {}), id: direction.strategyId, zh: direction.strategyZh || "反伤·荆棘" }
    : direction?.selectionMode === "manual" ? null : profile.specialStrategy;
  return {
    ...profile,
    selectedStyles: profile.styles.filter((entry) => entry.hrid === direction.styleHrid),
    selectedStyleHrids: new Set([direction.styleHrid]),
    selectedDirections: [direction],
    preferredDamageTypes: profile.damageTypes.filter((entry) => entry.hrid === direction.damageTypeHrid),
    specialStrategy,
  };
}

export function resolveSimulationDirections(profile, selection = SIMULATION_DIRECTION_AUTO) {
  if (selection && selection !== SIMULATION_DIRECTION_AUTO) {
    const manual = manualSimulationDirection(selection);
    if (!manual) throw new Error(`未知模拟方向：${selection}`);
    return [manual];
  }
  const primary = profile?.selectedDirections?.[0];
  if (!primary) throw new Error("怪物没有可用的第一弱点方向");
  return [{ ...primary, selectionMode: "auto", presetLabel: "自动最优" }];
}

export function prepareDirection(options) {
  const intelligence=options.character.characterSkills?.find(s=>s.skillHrid==='/skills/intelligence')?.level||1;
  if(intelligence<(options.catalog.abilitySlotsLevelRequirementList?.[5]??90))throw Error('尚未解锁全部战斗技能槽');
  const selectedTypes = new Set([...(options.selectedEquipmentTypes || [])].filter(type => ROTATION_EQUIPMENT[type]));
  const poolTypes = new Set(selectedTypes);
  if (selectedTypes.has(MAIN_HAND)) poolTypes.add(TWO_HAND);
  const pool = buildTargetedComponentPool(options.character, options.catalog, options.profile, options.direction, {
    minimumEquipmentLevel: options.minimumEquipmentLevel,
    selectedEquipmentTypes: [],
  });
  const abilityBaseline = buildCurrentBaseline(options.character, options.catalog, pool);
  const equipmentBaselines = resolveEquipmentPresetBaselines(
    options.character,
    options.catalog,
    options.direction,
    options.monsterHrid,
    { source: options.equipmentPresetSource, selectedEquipmentTypes: selectedTypes },
  );
  const iterate = function* () {
    const seenEquipment = new Set();
    const skillGroups = new Map();
    for (const equipmentBaseline of equipmentBaselines) {
      const baseline = { ...abilityBaseline, ...equipmentBaseline };
      const branchPool = { ...pool, equipmentPools: presetRotationPool(options.character, options.catalog, baseline, selectedTypes) };
      yield* iterateUniqueComponentPlans(baseline, branchPool, options.direction, options.monsterHrid, {
      seenEquipment,
      skillGroups,
      selectedEquipmentTypes: selectedTypes,
      optimizeAura: options.optimizeAura,
      optimizeActives: options.optimizeActives,
      fixedAbilityRules: options.fixedAbilityRules,
      });
    }
  };
  return {pool,equipmentBaselines,iterate};
}

export async function previewMonster(options) {
  const profile = classifyMonster(options.catalog.combatMonsterDetailMap[options.monsterHrid], {roomLevel:100,playerCombatDetails:options.character.combatDetails});
  const direction = resolveSimulationDirections(profile,options.simulationDirection)[0];
  const prepared = prepareDirection({...options,profile:directionProfile(profile,direction),direction,
    selectedEquipmentTypes:options.optimizableEquipmentTypes || options.selectedEquipmentTypes || []});
  let count = 0;
  const usedAuras=new Map(),usedActives=new Map(),usedEquipment={};
  for(const plan of prepared.iterate()) {
    count++;
    const [aura,...actives]=plan.abilityOrder.abilities;
    usedAuras.set(aura.hrid,aura);for(const a of actives)usedActives.set(a.hrid,a);
    for(const [slot,item]of Object.entries(plan.equipmentCandidate.equipment)) (usedEquipment[slot] ||= new Map()).set(`${item.hrid}@${item.enhancementLevel}`,item);
    if(count%512===0) {checkAbort(options.signal); await new Promise(r=>setTimeout(r,0));}
  }
  return {profile,direction,pool:prepared.pool,baselines:prepared.equipmentBaselines,count,
    usedAuras:[...usedAuras.values()],usedActives:[...usedActives.values()],
    usedEquipment:Object.fromEntries(Object.entries(usedEquipment).map(([slot,entries])=>[slot,[...entries.values()]]))};
}
