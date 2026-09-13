import {COMBAT_EQUIPMENT_TYPES} from './data-model.js';
export const COMBAT_LEVELS={stamina:'耐力',intelligence:'智力',attack:'攻击',melee:'近战',defense:'防御',ranged:'远程',magic:'魔法'};
export const UPGRADES={labyrinthCombatDamageLevel:'迷宫伤害',labyrinthAttackSpeedLevel:'迷宫攻速',labyrinthCastSpeedLevel:'迷宫施法速度',labyrinthCriticalRateLevel:'迷宫暴击率'};
export const BUFF_GROUPS={personal:'个人',mooPass:'通行证',community:'社区',guild:'公会',custom:'自定义'};
export const SLOT_LABELS={head:'头部',body:'身体',legs:'腿部',feet:'脚部',hands:'手部',main_hand:'主手',two_hand:'双手',off_hand:'副手',back:'背部',neck:'项链',earrings:'耳环',ring:'戒指',pouch:'袋子'};
export const CRATES={teaCrateItemHrid:'茶箱',coffeeCrateItemHrid:'咖啡箱',foodCrateItemHrid:'食物箱'};
export function numeric(value,label,min=0,max=10000,integer=false){
  const n=Number(value);if(String(value).trim()===''||!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw Error(`${label}须为${min}～${max}之间的${integer?'整数':'数值'}`);return n;
}
export function enhancementMaximum(catalog){return Math.max(0,...Object.keys(catalog.enhancementLevelTotalBonusMultiplierTable||{}).map(Number).filter(Number.isFinite));}
export function createCharacterDraft(character,catalog){
  return {
    levels:Object.fromEntries(Object.keys(COMBAT_LEVELS).map(k=>[k,character.characterSkills.find(s=>s.skillHrid===`/skills/${k}`)?.level||1])),
    abilities:Object.fromEntries(character.characterAbilities.map(a=>[a.abilityHrid,a.level])),
    inventory:character.characterItems.flatMap((item,i)=>COMBAT_EQUIPMENT_TYPES.has(catalog?.itemDetailMap?.[item.itemHrid]?.equipmentDetail?.type)?[{...item,sourceIndex:i}]:[]),
    equipmentOverrides:structuredClone(character.equipmentOverrides||{}),
    buffs:Object.fromEntries(Object.keys(BUFF_GROUPS).map(k=>[k,structuredClone(character.buffs?.[k]||[])])),
    upgrades:Object.fromEntries(Object.keys(UPGRADES).map(k=>[k,character.characterInfo?.[k]||0])),
    rooms:Object.fromEntries(Object.entries(character.characterHouseRoomMap||{}).map(([k,v])=>[k,v.level])),
    achievements:Object.fromEntries((character.characterAchievements||[]).map(a=>[a.achievementHrid,a.isCompleted])),
    crates:Object.fromEntries(Object.keys(CRATES).map(k=>[k,character.labyrinth?.[k]||''])),
    triggers:structuredClone(character.abilityCombatTriggersMap||{}),
  };
}
export function applyCharacterDraft(base,draft,catalog){
  if(!catalog)throw Error('请先加载游戏数据，再应用角色修改');
  const c=structuredClone(base), maxEnh=enhancementMaximum(catalog);
  for(const [k,label]of Object.entries(COMBAT_LEVELS)){
    const level=numeric(draft.levels[k],label,1,10000,true),hrid=`/skills/${k}`;
    const entry=c.characterSkills.find(s=>s.skillHrid===hrid);if(entry)entry.level=level;else c.characterSkills.push({skillHrid:hrid,level,experience:0});
  }
  c.characterAbilities=[];
  for(const[hrid,value]of Object.entries(draft.abilities)){
    if(!catalog.abilityDetailMap[hrid])throw Error('技能不存在于当前游戏数据');
    const level=numeric(value,'技能等级',0,10000,true);
    if(level)c.characterAbilities.push({...base.characterAbilities.find(a=>a.abilityHrid===hrid),abilityHrid:hrid,level});
  }
  const references=new Map();
  c.characterItems=c.characterItems.filter(i=>!COMBAT_EQUIPMENT_TYPES.has(catalog.itemDetailMap[i.itemHrid]?.equipmentDetail?.type));
  for(const row of draft.inventory){
    const type=catalog.itemDetailMap[row.itemHrid]?.equipmentDetail?.type;
    if(!COMBAT_EQUIPMENT_TYPES.has(type))throw Error('请选择有效的战斗装备');
    const enhancementLevel=numeric(row.enhancementLevel,'强化等级',0,maxEnh,true);
    const count=numeric(row.count,'数量',1,1000000000,true);
    const original=base.characterItems[row.sourceIndex];
    if(original){
      if(catalog.itemDetailMap[original.itemHrid]?.equipmentDetail?.type!==type)throw Error('替换已有装备时须保持相同部位');
      references.set(`${original.itemHrid}@${original.enhancementLevel}`,{itemHrid:row.itemHrid,enhancementLevel});
    }
    c.characterItems.push({itemHrid:row.itemHrid,enhancementLevel,count,itemLocationHrid:original?.itemLocationHrid||'/item_locations/inventory'});
  }
  for(const loadout of Object.values(c.characterLoadoutMap||{}))for(const[slot,ref]of Object.entries(loadout.wearableMap||{})){
    const parts=typeof ref==='string'?ref.split('::'):[],idx=parts.findIndex(s=>s.startsWith('/items/'));
    const hrid=typeof ref==='object'?(ref.itemHrid||ref.hrid):parts[idx];
    const level=typeof ref==='object'?ref.enhancementLevel:Number(parts[idx+1]||0);
    const replacement=references.get(`${hrid}@${level}`);
    if(replacement)loadout.wearableMap[slot]=replacement;
    else if(base.characterItems.some(i=>i.itemHrid===hrid&&i.enhancementLevel===level&&COMBAT_EQUIPMENT_TYPES.has(catalog.itemDetailMap[hrid]?.equipmentDetail?.type)))delete loadout.wearableMap[slot];
  }
  c.equipmentOverrides={};
  for(const[type,item]of Object.entries(draft.equipmentOverrides)){
    if(!item?.hrid)continue;
    if(!COMBAT_EQUIPMENT_TYPES.has(type)||catalog.itemDetailMap[item.hrid]?.equipmentDetail?.type!==type)throw Error('基准装备与部位不匹配');
    const enhancementLevel=numeric(item.enhancementLevel,'基准强化等级',0,maxEnh,true);
    c.equipmentOverrides[type]={hrid:item.hrid,enhancementLevel};
    if(!c.characterItems.some(i=>i.itemHrid===item.hrid&&i.enhancementLevel===enhancementLevel))c.characterItems.push({itemHrid:item.hrid,enhancementLevel,count:1,itemLocationHrid:'/item_locations/inventory'});
  }
  if(c.equipmentOverrides['/equipment_types/two_hand']&&(c.equipmentOverrides['/equipment_types/main_hand']||c.equipmentOverrides['/equipment_types/off_hand']))throw Error('双手武器不能同时配置主手或副手覆盖；请将冲突部位设为跟随预设');
  c.buffs={};
  for(const group of Object.keys(BUFF_GROUPS))c.buffs[group]=(draft.buffs[group]||[]).map((buff,index)=>{
    if(!catalog.buffTypeDetailMap?.[buff.typeHrid])throw Error('Buff 类型不存在');
    const out={...buff,uniqueHrid:buff.uniqueHrid||`/buff_uniques/editor_${group}_${index}`};
    for(const k of ['ratioBoost','ratioBoostLevelBonus','flatBoost','flatBoostLevelBonus'])out[k]=numeric(buff[k]??0,'Buff 加成',-10000,10000);
    out.duration=numeric(buff.duration??0,'Buff 持续时间',0,Number.MAX_SAFE_INTEGER);
    return out;
  });
  for(const k of Object.keys(UPGRADES))c.characterInfo[k]=numeric(draft.upgrades[k],'迷宫升级',0,10000,true);
  c.characterHouseRoomMap={};
  for(const[k,value]of Object.entries(draft.rooms)){
    if(!catalog.houseRoomDetailMap[k])throw Error('房屋设施不存在');
    const max=Math.max(0,...Object.keys(catalog.houseRoomDetailMap[k].upgradeCostsMap||{}).map(Number));
    c.characterHouseRoomMap[k]={houseRoomHrid:k,level:numeric(value,'房屋等级',0,max||100,true)};
  }
  c.characterAchievements=Object.entries(draft.achievements).map(([hrid,done])=>{
    if(!catalog.achievementDetailMap[hrid])throw Error('成就不存在');
    return {achievementHrid:hrid,isCompleted:Boolean(done)};
  });
  c.labyrinth ||= {};
  for(const k of Object.keys(CRATES)){
    const value=draft.crates[k];
    const kind=k.startsWith('tea')?'tea':k.startsWith('coffee')?'coffee':'food';
    if(value&&(!catalog.labyrinthCrateDetailMap[value]||!value.endsWith(`_${kind}_crate`)))throw Error('补给箱类型不匹配');
    c.labyrinth[k]=value;
  }
  c.abilityCombatTriggersMap={};
  for(const[hrid,triggers]of Object.entries(draft.triggers)){
    if(!catalog.abilityDetailMap[hrid])throw Error('触发条件对应技能不存在');
    c.abilityCombatTriggersMap[hrid]=triggers.map(t=>{
      const dependency=catalog.combatTriggerDependencyDetailMap[t.dependencyHrid],condition=catalog.combatTriggerConditionDetailMap[t.conditionHrid],comparator=catalog.combatTriggerComparatorDetailMap[t.comparatorHrid];
      if(!dependency||!condition||!comparator||!condition.allowedComparatorHrids.includes(t.comparatorHrid))throw Error('技能触发条件或比较方式无效');
      if(!(dependency.isSingleTarget&&condition.isSingleTarget)&&!(dependency.isMultiTarget&&condition.isMultiTarget))throw Error('触发对象与触发条件不兼容');
      return {...t,value:comparator.allowValue?numeric(t.value,'触发阈值',0,1000000000):0};
    });
  }
  // Never reuse imported derived combat statistics after modifying their sources.
  c.combatDetails=null;
  return c;
}
