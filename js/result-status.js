export function resultLevelLabel(r){
 if(r?.staged)return r.searchHighestLevel==null?'参考测试等级':r.searchCapped?'已达设置上限':'搜索最高达标等级';
 if(!r?.learning)return '最高怪物等级';
 if(!r.targetMet)return '未认证候选';
 if(r.searchComplete===false)return '当前确认';
 return r.searchCapped?'已达设置上限':'最高确认等级';
}
export function resultSearchStatus(r){
 if(r?.rankingEligible===false)return "最终胜率未达标，无合格排名";
 if(r?.staged)return r.searchComplete?'阶段搜索完成 · '+(r.targetMet?'最终样本达标':'最终样本未达标'):'阶段搜索未完成';
 if(r?.searchComplete===false)return `搜索未完成 · 待确认 ${r.candidateCounts?.blockedPlans||0} 套`;
 return r?.learning?(r.searchCapped?'已到设置上限，区间外未搜索':'搜索完成（基于等级单调假设）'):'';
}
