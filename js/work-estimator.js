export class WorkEstimator {
  constructor(settings) { this.settings=settings; this.monsters=new Map(); this.newTrials=0; }
  record(record) { if(record.status==='completed')this.newTrials+=record.result?.trials||0; }
  observe(monster, p) {
    let entry=this.monsters.get(monster);
    if(!entry) {entry={stages:{},testPlans:0};this.monsters.set(monster,entry);}
    entry.stages[p.phase]={...p};
    if(p.phase==='test')entry.testPlans=p.totalPlans;
    entry.phase=p.phase;
  }
  finish(monster) { const e=this.monsters.get(monster); if(e)e.done=true; }
  estimate(elapsed, expectedMonsters) {
    if(this.monsters.size<expectedMonsters)return null;
    let remainingLow=0,remainingHigh=0,completed=0;
    for(const e of this.monsters.values()) {
      for(const phase of ['test','review','optimize']) {
        const trials=this.settings[`${phase}Trials`];
        const p=e.stages[phase];
        completed+=(p?.phaseCompletedBatches||0)*trials;
        if(e.done || p?.phaseComplete)continue;
        if(p) {
          const left=Math.max(0,p.phaseTotalBatches-p.phaseCompletedBatches)*trials;
          remainingHigh+=left;
          remainingLow+=phase==='optimize'?left:Math.max(0,p.totalPlans-p.completedPlans)*trials;
        } else if(phase==='review') {
          remainingLow+=trials;
          remainingHigh+=e.testPlans*this.settings.binaryBudget*trials;
        } else if(phase==='optimize') {remainingLow+=6*trials;remainingHigh+=120*trials;}
      }
    }
    const perTrial=this.newTrials?elapsed/this.newTrials:0;
    return {low:remainingLow*perTrial,high:remainingHigh*perTrial,
      progress:completed/(completed+(remainingLow+remainingHigh)/2||1)};
  }
}
