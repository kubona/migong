import { classifyMonster } from './classifier.js';
import { monsterLevelToFloorRange } from './data-model.js';
import { prepareDirection, directionProfile, resolveSimulationDirections, resultMetrics } from './exhaustive-optimizer.js';
import { searchStagedCandidates } from './staged-search.js';
import { wilsonInterval } from './statistics.js';

export const searchLearningCandidates=searchStagedCandidates;
export async function optimizeMonsterLearning(o){
 const profile=classifyMonster(o.catalog.combatMonsterDetailMap[o.monsterHrid],{roomLevel:100,playerCombatDetails:o.character.combatDetails});
 const intelligence=o.character.characterSkills.find(s=>s.skillHrid==='/skills/intelligence')?.level||1;
 if(intelligence<(o.catalog.abilitySlotsLevelRequirementList?.[5]||90))throw new Error('尚未解锁完整战斗技能槽');
 const direction=resolveSimulationDirections(profile,o.simulationDirection)[0];
 const prepared=prepareDirection({...o,direction,profile:directionProfile(profile,direction),selectedEquipmentTypes:o.optimizableEquipmentTypes||[],minimumEquipmentLevel:80});
 const run=await searchStagedCandidates({...o,direction,iterate:prepared.iterate,onProgress:p=>o.onProgress?.({...p,monsterHrid:o.monsterHrid,direction})});
 const s=run.state;
 const convert=(e,i)=>({plan:e.plan,result:e.result,certificationResult:e.certificationResult,rankingIndependent:!!e.rankingIndependent,
   metrics:{...resultMetrics(e.result),robustSuccessLower:wilsonInterval(e.result.successes,e.result.trials).lower},
   monsterLevel:e.level,direction,targetMet:e.status==='passed',certification:e.status,rank:i+1});
 const rankings={winRate:run.rankings.winRate.map(convert),speed:run.rankings.speed.map(convert)};
 if(!rankings.winRate.length&&run.fallback)rankings.winRate=[convert(run.fallback,0)];
 const best=rankings.winRate[0];
 if(!best)throw Error('没有可展示的战斗结果');
 const level=s.bestLevel??best.monsterLevel,targetMet=best.targetMet&&best.rankingIndependent;
 return {monsterHrid:o.monsterHrid,name:profile.name,profile,chosenDirection:direction,
   simulationDirectionSelection:o.simulationDirection||'auto',simulationDirectionMode:!o.simulationDirection||o.simulationDirection==='auto'?'auto':'manual',
   equipmentPresetSource:o.equipmentPresetSource,highestMonsterLevel:level,highestLevel:level,
   estimatedHighestFloorRange:monsterLevelToFloorRange(level),targetMet,searchHighestLevel:s.bestLevel,
   searchCapped:s.bestLevel===run.maximum,bestPlan:best.plan,finalResult:best.result,finalMetrics:best.metrics,
   certificationResult:best.certificationResult,rankingIndependent:best.rankingIndependent,
   rankingReview:{trials:s.rankingTrials,candidates:s.rankingReviewed},rankings,learning:true,staged:true,
   searchComplete:s.phase==='complete',possibleHighestLevel:null,certification:best.certification,
   directionWorkflows:[{direction,rankings,optimizationLevel:level}],
   candidateCounts:{savedPlans:s.totalBasePlans,orderedPlans:s.totalBasePlans,sampledOrderedPlans:s.totalBasePlans,
     simulatedPlans:s.testedPlans,resolvedPlans:s.resolvedPlans,discardedPlans:s.discardedPlans,blockedPlans:0,reusedPairs:0,finalOrders:s.rankingReviewed},
   searchDiagnostics:{learningBatches:s.done,trainingMilliseconds:0,historicalTrainingPairs:0,predictionRMSE:null},
   searchPolicy:{method:'预设白名单缩量 + 无序技能集合 + 首套二分 + 精确粗筛 + 逐级测试 + 独立纪录确认 + 最终全部顺序独立排名',
     targetRate:run.target,tolerance:.02,retestBand:.05,rankingDistinctSkillSets:true,rankingLimit:5,coarseOneSidedConfidence:.95,familywiseConfidence:null,
     confidenceScope:'粗筛置信度仅针对单次判断；结果为有限样本经验搜索',globalOptimalityProven:false,conditionalOptimalityCertified:false,
     monotonicityAssumedForElimination:true,rankingStatisticallyCertified:false,historyUsedForCertification:false,
     levelBounds:{minimum:run.minimum,maximum:run.maximum}},
   issues:[{type:targetMet?'stable':'survivability',text:s.bestLevel===null?'所选范围内没有建立达标纪录。':
     targetMet?'同级顺序排名已完成；胜率为独立样本结果，接近的名次仍可能波动。':'搜索等级的最终复核未达标，保留实际胜率，不自动回退等级。'}],
   simulationAuditSummary:o.auditRecorder?.summary({monsterHrid:o.monsterHrid})||null};
}
