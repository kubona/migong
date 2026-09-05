import {
  COMBAT_EQUIPMENT_TYPES,
  LABYRINTH_MONSTER_HRIDS,
  compareCharacterToCatalog,
  floorRangeText,
  monsterLevelToFloorRange,
  parseJsonText,
  sanitizeCharacterData,
  summarizeCharacter,
  validateClientData,
} from "./data-model.js";
import { CombatEngine, recommendedWorkerCount } from "./engine-adapter.js";
import { DEFAULT_FIXED_ABILITY_RULES, learnedFixedAbilityChoices, sanitizeFixedAbilityRules } from "./fixed-skill-options.js";
import { chineseName, loadChineseTranslations } from "./localization.js";
import { optimizeMonster } from "./optimizer.js";
import { downloadLoadouts, officialIconMarkup, loadoutRows } from "./loadout-image.js";
import { createPauseController } from "./pause-controller.js";
import { formatRunDuration, progressWithinMonster, remainingMilliseconds } from "./progress-metrics.js";
import { SIMULATION_DIRECTION_OPTIONS } from "./equipment-presets.js";
import { previewMonster } from './exhaustive-optimizer.js';
import { RunStorage, fingerprint, runtimeFingerprint, learningRuntimeFingerprint } from './run-storage.js';
import { exportLearning, importLearning } from './learning-library.js';
import { buildSimulationInput } from './player-dto.js';
import { createStoredAudit } from './stored-audit.js';
import { WorkEstimator } from './work-estimator.js';
import { maximumBinaryProbeCount } from './progress-metrics.js';

await loadChineseTranslations();

const SLOT_NAMES = {
  "/equipment_types/head": "头", "/equipment_types/body": "身", "/equipment_types/legs": "腿", "/equipment_types/feet": "脚",
  "/equipment_types/hands": "手", "/equipment_types/main_hand": "主", "/equipment_types/two_hand": "主", "/equipment_types/off_hand": "副",
  "/equipment_types/pouch": "袋子", "/equipment_types/back": "背", "/equipment_types/neck": "项链", "/equipment_types/earrings": "耳环", "/equipment_types/ring": "戒指",
};
const MONSTER_NAMES = Object.fromEntries(LABYRINTH_MONSTER_HRIDS.map((hrid) => [hrid, chineseName(hrid, hrid.split("/").pop())]));
const HAND_TYPES = new Set(["/equipment_types/main_hand", "/equipment_types/two_hand", "/equipment_types/off_hand"]);
const EQUIPMENT_OPTIONS = [
  { value: "/equipment_types/main_hand", label: "主手" },
  { value: "/equipment_types/off_hand", label: "副手" },
  ...[...COMBAT_EQUIPMENT_TYPES].filter((type) => !HAND_TYPES.has(type)).map((type) => ({ value: type, label: SLOT_NAMES[type] || type })),
];
const DEFAULT_EQUIPMENT_VALUES = new Set(["/equipment_types/head", "/equipment_types/body", "/equipment_types/legs", "/equipment_types/hands", "/equipment_types/feet"]);
const CHOICE_GROUP_IDS = { monsters: "monster-options", equipment: "equipment-options", skills: "skill-options" };
const FIXED_RULE_CATEGORIES = [
  { key: "magic", label: "魔法类" },
  { key: "physical", label: "物理类" },
  { key: "mimic", label: "宝箱怪特化" },
];
const elements = Object.fromEntries([
  'search-mode','learning-budget','learning-status','export-learning','import-learning',
  'preview-button','resume-button','candidate-panel','candidate-preview','checkpoint-status','performance-status',
  "bridge-status", "character-file", "client-file", "character-card", "client-card", "character-status", "client-status", "data-summary",
  "monster-options", "equipment-options", "skill-options", "fixed-rules-status", "fixed-skill-rules", "min-monster-level", "max-monster-level", "test-trials", "review-trials", "optimize-trials", "equipment-preset-source", "resource-utilization",
  "target-rate", "parallel-count", "start-button", "pause-button", "cancel-button", "run-status", "audit-status", "run-time-status", "elapsed-time", "remaining-time", "progress-percent", "progress-track", "progress-bar", "results-section", "loadout-summary", "monster-tabs", "monster-detail", "export-button", "export-loadout-button", "export-audit-button",
].map((id) => [id, document.getElementById(id)]));
const state = { character: null, catalog: null, results: [], activeMonster: 0, resultSelections: new Map(), engines: [], monsterProgress: new Map(), overallProgress: 0, abortController: null, pauseController: null, isPaused: false, lastRunStatus: "", startedAt: null, runStartedAtMilliseconds: 0, pausedAtMilliseconds: 0, pausedTotalMilliseconds: 0, timingInterval: null, auditRenderTimer: null, pendingAuditRecord: null, progressRenderTimer: null, pendingProgress: null, bridgeRevision: 0, fixedRules: structuredClone(DEFAULT_FIXED_ABILITY_RULES), auditRecorder: null, cpuWorkerCount: 0, resourceUtilization: 80 };

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function percent(value, digits = 1) { return `${(Number(value || 0) * 100).toFixed(digits)}%`; }
function seconds(value) { return Number.isFinite(value) ? `${value.toFixed(2)} 秒` : "—"; }
function highestMonsterLevelText(result) { const level = result?.highestMonsterLevel ?? result?.highestLevel; return level == null ? "—" : `${result?.learning && !result.targetMet ? '未认证 ' : ''}${result?.searchCapped ? "≥" : ""}Lv.${level}`; }
function checkAbort() { if (state.abortController?.signal.aborted) throw new DOMException("模拟已取消", "AbortError"); }
function setRunningStatus(text) {
  state.lastRunStatus = text;
  elements["run-status"].textContent = state.isPaused ? `已暂停 · ${text}` : text;
}

function activeRunMilliseconds(now = Date.now()) {
  if (!state.runStartedAtMilliseconds) return 0;
  const currentPause = state.isPaused && state.pausedAtMilliseconds ? now - state.pausedAtMilliseconds : 0;
  return Math.max(0, now - state.runStartedAtMilliseconds - state.pausedTotalMilliseconds - currentPause);
}

function updateRunTiming() {
  if (!state.runStartedAtMilliseconds) return;
  const elapsed = activeRunMilliseconds();
  elements["elapsed-time"].textContent = formatRunDuration(elapsed);
  elements["progress-percent"].textContent = `${(state.overallProgress * 100).toFixed(1)}%`;
  const estimate=state.workEstimator?.estimate(elapsed-(state.resumeElapsed||0),selectedValues('monster-options').length);
  const remaining = estimate && state.workEstimator.newTrials ? (estimate.low+estimate.high)/2 : null;
  elements["remaining-time"].textContent = state.overallProgress >= 1 ? "已完成"
    : remaining == null || elapsed < 3000 || state.overallProgress < 0.005 ? "计算中"
      : `约 ${formatRunDuration(estimate.low)}–${formatRunDuration(estimate.high)}`;
  if (state.searchMode === 'learning' && state.overallProgress < 1) {
    const f = [...state.monsterProgress.values()].reduce((a, b) => a + b, 0) / Math.max(1, state.monsterProgress.size);
    elements['remaining-time'].textContent = f > 0.01 && !state.resumeElapsed ? `约 ${formatRunDuration(elapsed * (1 - f) / f)}（预算估算）` : '计算中';
  }
  const engine=state.engines[0];
  if(engine){const s=engine.stats(); elements['performance-status'].textContent=`计算中 ${s.busyWorkers}/${s.totalWorkers} · 排队 ${s.pendingTasks} · 已派发 ${s.jobs} · 队列峰值 ${s.maxQueue}`;}
}

