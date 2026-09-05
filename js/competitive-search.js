import { activeOrderPermutations } from './component-planner.js';
import { buildSimulationInput } from './player-dto.js';
import { fingerprint } from './run-storage.js';
import { LearningLibrary, batchSeed, normalizeEvidence } from './learning-library.js';
import { randomGenerator, planFeatures, predictForest, ModelTrainer } from './learning-model.js';
import { anytimeInterval } from './sequential-confidence.js';
import { mergeRoomResults } from './engine-adapter.js';

const integer=(v,d,min,max)=>Math.max(min,Math.min(max,Math.floor(Number(v)||d)));
const pad=n=>String(n).padStart(12,'0');
const yieldUI=()=>new Promise(r=>setTimeout(r,0));
async function guard(o){if(o.signal?.aborted)throw new DOMException('模拟已取消','AbortError');await o.pauseController?.waitIfPaused(o.signal);if(o.signal?.aborted)throw new DOMException('模拟已取消','AbortError');}
function compact(p){return{key:p.key,baseKey:p.baseKey||p.key,zeroCooldownHrid:p.zeroCooldownHrid,sourcePreset:p.sourcePreset,
 equipmentCandidate:{equipment:Object.fromEntries(Object.entries(p.equipmentCandidate.equipment).map(([k,v])=>[k,{hrid:v.hrid,enhancementLevel:v.enhancementLevel||0}]))},
 abilityOrder:{abilities:p.abilityOrder.abilities.map(a=>a?{hrid:a.hrid,level:a.level||1}:null)}};}
function evidence(r){const {debug,combatStats,...rest}=normalizeEvidence(r);return rest;}
function tokens(p){const a=Object.entries(p.equipmentCandidate.equipment).map(([slot,i])=>`${slot}:${i.hrid}:${i.enhancementLevel}`);
 p.abilityOrder.abilities.forEach((v,i)=>{if(v)a.push(`skill:${i}:${v.hrid}`);});
 const t=[...a];for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)t.push(`${a[i]}|${a[j]}`);return t;}

// No reservoir: the entire legal universe is indexed on disk. A bounded
// scheduling window later changes only ordering, never eligibility.
export async function indexCompetitivePlans(o,root){
 const store=o.runStorage,key=store.key(`${root}/manifest`);const saved=await store.get(key);if(saved?.complete)return saved;
 let count=0,bases=0,buffer=[];
 const flush=async()=>{
   if(buffer.length){
     const unique=new Map();
     for(const p of buffer){const plan=compact(p);const id=await fingerprint({equipment:plan.equipmentCandidate.equipment,abilities:plan.abilityOrder.abilities});unique.set(id,plan);}
     const entries=[...unique],keys=entries.map(([id])=>store.key(`${root}/identity/${id}`));
     const existing=store.getMany?await store.getMany(keys):await Promise.all(keys.map(k=>store.get(k)));
     const writes=[];
     entries.forEach(([id,plan],j)=>{if(existing[j]!==undefined)return;
       const c={index:count++,id,plan,levels:{},low:null,high:o.maxMonsterLevel+1,status:'new',visits:0};
       writes.push([keys[j],c.index],[store.key(`${root}/candidate/${pad(c.index)}`),c]);});
     if(writes.length)await store.batch(writes);buffer=[];
   }
   await guard(o);await yieldUI();
 };
 const add=async p=>{buffer.push(p);if(buffer.length>=128)await flush();};
 // Recover an interrupted index without retaining an in-memory Set of all keys.
 for await(const c of store.values(`${root}/candidate/`))count=Math.max(count,c.index+1);
 if(o.legalPlans){for(const p of o.legalPlans){bases++;await add(p);}}
 else for(const p of o.iterate()){bases++;for(const q of activeOrderPermutations(p))await add({...q,baseKey:p.key});
   if(bases%128===0)o.onProgress?.({learning:true,phase:'index',totalPlans:count,completedPlans:0,sampledPlans:count,progressFraction:0});}
 await flush();if(!count)throw new Error('没有合法配装');
 const manifest={version:42,complete:true,totalOrderedPlans:count,totalBasePlans:bases};
 await store.batch([[key,manifest],[store.key(`competitive42-manifest/${root}`),{root,...manifest}]]);return manifest;
}

// Conditional on non-increasing true win probability with monster level.
// Failure pruning is permitted ONLY by a simultaneous confidence upper bound.
export function nextCompetitiveProbe(c,best,minimum,maximum){
 const baseline=Math.max(minimum,best??minimum);
 if(c.high<=baseline)return null;
 if(c.low==null||c.low<baseline)return{level:baseline,reason:'当前最高等级对比'};
 if(c.low>=maximum||c.high===c.low+1)return null;
 return c.high<=maximum?{level:Math.ceil((c.low+c.high)/2),reason:'二分定位'}:
   {level:Math.min(maximum,c.low+5),reason:'向上增加5级'};
}

