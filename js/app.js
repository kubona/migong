import {createCharacterEditor} from './character-editor.js';
import {LABYRINTH_MONSTER_HRIDS,sanitizeCharacterData,validateClientData,compareCharacterToCatalog} from './data-model.js';
import {loadChineseTranslations,chineseName} from './localization.js';
import {SIMULATION_DIRECTION_OPTIONS,ROTATION_EQUIPMENT} from './equipment-presets.js';
import {SLOT_LABELS} from './character-editor-model.js';
import {learnedFixedAbilityChoices,sanitizeFixedAbilityRules,DEFAULT_FIXED_ABILITY_RULES} from './fixed-skill-options.js';
import {classifyMonster} from './classifier.js';
import {prepareDirection,directionProfile,resolveSimulationDirections,previewMonster} from './candidate-planner.js';
import {searchExploration} from './exploration-search.js';
import {CombatEngine,recommendedWorkerCount} from './engine-adapter.js';
import {RunStorage,fingerprint,runtimeFingerprint} from './run-storage.js';
import {createPauseController} from './pause-controller.js';
await loadChineseTranslations();
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name=id=>chineseName(id,'未命名'),pct=n=>(100*n).toFixed(2)+'%',seconds=n=>Number.isFinite(n)?n.toFixed(2)+'秒':'—';
const state={character:null,source:null,catalog:null,rules:structuredClone(DEFAULT_FIXED_ABILITY_RULES),results:[],busy:false,controller:null,engine:null,pause:null,store:null,bridgeRevision:0,selected:0,point:0};
function status(s){$('run-status').textContent=s;}
function resetResults(){state.results=[];state.selected=0;state.point=0;$('results').hidden=true;$('preview-panel').hidden=true;}
const editor=createCharacterEditor($('character-editor'),c=>{state.character=c;resetResults();ready();});
function ready(){const okay=!!(state.character&&state.catalog);for(const id of ['start','resume','preview'])$(id).disabled=!okay||state.busy;if(!state.busy)status(okay?'已就绪':'请导入数据');if(okay){state.rules=sanitizeFixedAbilityRules(state.rules,state.catalog,state.character);renderRules();}}
function loadCharacter(raw){state.source=sanitizeCharacterData(raw);editor.load(state.source,state.catalog);$('character-status').textContent='已导入';ready();}
function loadCatalog(raw){const v=validateClientData(raw);if(!v.ok)throw Error(v.errors.join('；'));state.catalog=raw;editor.catalog(raw);$('client-status').textContent='已导入';ready();}
function guarded(fn){return async(...args)=>{try{await fn(...args);}catch(e){status(e.message);}};}
for(const [id,load]of [['character-file',loadCharacter],['client-file',loadCatalog]])$(id).addEventListener('change',guarded(async e=>{if(state.busy)return;const file=e.target.files[0];if(file){let raw;try{raw=JSON.parse(await file.text());}catch{throw Error('文件不是有效的角色或游戏数据');}load(raw);}}));
function selectedMonsters(){return [...$('monster-options').querySelectorAll('input:checked')].map(e=>e.value);}
function updateScope(){$('scope-summary').textContent=`${selectedMonsters().length}种怪物`;}
$('monster-options').innerHTML=LABYRINTH_MONSTER_HRIDS.map(id=>`<div class="monster"><label><input type="checkbox" value="${id}" checked>${esc(name(id))}</label><select data-direction="${id}" aria-label="${esc(name(id))}配装方向"><option value="auto">自动</option>${SIMULATION_DIRECTION_OPTIONS.filter(d=>d.value!=='auto').map(d=>`<option value="${esc(d.value)}">${esc(d.label)}</option>`).join('')}</select></div>`).join('');
$('equipment-options').innerHTML=Object.keys(ROTATION_EQUIPMENT).map(id=>`<label><input type="checkbox" value="${id}" checked>${SLOT_LABELS[id.split('/').pop()]}</label>`).join('');
$('monster-options').addEventListener('change',updateScope);document.querySelectorAll('[data-all]').forEach(b=>b.onclick=()=>{$('monster-options').querySelectorAll('input').forEach(e=>e.checked=b.dataset.all==='true');updateScope();});updateScope();
function renderRules(){
 if(!state.character||!state.catalog)return;
 const choices=aura=>learnedFixedAbilityChoices(state.catalog,state.character,aura).map(e=>e.hrid);
 const select=(category,index,value,aura)=>`<select data-category="${category}" data-index="${index}"><option value="">不固定</option>${choices(aura).map(id=>`<option value="${id}" ${id===value?'selected':''}>${esc(name(id))}</option>`).join('')}</select>`;
 $('fixed-rules').innerHTML=Object.entries({magic:'魔法',physical:'物理',mimic:'宝箱怪'}).map(([category,label])=>{const r=state.rules[category];return `<div class="fixed-group"><h3>${label}</h3><div class="grid"><label>特殊技能${select(category,-1,r.aura,true)}</label>${r.requiredActives.map((id,i)=>`<label>主动技能${select(category,i,id,false)}<button data-remove="${category}:${i}">删除</button></label>`).join('')}</div>${r.requiredActives.length<4?`<button data-add="${category}">添加主动技能</button>`:''}</div>`;}).join('');
}
$('fixed-rules').addEventListener('change',e=>{if(!e.target.dataset.category)return;const r=state.rules[e.target.dataset.category],i=Number(e.target.dataset.index);if(i<0)r.aura=e.target.value;else r.requiredActives[i]=e.target.value;});
$('fixed-rules').addEventListener('click',e=>{if(e.target.dataset.add){state.rules[e.target.dataset.add].requiredActives.push('');renderRules();}if(e.target.dataset.remove){const[c,i]=e.target.dataset.remove.split(':');state.rules[c].requiredActives.splice(Number(i),1);renderRules();}});
const fields=['minimum','maximum','target','resource','screen-trials','level-trials','final-trials','preset'];
function settings(){
 for(const id of fields){const e=$(id);if(!e.checkValidity()||e.value==='')throw Error('请检查模拟设置');}
 if(Number($('minimum').value)>Number($('maximum').value))throw Error('最低等级不能高于最高等级');
 for(const id of ['minimum','maximum','screen-trials','level-trials','final-trials'])if(!Number.isInteger(Number($(id).value)))throw Error('等级和场数必须为整数');
 return {fields:Object.fromEntries(fields.map(id=>[id,$(id).value])),monsters:selectedMonsters(),equipment:[...$('equipment-options').querySelectorAll('input:checked')].map(e=>e.value),
 directions:Object.fromEntries([...document.querySelectorAll('[data-direction]')].map(e=>[e.dataset.direction,e.value])),aura:$('aura').checked,active:$('active').checked,rules:sanitizeFixedAbilityRules(state.rules,state.catalog,state.character),characterEditor:editor.snapshot()};
}
function restore(s){for(const[id,v]of Object.entries(s.fields))if($(id))$(id).value=v;$('monster-options').querySelectorAll('input').forEach(e=>e.checked=s.monsters.includes(e.value));$('equipment-options').querySelectorAll('input').forEach(e=>e.checked=s.equipment.includes(e.value));document.querySelectorAll('[data-direction]').forEach(e=>e.value=s.directions[e.dataset.direction]);$('aura').checked=s.aura;$('active').checked=s.active;state.rules=structuredClone(s.rules);editor.restore(s.characterEditor);renderRules();updateScope();}
function options(s,id){return {character:state.character,catalog:state.catalog,monsterHrid:id,simulationDirection:s.directions[id],equipmentPresetSource:s.fields.preset,
 selectedEquipmentTypes:s.equipment,optimizableEquipmentTypes:s.equipment,optimizeAura:s.aura,optimizeActives:s.active,fixedAbilityRules:s.rules,minimumEquipmentLevel:80,
 minMonsterLevel:Number(s.fields.minimum),maxMonsterLevel:Number(s.fields.maximum),targetRate:Number(s.fields.target)/100,testTrials:Number(s.fields['screen-trials']),reviewTrials:Number(s.fields['level-trials']),rankingTrials:Number(s.fields['final-trials'])};}