function finishPausedInterval(now = Date.now()) {
  if (state.pausedAtMilliseconds) {
    state.pausedTotalMilliseconds += Math.max(0, now - state.pausedAtMilliseconds);
    state.pausedAtMilliseconds = 0;
  }
}

function setOverallProgress(value) {
  state.overallProgress = Math.max(state.overallProgress, Math.min(1, Number(value) || 0));
  const percentage = Math.min(100, state.overallProgress * 100);
  elements["progress-bar"].style.width = `${percentage.toFixed(1)}%`;
  elements["progress-track"].setAttribute("aria-valuenow", percentage.toFixed(1));
  updateRunTiming();
}

function renderAuditStatus(lastRecord = null) {
  const summary = state.auditRecorder?.summary();
  if (!summary?.actualSimulationBatches) {
    elements["audit-status"].hidden = true;
    elements["export-audit-button"].disabled = true;
    return;
  }
  const stage = summary.stageSummary || {};
  const stages = state.searchMode === 'learning' ? `学习 ${stage.learn?.batches || 0} · 独立验证 ${stage.validate?.batches || 0}` : `测试 ${stage.test?.batches || 0} · 复核 ${stage.review?.batches || 0} · 优化 ${stage.optimize?.batches || 0}`;
  const latest = lastRecord ? ` · 最近：${lastRecord.monsterName || lastRecord.monsterHrid} · ${lastRecord.stageLabel} · ${lastRecord.planId || "方案"} · Lv.${lastRecord.roomLevel}（${lastRecord.result?.trials || lastRecord.trialsRequested}场）` : "";
  const failed = summary.failedBatches ? ` · 失败批次 ${summary.failedBatches}` : "";
  elements["audit-status"].textContent = `已完成 ${summary.completedTrials.toLocaleString("zh-CN")} 场战斗 · ${summary.completedBatches.toLocaleString("zh-CN")} 个模拟批次 · ${summary.uniqueLoadouts.toLocaleString("zh-CN")} 套实际方案 · ${stages}${failed}${latest}`;
  elements["audit-status"].hidden = false;
  elements["export-audit-button"].disabled = false;
}

function flushAuditStatus() {
  if (state.auditRenderTimer) clearTimeout(state.auditRenderTimer);
  state.auditRenderTimer = null;
  const record = state.pendingAuditRecord;
  state.pendingAuditRecord = null;
  renderAuditStatus(record);
}

function scheduleAuditStatus(record) {
  state.workEstimator?.record(record);
  state.pendingAuditRecord = record;
  if (state.auditRenderTimer) return;
  state.auditRenderTimer = setTimeout(flushAuditStatus, 200);
}

function flushProgressStatus() {
  if (state.progressRenderTimer) clearTimeout(state.progressRenderTimer);
  state.progressRenderTimer = null;
  const pending = state.pendingProgress;
  state.pendingProgress = null;
  if (!pending) return;
  const aggregate = [...state.monsterProgress.values()].reduce((sum, value) => sum + value, 0);
  if (pending.progress.learning) {
    setOverallProgress(Math.min(0.999, aggregate / pending.total));
    const p = pending.progress;
    setRunningStatus(`${pending.name} · ${p.phase === 'learn' ? '学习搜索批次' : '独立验证项'} ${p.completedPlans}/${p.totalPlans} · 工作候选 ${p.sampledPlans} 套 · 复用 ${p.reusedPairs} 个历史等级样本${p.bestObservedLevel > 0 ? ` · 搜索候选 Lv.${p.bestObservedLevel}（待认证）` : ''}`);
    return;
  }
  const work=state.workEstimator?.estimate(activeRunMilliseconds()-(state.resumeElapsed||0),pending.total);
  setOverallProgress(Math.min(0.999,work?.progress ?? 0));
  const { name, progress } = pending;
  const phase = progress.phase === "test" ? "测试阶段" : progress.phase === "review" ? "复核阶段" : progress.phase === "optimize" ? "优化阶段" : "处理中";
  const direction = progress.direction ? `${progress.direction.strategyZh || `${progress.direction.styleZh || ""}${progress.direction.damageTypeZh ? `·${progress.direction.damageTypeZh}` : ""}`} · ` : "";
  const detail = `${direction}方案 ${progress.currentPlan || progress.completedPlans || 0}/${progress.totalPlans || "—"}${progress.level ? ` · 二分探测 Lv.${progress.level}` : ""}${progress.probeCount ? ` · 本方案第 ${progress.probeCount} 次探测` : ""}`;
  setRunningStatus(`${name} · ${phase} ${progress.phaseComplete ? "100" : ((progress.phaseCompletedBatches||0)/Math.max(1,progress.phaseTotalBatches||1)*100).toFixed(1)}% · ${detail}`);
}

