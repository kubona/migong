import {retainDistinctRanking} from './distinct-ranking.js';
import {diagnosticResult,eliminationRecord} from './staged-diagnostics.js';
import {activeOrderPermutations,unorderedPlanKey} from './component-planner.js';
import {fingerprint} from './run-storage.js';
import {LearningLibrary,batchSeed,normalizeEvidence} from './learning-library.js';
import {buildSimulationInput} from './player-dto.js';
import {mergeRoomResults} from './engine-adapter.js';
import {wilsonInterval} from './statistics.js';
import {coarseRejected,stageStatus,needsBoundaryRetest} from './staged-statistics.js';

const pad = n => String(n).padStart(12,'0');
const count = (v,d) => Math.max(10,Math.min(100000,Math.floor(Number(v)||d)));
const clean = r => { const {debug,combatStats,...rest}=normalizeEvidence(r);return rest; };
const compact = p => ({key:unorderedPlanKey(p),zeroCooldownHrid:p.zeroCooldownHrid,sourcePreset:p.sourcePreset,
  equipmentCandidate:{equipment:Object.fromEntries(Object.entries(p.equipmentCandidate.equipment).map(([k,v])=>[k,{hrid:v.hrid,enhancementLevel:v.enhancementLevel||0}]))},
  abilityOrder:{abilities:p.abilityOrder.abilities.map(v=>({hrid:v.hrid,level:v.level||1}))}});
async function guard(o) {
  if(o.signal?.aborted)throw new DOMException('模拟已取消','AbortError');
  await o.pauseController?.waitIfPaused(o.signal);
  if(o.signal?.aborted)throw new DOMException('模拟已取消','AbortError');
}

export async function indexStagedPlans(o, root) {
  const store=o.runStorage, key=store.key(`${root}/manifest`);
  const saved=await store.get(key);if(saved?.complete)return saved;
  let total=0;
  // Stable index identity survives an interrupted indexing pass. No order expansion.
  for await(const c of store.values(`${root}/candidate/`))total=Math.max(total,c.index+1);
  let buffer=[];
  const flush=async()=>{if(buffer.length)await store.batch(buffer);buffer=[];await guard(o);await new Promise(r=>setTimeout(r,0));};
  for(const raw of o.legalPlans || o.iterate()) {
    const plan=compact(raw);
    const id=await fingerprint({equipment:plan.equipmentCandidate.equipment,aura:plan.abilityOrder.abilities[0],
      actives:plan.abilityOrder.abilities.slice(1).sort((a,b)=>a.hrid.localeCompare(b.hrid))});
    const identity=store.key(`${root}/identity/${id}`);
    // Flush before duplicate lookups; buffer is deliberately bounded.
    if(buffer.some(([k])=>k===identity) || await store.get(identity)!==undefined)continue;
    const c={id,index:total++,plan,levels:{},phase:'screen',visits:0,highestPass:null,criticalLevel:null,firstFailure:null};
    buffer.push([identity,c.index],[store.key(`${root}/candidate/${pad(c.index)}`),c]);
    if(buffer.length>=128)await flush();
  }
  await flush();if(!total)throw Error('没有合法配装');
  const manifest={version:45,complete:true,totalBasePlans:total};await store.put(key,manifest);return manifest;
}