function download(data,label){const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=label;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
let lastProgress=0;
async function run(resume){
 if(state.busy)return;editor.apply();state.busy=true;$('configuration').inert=true;ready();let store,s;
 try{
  store=await RunStorage.open();
  if(resume){const saved=await store.get('latest');if(!saved||saved.settings?.version!==52)throw Error('没有可恢复的052任务');if(await fingerprint(state.source)!==saved.settings.sourceFingerprint)throw Error('请导入原始角色数据');restore(saved.settings);}
  editor.apply();s=settings();if(!s.monsters.length)throw Error('请选择怪物');
  const coverage=compareCharacterToCatalog(state.character,state.catalog);if(coverage.warnings.length)$('data-status').textContent=coverage.warnings.join('；');
  s.version=52;s.sourceFingerprint=await fingerprint(state.source);const workers=recommendedWorkerCount(navigator.hardwareConcurrency,s.fields.resource);
  const identity=await fingerprint({character:state.character,catalog:state.catalog,settings:s,workers,runtime:await runtimeFingerprint()});
  const meta=await store.begin(identity,s,resume);state.store?.db.close();state.store=store;state.busy=true;state.controller=new AbortController();state.pause=createPauseController();resetResults();
  $('configuration').inert=true;ready();$('pause').hidden=false;$('stop').hidden=false;$('progress').hidden=false;$('progress').value=0;
  const start=Date.now(),elapsed=resume?meta.elapsed||0:0;const timer=setInterval(()=>{$('run-time').textContent=`运行 ${Math.floor((Date.now()-start+elapsed)/1000)}秒`;},1000);
  try{
   state.engine=new CombatEngine({workerCount:workers,planScheduling:true});await state.engine.initialize(state.catalog);
   for(let i=0;i<s.monsters.length;i++){
    const id=s.monsters[i],o=options(s,id),profile=classifyMonster(state.catalog.combatMonsterDetailMap[id],{roomLevel:100,playerCombatDetails:state.character.combatDetails});
    const direction=resolveSimulationDirections(profile,o.simulationDirection)[0];const prepared=prepareDirection({...o,direction,profile:directionProfile(profile,direction)});
    const output=await searchExploration({...o,iterate:prepared.iterate,engine:state.engine,runStorage:store,signal:state.controller.signal,pauseController:state.pause,
     onProgress:p=>{if(Date.now()-lastProgress<200&&p.phase!=='complete')return;lastProgress=Date.now();const part=p.phase==='index'?0:p.phase==='search'?.05+.55*p.done/Math.max(1,p.total):p.phase==='review'?.6+.4*p.done/Math.max(1,p.total):1;
      $('progress').value=(i+part)/s.monsters.length;status(`${name(id)} · ${{index:'整理候选',search:'等级搜索',review:'方案复核',complete:'完成'}[p.phase]} ${p.done}/${p.total}`);}});
    state.results.push({...output,name:name(id),direction});state.selected=state.results.length-1;state.point=0;renderResults();
   }
   await store.updateMeta({complete:true});status('模拟完成');
  }finally{clearInterval(timer);state.engine?.terminate();state.engine=null;await store.updateMeta({elapsed:elapsed+Date.now()-start});}
 }catch(e){if(store&&state.store!==store)store.db.close();throw e;}
 finally{state.busy=false;state.controller=null;$('configuration').inert=false;$('pause').hidden=true;$('stop').hidden=true;$('pause').textContent='暂停';for(const id of ['start','resume','preview'])$(id).disabled=!(state.character&&state.catalog);}
}
$('start').onclick=guarded(()=>run(false));$('resume').onclick=guarded(()=>run(true));
$('pause').onclick=()=>{if(!state.pause)return;if(state.pause.paused){state.pause.resume();$('pause').textContent='暂停';}else{state.pause.pause();$('pause').textContent='继续';}};
$('stop').onclick=()=>{state.controller?.abort();state.engine?.terminate();};
$('preview').onclick=guarded(async()=>{editor.apply();const s=settings();if(!s.monsters.length)throw Error('请选择怪物');state.busy=true;$('configuration').inert=true;ready();try{$('preview-panel').hidden=false;$('preview-panel').textContent='正在整理候选';let html='';for(const id of s.monsters){const p=await previewMonster(options(s,id));html+=`<p>${esc(name(id))}：${p.count}套</p>`;}$('preview-panel').innerHTML=html;}finally{state.busy=false;$('configuration').inert=false;ready();}});
function renderResults(){
 $('results').hidden=false;$('result-tabs').innerHTML=state.results.map((r,i)=>`<button data-result="${i}" class="${i===state.selected?'active':''}">${esc(r.name)}</button>`).join('');
 const r=state.results[state.selected];if(!r)return;
 if(!r.frontier.length){$('result-body').innerHTML='<p>设置等级范围内没有最终达标方案。</p>';return;}
 state.point=Math.min(state.point,r.frontier.length-1);const p=r.frontier[state.point];
 const table=`<div class="table-scroll"><table><thead><tr><th>建议等级</th><th>房间通过概率</th><th>房间平均耗时</th><th>单场胜率</th></tr></thead><tbody>${r.frontier.map((x,i)=>`<tr tabindex="0" role="button" data-point="${i}" class="${i===state.point?'selected':''}"><td>${x.level}</td><td>${pct(x.metrics.roomPassRate)}</td><td>${seconds(x.metrics.averageRoomSeconds)}</td><td>${pct(x.metrics.singleWinRate)}</td></tr>`).join('')}</tbody></table></div>`;
 const gear=Object.entries(p.plan.equipmentCandidate.equipment).map(([slot,v])=>`<div><span>${SLOT_LABELS[slot.split('/').pop()]||'装备'}</span><span>${esc(name(v.hrid))} +${v.enhancementLevel}</span></div>`).join('');
 const abilities=p.plan.abilityOrder.abilities.map(a=>esc(name(a.hrid))).join(' → ');
 $('result-body').innerHTML=table+`<div class="loadout">${gear}</div><p>${abilities}</p>`;
}
$('result-tabs').onclick=e=>{if(e.target.dataset.result!==undefined){state.selected=Number(e.target.dataset.result);state.point=0;renderResults();}};
$('result-body').onclick=e=>{const row=e.target.closest('[data-point]');if(row){state.point=Number(row.dataset.point);renderResults();}};
$('result-body').onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target.dataset.point!==undefined){e.preventDefault();state.point=Number(e.target.dataset.point);renderResults();}};
$('export').onclick=()=>download({version:52,attemptLimit:2,failurePenaltySeconds:120,results:state.results},'迷宫模拟结果-v052.json');
$('audit').onclick=guarded(async()=>{
 if(!state.store)return;const parts=[];let buffer='{"version":52,"attemptLimit":2,"rows":[',comma='';
 for await(const [key,value]of state.store.entries(state.store.key('explore/'))){buffer+=comma+JSON.stringify({key:key.slice(state.store.id.length+1),value});comma=',';if(buffer.length>=262144){parts.push(new Blob([buffer]));buffer='';}}
 parts.push(buffer+']}');const url=URL.createObjectURL(new Blob(parts,{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='迷宫模拟明细-v052.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('clear').onclick=guarded(async()=>{if(state.busy)throw Error('请先停止模拟');const store=await RunStorage.open();try{await store.clearAll();}finally{store.db.close();}resetResults();status('本机任务已清除');});
if(['127.0.0.1','localhost'].includes(location.hostname))setInterval(async()=>{if(state.busy||editor.hasEdits())return;try{const response=await fetch(`/api/data?since=${state.bridgeRevision}`,{cache:'no-store'});if(!response.ok)return;const data=await response.json();if(data.unchanged)return;state.bridgeRevision=data.revision;if(data.client)loadCatalog(data.client);if(data.character)loadCharacter(data.character);}catch{}},2000);
