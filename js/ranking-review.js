import {buildSimulationInput} from './player-dto.js';
import {batchSeed,normalizeEvidence} from './learning-library.js';
import {mergeRoomResults} from './engine-adapter.js';

// Equal fresh samples for EVERY certified contender at the same level.
// Review evidence never trains/selects search candidates or enters certification.
export async function reviewRankings(o,{store,lib,root,level,onProgress}){
 const trials=Math.max(10,Math.min(100000,Math.floor(Number(o.rankingTrials)||1000)));
 const rankings={winRate:[],speed:[]};let reviewed=0,total=0;
 if(level===null)return{rankings,reviewed,trials};
 for await(const c of store.values(`${root}/candidate/`))if(c.levels[level]?.status==='certified')total++;
 const guard=async()=>{if(o.signal?.aborted)throw new DOMException('模拟已取消','AbortError');await o.pauseController?.waitIfPaused(o.signal);if(o.signal?.aborted)throw new DOMException('模拟已取消','AbortError');};
 const retain=(list,e,cmp)=>{list.push(e);list.sort(cmp);if(list.length>3)list.length=3;};
 const run=async c=>{
   const key=store.key(`${root}/ranking/${level}/${trials}/${c.id}`);
   let row=await store.get(key)||{candidate:c.index,candidateId:c.id,level,plannedTrials:trials,result:null,pending:null};
   while((row.result?.trials||0)<trials){
     await guard();
     if(!row.pending){const n=Math.min(Math.max(10,Math.min(1000,Number(o.reviewTrials)||300)),trials-(row.result?.trials||0));
       row.pending={trials:n,offset:await lib.reserve(n)};await store.put(key,row);}
     const task=row.pending;
     const input={...buildSimulationInput(o.character,o.catalog,c.plan.equipmentCandidate,c.plan.abilityOrder),monsterHrid:o.monsterHrid,
       roomLevel:level,roomDurationSeconds:120,trials:task.trials,seed:batchSeed(task.offset),plannedConcurrency:Math.max(1,o.engine.workerCount||1)};
     const batchKey=store.key(`${root}/ranking-batch/${task.offset}`);
     let r=await store.get(batchKey);
     if(!r){r=normalizeEvidence(o.auditRecorder?await o.auditRecorder.simulate(o.engine,input,{stage:'ranking',planId:c.id,direction:o.direction,
       candidateIndex:c.index,trialOffset:task.offset,bestLevelAtDispatch:level,reason:'同级等场数独立排名复核',candidateKind:'排名复核',expectedRetest:true}):await o.engine.simulateRoom(input));
       if(r.trials!==task.trials||r.successes+r.failedByDeath+r.failedByTimeout!==r.trials)throw new Error('排名复核场数不完整');
       await store.put(batchKey,r);}
     const {debug,combatStats,...clean}=normalizeEvidence(row.result?mergeRoomResults([row.result,r]):r);
     row.result=clean;row.pending=null;row.auditSequence=o.auditRecorder?.recordCount;await store.put(key,row);
     onProgress?.({phase:'ranking',level,rankingCompleted:reviewed,rankingTotal:total,rankingTrials:trials,reason:`排名复核 ${reviewed}/${total} 套`});
   }
   const v=c.levels[level],entry={plan:c.plan,level,result:row.result,status:v.status,
     certificationResult:{...v.result,interval:v.interval},rankingIndependent:true};
   retain(rankings.winRate,entry,(a,b)=>b.result.clearRate-a.result.clearRate||a.result.averageClearSeconds-b.result.averageClearSeconds||a.plan.key.localeCompare(b.plan.key));
   retain(rankings.speed,entry,(a,b)=>a.result.averageClearSeconds-b.result.averageClearSeconds||b.result.clearRate-a.result.clearRate||a.plan.key.localeCompare(b.plan.key));
   reviewed++;
 };
 const width=Math.max(1,Math.min(64,o.engine.workerCount||1));let wave=[];
 const flush=async()=>{const outcomes=await Promise.allSettled(wave.map(run));wave=[];const error=outcomes.find(x=>x.status==='rejected');if(error)throw error.reason;};
 for await(const c of store.values(`${root}/candidate/`))if(c.levels[level]?.status==='certified'){wave.push(c);if(wave.length>=width)await flush();}
 if(wave.length)await flush();
 return{rankings,reviewed,trials};
}
