import {averageAttemptSeconds} from './statistics.js';

export function roomMetrics(result){
  const p=result.trials>0?result.successes/result.trials:0;
  const attempt=averageAttemptSeconds(result);
  return {singleWinRate:p,roomPassRate:1-(1-p)**2,averageAttemptSeconds:attempt,
    averageRoomSeconds:attempt*(2-p),expectedAttempts:2-p};
}
export function checkpoints(min,max){
  const points=new Set([min,max]);
  for(let level=Math.max(40,Math.ceil(min/20)*20);level<=max;level+=20)points.add(level);
  return [...points].sort((a,b)=>a-b);
}
export function retainFrontier(frontier,entry){
  const dominates=(a,b)=>a.level>=b.level&&a.metrics.averageRoomSeconds<=b.metrics.averageRoomSeconds
    &&(a.level>b.level||a.metrics.averageRoomSeconds<b.metrics.averageRoomSeconds);
  if(frontier.some(x=>dominates(x,entry)))return;
  for(let i=frontier.length-1;i>=0;i--)if(dominates(entry,frontier[i]))frontier.splice(i,1);
  // Equal measured objectives need one deterministic representative, not an arbitrary top-N cap.
  const equal=frontier.findIndex(x=>x.level===entry.level&&x.metrics.averageRoomSeconds===entry.metrics.averageRoomSeconds);
  if(equal>=0){if(frontier[equal].metrics.roomPassRate>entry.metrics.roomPassRate||
    (frontier[equal].metrics.roomPassRate===entry.metrics.roomPassRate&&frontier[equal].plan.key<=entry.plan.key))return;
    frontier.splice(equal,1);}
  frontier.push(entry);
  frontier.sort((a,b)=>b.level-a.level||a.metrics.averageRoomSeconds-b.metrics.averageRoomSeconds||a.plan.key.localeCompare(b.plan.key));
}