export async function searchStagedCandidates(o) {
  const store=o.runStorage;
  if(!store?.mutate)throw Error('阶段搜索需要支持原子清理的本机存储');
  const root=`staged45/${o.monsterHrid}`,stateKey=store.key(`${root}/state`);
  const ck=i=>store.key(`${root}/candidate/${pad(i)}`), cache=offset=>store.key(`staged45-cache/${offset}`);
  const minimum=Math.max(1,Math.min(5000,Math.floor(Number(o.minMonsterLevel)||200)));
  const maximum=Math.max(minimum,Math.min(5000,Math.floor(Number(o.maxMonsterLevel)||300)));
  const target=Math.max(.01,Math.min(.99,Number(o.targetRate)||.7));
  const screenTrials=count(o.testTrials,100),levelTrials=count(o.reviewTrials,1000);
  const confirmTrials=count(o.optimizeTrials,1000),rankingTrials=count(o.rankingTrials,5000);
  const lib=new LearningLibrary(store,o.learningFamily);
  const manifest=await indexStagedPlans(o,root);
  let s=await store.get(stateKey);
  if(!s) {
    s={version:45,...manifest,phase:'bootstrap',bestLevel:null,cursor:1,window:[0],pending:null,done:0,
      testedPlans:0,resolvedPlans:0,discardedPlans:0,recordVersion:0,fallback:null,rankingTrials,rankingReviewed:0,rankingTotal:0};
    const c=await store.get(ck(0));c.bootstrap=true;c.phase='step';c.binaryLow=minimum;c.binaryHigh=maximum;
    c.nextLevel=Math.floor((minimum+maximum)/2);
    await store.batch([[ck(0),c],[stateKey,s]]);
  }
  let window=(await Promise.all(s.window.map(i=>store.get(ck(i))))).filter(Boolean);
  const progress=(extra={})=>o.onProgress?.({learning:true,staged:true,phase:s.phase,totalPlans:s.totalBasePlans,
    testedPlans:s.testedPlans,completedPlans:s.resolvedPlans,discardedPlans:s.discardedPlans,
    bestObservedLevel:s.bestLevel,bestCertifiedLevel:null,bestLevel:s.bestLevel,
    progressFraction:s.phase==='complete'?1:s.phase==='ranking'?.8+.2*s.rankingReviewed/Math.max(1,s.rankingTotal):.8*s.resolvedPlans/s.totalBasePlans,...extra});
  const save=async(deletes=[])=>{s.window=window.map(c=>c.index);await store.mutate([...window.map(c=>[ck(c.index),c]),[stateKey,s]],deletes);};
  const finish=(c,reason='search-ended')=>{if(c.phase!=='done'){c.stopReason=reason;c.phase='done';s.resolvedPlans++;}};
  const binaryNext=(c,passed)=>{
    if(passed)c.binaryLow=c.nextLevel+1;else c.binaryHigh=c.nextLevel-1;
    if(c.binaryLow>c.binaryHigh){finish(c);return;}
    c.nextLevel=Math.floor((c.binaryLow+c.binaryHigh)/2);c.phase='step';
  };
  const advance=c=>{
    if(c.nextLevel>=maximum){finish(c);return;}
    c.nextLevel++;c.phase='step';
  };
  const acceptSearch=(c,status,bestAtDispatch)=>{
    const level=c.nextLevel;
    if(status==='passed') {
      c.highestPass=Math.max(c.highestPass??minimum-1,level);
      if(level>(bestAtDispatch??minimum-1)){c.phase='confirm';return;}
      if(c.bootstrap)binaryNext(c,true);else advance(c);
    } else {
      if(status==='tolerance')c.criticalLevel=Math.max(c.criticalLevel??minimum-1,level);
      else c.firstFailure=Math.min(c.firstFailure??maximum+1,level);
      if(c.bootstrap)binaryNext(c,false);else finish(c,c.phase==='boundary'?'boundary-below-target':'level-below-target');
    }
  };
  const keep=c=>s.bestLevel!==null&&['passed','tolerance'].includes(c.levels[s.bestLevel]?.status);
  async function compactFinished() {
    const deletes=[],writes=[];
    for(const c of window.filter(c=>c.phase==='done')) {
      // The first binary candidate may remain a finalist while later candidates run.
      if(keep(c))writes.push([ck(c.index),c]);
      else {writes.push([store.key(`${root}/eliminated/${pad(c.index)}`),eliminationRecord(c,s.bestLevel,'not-retained-at-best-level',o.monsterHrid)]);deletes.push(ck(c.index),store.key(`${root}/identity/${c.id}`));s.discardedPlans++;}
    }
    window=window.filter(c=>c.phase!=='done');
    if(s.phase==='bootstrap'&&!window.length)s.phase='search';
    s.window=window.map(c=>c.index);
    await store.mutate([...writes,...window.map(c=>[ck(c.index),c]),[stateKey,s]],deletes);
  }
  async function pruneOldFinalists() {
    if(s.bestLevel===null)return;
    for await(const c of store.values(`${root}/candidate/`)) {
      if(c.phase!=='done'||keep(c))continue;
      s.discardedPlans++;
      await store.mutate([[stateKey,s],[store.key(`${root}/eliminated/${pad(c.index)}`),eliminationRecord(c,s.bestLevel,'record-raised',o.monsterHrid)]], [ck(c.index),store.key(`${root}/identity/${c.id}`)]);
    }
  }
  async function execute() {
    const tasks=s.pending;
    const out=await Promise.allSettled(tasks.map(async task=>{
      await guard(o);const c=window.find(c=>c.index===task.candidate);if(!c)throw Error('缺少在途候选');
      let r=await store.get(cache(task.offset));
      if(!r) {
        const input={...buildSimulationInput(o.character,o.catalog,c.plan.equipmentCandidate,c.plan.abilityOrder),
          monsterHrid:o.monsterHrid,roomLevel:task.level,roomDurationSeconds:120,trials:task.trials,seed:batchSeed(task.offset),plannedConcurrency:o.engine.workerCount||1};
        const context={stage:task.stage,trialOffset:task.offset,planId:c.id,candidateIndex:c.index,firstVisit:c.visits===0,bestLevelAtDispatch:task.best};
        r=clean(o.auditRecorder?await o.auditRecorder.simulate(o.engine,input,context):await o.engine.simulateRoom(input));
        if(r.trials!==task.trials||r.successes+r.failedByDeath+r.failedByTimeout!==r.trials)throw Error('战斗场次不完整');
        await store.put(cache(task.offset),r);
      }
      return {task,c,r};
    }));
    const error=out.find(r=>r.status==='rejected');if(error)throw error.reason;
    let newBest=s.bestLevel;
    for(const {value:{task,c,r}} of out) {
      if(!c.visits)s.testedPlans++;c.visits++;s.done++;
      const level=task.level;
      c.lastCheck={stage:task.kind,level,bestLevelAtDispatch:task.best,result:diagnosticResult(r)};
      if(task.kind==='screen') {
        if(coarseRejected(r.successes,r.trials,target))finish(c,'coarse-upper-bound-below-retest-floor');
        else {c.phase='step';c.nextLevel=Math.max(minimum,task.best??minimum);}
      } else if(task.kind==='confirm') {
        c.levels[level].confirmation={result:r,status:stageStatus(r,target)};
        if(stageStatus(r,target)==='passed') {
          newBest=Math.max(newBest??minimum-1,level);
          if(c.bootstrap)binaryNext(c,true);else advance(c);
        } else {if(c.bootstrap)binaryNext(c,false);else finish(c,'independent-confirmation-below-target');}
      } else {
        const result=task.kind==='boundary'?clean(mergeRoomResults([c.levels[level].result,r])):r;
        const status=stageStatus(result,target);
        const boundary=task.kind==='boundary'?{initial:diagnosticResult(c.levels[level].result),supplement:diagnosticResult(r)}:null;
        c.levels[level]={result,status,interval:wilsonInterval(result.successes,result.trials),boundary};
        const fallback={plan:c.plan,level,result,status,rankingIndependent:false};
        if(!s.fallback||result.clearRate>s.fallback.result.clearRate)s.fallback=fallback;
        if(task.kind!=='boundary'&&needsBoundaryRetest(result,target))c.phase='boundary';
        else acceptSearch(c,status,task.best);
      }
    }
    const raised=newBest!==s.bestLevel;s.bestLevel=newBest;if(raised)s.recordVersion++;
    if(s.bestLevel!==null)s.fallback=null;
    s.pending=null;
    await save(tasks.map(t=>cache(t.offset)));
    await compactFinished();if(raised)await pruneOldFinalists();
    const last=tasks.at(-1);progress({level:last.level,reason:last.reason});
  }
  while(s.phase==='bootstrap'||s.phase==='search') {
    await guard(o);
    if(s.pending){await execute();continue;}
    // Recovery after a committed wave but before terminal compaction.
    await compactFinished();
    if(s.phase==='search') {
      while(window.length<Math.max(1,Math.min(64,o.engine.workerCount||1))&&s.cursor<s.totalBasePlans) {
        const c=await store.get(ck(s.cursor++));if(c)window.push(c);
      }
    }
    if(!window.length) {
      if(s.cursor<s.totalBasePlans)continue;
      s.phase='ranking';await save();break;
    }
    const tasks=[];
    for(const c of window) {
      if(!c.bootstrap&&!['confirm','boundary'].includes(c.phase)) {
        c.nextLevel=Math.max(c.nextLevel??minimum,s.bestLevel??minimum);
      }
      const kind=c.phase,stage=kind==='step'&&c.bootstrap?'bootstrap':kind;
      const level=c.nextLevel??s.bestLevel??minimum;
      const trials=kind==='screen'?screenTrials:kind==='confirm'?confirmTrials:levelTrials;
      const reason={bootstrap:'初始二分',screen:'当前纪录粗筛',step:'逐级测试',boundary:'临界补样',confirm:'独立纪录确认'}[stage];
      tasks.push({candidate:c.index,kind,stage,level,trials,best:s.bestLevel,recordVersion:s.recordVersion,offset:await lib.reserve(trials),reason});
    }
    s.pending=tasks;await save();await execute();
  }
  await pruneOldFinalists();
  const rankings={winRate:[],speed:[]};
  const retain=retainDistinctRanking;
  const winCompare=(a,b)=>b.result.clearRate-a.result.clearRate||a.result.averageClearSeconds-b.result.averageClearSeconds||a.plan.key.localeCompare(b.plan.key);
  const speedCompare=(a,b)=>a.result.averageClearSeconds-b.result.averageClearSeconds||b.result.clearRate-a.result.clearRate||a.plan.key.localeCompare(b.plan.key);
  if(s.bestLevel!==null) {
    let total=0;
    for await(const c of store.values(`${root}/candidate/`))if(keep(c))total+=activeOrderPermutations(c.plan).length;
    s.rankingTotal=total;s.rankingReviewed=0;await save();
    for await(const c of store.values(`${root}/candidate/`)) {
      if(!keep(c))continue;
      const permutations=activeOrderPermutations(c.plan);
      for(let order=0;order<permutations.length;order++) {
        await guard(o);const plan=permutations[order], key=store.key(`${root}/ranking/${pad(c.index)}-${pad(order)}`);
        let row=await store.get(key)||{candidate:c.index,order,plan,level:s.bestLevel,result:null,pending:null,rankingIndependent:true};
        while((row.result?.trials||0)<rankingTrials) {
          if(!row.pending) {row.pending={offset:await lib.reserve(Math.min(1000,rankingTrials-(row.result?.trials||0))),
            trials:Math.min(1000,rankingTrials-(row.result?.trials||0))};await store.put(key,row);}
          await guard(o);const task=row.pending;
          let batch=await store.get(cache(task.offset));
          if(!batch) {
            const input={...buildSimulationInput(o.character,o.catalog,plan.equipmentCandidate,plan.abilityOrder),monsterHrid:o.monsterHrid,
              roomLevel:s.bestLevel,roomDurationSeconds:120,trials:task.trials,seed:batchSeed(task.offset),plannedConcurrency:o.engine.workerCount||1};
            batch=clean(o.auditRecorder?await o.auditRecorder.simulate(o.engine,input,{stage:'ranking',trialOffset:task.offset,
              candidateIndex:c.index,planId:plan.key,firstVisit:!row.result}):await o.engine.simulateRoom(input));
            if(batch.trials!==task.trials||batch.successes+batch.failedByDeath+batch.failedByTimeout!==batch.trials)throw Error('排名场次不完整');
            await store.put(cache(task.offset),batch);
          }
          row.result=clean(row.result?mergeRoomResults([row.result,batch]):batch);row.pending=null;
          row.status=stageStatus(row.result,target);row.interval=wilsonInterval(row.result.successes,row.result.trials);
          await store.mutate([[key,row]],[cache(task.offset)]);
          progress({phase:'ranking',level:s.bestLevel,rankingCompleted:s.rankingReviewed,rankingTotal:total,rankingTrials,
            currentOrderTrials:row.result.trials,reason:'技能顺序独立排名'});
        }
        const entry={plan,level:s.bestLevel,result:row.result,status:row.status,rankingIndependent:true,
          certificationResult:{...c.levels[s.bestLevel].result,interval:c.levels[s.bestLevel].interval},interval:row.interval};
        retain(rankings.winRate,entry,winCompare);
        if(row.status==='passed'&&row.result.successes>0)retain(rankings.speed,entry,speedCompare);
        s.rankingReviewed++;await save();
      }
    }
  }
  s.phase='complete';await save();progress();
  return {state:s,rankings,fallback:s.fallback,minimum,maximum,target,root,rankingTrials};
}
