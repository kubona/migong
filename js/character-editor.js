import {SIMULATION_DIRECTION_OPTIONS} from './equipment-presets.js';
import {classifyAbility} from './classifier.js';
import {COMBAT_LEVELS,UPGRADES,BUFF_GROUPS,SLOT_LABELS,CRATES,createCharacterDraft,applyCharacterDraft,enhancementMaximum,totalCombatLevel} from './character-editor-model.js';
import {chineseName} from './localization.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name=(id,detail)=>{const label=chineseName(id,detail?.name||'');return /[a-z]/i.test(label)?'未收录中文名称':label||'未命名项目';};
export function createCharacterEditor(host,onApply){
  let base=null,catalog=null,draft=null,pending=false,modified=false;const selectedSkills=new Set();
  const field=(path,label,value,{min=0,max=10000,step='1',scale=1}={})=>`<label>${esc(label)}<input type="number" data-edit-path="${esc(JSON.stringify(path))}" data-scale="${scale}" min="${min}" max="${max}" step="${step}" value="${esc(value===''?'':value/scale)}"></label>`;
  const select=(path,label,value,choices)=>`<label>${esc(label)}<select data-edit-path="${esc(JSON.stringify(path))}">${choices.map(([v,t])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;
  const section=(id,label,html,open=false)=>`<details class="subsection" data-editor-section="${id}" ${open?'open':''}><summary>${label}</summary><div class="subsection-content">${html}</div></details>`;
  const grid=s=>`<div class="character-edit-grid">${s}</div>`;
  function set(path,value){let obj=draft;for(const k of path.slice(0,-1))obj=obj[k];obj[path.at(-1)]=value;pending=true;modified=true;status('有未应用修改');if(path[0]==='levels')updateTotal();}
  function status(message,error=false){const el=host.querySelector('#character-edit-status');if(el){el.textContent=message;el.classList.toggle('editor-error',error);}}
  host.addEventListener('toggle',e=>{const el=e.target;if(el.open&&el.matches('[data-editor-section]')&&el.parentElement?.classList.contains('character-editor-body'))for(const other of el.parentElement.children)if(other!==el&&other.tagName==='DETAILS')other.open=false;},true);
  function updateTotal(){
    const el=host.querySelector('#total-combat-level');if(!el||!draft)return;
    const unchanged=Object.entries(draft.levels).every(([k,v])=>Number(v)===(base.characterSkills.find(s=>s.skillHrid===`/skills/${k}`)?.level||1));
    const imported=base.combatDetails?.combatLevel;
    const valid=Object.values(draft.levels).every(v=>v!==''&&Number.isFinite(Number(v))&&Number(v)>=1);
    el.value=valid?(unchanged&&Number.isFinite(imported)?imported:totalCombatLevel(draft.levels)):'—';
  }
  function skillGroup(ability){
    const c=classifyAbility(ability);
    if(c.isAura)return '特殊技能';
    if(c.styles.has('/combat_styles/magic'))return c.damageTypes.has('/damage_types/water')?'水系':c.damageTypes.has('/damage_types/fire')?'火系':c.damageTypes.has('/damage_types/nature')?'自然系':'魔法';
    if(c.styles.has('/combat_styles/ranged'))return '远程';
    if([...c.styles].some(s=>['/combat_styles/slash','/combat_styles/smash','/combat_styles/stab'].includes(s)))return '近战';
    return c.hasHealing?'治疗':'通用';
  }
  function render(){
    if(!base){host.hidden=true;return;}
    const opened=new Set([...host.querySelectorAll('[data-editor-section][open]')].map(e=>e.dataset.editorSection));
    host.hidden=false;
    let html=section('levels','战斗等级',grid('<label>总战斗等级<input id="total-combat-level" readonly></label>'+Object.entries(COMBAT_LEVELS).map(([k,v])=>field(['levels',k],v,draft.levels[k],{min:1})).join('')));
    if(!catalog){html+='<p>游戏数据加载后，可编辑装备、技能与增益。</p>';}
    else {
      const maxEnh=enhancementMaximum(catalog);
      const equipment=Object.entries(catalog.itemDetailMap).filter(([,v])=>Object.hasOwn(SLOT_LABELS,v.equipmentDetail?.type?.split('/').pop())).sort(([a],[b])=>name(a,catalog.itemDetailMap[a]).localeCompare(name(b,catalog.itemDetailMap[b]),'zh'));
      const choicesFor=type=>equipment.filter(([,v])=>v.equipmentDetail.type===type).map(([k,v])=>[k,name(k,v)]);
      const presets=SIMULATION_DIRECTION_OPTIONS.filter(d=>d.value!=='auto').map(({value:key,label})=>section(`preset-${key}`,label,
        `<div class="preset-equipment-grid">${Object.entries(draft.presetEquipment[key]||{}).map(([type,item])=>`<div class="preset-item">${select(['presetEquipment',key,type,'hrid'],SLOT_LABELS[type.split('/').pop()],item.hrid,[['','未配置'],...choicesFor(type)])}${field(['presetEquipment',key,type,'enhancementLevel'],'强化等级',item.enhancementLevel,{max:maxEnh})}</div>`).join('')}</div>`)).join('');
      html+=section('equipment','装备与强化',presets);
      const abilities=Object.entries(catalog.abilityDetailMap).sort(([,a],[,b])=>(a.sortIndex||0)-(b.sortIndex||0));
      const buttons=group=>`<div class="toolbar skill-selection"><button data-select-skills="all" data-skill-group="${group}">全选</button><button data-select-skills="invert" data-skill-group="${group}">反选</button><button data-select-skills="clear" data-skill-group="${group}">清空</button></div>`;
      html+=section('abilities','技能等级',`<div class="skill-batch">${buttons('')}<label>批量等级<input id="batch-skill-level" type="number" min="0" max="10000" value="1"></label><button data-batch-skills>设置所选技能</button></div>`+
       ['特殊技能','近战','远程','水系','火系','自然系','魔法','治疗','通用'].map(group=>{
        const members=abilities.filter(([,v])=>skillGroup(v)===group);if(!members.length)return '';
        return section(`skills-${group}`,group,buttons(group)+`<div class="skill-level-grid">${members.map(([k,v])=>`<div class="skill-level-row"><label><input type="checkbox" data-skill-select="${k}" data-skill-group="${group}" ${selectedSkills.has(k)?'checked':''}>${esc(name(k,v))}</label><input aria-label="${esc(name(k,v))}等级" type="number" data-edit-path="${esc(JSON.stringify(['abilities',k]))}" min="0" max="10000" step="1" value="${draft.abilities[k]||0}"></div>`).join('')}</div>`);
       }).join(''));
      const buffOptions=Object.entries(catalog.buffTypeDetailMap).filter(([,v])=>v.isCombat).map(([k,v])=>[k,name(k,v)]);
      const buffs=Object.entries(BUFF_GROUPS).map(([group,label])=>section(`buff-${group}`,`${label}增益`,`<div class="buff-items">`+draft.buffs[group].map((b,i)=>{
        const choices=buffOptions.some(([k])=>k===b.typeHrid)?buffOptions:[...buffOptions,[b.typeHrid,name(b.typeHrid,catalog.buffTypeDetailMap[b.typeHrid])]];
        return `<div class="editor-buff">${select(['buffs',group,i,'typeHrid'],'增益类型',b.typeHrid,choices)}${grid(field(['buffs',group,i,'ratioBoost'],'比例加成 %',b.ratioBoost||0,{min:-1000000,max:1000000,step:'any',scale:.01})+field(['buffs',group,i,'flatBoost'],'固定加成',b.flatBoost||0,{min:-10000,step:'any'}))}<button type="button" class="text-button" data-remove-buff="${group}:${i}">删除此增益</button></div>`;
      }).join('')+`</div><button type="button" class="text-button" data-add-buff="${group}">添加${label}增益</button>`)).join('');
      html+=section('buffs','各来源增益',`<p class="editor-note">比例加成填百分数；固定加成按属性单位填写，概率类属性中 0.01 表示 1%。</p><div class="buff-groups">${buffs}</div>`);
      html+=section('labyrinth','迷宫升级与补给箱',grid(Object.entries(UPGRADES).map(([k,v])=>field(['upgrades',k],`${v}等级`,draft.upgrades[k])).join(''))+grid(Object.entries(CRATES).map(([k,label])=>{const kind=k.startsWith('tea')?'tea':k.startsWith('coffee')?'coffee':'food';return select(['crates',k],label,draft.crates[k],[['','不使用'],...Object.keys(catalog.labyrinthCrateDetailMap).filter(id=>id.endsWith(`_${kind}_crate`)).map(id=>[id,name(id,catalog.itemDetailMap[id])])]);}).join('')));
      html+=section('rooms','房屋设施与等级',grid(Object.entries(catalog.houseRoomDetailMap).filter(([,v])=>v.usableInActionTypeMap?.['/action_types/combat']).map(([k,v])=>field(['rooms',k],name(k,v),draft.rooms[k]||0,{max:Math.max(0,...Object.keys(v.upgradeCostsMap||{}).map(Number))||100})).join('')));
      const tierNames={beginner:'初学者',novice:'新手',adept:'熟练者',veteran:'老手',elite:'精英',champion:'冠军'};
      html+=section('achievements','成就增益',`<div class="achievement-grid">${Object.entries(catalog.achievementTierDetailMap).sort(([,a],[,b])=>a.sortIndex-b.sortIndex).map(([k,t])=>{
        const ids=Object.entries(catalog.achievementDetailMap).filter(([,v])=>v.tierHrid===k).map(([id])=>id);
        const label=tierNames[k.split('/').pop()]||'其他成就',boost=Number(((t.buff.ratioBoost||t.buff.flatBoost||0)*100).toFixed(4));
        return `<label class="achievement-toggle"><input type="checkbox" data-achievement-tier="${k}" ${ids.every(id=>draft.achievements[id])?'checked':''}><span><strong>${label}</strong><span>${k.endsWith('/novice')?'经验':name(t.buff.typeHrid,catalog.buffTypeDetailMap[t.buff.typeHrid])} +${boost}%</span></span></label>`;
      }).join('')}</div>`);

    }
    host.innerHTML=`<summary>角色数据</summary><div class="subsection-content character-editor-body">${html}<div class="editor-actions"><button type="button" class="secondary-button" data-apply-character ${!catalog?'disabled':''}>应用修改</button><button type="button" class="text-button" data-reset-character>恢复导入数据</button></div><p id="character-edit-status" role="status">${pending?'有未应用修改':modified?'已应用模拟修改':'当前为导入数据'}</p></div>`;
    for(const el of host.querySelectorAll('[data-editor-section]'))if(opened.has(el.dataset.editorSection))el.open=true;
    updateTotal();
  }
  host.addEventListener('input',e=>{
    const tier=e.target.dataset.achievementTier;
    if(tier){for(const[id,v]of Object.entries(catalog.achievementDetailMap))if(v.tierHrid===tier)set(['achievements',id],e.target.checked);return;}
    if(e.target.dataset.skillSelect){if(e.target.checked)selectedSkills.add(e.target.dataset.skillSelect);else selectedSkills.delete(e.target.dataset.skillSelect);return;}
    const path=e.target.dataset.editPath;if(!path||e.target.tagName==='SELECT')return;
    const value=e.target.type==='checkbox'?e.target.checked:e.target.value===''?'':Number(e.target.value)*(Number(e.target.dataset.scale)||1);
    set(JSON.parse(path),value);
  });
  host.addEventListener('change',e=>{
    if(!e.target.dataset.editPath||e.target.tagName!=='SELECT')return;
    set(JSON.parse(e.target.dataset.editPath),e.target.value);
  });
  host.addEventListener('click',e=>{
    const button=e.target.closest('button');if(!button)return;
    try{
      if(button.hasAttribute('data-apply-character')){api.apply();return;}
      if(button.hasAttribute('data-reset-character')){selectedSkills.clear();draft=createCharacterDraft(base,catalog);pending=false;modified=false;onApply(structuredClone(base));render();return;}
      if(button.hasAttribute('data-select-skills')){
        const group=button.dataset.skillGroup;
        for(const input of host.querySelectorAll('[data-skill-select]'))if(!group||input.dataset.skillGroup===group){
          input.checked=button.dataset.selectSkills==='all'||button.dataset.selectSkills==='invert'&&!input.checked;
          if(input.checked)selectedSkills.add(input.dataset.skillSelect);else selectedSkills.delete(input.dataset.skillSelect);
        }return;
      }
      if(button.hasAttribute('data-batch-skills')){
        const field=host.querySelector('#batch-skill-level');if(field.value===''||!field.checkValidity())throw Error('批量等级须为0～10000之间的整数');
        if(!selectedSkills.size)throw Error('请先选择技能');
        for(const id of selectedSkills)set(['abilities',id],Number(field.value));render();return;
      }
      if(button.hasAttribute('data-add-buff'))draft.buffs[button.dataset.addBuff].push({typeHrid:'/buff_types/damage',ratioBoost:0,flatBoost:0,ratioBoostLevelBonus:0,flatBoostLevelBonus:0,duration:0});
      else if(button.hasAttribute('data-remove-buff')){const[g,i]=button.dataset.removeBuff.split(':');draft.buffs[g].splice(Number(i),1);}
      else return;
      pending=true;modified=true;render();
    }catch(error){status(error.message,true);}
  });
  const api={
    load(character,nextCatalog){selectedSkills.clear();base=structuredClone(character);catalog=nextCatalog;draft=createCharacterDraft(base,catalog);pending=false;modified=false;onApply(structuredClone(base));render();host.open=true;},
    catalog(next){const hadCatalog=!!catalog;catalog=next;if(!base)return;if(!hadCatalog)draft.presetEquipment=createCharacterDraft(base,catalog).presetEquipment;if(modified)pending=true;render();},
    apply(){if(!pending)return;try{const next=applyCharacterDraft(base,draft,catalog);onApply(next);pending=false;status('已应用；下一次模拟使用修改后的角色数据。');}catch(error){status(error.message,true);throw error;}},
    hasEdits(){return modified;},
    snapshot(){return modified?structuredClone(draft):null;},
    restore(saved){if(saved){draft=structuredClone(saved);pending=true;modified=true;api.apply();render();}else if(base){draft=createCharacterDraft(base,catalog);pending=false;modified=false;onApply(structuredClone(base));render();}},
    hide(){host.hidden=true;},
  };return api;
}
