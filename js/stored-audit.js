import { fingerprint } from './run-storage.js';
import { simulationLoadoutSignature, summarizeSimulationLoadout } from './simulation-audit.js';

function empty() { return { actualSimulationBatches:0, completedBatches:0, failedBatches:0, uniqueCombinations:0,
  uniqueLoadouts:0, requestedTrials:0, completedTrials:0, repeatedBatches:0, expectedRetestBatches:0,
  suspiciousRepeatBatches:0, byStage:{}, stageSummary:{} }; }
const labels = {test:'测试阶段',review:'复核阶段',optimize:'优化阶段',learn:'学习搜索',validate:'独立验证'};
export async function createStoredAudit(store, options = {}) {
  let stats = await store.get(store.key('audit-summary')) || { overall: empty(), monsters:{} };
  return {
    get recordCount() { return stats.overall.actualSimulationBatches; },
    summary(filter = {}) { return structuredClone(filter.monsterHrid ? stats.monsters[filter.monsterHrid] || empty() : stats.overall); },
    async simulate(engine, input, context = {}) {
      // Full input and stage distinguish independent review from an exact replay.
      const {plannedConcurrency: _schedulingOnly, ...combatInput} = input;
      const cacheId = await fingerprint({input:combatInput,stage:context.stage,planId:context.planId,direction:context.direction});
      const saved = await store.get(store.key(`probe/${cacheId}`));
      if (saved) { options.onReplay?.(); return saved; }
      const began = performance.now();
      let result, failure;
      try { result = await engine.simulateRoom(input); } catch (e) { failure = e; }
      await store.serial(async () => {
        const signature = simulationLoadoutSignature(input);
        const loadoutId = await fingerprint(signature);
        const loadoutKey = store.key(`loadout/${loadoutId}`);
        const firstLoadout = !(await store.get(loadoutKey));
        const combination = `${loadoutId}/${input.roomLevel}`;
        const repeatKey = store.key(`repeat/${combination}`);
        const repeatIndex = (await store.get(repeatKey) || 0) + 1;
        const stageKey = store.key(`stage-loadout/${context.stage}/${loadoutId}`);
        const firstStage = !(await store.get(stageKey));
        const record = { schemaVersion:4, sequence: stats.overall.actualSimulationBatches + 1,
          timestamp:new Date().toISOString(), monsterHrid:input.monsterHrid,
          monsterName:options.resolveName?.(input.monsterHrid), roomLevel:input.roomLevel,
          trialsRequested:input.trials, seed:input.seed, stage:context.stage, stageLabel:labels[context.stage],
          planId:context.planId, direction:context.direction, reason:context.reason,
          candidateKind:context.candidateKind, loadoutId, repeatIndex, expectedRetest:!!context.expectedRetest,
          repeatClassification:repeatIndex === 1 ? 'first_test' : context.expectedRetest ? 'expected_retest' : 'suspicious_repeat',
          status:failure ? 'failed' : 'completed', durationMilliseconds:performance.now()-began,
          result:result || null, error:failure ? {name:failure.name,message:failure.message} : null };
        const next = structuredClone(stats);
        next.monsters[input.monsterHrid] ||= empty();
        for (const state of [next.overall,next.monsters[input.monsterHrid]]) {
          state.actualSimulationBatches++;
          state.completedBatches += failure ? 0 : 1; state.failedBatches += failure ? 1 : 0;
          state.uniqueLoadouts += firstLoadout ? 1 : 0; state.uniqueCombinations += repeatIndex === 1 ? 1 : 0;
          state.requestedTrials += input.trials; state.completedTrials += result?.trials || 0;
          state.repeatedBatches += repeatIndex > 1 ? 1 : 0;
          state.expectedRetestBatches += record.repeatClassification === 'expected_retest' ? 1 : 0;
          state.suspiciousRepeatBatches += record.repeatClassification === 'suspicious_repeat' ? 1 : 0;
          state.byStage[context.stage] = (state.byStage[context.stage] || 0) + 1;
          const stage = state.stageSummary[context.stage] ||= {batches:0,completedTrials:0,uniqueLoadouts:0};
          stage.batches++; stage.completedTrials += result?.trials || 0; stage.uniqueLoadouts += firstStage ? 1 : 0;
        }
        const entries = [[repeatKey,repeatIndex],[stageKey,true],
          [store.key(`record/${String(record.sequence).padStart(12,'0')}`),record],[store.key('audit-summary'),next]];
        if (firstLoadout) entries.push([loadoutKey,{id:loadoutId,signature,loadout:summarizeSimulationLoadout(input,options.resolveName)}]);
        if (!failure) entries.push([store.key(`probe/${cacheId}`),result]);
        await store.batch(entries); stats = next;
        options.onRecord?.(record);
      });
      if (failure) throw failure;
      return result;
    },
    async exportTo(writable, extra = {}) {
      const write = async part => writable.write(part);
      const summary=this.summary();
      await write(JSON.stringify({reportType:'mwi_labyrinth_simulation_audit_v039',schemaVersion:4,...extra,summary}).slice(0,-1)+',"loadouts":[');
      let separator = '';
      for await (const row of store.values('loadout/')) { await write(separator+JSON.stringify(row)); separator=','; }
      await write('],"records":['); separator='';
      for await (const row of store.values('record/')) {
        if(row.sequence>summary.actualSimulationBatches)break;
        await write(separator+JSON.stringify(row)); separator=',';
      }
      await write(']}');
    },
    async exportBlob(extra = {}) {
      const chunks=[]; let buffer='';
      await this.exportTo({async write(part){buffer+=part;if(buffer.length>262144){chunks.push(new Blob([buffer]));buffer='';}}},extra);
      if(buffer)chunks.push(new Blob([buffer]));
      return new Blob(chunks,{type:'application/json'});
    },
  };
}
