import { classifyMonster } from './classifier.js';
import { monsterLevelToFloorRange } from './data-model.js';
import { prepareDirection, directionProfile, resolveSimulationDirections, resultMetrics } from './exhaustive-optimizer.js';
import { searchCompetitiveCandidates } from './competitive-search.js';

export const searchLearningCandidates=searchCompetitiveCandidates;
export async function optimizeMonsterLearning(o){
 const profile=classifyMonster(o.catalog.combatMonsterDetailMap[o.monsterHrid],{roomLevel:100,playerCombatDetails:o.character.combatDetails});
 const intelligence=o.character.characterSkills.find(s=>s.skillHrid==='/skills/intelligence')?.level||1;
 if(intelligence<(o.catalog.abilitySlotsLevelRequirementList?.[5]||90))throw new Error('尚未解锁完整战斗技能槽');
 const direction=resolveSimulationDirections(profile,o.simulationDirection)[0];
 const prepared=prepareDirection({...o,direction,profile:directionProfile(profile,direction),selectedEquipmentTypes:o.optimizableEquipmentTypes||[],minimumEquipmentLevel:80});
 const run=await searchCompetitiveCandidates({...o,direction,iterate:prepared.iterate,onProgress:p=>o.onProgress?.({...p,monsterHrid:o.monsterHrid,direction})});
 const s=run.state,targetMet=s.bestLevel!==null;
 const convert=(e,i)=>({plan:e.plan,result:e.result,metrics:resultMetrics(e.result),monsterLevel:e.level,direction,targetMet:e.status==='certified',certification:e.status,rank:i+1});
 const rankings={winRate:run.rankings.winRate.map(convert),speed:run.rankings.speed.map(convert)};
 if(!targetMet&&run.fallback){rankings.winRate=[convert(run.fallback,0)];rankings.speed=[convert(run.fallback,0)];}
 const best=rankings.winRate[0];if(!best)throw new Error('没有可展示的战斗结果');
 const level=targetMet?s.bestLevel:best.monsterLevel,complete=s.phase==='complete';
 return{monsterHrid:o.monsterHrid,name:profile.name,profile,chosenDirection:direction,
   simulationDirectionSelection:o.simulationDirection||'auto',simulationDirectionMode:!o.simulationDirection||o.simulationDirection==='auto'?'auto':'manual',equipmentPresetSource:o.equipmentPresetSource,
   highestMonsterLevel:level,highestLevel:level,estimatedHighestFloorRange:monsterLevelToFloorRange(level),targetMet,
   searchCapped:targetMet&&level===run.maximum,bestPlan:best.plan,finalResult:best.result,finalMetrics:best.metrics,rankings,learning:true,
   searchComplete:complete,possibleHighestLevel:s.possibleLevel,certification:targetMet?'certified':'not-certified',directionWorkflows:[{direction,rankings,optimizationLevel:level}],
   candidateCounts:{savedPlans:s.totalBasePlans,orderedPlans:s.totalOrderedPlans,sampledOrderedPlans:s.totalOrderedPlans,simulatedPlans:s.testedPlans,resolvedPlans:s.resolvedPlans,blockedPlans:s.blockedPlans,reusedPairs:0},
   searchDiagnostics:{learningBatches:s.done,trainingMilliseconds:s.trainingMilliseconds,historicalTrainingPairs:s.historicalTrainingPairs,
     predictionRMSE:s.predictionError.count?Math.sqrt(s.predictionError.sum/s.predictionError.count):null},
   searchPolicy:{method:'完整候选竞争 + 在线学习排序 + 当前等级对比 + 每次上探5级 + 失败后二分',targetRate:run.target,familywiseConfidence:.95,
     confidenceScope:'本次任务全部选中怪物、合法有序配装、允许等级及全部样本数',globalOptimalityProven:false,conditionalOptimalityCertified:complete&&targetMet,
     monotonicityAssumedForElimination:true,rankingStatisticallyCertified:false,searchBudgetBatches:null,historyUsedForCertification:false,
     validationMaximumAdditionalTrialsPerPair:run.maximumValidation,levelBounds:{minimum:run.minimum,maximum:run.maximum}},
   issues:[{type:targetMet?'stable':'survivability',text:!targetMet?(complete?'所选范围内没有确认达标的方案。':'尚有未确定方案，可恢复任务继续确认。'):
     complete?'最高等级已确认（基于等级单调假设）；同等级榜单按实测值排序。':`当前确认 Lv.${level}，仍有 ${s.blockedPlans} 套待确认；可恢复任务继续计算。`}],
   simulationAuditSummary:o.auditRecorder?.summary({monsterHrid:o.monsterHrid})||null};
}