function scheduleProgressStatus(monsterHrid, name, total, progress) {
  state.workEstimator?.observe(monsterHrid,progress);
  state.monsterProgress.set(monsterHrid, progress.learning ? progress.progressFraction : progressWithinMonster(progress));
  state.pendingProgress = { name, total, progress };
  if (state.progressRenderTimer) return;
  state.progressRenderTimer = setTimeout(flushProgressStatus, 100);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadJson(payload, filename) {
  const text = JSON.stringify(payload, (_key, value) => value instanceof Set ? [...value] : value, 2);
  downloadBlob(new Blob([text], { type: "application/json" }), filename);
}

function checkbox(id, label, checked = true, group = "") { return `<label class="choice"><input type="checkbox" data-group="${group}" data-value="${escapeHtml(id)}" ${checked ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`; }
function monsterChoice(hrid) {
  const options = SIMULATION_DIRECTION_OPTIONS.map((entry) => `<option value="${escapeHtml(entry.value)}">${escapeHtml(entry.label)}</option>`).join("");
  return `<div class="monster-direction-card"><label class="choice"><input type="checkbox" data-group="monsters" data-value="${escapeHtml(hrid)}" checked><span>${escapeHtml(MONSTER_NAMES[hrid])}</span></label><select data-monster-direction="${escapeHtml(hrid)}" aria-label="${escapeHtml(MONSTER_NAMES[hrid])}模拟方向">${options}</select></div>`;
}
function renderChoices() {
  elements["monster-options"].innerHTML = LABYRINTH_MONSTER_HRIDS.map(monsterChoice).join("");
  elements["equipment-options"].innerHTML = EQUIPMENT_OPTIONS.map((entry) => checkbox(entry.value, entry.label, DEFAULT_EQUIPMENT_VALUES.has(entry.value), "equipment")).join("");
  elements["skill-options"].innerHTML = checkbox("aura", "特殊技能组合", true, "skills") + checkbox("active", "四个普通主动技能组合", true, "skills");
  const max = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
  elements["parallel-count"].innerHTML = Array.from({ length: max }, (_, index) => `<option value="${index + 1}">${index + 1} 个怪物</option>`).join("");
  elements["parallel-count"].value = String(Math.min(2, max));
}
function selectedMonsterDirections() {
  return Object.fromEntries(LABYRINTH_MONSTER_HRIDS.map((hrid) => [
    hrid,
    document.querySelector(`[data-monster-direction="${hrid}"]`)?.value || "auto",
  ]));
}
function abilityChoices(wantAura) {
  return learnedFixedAbilityChoices(state.catalog, state.character, wantAura);
}
function fixedSelect(category, key, label, index = null) {
  const ready = Boolean(state.catalog && state.character);
  const value = index == null ? state.fixedRules[category][key] : state.fixedRules[category].requiredActives[index];
  const options = ready
    ? [`<option value="">不固定</option>`, ...abilityChoices(key === "aura").map((entry) => `<option value="${escapeHtml(entry.hrid)}" ${value === entry.hrid ? "selected" : ""}>${escapeHtml(chineseName(entry.hrid, entry.name))}</option>`)].join("")
    : `<option value="">等待角色和游戏数据</option>`;
  const indexAttribute = index == null ? "" : ` data-fixed-index="${index}"`;
  const remove = index == null ? "" : `<button type="button" class="fixed-remove" data-remove-fixed="${category}" data-remove-index="${index}" aria-label="删除该必选技能">删除</button>`;
  return `<label class="fixed-rule-field"><span>${label}</span><span class="fixed-rule-control"><select data-fixed-category="${category}" data-fixed-key="${key}"${indexAttribute} ${ready ? "" : "disabled"}>${options}</select>${remove}</span></label>`;
}
function renderFixedSkillRules(skipSanitize = false) {
  if (!skipSanitize && state.catalog && state.character) state.fixedRules = sanitizeFixedAbilityRules(state.fixedRules, state.catalog, state.character);
  const ready = Boolean(state.catalog && state.character);
  if (ready) {
    const auraCount = abilityChoices(true).length;
    const activeCount = abilityChoices(false).length;
    elements["fixed-rules-status"].textContent = `可选：特殊 ${auraCount} · 主动 ${activeCount}`;
    elements["fixed-rules-status"].hidden = false;
  } else {
    elements["fixed-rules-status"].hidden = true;
  }
  elements["fixed-skill-rules"].innerHTML = FIXED_RULE_CATEGORIES.map(({ key, label }) => {
    const activeRows = state.fixedRules[key].requiredActives.map((_hrid, index) => fixedSelect(key, "requiredActives", `必选主动 ${index + 1}`, index)).join("");
    const magicNote = key === "magic" ? `<p class="fixed-rule-note">主动4：元素 0CD</p>` : "";
    const add = state.fixedRules[key].requiredActives.length < 4 ? `<button type="button" class="text-button fixed-add" data-add-fixed="${key}" ${ready ? "" : "disabled"}>增加必选主动</button>` : "";
    return `<div class="fixed-rule-card"><h3>${label}</h3><div class="fixed-rule-grid">${fixedSelect(key, "aura", "必选特殊技能")}${activeRows}</div>${magicNote}${add}</div>`;
  }).join("");
  elements["fixed-skill-rules"].querySelectorAll("select[data-fixed-category]").forEach((select) => select.addEventListener("change", () => {
    const category = state.fixedRules[select.dataset.fixedCategory];
    if (select.dataset.fixedIndex == null) category[select.dataset.fixedKey] = select.value;
    else category.requiredActives[Number(select.dataset.fixedIndex)] = select.value;
  }));
  elements["fixed-skill-rules"].querySelectorAll("[data-add-fixed]").forEach((button) => button.addEventListener("click", () => {
    state.fixedRules[button.dataset.addFixed].requiredActives.push("");
    renderFixedSkillRules(true);
  }));
  elements["fixed-skill-rules"].querySelectorAll("[data-remove-fixed]").forEach((button) => button.addEventListener("click", () => {
    state.fixedRules[button.dataset.removeFixed].requiredActives.splice(Number(button.dataset.removeIndex), 1);
    renderFixedSkillRules(true);
  }));
}
function selectedValues(id) { return [...document.querySelectorAll(`#${id} input:checked`)].map((input) => input.dataset.value); }
function installChoiceToolbar() {
  document.querySelectorAll("[data-select-all]").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(`#${CHOICE_GROUP_IDS[button.dataset.selectAll]} input`).forEach((input) => { input.checked = true; }); }));
  document.querySelectorAll("[data-clear-all]").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(`#${CHOICE_GROUP_IDS[button.dataset.clearAll]} input`).forEach((input) => { input.checked = false; }); }));
}

async function readJsonFile(file, label) { if (!file) throw new Error(`请选择${label}`); return parseJsonText(await file.text(), label); }
function updateReadyState() {
  const ready = Boolean(state.character && state.catalog);
  elements["start-button"].disabled = !ready;
  elements['preview-button'].disabled=!ready;
  elements['resume-button'].disabled=!ready;
  elements["run-status"].textContent = ready ? "数据已就绪，可以开始" : "请先加载两份数据";
  if (!ready) return;
  const summary = summarizeCharacter(state.character);
  const coverage = compareCharacterToCatalog(state.character, state.catalog);
  elements["data-summary"].hidden = false;
  elements["data-summary"].innerHTML = coverage.warnings.length ? `<strong>数据需要注意：</strong>${coverage.warnings.map(escapeHtml).join("；")}` : `<strong>校验通过。</strong> 游戏版本 ${escapeHtml(state.catalog.gameVersion)}；角色拥有 ${summary.itemStacks} 组物品、已学 ${summary.learnedAbilities} 个战斗技能，迷宫历史最高 ${summary.highestFloor} 层。`;
}
function acceptCharacter(raw, source = "手动文件") {
  if(state.busy || state.abortController)return;
  state.character = sanitizeCharacterData(raw); elements["character-card"].classList.add("ready");
  const summary = summarizeCharacter(state.character); elements["character-status"].textContent = `已读取：${summary.itemStacks} 组物品、${summary.learnedAbilities} 个技能（${source}）`; renderFixedSkillRules(); updateReadyState();
}
function acceptCatalog(raw, source = "手动文件") {
  if(state.busy || state.abortController)return;
  const validation = validateClientData(raw); if (!validation.ok) throw new Error(validation.errors.join("；"));
  state.catalog = raw; elements["client-card"].classList.add("ready"); elements["client-status"].textContent = `已读取：${raw.gameVersion || "未知版本"}，${Object.keys(raw.combatMonsterDetailMap).length} 个怪物（${source}）`; renderFixedSkillRules(); updateReadyState();
}
elements["character-file"].addEventListener("change", async (event) => { try { acceptCharacter(await readJsonFile(event.target.files[0], "角色数据")); } catch (error) { state.character = null; elements["character-status"].textContent = error.message; updateReadyState(); } });
elements["client-file"].addEventListener("change", async (event) => { try { acceptCatalog(await readJsonFile(event.target.files[0], "游戏数据")); } catch (error) { state.catalog = null; elements["client-status"].textContent = error.message; updateReadyState(); } });

