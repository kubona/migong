// Compact task audit: completed caches live only until the scheduler commits.
// No per-candidate learning records or permanent simulation-input archive.
export async function createStagedAudit(store, options = {}) {
  const empty = () => ({actualSimulationBatches:0,completedBatches:0,failedBatches:0,uniqueLoadouts:0,
    uniqueCombinations:0,completedTrials:0,requestedTrials:0,stageSummary:{},byStage:{}});
  let stats = await store.get(store.key('audit-summary')) || {overall:empty(),monsters:{}};
  const labels = {bootstrap:'初始二分',screen:'粗筛',step:'逐级测试',boundary:'临界补样',confirm:'纪录确认',ranking:'顺序排名'};
  const recorder = {
    get recordCount() { return stats.overall.actualSimulationBatches; },
    summary(filter = {}) { return structuredClone(filter.monsterHrid ? stats.monsters[filter.monsterHrid] || empty() : stats.overall); },
    async simulate(engine, input, context) {
      const key = store.key(`staged45-cache/${context.trialOffset}`);
      const cached = await store.get(key);
      if (cached) return cached;
      const result = await engine.simulateRoom(input);
      if (result.trials !== input.trials || result.successes + result.failedByDeath + result.failedByTimeout !== result.trials) throw Error('战斗场次不完整');
      const {debug,combatStats,...clean} = result;
      await store.serial(async () => {
        const next = structuredClone(stats);
        next.monsters[input.monsterHrid] ||= empty();
        for (const s of [next.overall, next.monsters[input.monsterHrid]]) {
          s.actualSimulationBatches++; s.completedBatches++;
          s.uniqueLoadouts += context.firstVisit ? 1 : 0;
          s.uniqueCombinations += context.firstVisit ? 1 : 0;
          s.completedTrials += result.trials; s.requestedTrials += result.trials;
          s.byStage[context.stage] = (s.byStage[context.stage] || 0) + 1;
          const stage = s.stageSummary[context.stage] ||= {batches:0,completedTrials:0};
          stage.batches++; stage.completedTrials += result.trials;
        }
        await store.batch([[key,clean],[store.key('audit-summary'),next]]);
        stats = next;
        options.onRecord?.({status:'completed',result:clean,stage:context.stage,stageLabel:labels[context.stage],
          monsterHrid:input.monsterHrid,candidateIndex:context.candidateIndex,roomLevel:input.roomLevel});
      });
      return clean;
    },
    async exportTo(writable, extra = {}) {
      await writable.write(JSON.stringify({reportType:'mwi_staged_audit_v045',schemaVersion:6,...extra,
        retention:'汇总审计；已结算批次缓存已清理，保留淘汰候选的配装、分批及合并结果摘要，不含完整逐场回放',summary:recorder.summary()}).slice(0,-1)+',"searchStates":[');
      let comma='';
      for await (const row of store.values('staged45/')) {
        if (row.version !== 45 || !row.phase) continue;
        const {window,pending,fallback,...summary}=row;
        await writable.write(comma+JSON.stringify(summary));comma=',';
      }
      await writable.write('],"rankingReviews":[');comma='';
      for await (const row of store.values('staged45/')) {
        if (!row.rankingIndependent) continue;
        await writable.write(comma+JSON.stringify(row));comma=',';
      }
      await writable.write('],"eliminatedCandidates":[');comma='';
      for await (const row of store.values('staged45/')) {
        if(row.recordType!=='eliminated-candidate')continue;
        await writable.write(comma+JSON.stringify(row));comma=',';
      }
      await writable.write(']}');
    },
    async exportBlob(extra = {}) {
      const chunks=[];let buffer='';
      await recorder.exportTo({async write(s){buffer+=s;if(buffer.length>262144){chunks.push(new Blob([buffer]));buffer='';}}},extra);
      if(buffer)chunks.push(new Blob([buffer]));return new Blob(chunks,{type:'application/json'});
    },
  };
  return recorder;
}
