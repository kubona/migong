// Rank distinct skill sets, ignoring gear and active slot order.
export function skillCombinationKey(plan) {
 const abilities=plan?.abilityOrder?.abilities||[];
 return JSON.stringify([abilities[0]?.hrid||'',abilities.slice(1).map(a=>a.hrid).sort()]);
}
export function retainDistinctRanking(list,entry,compare,limit=5) {
 const key=skillCombinationKey(entry.plan);
 const index=list.findIndex(e=>skillCombinationKey(e.plan)===key);
 if(index>=0){if(compare(entry,list[index])>=0)return;list.splice(index,1);}
 list.push(entry);list.sort(compare);if(list.length>limit)list.length=limit;
}
export function distinctRanking(entries,compare,limit=5) {
 const list=[];for(const entry of entries)retainDistinctRanking(list,entry,compare,limit);return list;
}