async function pollBridge() {
  if(state.busy || state.abortController) return;
  try {
    const response = await fetch(`/api/data?since=${state.bridgeRevision}`, { cache: "no-store" });
    if (!response.ok) throw new Error("本机桥接未启动");
    const payload = await response.json();
    if (payload.unchanged) return;
    state.bridgeRevision = Number(payload.revision) || state.bridgeRevision;
    if (payload.character) acceptCharacter(payload.character, "自动桥接");
    if (payload.client) acceptCatalog(payload.client, "自动桥接");
    elements["bridge-status"].textContent = payload.updatedAt ? `已连接本机数据桥接 · ${new Date(payload.updatedAt).toLocaleTimeString()}` : "已连接本机数据桥接，等待游戏数据";
  } catch { elements["bridge-status"].textContent = "未连接本机数据桥接，可继续手动加载文件"; }
}
const localBridgeAvailable = location.hostname === "127.0.0.1" || location.hostname === "localhost";
if (localBridgeAvailable) {
  setInterval(pollBridge, 1500);
  pollBridge();
} else {
  elements["bridge-status"].textContent = "网页版请手动加载两份数据；自动桥接仅连接 Windows 本机版";
}
renderChoices(); installChoiceToolbar(); renderFixedSkillRules();

function renderTabs() {
  const selected = selectedValues("monster-options");
  elements["monster-tabs"].innerHTML = selected.map((hrid) => { const result = state.results[LABYRINTH_MONSTER_HRIDS.indexOf(hrid)]; return `<button type="button" role="tab" data-hrid="${hrid}" class="${state.activeMonster === LABYRINTH_MONSTER_HRIDS.indexOf(hrid) ? "active" : ""} ${result ? "" : "pending"}" aria-selected="${state.activeMonster === LABYRINTH_MONSTER_HRIDS.indexOf(hrid)}"><strong>${escapeHtml(result?.name || MONSTER_NAMES[hrid])}</strong><span>${result ? `${highestMonsterLevelText(result)} · ${percent(result.finalResult.clearRate)}` : "等待模拟"}</span></button>`; }).join("");
  elements["monster-tabs"].querySelectorAll("button").forEach((button) => button.addEventListener("click", () => { state.activeMonster = LABYRINTH_MONSTER_HRIDS.indexOf(button.dataset.hrid); renderTabs(); renderDetail(); }));
  renderLoadoutSummary();
}
function summaryGearMarkup(rows) {
  return rows.gearPairs.flat().map((entry) => `<div class="summary-gear-cell ${entry.item ? "" : "empty"}"><span class="summary-slot">${escapeHtml(entry.slot)}</span><span>${entry.item ? officialIconMarkup(entry.hrid, state.catalog, entry.name) : "—"}</span><span class="summary-item-name">${escapeHtml(entry.name || "空")}</span><span class="summary-item-level">${escapeHtml(entry.level)}</span></div>`).join("");
}
function summaryAbilityMarkup(rows) {
  return rows.abilities.map((entry) => `<div class="summary-ability"><span>${escapeHtml(entry.slot)}</span>${officialIconMarkup(entry.hrid, state.catalog, entry.name)}<strong>${escapeHtml(entry.name)}</strong></div>`).join("");
}
function renderLoadoutSummary() {
  const selected = selectedValues("monster-options");
  const body = selected.map((hrid) => {
    const result = state.results[LABYRINTH_MONSTER_HRIDS.indexOf(hrid)];
    if (!result) return `<tr><td class="summary-monster"><strong>${escapeHtml(MONSTER_NAMES[hrid])}</strong><span>等待模拟</span></td><td class="summary-result">—</td><td colspan="2" class="summary-pending">尚无配装结果</td></tr>`;
    const rows = loadoutRows(result, state.catalog, SLOT_NAMES);
    return `<tr><td class="summary-monster"><button type="button" class="summary-monster-button" data-summary-hrid="${escapeHtml(hrid)}"><strong>${escapeHtml(result.name)}</strong><span>查看详细报告</span></button></td><td class="summary-result"><strong>${highestMonsterLevelText(result)}</strong><span>${percent(result.finalResult?.clearRate)}</span></td><td><div class="summary-gear-grid">${summaryGearMarkup(rows)}</div></td><td><div class="summary-abilities">${summaryAbilityMarkup(rows)}</div></td></tr>`;
  }).join("");
  elements["loadout-summary"].innerHTML = `<table class="loadout-summary-table"><thead><tr><th>怪物</th><th>结果</th><th>装备</th><th>技能</th></tr></thead><tbody>${body}</tbody></table>`;
  elements["loadout-summary"].querySelectorAll("[data-summary-hrid]").forEach((button) => button.addEventListener("click", () => {
    state.activeMonster = LABYRINTH_MONSTER_HRIDS.indexOf(button.dataset.summaryHrid);
    document.getElementById("detail-report").open = true;
    renderTabs();
    renderDetail();
  }));
}
function loadoutTile(entry) {
  if (!entry.item) return `<div class="loadout-tile empty"><div class="loadout-tile-icon">—</div><div class="loadout-tile-copy"><strong>空</strong><small>${escapeHtml(entry.slot)}</small></div></div>`;
  const twoHand = entry.sourceType === "/equipment_types/two_hand" ? " · 双手武器" : "";
  return `<div class="loadout-tile"><div class="loadout-tile-icon">${officialIconMarkup(entry.hrid, state.catalog, entry.name)}</div><div class="loadout-tile-copy"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.slot)}${twoHand} · ${escapeHtml(entry.level)}</small></div></div>`;
}
function renderLoadoutChart(result) {
  const rows = loadoutRows(result, state.catalog, SLOT_NAMES);
  const gear = rows.gearPairs.flat().map(loadoutTile).join("");
  const abilities = rows.abilities.map((entry) => `<div class="loadout-tile"><div class="loadout-tile-icon">${officialIconMarkup(entry.hrid, state.catalog, entry.name)}</div><div class="loadout-tile-copy"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.slot)} · ${escapeHtml(entry.level)}</small></div></div>`).join("");
  return `<section class="loadout-chart"><div class="loadout-chart-heading"><h3>最终配装</h3></div><div class="loadout-chart-section"><h4>装备</h4><div class="loadout-chart-grid">${gear}</div></div><div class="loadout-chart-section"><h4>技能顺序</h4><div class="loadout-chart-grid ability-grid">${abilities}</div></div></section>`;
}
function selectedRankedResult(result) {
  const selection = state.resultSelections.get(result.monsterHrid) || { list: "winRate", rank: 1 };
  const entry = result.rankings?.[selection.list]?.[selection.rank - 1] || result.rankings?.winRate?.[0];
  if (!entry) return { view: result, selection };
  return {
    selection,
    view: {
      ...result,
      bestPlan: entry.plan,
      finalResult: entry.result,
      finalMetrics: entry.metrics,
      highestMonsterLevel: entry.monsterLevel,
      highestLevel: entry.monsterLevel,
      estimatedHighestFloorRange: monsterLevelToFloorRange(entry.monsterLevel),
    },
  };
}
function rankingControls(result, selection) {
  const listButton = (key, label) => `<button type="button" class="ranking-button ${selection.list === key ? "active" : ""}" data-ranking-list="${key}">${label}</button>`;
  const ranks = result.rankings?.[selection.list] || [];
  return `<div class="ranking-controls"><div>${listButton("winRate", "胜率最高")}${listButton("speed", "胜场耗时最短")}</div><div>${ranks.map((entry) => `<button type="button" class="ranking-button ${selection.rank === entry.rank ? "active" : ""}" data-ranking-rank="${entry.rank}">第 ${entry.rank} 名</button>`).join("")}</div></div>`;
}
function renderDetail() {
  const result = state.results[state.activeMonster]; if (!result) { elements["monster-detail"].innerHTML = '<div class="empty-result">该怪物尚未完成模拟。</div>'; return; }
  const { view, selection } = selectedRankedResult(result);
  const simulation = view.finalResult;
  const metrics = view.finalMetrics || {};
  const directionLabel = (entry) => entry?.strategyZh || `${entry.styleZh}${entry.styleHrid === "/combat_styles/magic" ? `·${entry.damageTypeZh}` : "·物理"}`;
  const directions = result.profile.selectedDirections.map(directionLabel).join(" / ");
  const chosen = result.chosenDirection ? directionLabel(result.chosenDirection) : "—";
  const directionMode = result.simulationDirectionMode === "manual" ? `手动·${result.chosenDirection?.presetLabel || chosen}` : "自动最优";
  const presetStart = view.bestPlan?.sourcePreset ? ` · 起点：${view.bestPlan.sourcePreset}` : "";
  const incomingStyles = (result.profile.defenseTargets?.incomingStyles || []).map((entry) => entry.zh).join(" / ") || "未知";
  const incomingDamage = result.profile.defenseTargets?.incomingDamageType?.zh || "未知";
  const defenseFocus = (result.profile.defenseTargets?.labels || []).join(" / ") || "生命";
  const specialCore = result.profile.specialStrategy?.coreZh?.length ? ` · 特化核心：${result.profile.specialStrategy.coreZh.join(" / ")}` : "";
  const counter = Math.max(0, Number(simulation.damageSummary?.counterDamage) || 0);
  elements["monster-detail"].innerHTML = `${rankingControls(result, selection)}<div class="result-hero"><div><h3>${escapeHtml(result.name)}</h3><div class="weaknesses">弱点：${escapeHtml(directions)} · 模拟：${escapeHtml(directionMode)} · 采用：${escapeHtml(chosen)}${escapeHtml(presetStart)}${escapeHtml(specialCore)}<br>来袭：${escapeHtml(incomingStyles)}·${escapeHtml(incomingDamage)} · 防御：${escapeHtml(defenseFocus)}</div></div><div class="result-score"><strong>${highestMonsterLevelText(view)}</strong><span>${floorRangeText(view.estimatedHighestFloorRange || monsterLevelToFloorRange(view.highestLevel))}</span></div></div><div class="metric-grid"><div class="metric"><span>实测胜率</span><strong>${percent(simulation.clearRate)}</strong><small>${simulation.successes} / ${simulation.trials}</small></div><div class="metric"><span>${result.learning ? "认证胜率下界（任务95%）" : "胜率下界（80%）"}</span><strong>${percent(metrics.robustSuccessLower)}</strong></div><div class="metric"><span>死亡 / 超时</span><strong>${percent(metrics.deathRate)} / ${percent(metrics.timeoutRate)}</strong></div><div class="metric"><span>期望通关耗时</span><strong>${seconds(metrics.expectedSecondsPerClear)}</strong></div><div class="metric"><span>成功平均耗时</span><strong>${seconds(simulation.averageClearSeconds)}</strong></div><div class="metric"><span>伤害效率</span><strong>${Number.isFinite(metrics.damagePerSecond) ? Math.round(metrics.damagePerSecond).toLocaleString("zh-CN") : "—"}</strong></div><div class="metric"><span>综合命中</span><strong>${simulation.attackSummary?.total > 0 ? percent(simulation.attackSummary.hitRate) : "—"}</strong></div><div class="metric"><span>反制伤害</span><strong>${Math.round(counter).toLocaleString("zh-CN")}</strong></div></div>${renderLoadoutChart(view)}<ul class="issue-list">${result.issues.map((issue) => `<li class="${escapeHtml(issue.type)}">${escapeHtml(issue.text)}</li>`).join("")}</ul>`;
  elements["monster-detail"].querySelectorAll("[data-ranking-list]").forEach((button) => button.addEventListener("click", () => {
    state.resultSelections.set(result.monsterHrid, { list: button.dataset.rankingList, rank: 1 });
    renderDetail();
  }));
  elements["monster-detail"].querySelectorAll("[data-ranking-rank]").forEach((button) => button.addEventListener("click", () => {
    state.resultSelections.set(result.monsterHrid, { list: selection.list, rank: Number(button.dataset.rankingRank) });
    renderDetail();
  }));
}

