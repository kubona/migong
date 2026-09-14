import {fingerprint} from './run-storage.js';
import {buildSimulationInput} from './player-dto.js';
import {mergeRoomResults} from './engine-adapter.js';
import {activeOrderPermutations,unorderedPlanKey} from './component-planner.js';
import {coarseRejected,needsBoundaryRetest} from './staged-statistics.js';
import {meetsFinalTarget} from './statistics.js';
import {roomMetrics,checkpoints,retainFrontier} from './exploration-math.js';

const pad=n=>String(n).padStart(8,'0');
const compact=plan=>({key:unorderedPlanKey(plan),sourcePreset:plan.sourcePreset,zeroCooldownHrid:plan.zeroCooldownHrid,
 equipmentCandidate:{equipment:Object.fromEntries(Object.entries(plan.equipmentCandidate.equipment).map(([k,v])=>[k,{hrid:v.hrid,enhancementLevel:v.enhancementLevel||0}]))},
 abilityOrder:{abilities:plan.abilityOrder.abilities.map(a=>({hrid:a.hrid,level:a.level}))}});
const clean=r=>{const {debug,combatStats,attackSummary,damageSummary,...v}=r;return v;};
export async function searchExploration(o){
 const store=o.runStorage,root=`explore/${o.monsterHrid}`,key=s=>store.key(`${root}/${s}`);
 const min=o.minMonsterLevel,max=o.maxMonsterLevel,target=o.targetRate,attemptLimit=o.attemptLimit??2;
 if(!Number.isInteger(attemptLimit)||attemptLimit<1||attemptLimit>10||!Number.isInteger(min)||!Number.isInteger(max)||min<20||max<min||!Number.isFinite(target)||target<=0||target>1||
  ![o.testTrials,o.reviewTrials,o.rankingTrials].every(n=>Number.isInteger(n)&&n>0))throw Error('模拟设置无效');
 const completed=await store.get(key('output'));
 if(completed?.complete){o.onProgress?.({trials:completed.audit?.trials||0,tasks:[],phase:'complete',done:completed.reviewed,total:completed.reviewed});return completed;}
 const guard=async()=>{if(o.signal?.aborted)throw new DOMException('模拟已停止','AbortError');await o.pauseController?.waitIfPaused(o.signal);if(o.signal?.aborted)throw new DOMException('模拟已停止','AbortError');};
 let phaseState={phase:'index',done:0,total:0},totalTrials=(await store.get(key('audit')))?.trials||0;
 const liveTasks=new Map();
 const emit=(phase,done,total,extra={})=>{phaseState={phase,done,total};o.onProgress?.({...phaseState,trials:totalTrials,tasks:[...liveTasks.values()],...extra});};
 const activity=()=>emit(phaseState.phase,phaseState.done,phaseState.total);
 let active=0;
 async function reserve(n){return store.serial(async()=>{const offset=await store.get(store.key('seed'))||0;if(offset+n>=2**32)throw Error('随机样本序列已用尽');await store.put(store.key('seed'),offset+n);return offset;});}
 async function evaluate(plan,level,trials,id,stage){
  const rowKey=key(`samples/${id}`);let row=await store.get(rowKey)||{monsterHrid:o.monsterHrid,stage,level,result:null,pending:null};
  liveTasks.set(id,{id,stage,level,done:row.result?.trials||0,total:trials});activity();
  try { while((row.result?.trials||0)<trials){
   await guard();
   if(!row.pending){const n=Math.min(1000,trials-(row.result?.trials||0));row.pending={trials:n,offset:await reserve(n)};await store.put(rowKey,row);}
   const task=row.pending,cacheKey=store.key(`cache/${task.offset}`);let result=await store.get(cacheKey);
   if(!result){
    const input={...buildSimulationInput(o.character,o.catalog,plan.equipmentCandidate,plan.abilityOrder),monsterHrid:o.monsterHrid,
     roomLevel:level,roomDurationSeconds:120,trials:task.trials,seed:Math.imul(task.offset>>>0,2654435761)>>>0,plannedConcurrency:Math.max(1,active)};
    result=clean(await o.engine.simulateRoom(input));
    if(result.trials!==task.trials||![result.successes,result.failedByDeath,result.failedByTimeout].every(n=>Number.isInteger(n)&&n>=0)||result.successes+result.failedByDeath+result.failedByTimeout!==result.trials||
     !Number.isFinite(result.successfulSpentSeconds)||result.successfulSpentSeconds<0||result.successfulSpentSeconds>120*result.successes+1e-6)throw Error('战斗统计不完整');
    await store.serial(async()=>{const stats=await store.get(key('audit'))||{batches:0,trials:0};stats.batches++;stats.trials+=result.trials;
     await store.batch([[cacheKey,result],[key('audit'),stats]]);totalTrials=stats.trials;});
   }
   row.result=clean(row.result?mergeRoomResults([row.result,result]):result);row.pending=null;
   await store.mutate([[rowKey,row]],[cacheKey]);
   liveTasks.set(id,{id,stage,level,done:row.result.trials,total:trials});activity();
  }
  return row.result;
  } finally {liveTasks.delete(id);activity();}
 }
 async function mapStream(source,fn){
  const iterator=source[Symbol.asyncIterator]?.()||source[Symbol.iterator]();let tail=Promise.resolve(),failure;
  const take=()=>{const next=tail.then(()=>iterator.next());tail=next.then(()=>{},()=>{});return next;};
  const workers=Array.from({length:Math.max(1,Math.min(64,o.engine.workerCount||1))},async()=>{
   while(!failure){const item=await take();if(item.done)return;active++;try{await fn(item.value);}catch(e){failure=e;throw e;}finally{active--;}}
  });
  const settled=await Promise.allSettled(workers);const bad=settled.find(x=>x.status==='rejected');if(bad)throw bad.reason;
 }
 let manifest=await store.get(key('manifest'));
 if(!manifest?.complete){
  let n=0,buffer=[];const seen=new Set();
  for(const raw of o.iterate()){
   await guard();const plan=compact(raw),id=await fingerprint(plan.key);if(seen.has(id))continue;seen.add(id);
   // Indexing is replayable; only the completed manifest permits simulation.
   buffer.push([key(`candidates/${pad(n)}`),{index:n,plan,done:false}]);n++;
   if(buffer.length>=64){await store.batch(buffer);buffer=[];emit('index',n,n);await new Promise(r=>setTimeout(r,0));}
  }
  if(buffer.length)await store.batch(buffer);if(!n)throw Error('没有合法配装');
  manifest={complete:true,total:n};await store.put(key('manifest'),manifest);
 }
 let done=0;
 for await(const c of store.values(`${root}/candidates/`))if(c.done)done++;
 emit('search',done,manifest.total);
 await mapStream(store.values(`${root}/candidates/`),async c=>{
  if(c.done)return;await guard();
  const checked=new Map();
  const check=async level=>{
   if(checked.has(level))return checked.get(level);
   const id=`c${c.index}-${level}`;let result=await evaluate(c.plan,level,o.reviewTrials,`${id}-test`,'search');
   if(needsBoundaryRetest(result,target)){
    const extra=await evaluate(c.plan,level,o.reviewTrials,`${id}-extra`,'boundary');result=clean(mergeRoomResults([result,extra]));
   }
   const point={level,result,metrics:roomMetrics(result,attemptLimit)};checked.set(level,point);return point;
  };
  const coarse=await evaluate(c.plan,min,o.testTrials,`c${c.index}-screen`,'screen');
  if(coarseRejected(coarse.successes,coarse.trials,target)){c.reason='最低设置等级粗筛未通过';c.highest=null;c.points=[];}
  else{
   const first=await check(min);let highest=null;
   if(meetsFinalTarget(first.result,target)){
    highest=min;let low=min+1,high=max;
    while(low<=high){const level=Math.floor((low+high)/2),point=await check(level);
     if(meetsFinalTarget(point.result,target)){highest=level;low=level+1;}else high=level-1;
    }
    // Each build keeps its own range. No incumbent-driven pruning.
    for(const level of checkpoints(min,highest))await check(level);
   }
   c.highest=highest;c.points=[...checked.values()].filter(p=>meetsFinalTarget(p.result,target));
   c.reason=highest===null?'最低设置等级未达标':null;
  }
  c.done=true;await store.put(key(`candidates/${pad(c.index)}`),c);done++;emit('search',done,manifest.total);
 });
 let shortlist=await store.get(key('shortlist'));
 if(!shortlist){
  const frontier=[];
  for await(const c of store.values(`${root}/candidates/`))for(const point of c.points||[])retainFrontier(frontier,{...point,plan:c.plan,candidate:c.index});
  const ids=new Set(frontier.map(p=>p.candidate)),plans=[];
  for await(const c of store.values(`${root}/candidates/`))if(ids.has(c.index))plans.push(c);
  const levels=[...new Set([...checkpoints(min,max),...frontier.map(p=>p.level)])].sort((a,b)=>a-b);
  shortlist={plans,levels};await store.put(key('shortlist'),shortlist);
 }
 function* finalTasks(){for(const c of shortlist.plans){const orders=activeOrderPermutations(c.plan);for(let order=0;order<orders.length;order++)for(const level of shortlist.levels)if(level<=c.highest)yield{candidate:c.index,plan:orders[order],order,level};}}
 const finalFrontier=[];let reviewed=0,total=0;for(const task of finalTasks())total++;
 emit('review',0,total);
 await mapStream(finalTasks(),async task=>{
  const result=await evaluate(task.plan,task.level,o.rankingTrials,`final-${task.candidate}-${task.order}-${task.level}`,'review');
  const entry={...task,result,metrics:roomMetrics(result,attemptLimit)};
  if(meetsFinalTarget(result,target))retainFrontier(finalFrontier,entry);
  reviewed++;emit('review',reviewed,total);
 });
 await guard();
 const output={monsterHrid:o.monsterHrid,frontier:finalFrontier,totalCandidates:manifest.total,reviewed,
  levelBounds:{minimum:min,maximum:max},singleTarget:target,roomTarget:1-(1-target)**attemptLimit,attemptLimit,
  checkpointLevels:shortlist.levels,complete:true,audit:await store.get(key('audit'))};
 await store.put(key('output'),output);emit('complete',total,total);return output;
}