export async function searchCompetitiveCandidates(o){
 if(!o.runStorage||!o.learningFamily)throw new Error('全量竞争需要本机存储与版本标识');
 const store=o.runStorage,lib=new LearningLibrary(store,o.learningFamily),root=`competitive42/${o.monsterHrid}`;
 const key=store.key(`${root}/state`),candidateKey=i=>store.key(`${root}/candidate/${pad(i)}`);
 const minimum=integer(o.minMonsterLevel,200,1,5000),maximum=integer(o.maxMonsterLevel,300,minimum,5000);
 const trials=integer(o.testTrials,100,1,10000),step=integer(o.reviewTrials,300,1,10000),cap=integer(o.optimizeTrials,5000,step,100000);
 const target=Math.max(.01,Math.min(.99,Number(o.targetRate)||.7));
 const manifest=await indexCompetitivePlans({...o,minMonsterLevel:minimum,maxMonsterLevel:maximum},root);
 const alpha=.05/(Math.max(1,o.certificationMonsterCount||1)*manifest.totalOrderedPlans*(maximum-minimum+1));
 let s=await store.get(key);
 if(!s){const seed=await lib.reserve(1),history=await lib.sample(o.monsterHrid,1024,randomGenerator(seed));
   s={version:42,...manifest,phase:'learn',done:0,testedPlans:0,resolvedPlans:0,blockedPlans:0,bestLevel:null,upperCounts:{[maximum]:manifest.totalOrderedPlans},possibleLevel:maximum,
     cursor:0,window:[],pending:null,seed,epoch:1,allowance:cap,seenTokens:[],selections:0,samples:history.rows.map(r=>({id:r.pairId,x:r.x,n:r.search.trials,w:r.search.successes})),
     reusedPairs:0,historicalTrainingPairs:history.rows.length,trainingMilliseconds:0,trainedAt:-1,predictionError:{sum:0,count:0},baselineError:0};
   await store.put(key,s);
 }
 if(s.phase==='incomplete'){
   s.phase='learn';s.cursor=0;s.window=[];s.allowance+=cap;s.epoch++;s.blockedPlans=0;await store.put(key,s);
 }
 let model=await lib.model(o.monsterHrid),window=await Promise.all(s.window.map(i=>store.get(candidateKey(i))));
 const trainer=new ModelTrainer(),seenTokens=new Set(s.seenTokens),features=new Map();
 const feature=c=>{if(!features.has(c.index))features.set(c.index,planFeatures(c.plan,o.catalog,0));return features.get(c.index);};
 // Random-looking, bijective traversal across the complete indexed universe.
 const gcd=(a,b)=>b?gcd(b,a%b):a;let stride=Math.max(1,Math.floor(s.totalOrderedPlans*.61803398875));while(gcd(stride,s.totalOrderedPlans)!==1)stride++;
 const indexAt=i=>(i*stride+(s.seed%s.totalOrderedPlans))%s.totalOrderedPlans;
 const save=async(extra=[])=>{s.window=window.map(c=>c.index);s.seenTokens=[...seenTokens];await store.batch([...window.map(c=>[candidateKey(c.index),c]),...extra,[key,s]]);};
 const progress=(level,reason)=>o.onProgress?.({learning:true,competitive:true,phase:s.phase,level,reason,completedPlans:s.resolvedPlans,totalPlans:s.totalOrderedPlans,
   currentPlan:s.testedPlans,phaseCompletedBatches:s.done,phaseTotalBatches:null,progressFraction:s.phase==='complete'?1:Math.min(.99,s.resolvedPlans/s.totalOrderedPlans),
   bestObservedLevel:s.bestLevel,bestCertifiedLevel:s.bestLevel,possibleLevel:s.possibleLevel,sampledPlans:s.totalOrderedPlans,testedPlans:s.testedPlans,blockedPlans:s.blockedPlans,
   historicalTrainingPairs:s.historicalTrainingPairs,reusedPairs:0,phaseComplete:s.phase==='complete'});
 function classify(c){const probe=nextCompetitiveProbe(c,s.bestLevel,minimum,maximum);
   if(!probe){if(c.status!=='resolved')s.resolvedPlans++;c.status='resolved';return null;}
   const pair=c.levels[probe.level];
   if(pair?.result.trials>=s.allowance){if(c.status!=='blocked')s.blockedPlans++;c.status='blocked';return null;}
   c.status='active';return{...probe,reason:pair?'追加统计证据':probe.reason};
 }
 async function fill(){
   const removed=window.filter(c=>c.status==='resolved'||c.status==='blocked');
   if(removed.length){await store.batch(removed.map(c=>[candidateKey(c.index),c]));window=window.filter(c=>!removed.includes(c));for(const c of removed)features.delete(c.index);}
   // This is a refillable memory window, not a candidate cap.
   while(window.length<128&&s.cursor<s.totalOrderedPlans){const c=await store.get(candidateKey(indexAt(s.cursor++)));if(c.status==='resolved')continue;
     if(c.status==='blocked'&&c.epoch===s.epoch)continue;c.epoch=s.epoch;window.push(c);}
 }
 async function runTask(task){await guard(o);const c=window.find(c=>c.index===task.candidate);if(!c)throw new Error('断点缺少待运行候选');
   const completionKey=store.key(`${root}/batch/${task.offset}`);let r=await store.get(completionKey);
   const input={...buildSimulationInput(o.character,o.catalog,c.plan.equipmentCandidate,c.plan.abilityOrder),monsterHrid:o.monsterHrid,roomLevel:task.level,roomDurationSeconds:120,trials:task.trials,seed:batchSeed(task.offset),plannedConcurrency:Math.max(1,o.engine.workerCount||1)};
   if(!r){const context={stage:task.previousTrials?'review':'test',planId:c.id,reason:task.reason,candidateKind:task.queue,expectedRetest:!!task.previousTrials,direction:o.direction,
       candidateIndex:c.index,trialOffset:task.offset,prediction:task.prediction,bestLevelAtDispatch:task.bestLevel};
     r=normalizeEvidence(o.auditRecorder?await o.auditRecorder.simulate(o.engine,input,context):await o.engine.simulateRoom(input));
     if(r.trials!==task.trials||r.successes+r.failedByDeath+r.failedByTimeout!==r.trials)throw new Error('战斗场次不完整，不能计入证据');
     await store.put(completionKey,r);
   }
   const id=await fingerprint({family:o.learningFamily,candidate:c.id,level:task.level});const x={...feature(c),'monster.level':task.level};
   await lib.add({family:o.learningFamily,pairId:id,monsterHrid:o.monsterHrid,level:task.level,plan:c.plan,x,purpose:'search',offset:task.offset,result:r});
   return{task,c,r,id,x};
 }
 async function execute(){const out=await Promise.allSettled(s.pending.map(runTask));const failure=out.find(v=>v.status==='rejected');if(failure)throw failure.reason;
   const decisions=[];
   for(const {value:{task,c,r,id,x}}of out){const old=c.levels[task.level];const result=evidence(old?mergeRoomResults([old.result,r]):r);
     const next=anytimeInterval(result.successes,result.trials,alpha);const interval={lower:Math.max(old?.interval.lower||0,next.lower),upper:Math.min(old?.interval.upper??1,next.upper)};
     if(interval.lower>interval.upper)throw new Error('统计证据区间冲突，请检查战斗数据');
     const status=interval.lower>=target?'certified':interval.upper<target?'failed':'uncertain';
     c.levels[task.level]={result,interval,status};if(!c.visits)s.testedPlans++;c.visits++;s.done++;
     if(status==='certified'){c.low=Math.max(c.low??minimum-1,task.level);s.bestLevel=Math.max(s.bestLevel??minimum-1,task.level);}
     if(status==='failed'&&task.level<c.high){s.upperCounts[c.high-1]--;c.high=task.level;s.upperCounts[c.high-1]=(s.upperCounts[c.high-1]||0)+1;
       s.possibleLevel=Math.max(...Object.entries(s.upperCounts).filter(([l,n])=>n>0&&+l>=minimum).map(([l])=>+l),minimum-1);
       if(s.possibleLevel<minimum)s.possibleLevel=null;
     }
     if(c.low!==null&&c.high<=c.low)throw new Error('达标等级与失败等级冲突，单调搜索前提不成立或证据异常');
     const row={id,x,n:result.trials,w:result.successes};const pos=s.samples.findIndex(v=>v.id===id);
     if(pos>=0)s.samples[pos]=row;else if(s.samples.length<1024)s.samples.push(row);else{const k=Math.floor(randomGenerator(task.offset+19)()*(s.done+1024));if(k<1024)s.samples[k]=row;}
     if(task.prediction!=null){s.predictionError.sum+=(task.prediction-r.clearRate)**2;s.predictionError.count++;s.baselineError+=(.5-r.clearRate)**2;}
     const probe=classify(c);
     decisions.push([store.key(`${root}/decision/${pad(s.done)}`),{sequence:s.done,candidate:c.index,candidateId:c.id,level:task.level,trialOffset:task.offset,
       additionalTrials:r.trials,totalTrials:result.trials,successes:result.successes,interval,status,bestLevel:s.bestLevel,queue:task.queue,prediction:task.prediction,auditSequence:o.auditRecorder?.recordCount,
       reason:task.reason,nextLevel:probe?.level??null,candidateStatus:c.status,monotonicityAssumed:true}]);
   }
   s.pending=null;await save(decisions);
   const last=out.at(-1)?.value.task;progress(last?.level,last?.reason);
 }
 try{
   while(s.phase==='learn'){
     await guard(o);
     if(s.pending){await execute();continue;}
     await fill();
     if(!window.length){
       // Recheck capped contenders against the now-final incumbent without
       // spending more samples; a higher incumbent may legitimately retire them.
       let blocked=0,resolved=0,upper=s.bestLevel;
       for await(const c of store.values(`${root}/candidate/`)){
         const p=nextCompetitiveProbe(c,s.bestLevel,minimum,maximum);
         if(!p){c.status='resolved';resolved++;}
         else{c.status='blocked';blocked++;upper=Math.max(upper??minimum-1,c.high-1);}
         await store.put(candidateKey(c.index),c);
       }
       s.resolvedPlans=resolved;s.blockedPlans=blocked;s.possibleLevel=upper;s.phase=blocked?'incomplete':'complete';await save();break;
     }
     for(const c of window)classify(c);
     const available=window.filter(c=>c.status==='active');if(!available.length){await save();continue;}
     const tasks=[],used=new Set(),concurrency=Math.max(1,Math.min(64,o.engine.workerCount||1));
     for(let k=0;k<concurrency;k++){
       const remaining=available.filter(c=>!used.has(c.index));if(!remaining.length)break;
       const slot=s.selections++,useModel=!o.disableLearning&&model&&slot%4!==0&&
         (s.predictionError.count<32||s.predictionError.sum<=s.baselineError);
       let chosen,queue;
       if(slot%4===0){chosen=remaining.reduce((a,b)=>a.index<b.index?a:b);queue='完整覆盖';}
       else if(useModel){queue='模型建议';chosen=remaining.map(c=>{const p=nextCompetitiveProbe(c,s.bestLevel,minimum,maximum);
           const pred=predictForest(model,{...feature(c),'monster.level':p.level});return{c,score:pred.mean+pred.disagreement*.2};}).sort((a,b)=>b.score-a.score)[0].c;}
       else {queue='组件与搭配覆盖';chosen=remaining.map(c=>({c,score:tokens(c.plan).reduce((n,t)=>n+(!seenTokens.has(t)?1:0),0),tie:randomGenerator(s.seed+c.index+slot)()})).sort((a,b)=>b.score-a.score||a.tie-b.tie)[0].c;}
       used.add(chosen.index);for(const t of tokens(chosen.plan))seenTokens.add(t);
       const p=nextCompetitiveProbe(chosen,s.bestLevel,minimum,maximum),previousTrials=chosen.levels[p.level]?.result.trials||0;
       const n=Math.min(previousTrials?step:trials,s.allowance-previousTrials);
       tasks.push({candidate:chosen.index,level:p.level,trials:n,previousTrials,offset:await lib.reserve(n),queue,
         reason:previousTrials?'追加统计证据':p.reason,bestLevel:s.bestLevel,prediction:queue==='模型建议'?predictForest(model,{...feature(chosen),'monster.level':p.level}).mean:null});
     }
     s.pending=tasks;await save();
     const training=!o.disableLearning&&s.samples.length>=16&&(s.trainedAt<0||s.done-s.trainedAt>=64)?trainer.train(s.samples,s.seed+s.done):null;
     if(training)training.catch(()=>{});
     await execute();
     if(training){model=await training;s.trainedAt=s.done;s.trainingMilliseconds+=model.trainingMilliseconds;await lib.model(o.monsterHrid,model);await save();}
   }
   // Stream the final comparison at exactly the same certified highest level.
   const rankings={winRate:[],speed:[]};let fallback=null;
   const retain=(list,e,compare)=>{list.push(e);list.sort(compare);if(list.length>3)list.length=3;};
   for await(const c of store.values(`${root}/candidate/`)){
     for(const [l,v]of Object.entries(c.levels)){
       const entry={plan:c.plan,level:+l,result:{...v.result,interval:v.interval},status:v.status};
       if(!fallback||v.result.clearRate>fallback.result.clearRate)fallback=entry;
       if(+l!==s.bestLevel||v.status!=='certified')continue;
       retain(rankings.winRate,entry,(a,b)=>b.result.clearRate-a.result.clearRate||a.result.averageClearSeconds-b.result.averageClearSeconds||a.plan.key.localeCompare(b.plan.key));
       retain(rankings.speed,entry,(a,b)=>a.result.averageClearSeconds-b.result.averageClearSeconds||b.result.clearRate-a.result.clearRate||a.plan.key.localeCompare(b.plan.key));
     }
   }
   progress();return{state:s,rankings,fallback,minimum,maximum,target,maximumValidation:cap,alpha};
 }finally{trainer.close();}
}