async function runMonster(monsterHrid, index, options, engine, total) {
  const name = MONSTER_NAMES[monsterHrid];
  return optimizeMonster({ character: state.character, catalog: state.catalog, engine, monsterHrid, ...options, simulationDirection: options.simulationDirectionsByMonster?.[monsterHrid] || "auto", auditRecorder: state.auditRecorder, seedBase: 20260819 + index * 1000003, signal: state.abortController.signal, onProgress: (progress) => {
    scheduleProgressStatus(monsterHrid, name, total, progress);
  } });
}
async function runAll(resume = false) {
  const searchMode = elements['search-mode'].value;
  state.searchMode = searchMode;
  const monsterHrids = selectedValues("monster-options"); if (!monsterHrids.length) { elements["run-status"].textContent = "至少选择一个怪物"; return; }
  const selectedEquipmentTypes = new Set(selectedValues("equipment-options"));
  const skillValues = selectedValues("skill-options");
  const minMonsterLevel = Math.max(1, Math.floor(Number(elements["min-monster-level"].value) || 200));
  const maxMonsterLevel = Math.max(minMonsterLevel, Math.floor(Number(elements["max-monster-level"].value) || 300));
  elements["min-monster-level"].value = String(minMonsterLevel);
  elements["max-monster-level"].value = String(maxMonsterLevel);
  const testTrials = Math.max(10, Math.min(10000, Math.floor(Number(elements["test-trials"].value) || 100)));
  const reviewTrials = Math.max(10, Math.min(10000, Math.floor(Number(elements["review-trials"].value) || 300)));
  const optimizeTrials = Math.max(searchMode === 'learning' ? reviewTrials : 10, Math.min(searchMode === 'learning' ? 100000 : 10000, Math.floor(Number(elements["optimize-trials"].value) || 5000)));
  elements["test-trials"].value = String(testTrials);
  elements["review-trials"].value = String(reviewTrials);
  elements["optimize-trials"].value = String(optimizeTrials);
  const resourceUtilization = [50, 80, 100].includes(Number(elements["resource-utilization"].value)) ? Number(elements["resource-utilization"].value) : 80;
  const safeCapacity = recommendedWorkerCount(navigator.hardwareConcurrency, resourceUtilization);
  const effectiveParallel = Math.min(Number(elements['parallel-count'].value) || 1, monsterHrids.length,
    searchMode === 'learning' ? Math.max(1, Math.floor(safeCapacity / 2)) : monsterHrids.length);
  const learningTrainers = searchMode === 'learning' ? effectiveParallel : 0;
  const cpuWorkerCount = Math.max(1, safeCapacity - learningTrainers);
  state.resourceUtilization = resourceUtilization;
  state.cpuWorkerCount = cpuWorkerCount;
  const pauseController = createPauseController();
  const options = { minMonsterLevel, maxMonsterLevel, minimumEquipmentLevel: 80, optimizableEquipmentTypes: selectedEquipmentTypes, equipmentPresetSource: elements["equipment-preset-source"].value, simulationDirectionsByMonster: selectedMonsterDirections(), optimizeAura: skillValues.includes("aura"), optimizeActives: skillValues.includes("active"), fixedAbilityRules: structuredClone(state.fixedRules), targetRate: Math.max(0.01, Math.min(0.99, (Number(elements["target-rate"].value) || 70) / 100)), testTrials, reviewTrials, optimizeTrials, pauseController, resourceUtilization };
  const storage=await RunStorage.open();
  options.searchMode = searchMode;
  options.learningBudget = Math.max(10, Math.min(1000000, Math.floor(Number(elements['learning-budget'].value) || 2000)));
  options.certificationMonsterCount = monsterHrids.length;
  if (searchMode === 'learning') {
    options.learningFamily = await fingerprint({ catalog: state.catalog, combatRuntime: await learningRuntimeFingerprint(),
      base: buildSimulationInput(state.character, state.catalog, {equipment:{}}, {abilities:[]}),
      triggers: state.character.abilityCombatTriggersMap || {} });
  }
  const settings=captureSettings();
  const identity=await fingerprint({character:state.character,catalog:state.catalog,settings,workerCount:cpuWorkerCount,runtime:await runtimeFingerprint()});
  const meta=await storage.begin(identity,settings,resume);
  const recorder=await createStoredAudit(storage,{resolveName:hrid=>chineseName(hrid,hrid),onRecord:scheduleAuditStatus});
  state.storage?.db.close(); state.storage=storage; options.runStorage=storage;
  state.workEstimator=new WorkEstimator({testTrials,reviewTrials,optimizeTrials,binaryBudget:maximumBinaryProbeCount(minMonsterLevel,maxMonsterLevel)});
  state.resumeElapsed=resume?meta.elapsed||0:0;
  clearInterval(state.timingInterval); clearTimeout(state.auditRenderTimer); clearTimeout(state.progressRenderTimer); state.auditRenderTimer = null; state.pendingAuditRecord = null; state.progressRenderTimer = null; state.pendingProgress = null; state.results = []; state.resultSelections = new Map(); state.monsterProgress = new Map(monsterHrids.map((hrid) => [hrid, 0])); state.overallProgress = 0; state.startedAt = new Date().toISOString(); state.runStartedAtMilliseconds = Date.now(); state.pausedAtMilliseconds = 0; state.pausedTotalMilliseconds = 0; state.auditRecorder = recorder; state.abortController = new AbortController(); state.pauseController = pauseController; state.isPaused = false; state.lastRunStatus = ""; state.engines = []; elements["start-button"].disabled = true; elements["pause-button"].hidden = false; elements["pause-button"].textContent = "暂停"; elements["cancel-button"].hidden = false; elements["run-time-status"].hidden = false; elements["progress-track"].hidden = false; elements["progress-bar"].style.width = "0%"; elements["progress-track"].setAttribute("aria-valuenow", "0"); elements["results-section"].hidden = false; state.timingInterval = setInterval(updateRunTiming, 1000); updateRunTiming(); renderAuditStatus(); renderTabs(); renderDetail();
  state.startedAt=meta.startedAt;
  state.runStartedAtMilliseconds=Date.now()-state.resumeElapsed;
  elements['checkpoint-status'].textContent=resume?'已载入断点，正在恢复已保存的探测':'本机断点保存已开启';
  const saveTimer=setInterval(()=>storage.updateMeta({elapsed:activeRunMilliseconds()}).catch(e=>{setRunningStatus(e.message);elements['checkpoint-status'].textContent=e.message;state.abortController?.abort();state.engines.forEach(e=>e.terminate());}),5000);
  let completedNormally = false;
  try {
    const concurrency = Math.max(1, effectiveParallel); let cursor = 0;
    for(const hrid of searchMode === 'learning' ? [] : monsterHrids) {
      checkAbort();setRunningStatus(`正在准备 ${MONSTER_NAMES[hrid]} 的任务数量`);
      const preview=await previewMonster({...options,character:state.character,catalog:state.catalog,monsterHrid:hrid,
        simulationDirection:options.simulationDirectionsByMonster[hrid],signal:state.abortController.signal});
      state.workEstimator.observe(hrid,{phase:'test',totalPlans:preview.count,completedPlans:0,
        phaseCompletedBatches:0,phaseTotalBatches:preview.count*maximumBinaryProbeCount(minMonsterLevel,maxMonsterLevel)});
    }
    const engine = new CombatEngine({ workerCount: cpuWorkerCount, minimumTrialsPerWorker: 2, planScheduling:true });
    state.engines.push(engine);
    setRunningStatus(`正在初始化 ${cpuWorkerCount} 个 CPU Worker（${resourceUtilization === 100 ? "安全满载" : `${resourceUtilization}%`}）…`);
    await engine.initialize(state.catalog);
    const worker = async () => { while (cursor < monsterHrids.length) { checkAbort(); const position = cursor++; const hrid = monsterHrids[position]; const result = await storage.get(storage.key(`finished/${hrid}`)) || await runMonster(hrid, position, options, engine, monsterHrids.length);
      await storage.put(storage.key(`finished/${hrid}`),result); state.workEstimator.finish(hrid); state.results[LABYRINTH_MONSTER_HRIDS.indexOf(hrid)] = result; state.monsterProgress.set(hrid, 1); setOverallProgress(Math.min(0.999, searchMode === "learning" ? [...state.monsterProgress.values()].reduce((a,b)=>a+b,0)/monsterHrids.length : state.workEstimator.estimate(activeRunMilliseconds()-(state.resumeElapsed||0),monsterHrids.length)?.progress||0)); state.activeMonster = LABYRINTH_MONSTER_HRIDS.indexOf(hrid); renderTabs(); renderDetail(); } };
    const tasks=Array.from({length:concurrency},()=>worker().catch(e=>{state.abortController.abort();engine.terminate();throw e;}));
    const settlements=await Promise.allSettled(tasks);
    const failure=settlements.find(s=>s.status==='rejected');if(failure)throw failure.reason;
    completedNormally = true; flushAuditStatus(); flushProgressStatus(); setOverallProgress(1); setRunningStatus(`已完成 ${monsterHrids.length} 个怪物的并行模拟`);
  } catch (error) { const stopped = error.name === "AbortError" || error.message === "模拟已取消"; setRunningStatus(stopped ? "模拟已停止，已完成的结果仍可查看" : `模拟失败：${error.message}`); }
  finally { clearInterval(saveTimer); await storage.updateMeta({elapsed:activeRunMilliseconds(),complete:completedNormally}).catch(e=>{elements["checkpoint-status"].textContent=e.message;}); finishPausedInterval(); state.isPaused = false; clearInterval(state.timingInterval); state.timingInterval = null; clearTimeout(state.progressRenderTimer); state.progressRenderTimer = null; state.pendingProgress = null; flushAuditStatus(); updateRunTiming(); if (!completedNormally) elements["remaining-time"].textContent = "—"; state.pauseController?.resume(); state.engines.forEach((engine) => engine.terminate()); state.engines = []; state.abortController = null; state.pauseController = null; elements["start-button"].disabled = false; elements["pause-button"].hidden = true; elements["pause-button"].textContent = "暂停"; elements["cancel-button"].hidden = true; }
}
const SETTING_IDS=['search-mode','learning-budget','min-monster-level','max-monster-level','target-rate','test-trials','review-trials','optimize-trials','equipment-preset-source','resource-utilization','parallel-count'];
function captureSettings() {
  return {fields:Object.fromEntries(SETTING_IDS.map(id=>[id,elements[id].value])),
    monsters:selectedValues('monster-options'),equipment:selectedValues('equipment-options'),skills:selectedValues('skill-options'),
    directions:selectedMonsterDirections(),fixedRules:structuredClone(state.fixedRules)};
}
function restoreSettings(s) {
  for(const [id,value] of Object.entries(s.fields))elements[id].value=value;
  updateSearchLabels();
  for(const [group,values] of [['monster-options',s.monsters],['equipment-options',s.equipment],['skill-options',s.skills]])
    document.querySelectorAll(`#${group} input`).forEach(input=>input.checked=values.includes(input.dataset.value));
  document.querySelectorAll('[data-monster-direction]').forEach(select=>select.value=s.directions[select.dataset.monsterDirection]||'auto');
  state.fixedRules=structuredClone(s.fixedRules);renderFixedSkillRules(true);
}
async function guarded(action) {
  if(state.busy || state.abortController)return;
  state.busy=true;
  for(const id of ['data-panel','scope-panel','settings-panel'])document.getElementById(id).inert=true;
  const controls=[...document.querySelectorAll('#data-panel input,#scope-panel input,#scope-panel select,#scope-panel button,#settings-panel input,#settings-panel select,#preview-button,#resume-button,#start-button')];
  const disabled=controls.map(el=>el.disabled);controls.forEach(el=>el.disabled=true);
  try {
    if(!navigator.locks)throw new Error('浏览器版本不支持安全任务锁，请更新浏览器后运行');
    await navigator.locks.request('mwi-v039-task',{ifAvailable:true},async lock=>{
      if(!lock)throw new Error('另一个页面正在处理此模拟器任务，请先暂停并停止该页面任务');
      await action();
    });
  } catch(e){elements['run-status'].textContent=e.message;}
  finally {state.busy=false;for(const id of ['data-panel','scope-panel','settings-panel'])document.getElementById(id).inert=false;controls.forEach((el,i)=>el.disabled=disabled[i]);}
}
function updateSearchLabels() {
  const learning = elements['search-mode'].value === 'learning';
  document.getElementById('test-trials-label').textContent = learning ? '搜索每批场数' : '测试次数';
  document.getElementById('review-trials-label').textContent = learning ? '验证每批场数' : '复核次数';
  document.getElementById('optimize-trials-label').textContent = learning ? '每方案等级验证上限' : '优化次数';
  document.getElementById('learning-budget-label').hidden = !learning;
  elements['start-button'].textContent = learning ? '开始学习搜索' : '开始全量模拟';
}
elements['search-mode'].addEventListener('change', () => {
  elements['optimize-trials'].value = elements['search-mode'].value === 'learning' ? '5000' : '500';
  updateSearchLabels();
});
elements['export-learning'].addEventListener('click', () => guarded(async () => {
  const store = await RunStorage.open();
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: 'mwi-learning-v039.jsonl', types: [{ description: '学习档案', accept: { 'application/json': ['.jsonl'] } }] });
      const writable = await handle.createWritable();
      try { await exportLearning(store, writable); await writable.close(); } catch (e) { await writable.abort(); throw e; }
    } else {
      const chunks = []; let buffer = '';
      await exportLearning(store, { async write(p) { buffer += p; if (buffer.length > 262144) { chunks.push(new Blob([buffer])); buffer = ''; } } });
      chunks.push(new Blob([buffer])); downloadBlob(new Blob(chunks, {type:'application/json'}), 'mwi-learning-v039.jsonl');
    }
    elements['learning-status'].textContent = '学习档案已导出';
  } finally { store.db.close(); }
}));
elements['import-learning'].addEventListener('change', () => {
  const file = elements['import-learning'].files[0]; if (!file) return;
  guarded(async () => {
    const store = await RunStorage.open();
    try {
      elements['learning-status'].textContent = '正在校验并导入';
      const result = await importLearning(store, file);
      elements['learning-status'].textContent = `导入 ${result.imported} 批 · 跳过重复 ${result.duplicates} 批`;
    } finally { store.db.close(); elements['import-learning'].value = ''; }
  });
});
elements['start-button'].addEventListener('click',()=>guarded(()=>runAll(false)));
elements['resume-button'].addEventListener('click',()=>guarded(async()=>{
  const store=await RunStorage.open();const saved=await store.get('latest');store.db.close();
  if(!saved)throw new Error('没有可恢复的任务');
  restoreSettings(saved.settings);await runAll(true);
}));
elements['preview-button'].addEventListener('click',()=>guarded(async()=>{
  const monsters=selectedValues('monster-options');
  if(!monsters.length)throw new Error('至少选择一个怪物');
  elements['candidate-panel'].hidden=false;elements['candidate-panel'].open=true;elements['candidate-preview'].innerHTML='';
  const entryName=e=>`${chineseName(e.hrid,e.name||e.hrid)}${e.enhancementLevel!=null?` +${e.enhancementLevel}`:` Lv.${e.level||1}`}`;
  for(const hrid of monsters){
    elements['run-status'].textContent=`正在整理 ${MONSTER_NAMES[hrid]} 的候选`;
    const p=await previewMonster({character:state.character,catalog:state.catalog,monsterHrid:hrid,
      simulationDirection:selectedMonsterDirections()[hrid],equipmentPresetSource:elements['equipment-preset-source'].value,
      optimizableEquipmentTypes:new Set(selectedValues('equipment-options')),fixedAbilityRules:state.fixedRules,
      optimizeAura:selectedValues('skill-options').includes('aura'),optimizeActives:selectedValues('skill-options').includes('active')});
    const rows=Object.entries(p.usedEquipment).map(([slot,items])=>`<tr><td>${escapeHtml(SLOT_NAMES[slot]||slot)}</td><td>${items.map(e=>escapeHtml(entryName(e))+'（'+(!(selectedValues('equipment-options').includes(slot)||(slot==='/equipment_types/two_hand'&&selectedValues('equipment-options').includes('/equipment_types/main_hand')))?'预设固定':e.isTargetedDefense?'定向防御最高':'方向候选')+'）').join('、')}</td></tr>`).join('');
    const fixed=p.baselines.map(b=>`<details><summary>${escapeHtml(b.sourcePreset||'预设')} · 起点与固定栏位</summary><ul>${Object.entries(b.equipment).map(([slot,e])=>`<li>${escapeHtml(SLOT_NAMES[slot]||slot)}：${escapeHtml(entryName(e))} · ${selectedValues('equipment-options').includes(slot)?'参与组合':'固定/预设'} </li>`).join('')}</ul></details>`).join('');
    const budget=maximumBinaryProbeCount(Number(elements['min-monster-level'].value),Number(elements['max-monster-level'].value));
    elements['candidate-preview'].insertAdjacentHTML('beforeend',`<details open><summary>${escapeHtml(MONSTER_NAMES[hrid])} · ${p.count.toLocaleString()} 套</summary><div class="preview-scroll"><table><tbody>${rows}</tbody></table></div><p>特殊：${p.usedAuras.map(e=>escapeHtml(entryName(e))).join('、')}</p><p>主动：${p.usedActives.map(e=>escapeHtml(entryName(e))).join('、')}</p><p>防御依据：${escapeHtml(p.profile.defenseTargets?.labels?.join('、'))}</p>${elements['search-mode'].value === 'learning' ? `<p>学习搜索预算 ${Number(elements['learning-budget'].value).toLocaleString()} 批 × ${Number(elements['test-trials'].value)} 场 · 独立验证最多12项 × ${Math.max(Number(elements['review-trials'].value),Number(elements['optimize-trials'].value))} 场；上方数量为基础组合，不含顺序变化。</p>` : `<p>测试最多 ${(p.count*budget*Number(elements['test-trials'].value)).toLocaleString()} 场 · 复核最多 ${(p.count*budget*Number(elements['review-trials'].value)).toLocaleString()} 场 · 优化最多 ${(120*Number(elements['optimize-trials'].value)).toLocaleString()} 场</p>`}${fixed}</details>`);
  }
  elements['run-status'].textContent='候选预览完成';
}));
RunStorage.open().then(async store=>{const m=await store.get('latest');store.db.close();if(m)elements['checkpoint-status'].textContent=`上次任务：${new Date(m.startedAt).toLocaleString()} · ${m.complete?'已完成':'可恢复'}`;}).catch(()=>{});
elements["pause-button"].addEventListener("click", () => {
  if (!state.pauseController) return;
  if (state.pauseController.paused) {
    finishPausedInterval();
    state.isPaused = false;
    state.pauseController.resume();
    elements["pause-button"].textContent = "暂停";
    elements["run-status"].textContent = state.lastRunStatus || "继续模拟";
  } else {
    state.pauseController.pause();
    state.isPaused = true;
    state.pausedAtMilliseconds = Date.now();
    elements["pause-button"].textContent = "继续";
    elements["run-status"].textContent = `已暂停 · ${state.lastRunStatus || "等待当前批次结束"}`;
  }
});
elements["cancel-button"].addEventListener("click", () => { state.abortController?.abort(); state.engines.forEach((engine) => engine.terminate()); });
elements["export-button"].addEventListener("click", () => {
  const skillValues = selectedValues("skill-options");
  const payload = { searchMode: state.searchMode, learningBudget: Number(elements["learning-budget"].value), reportType: "mwi_labyrinth_exhaustive_search_v039", gameVersion: state.catalog?.gameVersion, startedAt: state.startedAt, exportedAt: new Date().toISOString(), selectedMonsters: selectedValues("monster-options"), selectedEquipmentTypes: selectedValues("equipment-options"), equipmentPresetSource: elements["equipment-preset-source"].value, simulationDirectionsByMonster: selectedMonsterDirections(), optimizeAura: skillValues.includes("aura"), optimizeActives: skillValues.includes("active"), fixedAbilityRules: state.fixedRules, levelBounds: { minimum: Number(elements["min-monster-level"].value), maximum: Number(elements["max-monster-level"].value) }, phaseTrials: { test: Number(elements["test-trials"].value), review: Number(elements["review-trials"].value), optimize: Number(elements["optimize-trials"].value) }, parallelCount: Number(elements["parallel-count"].value), resourceUtilization: state.resourceUtilization, cpuWorkerCount: state.cpuWorkerCount, simulationAuditSummary: state.auditRecorder?.summary() || null, searchPolicy: { weaknessOrder: "保留完整弱点分析；自动最优只模拟第一弱点", simulationDirectionPolicy: "每只怪独立选择自动最优或九套系统预设方向；手动方向强制使用对应系统预设", minimumCombatEquipmentRequirement: 80, equipmentVariantPreference: "系统预设同一装备族按实际强化后属性择优；其余候选同族先取强化最高，强化相同优先精炼", equipmentPresetSource: elements["equipment-preset-source"].value, targetedDefenseComparison: "同槽分别只取对应闪避、护甲/元素抗性、生命的最高装备；跨属性去重，保留并列最高", weaponStates: "九套预设武器默认固定；勾选主手可解除；只勾选副手时单手预设搜索副手，双手预设保持固定", levelOneActiveFilter: "除对应元素魔法0CD外，能力书战斗需求等级1的主动技能排除", skillSetBeforeOrder: state.searchMode !== "learning", uniqueWithinStage: true, parallelPlanPipelines: true, testReviewBinarySearch: state.searchMode !== "learning", reviewTolerance: 0.01, safeDynamicRetention: state.searchMode !== "learning", finalists: 5, leaderboards: ["winRate", "averageSuccessfulBattleSeconds"] }, results: state.results };
  if (state.searchMode === 'learning') {
    payload.reportType = 'mwi_labyrinth_learning_search_v039';
    delete payload.searchPolicy.reviewTolerance;
    delete payload.searchPolicy.finalists;
    payload.searchPolicy.globalOptimalityProven = false;
    payload.searchPolicy.certificationConfidence = 0.95;
    payload.searchPolicy.independentValidation = true;
    payload.searchPolicy.uniqueWithinStage = '同一配装等级可追加独立随机样本；同一已保存批次不重复计数';
    payload.phaseTrials = { searchBatch: Number(elements['test-trials'].value), validationBatch: Number(elements['review-trials'].value), validationMaximum: Number(elements['optimize-trials'].value) };
  }
  downloadJson(payload, `mwi迷宫模拟报告-v039-${new Date().toISOString().slice(0, 10)}.json`);
});
elements['export-audit-button'].addEventListener('click',async()=>{
  if(!state.auditRecorder?.recordCount)return;
  elements['export-audit-button'].disabled=true;
  try{
    const extra={gameVersion:state.catalog.gameVersion,startedAt:state.startedAt};
    if(window.showSaveFilePicker && state.auditRecorder.exportTo){
      const handle=await window.showSaveFilePicker({suggestedName:'mwi模拟审计日志-v039.json',types:[{description:'JSON',accept:{'application/json':['.json']}}]});
      const writable=await handle.createWritable();
      try{await state.auditRecorder.exportTo(writable,extra);await writable.close();}catch(e){await writable.abort();throw e;}
    }else downloadBlob(await state.auditRecorder.exportBlob(extra),'mwi模拟审计日志-v039.json');
  }catch(e){if(e.name!=='AbortError')elements['run-status'].textContent='导出失败：'+e.message;}
  finally{elements['export-audit-button'].disabled=false;}
});
  elements["export-loadout-button"].addEventListener("click", async () => { try { const ok = await downloadLoadouts(state.results, state.catalog, SLOT_NAMES, MONSTER_NAMES); elements["run-status"].textContent = ok ? "已导出全部怪物配装总表" : "尚无已完成的方案可导出"; } catch (error) { elements["run-status"].textContent = `配装总表导出失败：${error.message}`; } });
document.getElementById('clear-saved-button').addEventListener('click',()=>guarded(async()=>{
  if(!window.confirm('清除本浏览器中本模拟器保存的全部任务、断点、学习模型、战斗学习档案和审计记录？请先导出需要保留的档案。此操作无法恢复。'))return;
  const store=await RunStorage.open();await store.clearAll();store.db.close();
  state.auditRecorder=null;elements['export-audit-button'].disabled=true;
  elements['checkpoint-status'].textContent='本机任务记录已清除';elements['learning-status'].textContent='本机学习档案已清除';elements['audit-status'].hidden=true;
}));
