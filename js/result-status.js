export function resultLevelLabel(r){
 if(!r?.learning)return '最高怪物等级';
 if(!r.targetMet)return '未认证候选';
 if(r.searchComplete===false)return '当前确认';
 return r.searchCapped?'已达设置上限':'最高确认等级';
}
export function resultSearchStatus(r){
 if(r?.searchComplete===false)return `搜索未完成 · 待确认 ${r.candidateCounts?.blockedPlans||0} 套`;
 return r?.learning?(r.searchCapped?'已到设置上限，区间外未搜索':'搜索完成（基于等级单调假设）'):'';
}
