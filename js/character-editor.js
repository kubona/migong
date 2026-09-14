import {COMBAT_LEVELS,UPGRADES,BUFF_GROUPS,SLOT_LABELS,CRATES,createCharacterDraft,applyCharacterDraft,enhancementMaximum} from './character-editor-model.js';
import {chineseName} from './localization.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name=(id,detail)=>{const label=chineseName(id,detail?.name||'');return /[a-z]/i.test(label)?'未收录中文名称':label||'未命名项目';};
export function createCharacterEditor(host,onApply){
  let base=null,catalog=null,draft=null,pending=false,modified=false;
  const field=(path,label,value,{min=0,max=10000,step='1',scale=1}={})=>`<label>${esc(label)}<input type="number" data-edit-path="${esc(JSON.stringify(path))}" data-scale="${scale}" min="${min}" max="${max}" step="${step}" value="${esc(value===''?'':value/scale)}"></label>`;
  const select=(path,label,value,choices)=>`<label>${esc(label)}<select data-edit-path="${esc(JSON.stringify(path))}">${choices.map(([v,t])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;
  const section=(id,label,html,open=false)=>`<details class="subsection" data-editor-section="${id}" ${open?'open':''}><summary>${label}</summary><div class="subsection-content">${html}</div></details>`;
  const grid=s=>`<div class="character-edit-grid">${s}</div>`;
  function set(path,value){let obj=draft;for(const k of path.slice(0,-1))obj=obj[k];obj[path.at(-1)]=value;pending=true;modified=true;status('有未应用修改');}
  function status(message,error=false){const el=host.querySelector('#character-edit-status');if(el){el.textContent=message;el.classList.toggle('editor-error',error);}}
  host.addEventListener('toggle',e=>{const el=e.target;if(el.open&&el.matches('[data-editor-section]')&&el.parentElement?.classList.contains('character-editor-body'))for(const other of el.parentElement.children)if(other!==el&&other.tagName==='DETAILS')other.open=false;},true);
  function render(){
    if(!base){host.hidden=true;return;}
    const opened=new Set([...host.querySelectorAll('[data-editor-section][open]')].map(e=>e.dataset.editorSection));
    host.hidden=false;
    let html=section('levels','战斗等级',grid(Object.entries(COMBAT_LEVELS).map(([k,v])=>field(['levels',k],v,draft.levels[k],{min:1})).join('')));
    if(!catalog){html+='<p>游戏数据加载后，可编辑装备、技能、触发条件与增益。</p>';}
    else {
      const maxEnh=enhancementMaximum(catalog);
      const equipment=Object.entries(catalog.itemDetailMap).filter(([,v])=>Object.hasOwn(SLOT_LABELS,v.equipmentDetail?.type?.split('/').pop())).sort(([a],[b])=>name(a,catalog.itemDetailMap[a]).localeCompare(name(b,catalog.itemDetailMap[b]),'zh'));
      const choicesFor=type=>equipment.filter(([,v])=>v.equipmentDetail.type===type).map(([k,v])=>[k,name(k,v)]);
      const overrides=Object.entries(SLOT_LABELS).map(([key,label])=>{
        const type=`/equipment_types/${key}`;draft.equipmentOverrides[type]||={hrid:'',enhancementLevel:0};const item=draft.equipmentOverrides[type];
        return `<div class="character-edit-row">${select(['equipmentOverrides',type,'hrid'],label,item.hrid,[['','跟随所选预设'],...choicesFor(type)])}${field(['equipmentOverrides',type,'enhancementLevel'],'强化',item.enhancementLevel,{max:maxEnh})}</div>`;
      }).join('');
      const inventory=draft.inventory.map((row,i)=>`<div class="character-edit-row">${select(['inventory',i,'itemHrid'],'装备',row.itemHrid,choicesFor(catalog.itemDetailMap[row.itemHrid]?.equipmentDetail.type))}${field(['inventory',i,'enhancementLevel'],'强化',row.enhancementLevel,{max:maxEnh})}${field(['inventory',i,'count'],'数量',row.count,{min:1,max:1000000000})}<button type="button" class="text-button" data-remove-inventory="${i}">删除</button></div>`).join('');
      html+=section('equipment','装备与强化',`<p class="editor-note">所选装备替换预设对应部位。</p>${grid(overrides)}${section('inventory','装备清单',inventory+`<div class="character-edit-row"><label>添加模拟装备<select id="editor-add-equipment">${equipment.map(([k,v])=>`<option value="${esc(k)}">${esc(name(k,v))}</option>`).join('')}</select></label><button type="button" class="text-button" data-add-inventory>添加装备</button></div>`)}`);
      const abilities=Object.entries(catalog.abilityDetailMap).sort(([,a],[,b])=>(a.sortIndex||0)-(b.sortIndex||0));
      html+=section('abilities','技能等级',`<p class="editor-note">0 表示未学习。</p>${grid(abilities.map(([k,v])=>field(['abilities',k],name(k,v),draft.abilities[k]||0)).join(''))}`);
      const triggerSkill=host.querySelector('#editor-trigger-skill')?.value||abilities[0]?.[0];
      html+=section('triggers','技能触发条件',`<label>技能<select id="editor-trigger-skill">${abilities.map(([k,v])=>`<option value="${esc(k)}" ${k===triggerSkill?'selected':''}>${esc(name(k,v))}</option>`).join('')}</select></label><div id="editor-triggers"></div><p class="editor-note">自定义条件为空时，无附加触发限制。</p>`);
      const buffOptions=Object.entries(catalog.buffTypeDetailMap).filter(([,v])=>v.isCombat).map(([k,v])=>[k,name(k,v)]);
      const buffs=Object.entries(BUFF_GROUPS).map(([group,label])=>section(`buff-${group}`,`${label}增益`,draft.buffs[group].map((b,i)=>{
        const choices=buffOptions.some(([k])=>k===b.typeHrid)?buffOptions:[...buffOptions,[b.typeHrid,name(b.typeHrid,catalog.buffTypeDetailMap[b.typeHrid])]];
        return `<div class="editor-buff">${select(['buffs',group,i,'typeHrid'],'增益类型',b.typeHrid,choices)}${grid(field(['buffs',group,i,'ratioBoost'],'比例加成 %',b.ratioBoost||0,{min:-1000000,max:1000000,step:'any',scale:.01})+field(['buffs',group,i,'flatBoost'],'固定加成',b.flatBoost||0,{min:-10000,step:'any'}))}<button type="button" class="text-button" data-remove-buff="${group}:${i}">删除此增益</button></div>`;
      }).join('')+`<button type="button" class="text-button" data-add-buff="${group}">添加${label}增益</button>`)).join('');
      html+=section('buffs','各来源增益',`<p class="editor-note">比例加成填百分数；固定加成按属性单位填写，概率类属性中 0.01 表示 1%。</p>${buffs}`);
      html+=section('labyrinth','迷宫升级与补给箱',grid(Object.entries(UPGRADES).map(([k,v])=>field(['upgrades',k],`${v}等级`,draft.upgrades[k])).join(''))+grid(Object.entries(CRATES).map(([k,label])=>{const kind=k.startsWith('tea')?'tea':k.startsWith('coffee')?'coffee':'food';return select(['crates',k],label,draft.crates[k],[['','不使用'],...Object.keys(catalog.labyrinthCrateDetailMap).filter(id=>id.endsWith(`_${kind}_crate`)).map(id=>[id,name(id,catalog.itemDetailMap[id])])]);}).join('')));
      html+=section('rooms','房屋设施与等级',grid(Object.entries(catalog.houseRoomDetailMap).filter(([,v])=>v.usableInActionTypeMap?.['/action_types/combat']).map(([k,v])=>field(['rooms',k],name(k,v),draft.rooms[k]||0,{max:Math.max(0,...Object.keys(v.upgradeCostsMap||{}).map(Number))||100})).join('')));
      const tierNames={beginner:'初学者',novice:'新手',adept:'熟练者',veteran:'老手',elite:'精英',champion:'冠军'};
      html+=section('achievements','成就增益',`<p class="editor-note">完成该类全部成就后启用增益。</p>${Object.entries(catalog.achievementTierDetailMap).sort(([,a],[,b])=>a.sortIndex-b.sortIndex).map(([k,t])=>{
        const ids=Object.entries(catalog.achievementDetailMap).filter(([,v])=>v.tierHrid===k).map(([id])=>id),count=ids.filter(id=>draft.achievements[id]).length;
        const label=tierNames[k.split('/').pop()]||'其他成就',boost=Number(((t.buff.ratioBoost||t.buff.flatBoost||0)*100).toFixed(4));
        return `<div class="editor-achievement"><strong>${label}（<span data-tier-count="${esc(k)}">${count}</span>/${ids.length}）</strong><p>${k.endsWith('/novice')?'经验':name(t.buff.typeHrid,catalog.buffTypeDetailMap[t.buff.typeHrid])}：+${boost}% · <span data-tier-state="${esc(k)}">${count===ids.length?'已启用':'未启用'}</span></p><label>已完成数量<input type="number" data-achievement-tier="${esc(k)}" min="0" max="${ids.length}" step="1" value="${count}"></label></div>`;
      }).join('')}`);
    }
    host.innerHTML=`<summary>角色数据</summary><div class="subsection-content character-editor-body">${html}<div class="editor-actions"><button type="button" class="secondary-button" data-apply-character ${!catalog?'disabled':''}>应用修改</button><button type="button" class="text-button" data-reset-character>恢复导入数据</button></div><p id="character-edit-status" role="status">${pending?'有未应用修改':modified?'已应用模拟修改':'当前为导入数据'}</p></div>`;
    for(const el of host.querySelectorAll('[data-editor-section]'))if(opened.has(el.dataset.editorSection))el.open=true;
    renderTriggers();
  }
  function renderTriggers(){
    const container=host.querySelector('#editor-triggers');if(!container)return;
    const hrid=host.querySelector('#editor-trigger-skill').value,custom=Object.hasOwn(draft.triggers,hrid);
    const rows=custom?draft.triggers[hrid]:catalog.abilityDetailMap[hrid].defaultCombatTriggers||[];
    const options=map=>Object.entries(map).map(([k,v])=>[k,name(k,v)]);
    container.innerHTML=`<p>${custom?'自定义条件':'游戏默认条件'}</p>${custom?rows.map((t,i)=>{
      const dep=catalog.combatTriggerDependencyDetailMap[t.dependencyHrid];
      const conditions=Object.fromEntries(Object.entries(catalog.combatTriggerConditionDetailMap).filter(([,v])=>dep&&(dep.isSingleTarget&&v.isSingleTarget||dep.isMultiTarget&&v.isMultiTarget)));
      const allowed=catalog.combatTriggerConditionDetailMap[t.conditionHrid]?.allowedComparatorHrids||[];
      return `<div class="character-edit-row editor-trigger">${select(['triggers',hrid,i,'dependencyHrid'],'对象',t.dependencyHrid,options(catalog.combatTriggerDependencyDetailMap))}${select(['triggers',hrid,i,'conditionHrid'],'条件',t.conditionHrid,options(conditions))}${select(['triggers',hrid,i,'comparatorHrid'],'比较',t.comparatorHrid,options(Object.fromEntries(allowed.map(k=>[k,catalog.combatTriggerComparatorDetailMap[k]]))))}${field(['triggers',hrid,i,'value'],'阈值',t.value||0,{max:1000000000,step:'any'})}<button type="button" class="text-button" data-remove-trigger="${i}">删除</button></div>`;
    }).join(''):`<p>${rows.length?rows.map(t=>esc(`${name(t.dependencyHrid,catalog.combatTriggerDependencyDetailMap[t.dependencyHrid])} · ${name(t.conditionHrid,catalog.combatTriggerConditionDetailMap[t.conditionHrid])} ${name(t.comparatorHrid,catalog.combatTriggerComparatorDetailMap[t.comparatorHrid])} ${t.value??''}`)).join('<br>'):'无附加触发限制'}</p>`}<button type="button" class="text-button" data-custom-trigger>${custom?'添加条件':'编辑默认条件'}</button> <button type="button" class="text-button" data-default-trigger>恢复游戏默认</button>`;
  }
  host.addEventListener('input',e=>{
    const tier=e.target.dataset.achievementTier;
    if(tier){
      const ids=Object.entries(catalog.achievementDetailMap).filter(([,v])=>v.tierHrid===tier).map(([id])=>id).sort((a,b)=>Number(!!draft.achievements[b])-Number(!!draft.achievements[a]));
      const count=Number(e.target.value),valid=e.target.value!==''&&Number.isInteger(count)&&count>=0&&count<=ids.length;
      e.target.setCustomValidity(valid?'':'请填写范围内的整数');
      if(!valid){status('成就数量须为范围内的整数。',true);return;}
      ids.forEach((id,i)=>set(['achievements',id],i<count));
      host.querySelector(`[data-tier-count="${tier}"]`).textContent=count;
      host.querySelector(`[data-tier-state="${tier}"]`).textContent=count===ids.length?'已启用':'未启用';return;
    }
    const path=e.target.dataset.editPath;if(!path||e.target.tagName==='SELECT')return;
    const value=e.target.type==='checkbox'?e.target.checked:e.target.value===''?'':Number(e.target.value)*(Number(e.target.dataset.scale)||1);
    set(JSON.parse(path),value);
  });
  host.addEventListener('change',e=>{
    if(e.target.id==='editor-trigger-skill'){renderTriggers();return;}
    if(!e.target.dataset.editPath||e.target.tagName!=='SELECT')return;
    const path=JSON.parse(e.target.dataset.editPath);set(path,e.target.value);
    if(path[0]==='triggers'){
      const t=draft.triggers[path[1]][path[2]],dep=catalog.combatTriggerDependencyDetailMap[t.dependencyHrid];
      const choices=Object.entries(catalog.combatTriggerConditionDetailMap).filter(([,v])=>dep.isSingleTarget&&v.isSingleTarget||dep.isMultiTarget&&v.isMultiTarget);
      if(!choices.some(([k])=>k===t.conditionHrid))t.conditionHrid=choices[0][0];
      const allowed=catalog.combatTriggerConditionDetailMap[t.conditionHrid].allowedComparatorHrids;
      if(!allowed.includes(t.comparatorHrid))t.comparatorHrid=allowed[0];renderTriggers();
    }
  });
  host.addEventListener('click',e=>{
    const button=e.target.closest('button');if(!button)return;
    try{
      if(button.hasAttribute('data-apply-character')){api.apply();return;}
      if(button.hasAttribute('data-reset-character')){draft=createCharacterDraft(base,catalog);pending=false;modified=false;onApply(structuredClone(base));render();return;}
      if(button.hasAttribute('data-add-inventory'))draft.inventory.push({itemHrid:host.querySelector('#editor-add-equipment').value,enhancementLevel:0,count:1,sourceIndex:-1});
      else if(button.hasAttribute('data-remove-inventory'))draft.inventory.splice(Number(button.dataset.removeInventory),1);
      else if(button.hasAttribute('data-add-buff'))draft.buffs[button.dataset.addBuff].push({typeHrid:'/buff_types/damage',ratioBoost:0,flatBoost:0,ratioBoostLevelBonus:0,flatBoostLevelBonus:0,duration:0});
      else if(button.hasAttribute('data-remove-buff')){const[g,i]=button.dataset.removeBuff.split(':');draft.buffs[g].splice(Number(i),1);}
      else if(button.hasAttribute('data-custom-trigger')){const hrid=host.querySelector('#editor-trigger-skill').value;if(!Object.hasOwn(draft.triggers,hrid))draft.triggers[hrid]=structuredClone(catalog.abilityDetailMap[hrid].defaultCombatTriggers||[]);else draft.triggers[hrid].push({dependencyHrid:'/combat_trigger_dependencies/self',conditionHrid:'/combat_trigger_conditions/current_hp',comparatorHrid:'/combat_trigger_comparators/less_than_equal',value:100});}
      else if(button.hasAttribute('data-default-trigger'))delete draft.triggers[host.querySelector('#editor-trigger-skill').value];
      else if(button.hasAttribute('data-remove-trigger'))draft.triggers[host.querySelector('#editor-trigger-skill').value].splice(Number(button.dataset.removeTrigger),1);
      else return;
      pending=true;modified=true;render();
    }catch(error){status(error.message,true);}
  });
  const api={
    load(character,nextCatalog){base=structuredClone(character);catalog=nextCatalog;draft=createCharacterDraft(base,catalog);pending=false;modified=false;onApply(structuredClone(base));render();host.open=true;},
    catalog(next){const hadCatalog=!!catalog;catalog=next;if(!base)return;if(!hadCatalog)draft.inventory=createCharacterDraft(base,catalog).inventory;if(modified)pending=true;render();},
    apply(){if([...host.querySelectorAll('[data-achievement-tier]')].some(el=>!el.checkValidity()))throw Error('成就数量须为范围内的整数');if(!pending)return;try{const next=applyCharacterDraft(base,draft,catalog);onApply(next);pending=false;status('已应用；下一次模拟使用修改后的角色数据。');}catch(error){status(error.message,true);throw error;}},
    hasEdits(){return modified;},
    snapshot(){return modified?structuredClone(draft):null;},
    restore(saved){if(saved){draft=structuredClone(saved);pending=true;modified=true;api.apply();render();}else if(base){draft=createCharacterDraft(base,catalog);pending=false;modified=false;onApply(structuredClone(base));render();}},
    hide(){host.hidden=true;},
  };return api;
}
