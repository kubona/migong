import {
  COMBAT_EQUIPMENT_TYPES,
  LABYRINTH_MONSTER_HRIDS,
  compareCharacterToCatalog,
  floorRangeText,
  monsterLevelToFloorRange,
  parseJsonText,
  resolveReferenceMonsterLevel,
  sanitizeCharacterData,
  summarizeCharacter,
  validateClientData,
} from "./data-model.js";
import { CombatEngine, recommendedWorkerCount } from "./engine-adapter.js";
import { learnedFixedAbilityChoices, sanitizeFixedAbilityRules } from "./fixed-skill-options.js";
import { chineseName, loadChineseTranslations } from "./localization.js";
import { optimizeMonster } from "./optimizer.js";
import { downloadLoadouts, officialIconMarkup, loadoutRows } from "./loadout-image.js";
import { createSimulationAuditRecorder } from "./simulation-audit.js";

await loadChineseTranslations();

const SLOT_NAMES = {
  "/equipment_types/head": "头", "/equipment_types/body": "身", "/equipment_types/legs": "腿", "/equipment_types/feet": "脚",
  "/equipment_types/hands": "手", "/equipment_types/main_hand": "主", "/equipment_types/two_hand": "主", "/equipment_types/off_hand": "副",
  "/equipment_types/pouch": "袋子", "/equipment_types/back": "背", "/equipment_types/neck": "项链", "/equipment_types/earrings": "耳环", "/equipment_types/ring": "戒指", "/equipment_types/charm": "护符",
};
const MONSTER_NAMES = Object.fromEntries(LABYRINTH_MONSTER_HRIDS.map((hrid) => [hrid, chineseName(hrid, hrid.split("/").pop())]));
const HAND_TYPES = new Set(["/equipment_types/main_hand", "/equipment_types/two_hand", "/equipment_types/off_hand"]);
const EQUIPMENT_OPTIONS = [{ value: "weapon_group", label: "武器组合" }, ...[...COMBAT_EQUIPMENT_TYPES].filter((type) => !HAND_TYPES.has(type)).map((type) => ({ value: type, label: SLOT_NAMES[type] || type }))];
const DEFAULT_EQUIPMENT_VALUES = new Set(["/equipment_types/head", "/equipment_types/body", "/equipment_types/legs", "/equipment_types/hands", "/equipment_types/feet"]);
const CHOICE_GROUP_IDS = { monsters: "monster-options", equipment: "equipment-options", skills: "skill-options" };
const FIXED_RULE_CATEGORIES = [
  { key: "magic", label: "魔法类" },
  { key: "physical", label: "物理类" },
  { key: "mimic", label: "宝箱怪特化" },
];
const DEFAULT_FIXED_RULES = {
  magic: { aura: "", active1: "/abilities/elemental_affinity", active2: "", active3: "", active4: "__auto_zero__" },
  physical: { aura: "", active1: "/abilities/frenzy", active2: "/abilities/berserk", active3: "", active4: "" },
  mimic: { aura: "", active1: "", active2: "", active3: "/abilities/retribution", active4: "/abilities/spike_shell" },
};
const CPU_WORKER_COUNT = recommendedWorkerCount();
const elements = Object.fromEntries([
  "bridge-status", "character-file", "client-file", "character-card", "client-card", "character-status", "client-status", "data-summary",
  "monster-options", "equipment-options", "skill-options", "fixed-rules-status", "fixed-skill-rules", "reference-monster-level", "max-monster-level", "trials-per-plan",
  "target-rate", "parallel-count", "parallel-hint", "start-button", "cancel-button", "run-status", "audit-status", "progress-track", "progress-bar", "results-section", "loadout-summary", "monster-tabs", "monster-detail", "export-button", "export-loadout-button", "export-audit-button",
].map((id) => [id, document.getElementById(id)]));
const state = { character: null, catalog: null, results: [], activeMonster: 0, engines: [], monsterProgress: new Map(), abortController: null, startedAt: null, bridgeRevision: 0, fixedRules: structuredClone(DEFAULT_FIXED_RULES), auditRecorder: null };

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function percent(value, digits = 1) { return `${(Number(value || 0) * 100).toFixed(digits)}%`; }
function seconds(value) { return Number.isFinite(value) ? `${value.toFixed(2)} 秒` : "—"; }
function highestMonsterLevelText(result) { const level = result?.highestMonsterLevel ?? result?.highestLevel; return level == null ? "—" : `${result?.searchCapped ? "≥" : ""}Lv.${level}`; }
function checkAbort() { if (state.abortController?.signal.aborted) throw new DOMException("模拟已取消", "AbortError"); }

function renderAuditStatus(lastRecord = null) {
  const summary = state.auditRecorder?.summary();
  if (!summary?.actualSimulationBatches) {
    elements["audit-status"].textContent = "开始后记录每个组合及结果";
    elements["export-audit-button"].disabled = true;
    return;
  }
  const current = lastRecord ? ` · 最近：${lastRecord.reason}` : "";
  elements["audit-status"].textContent = `审计日志 ${summary.actualSimulationBatches} 批 · 唯一组合 ${summary.uniqueCombinations} 套 · 合理复核 ${summary.expectedRetestBatches} 批 · 可疑重复 ${summary.suspiciousRepeatBatches} 批${current}`;
  elements["export-audit-button"].disabled = false;
}

function downloadJson(payload, filename) {
  const text = JSON.stringify(payload, (_key, value) => value instanceof Set ? [...value] : value, 2);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function checkbox(id, label, checked = true, group = "") { return `<label class="choice"><input type="checkbox" data-group="${group}" data-value="${escapeHtml(id)}" ${checked ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`; }
function renderChoices() {
  elements["monster-options"].innerHTML = LABYRINTH_MONSTER_HRIDS.map((hrid) => checkbox(hrid, MONSTER_NAMES[hrid], true, "monsters")).join("");
  elements["equipment-options"].innerHTML = EQUIPMENT_OPTIONS.map((entry) => checkbox(entry.value, entry.label, DEFAULT_EQUIPMENT_VALUES.has(entry.value), "equipment")).join("");
  elements["skill-options"].innerHTML = checkbox("aura", "特殊技能槽（含光环）", true, "skills") + [1, 2, 3, 4].map((slot) => checkbox(String(slot), `主动技能${slot}`, true, "skills")).join("");
  const max = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
  elements["parallel-count"].innerHTML = Array.from({ length: max }, (_, index) => `<option value="${index + 1}">${index + 1} 个怪物</option>`).join("");
  elements["parallel-count"].value = String(Math.min(2, max));
  elements["parallel-hint"].textContent = `共享 ${CPU_WORKER_COUNT} 个 CPU Worker（预留系统资源）；最多并行 ${max} 个怪物`;
}
function abilityChoices(wantAura) {
  return learnedFixedAbilityChoices(state.catalog, state.character, wantAura);
}
function fixedSelect(category, key, label) {
  const ready = Boolean(state.catalog && state.character);
  const value = state.fixedRules[category][key];
  const options = ready
    ? [`<option value="">不固定</option>`, ...(key === "active4" && category === "magic" ? [`<option value="__auto_zero__" ${value === "__auto_zero__" ? "selected" : ""}>对应元素的 0CD 主动</option>`] : []), ...abilityChoices(key === "aura").map((entry) => `<option value="${escapeHtml(entry.hrid)}" ${value === entry.hrid ? "selected" : ""}>${escapeHtml(chineseName(entry.hrid, entry.name))}</option>`)].join("")
    : `<option value="">等待角色和游戏数据</option>`;
  return `<label class="fixed-rule-field"><span>${label}</span><select data-fixed-category="${category}" data-fixed-key="${key}" ${ready ? "" : "disabled"}>${options}</select></label>`;
}
function renderFixedSkillRules() {
  if (state.catalog && state.character) state.fixedRules = sanitizeFixedAbilityRules(state.fixedRules, state.catalog, state.character);
  const ready = Boolean(state.catalog && state.character);
  if (ready) {
    const auraCount = abilityChoices(true).length;
    const activeCount = abilityChoices(false).length;
    elements["fixed-rules-status"].textContent = `已学：特殊技能 ${auraCount} 个，普通主动 ${activeCount} 个。默认：魔法元素增幅/元素0CD；物理狂速/狂暴；宝箱怪惩戒/尖刺防护。每套方案只能使用一个特殊技能。`;
  } else {
    elements["fixed-rules-status"].textContent = "加载两份数据后显示已学技能。";
  }
  elements["fixed-skill-rules"].innerHTML = FIXED_RULE_CATEGORIES.map(({ key, label }) => `<div class="fixed-rule-card"><h3>${label}</h3><div class="fixed-rule-grid">${fixedSelect(key, "aura", "特殊技能")}${[1, 2, 3, 4].map((slot) => fixedSelect(key, `active${slot}`, `主动${slot}`)).join("")}</div></div>`).join("");
  elements["fixed-skill-rules"].querySelectorAll("select[data-fixed-category]").forEach((select) => select.addEventListener("change", () => { state.fixedRules[select.dataset.fixedCategory][select.dataset.fixedKey] = select.value; }));
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
  elements["run-status"].textContent = ready ? "数据已就绪，可以开始" : "请先加载两份数据";
  if (!ready) return;
  const summary = summarizeCharacter(state.character);
  const coverage = compareCharacterToCatalog(state.character, state.catalog);
  const reference = resolveReferenceMonsterLevel(state.character);
  elements["reference-monster-level"].value = reference;
  elements["max-monster-level"].value = Math.min(5000, Math.max(reference + 40, 100));
  elements["data-summary"].hidden = false;
  elements["data-summary"].innerHTML = coverage.warnings.length ? `<strong>数据需要注意：</strong>${coverage.warnings.map(escapeHtml).join("；")}` : `<strong>校验通过。</strong> 游戏版本 ${escapeHtml(state.catalog.gameVersion)}；角色拥有 ${summary.itemStacks} 组物品、已学 ${summary.learnedAbilities} 个战斗技能，迷宫历史最高 ${summary.highestFloor} 层。`;
}
function acceptCharacter(raw, source = "手动文件") {
  state.character = sanitizeCharacterData(raw); elements["character-card"].classList.add("ready");
  const summary = summarizeCharacter(state.character); elements["character-status"].textContent = `已读取：${summary.itemStacks} 组物品、${summary.learnedAbilities} 个技能（${source}）`; renderFixedSkillRules(); updateReadyState();
}
function acceptCatalog(raw, source = "手动文件") {
  const validation = validateClientData(raw); if (!validation.ok) throw new Error(validation.errors.join("；"));
  state.catalog = raw; elements["client-card"].classList.add("ready"); elements["client-status"].textContent = `已读取：${raw.gameVersion || "未知版本"}，${Object.keys(raw.combatMonsterDetailMap).length} 个怪物（${source}）`; renderFixedSkillRules(); updateReadyState();
}
elements["character-file"].addEventListener("change", async (event) => { try { acceptCharacter(await readJsonFile(event.target.files[0], "角色数据")); } catch (error) { state.character = null; elements["character-status"].textContent = error.message; updateReadyState(); } });
elements["client-file"].addEventListener("change", async (event) => { try { acceptCatalog(await readJsonFile(event.target.files[0], "游戏数据")); } catch (error) { state.catalog = null; elements["client-status"].textContent = error.message; updateReadyState(); } });

async function pollBridge() {
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

function progressWithinMonster(progress) { if (progress.phase === "recommendation") return 0.96; if (progress.phase === "level") return 0.88; const part = progress.evaluations ? Math.min(1, progress.evaluations / 250) : 0; return progress.phase === "counter" ? 0.55 + part * 0.3 : part * 0.82; }
function renderTabs() {
  const selected = selectedValues("monster-options");
  elements["monster-tabs"].innerHTML = selected.map((hrid) => { const result = state.results[LABYRINTH_MONSTER_HRIDS.indexOf(hrid)]; return `<button type="button" role="tab" data-hrid="${hrid}" class="${state.activeMonster === LABYRINTH_MONSTER_HRIDS.indexOf(hrid) ? "active" : ""} ${result ? "" : "pending"}" aria-selected="${state.activeMonster === LABYRINTH_MONSTER_HRIDS.indexOf(hrid)}"><strong>${escapeHtml(result?.name || MONSTER_NAMES[hrid])}</strong><span>${result ? `${result.searchCapped ? "至少" : "最高"} Lv.${result.highestMonsterLevel ?? result.highestLevel} · ${percent(result.finalResult.clearRate)}` : "等待模拟"}</span></button>`; }).join("");
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
  return `<section class="loadout-chart"><div class="loadout-chart-heading"><h3>最终配装</h3><span>主副严格对称</span></div><div class="loadout-chart-section"><h4>装备</h4><div class="loadout-chart-grid">${gear}</div></div><div class="loadout-chart-section"><h4>技能顺序</h4><div class="loadout-chart-grid ability-grid">${abilities}</div></div></section>`;
}
function renderDetail() {
  const result = state.results[state.activeMonster]; if (!result) { elements["monster-detail"].innerHTML = '<div class="empty-result">该怪物尚未完成模拟。</div>'; return; }
  const simulation = result.finalResult;
  const metrics = result.finalMetrics || {};
  const recommendations = Array.isArray(result.recommendations) ? result.recommendations : [];
  const directionLabel = (entry) => entry?.strategyZh || `${entry.styleZh}${entry.styleHrid === "/combat_styles/magic" ? `·${entry.damageTypeZh}` : "·物理"}`;
  const directions = result.profile.selectedDirections.map(directionLabel).join(" / ");
  const chosen = result.chosenDirection ? directionLabel(result.chosenDirection) : "—";
  const incomingStyles = (result.profile.defenseTargets?.incomingStyles || []).map((entry) => entry.zh).join(" / ") || "未知";
  const incomingDamage = result.profile.defenseTargets?.incomingDamageType?.zh || "未知";
  const defenseFocus = (result.profile.defenseTargets?.labels || []).join(" / ") || "生命";
  const specialCore = result.profile.specialStrategy?.coreZh?.length ? ` · 特化核心：${result.profile.specialStrategy.coreZh.join(" / ")}` : "";
  const counter = Math.max(0, Number(simulation.damageSummary?.counterDamage) || 0);
  const counts = result.candidateCounts || {};
  const retainedByDirection = (result.searchDiagnostics?.directionResults || []).map((entry) => `${directionLabel(entry.direction)} ${entry.retainedPlans || 0} 套`).join(" / ") || "—";
  const boundaryNote = result.searchDiagnostics?.finalistResults?.some((entry) => entry.boundaryReview?.nonMonotonic) ? "；检测到等级边界附近的抽样非单调，已做相邻等级复核" : "";
  const recommendationMarkup = recommendations.length
    ? `<section class="recommendations"><h3>提升建议</h3><ol>${recommendations.map((entry) => `<li><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.text)}；胜率 ${entry.clearRateDelta >= 0 ? "+" : ""}${(entry.clearRateDelta * 100).toFixed(1)} 个百分点${Number.isFinite(entry.secondsDelta) ? `；耗时 ${entry.secondsDelta >= 0 ? "+" : ""}${entry.secondsDelta.toFixed(2)} 秒` : ""}</span></li>`).join("")}</ol></section>`
    : `<section class="recommendations"><h3>下一步提升建议</h3><p class="settings-note">当前没有可复测的装备、技能或战斗等级提升候选。</p></section>`;
  elements["monster-detail"].innerHTML = `<div class="result-hero"><div><p class="eyebrow">迷宫怪物</p><h3>${escapeHtml(result.name)}</h3><div class="weaknesses">弱点：${escapeHtml(directions)} · 采用：${escapeHtml(chosen)}${escapeHtml(specialCore)}<br>来袭：${escapeHtml(incomingStyles)}·${escapeHtml(incomingDamage)} · 防御：${escapeHtml(defenseFocus)}</div></div><div class="result-score"><strong>${highestMonsterLevelText(result)}</strong><span>${floorRangeText(result.estimatedHighestFloorRange || monsterLevelToFloorRange(result.highestLevel))}</span></div></div><div class="metric-grid"><div class="metric"><span>复核胜率</span><strong>${percent(simulation.clearRate)}</strong><small>${simulation.successes} / ${simulation.trials}</small></div><div class="metric"><span>稳健下界</span><strong>${percent(metrics.robustSuccessLower)}</strong><small>90% Wilson</small></div><div class="metric"><span>死亡 / 超时</span><strong>${percent(metrics.deathRate)} / ${percent(metrics.timeoutRate)}</strong></div><div class="metric"><span>期望通关耗时</span><strong>${seconds(metrics.expectedSecondsPerClear)}</strong></div><div class="metric"><span>成功平均耗时</span><strong>${seconds(simulation.averageClearSeconds)}</strong></div><div class="metric"><span>伤害效率</span><strong>${Number.isFinite(metrics.damagePerSecond) ? Math.round(metrics.damagePerSecond).toLocaleString("zh-CN") : "—"}</strong></div><div class="metric"><span>综合命中</span><strong>${simulation.attackSummary?.total > 0 ? percent(simulation.attackSummary.hitRate) : "—"}</strong></div><div class="metric"><span>反制伤害</span><strong>${Math.round(counter).toLocaleString("zh-CN")}</strong></div></div>${renderLoadoutChart(result)}<ul class="issue-list">${result.issues.map((issue) => `<li class="${escapeHtml(issue.type)}">${escapeHtml(issue.text)}</li>`).join("")}</ul><details class="inline-help result-method"><summary>搜索统计与判定口径</summary><p>${escapeHtml(result.floorScaling.rule)}。方向保留：${escapeHtml(retainedByDirection)}。进攻 ${counts.offensePlans || 0} 批，反制 ${counts.counterPlans || 0} 批，等级探测 ${counts.highestLevelProbes || 0} 次，提升建议 ${counts.recommendationSimulations || 0} 次，总计 ${counts.simulatedPlans || 0} 批；双项联动 ${counts.interactionPlans || 0} 批，生存扩展 ${counts.survivalPlans || 0} 批，自适应追加 ${counts.adaptiveBatches || 0} 批${boundaryNote}。</p></details>`;
  elements["monster-detail"].innerHTML = elements["monster-detail"].innerHTML.replaceAll("100场", `${result.trialsPerPlan || simulation.trials}场`);
  elements["monster-detail"].querySelector(".issue-list")?.insertAdjacentHTML("afterend", recommendationMarkup);
}

async function runMonster(monsterHrid, index, options, engine, total) {
  const name = MONSTER_NAMES[monsterHrid];
  return optimizeMonster({ character: state.character, catalog: state.catalog, engine, monsterHrid, ...options, auditRecorder: state.auditRecorder, seedBase: 20260819 + index * 1000003, signal: state.abortController.signal, onProgress: (progress) => {
    state.monsterProgress.set(monsterHrid, progressWithinMonster(progress));
    const aggregate = [...state.monsterProgress.values()].reduce((sum, value) => sum + value, 0);
    elements["progress-bar"].style.width = `${Math.min(99, (aggregate / total) * 100).toFixed(1)}%`;
    const phase = progress.phase === "offense" ? "进攻筛选" : progress.phase === "counter" ? "反制搜索" : progress.phase === "level" ? "最高等级复核" : progress.phase === "recommendation" ? "提升建议" : "处理中";
    const round = progress.balancedMaxRounds ? `第 ${progress.balancedRound || 1}/${progress.balancedMaxRounds} 轮 · ` : "";
    const direction = progress.direction ? `${progress.direction.strategyZh || `${progress.direction.styleZh || ""}${progress.direction.damageTypeZh ? `·${progress.direction.damageTypeZh}` : ""}`} · ` : "";
    const detail = progress.phase === "level" ? `探测 Lv.${progress.level || "—"}${progress.finalistCount ? `（候选 ${progress.finalistIndex || 1}/${progress.finalistCount}）` : ""}` : progress.phase === "recommendation" ? `已完成 ${progress.completed || 0}/${progress.total || 0} 项` : `${direction}${round}本阶段累计比较 ${progress.phaseEvaluations || progress.evaluations || 0} 套`;
    elements["run-status"].textContent = `${name} · ${phase} · ${detail}`;
  } });
}
async function runAll() {
  const monsterHrids = selectedValues("monster-options"); if (!monsterHrids.length) { elements["run-status"].textContent = "至少选择一个怪物"; return; }
  const equipmentValues = selectedValues("equipment-options");
  const selectedEquipmentTypes = new Set(equipmentValues.filter((value) => value !== "weapon_group"));
  if (equipmentValues.includes("weapon_group")) for (const type of HAND_TYPES) selectedEquipmentTypes.add(type);
  const skillValues = selectedValues("skill-options"); const selectedSlots = new Set(skillValues.filter((value) => value !== "aura").map(Number));
  const trialsPerPlan = Math.max(10, Math.min(1000, Math.floor(Number(elements["trials-per-plan"].value) || 20)));
  elements["trials-per-plan"].value = String(trialsPerPlan);
  const options = { referenceMonsterLevel: Math.max(20, Number(elements["reference-monster-level"].value) || 20), maxMonsterLevel: Math.max(20, Number(elements["max-monster-level"].value) || 300), hardMaxLevel: 5000, minMonsterLevel: 20, searchSpaceOptions: { selectedEquipmentTypes }, optimizableEquipmentTypes: selectedEquipmentTypes, optimizeAura: skillValues.includes("aura"), optimizableActiveSlots: selectedSlots, fixedAbilityRules: structuredClone(state.fixedRules), targetRate: Math.max(0.01, Math.min(0.99, (Number(elements["target-rate"].value) || 70) / 100)), trialsPerPlan, confidenceZ: 1.2815515655446004, feasibilityMode: "observed", retentionRatio: 0.1, minimumRetainedPlans: 10, maximumRetainedPlans: 50 };
  state.results = []; state.monsterProgress = new Map(monsterHrids.map((hrid) => [hrid, 0])); state.startedAt = new Date().toISOString(); state.auditRecorder = createSimulationAuditRecorder({ startedAt: state.startedAt, resolveName: (hrid) => chineseName(hrid, state.catalog?.itemDetailMap?.[hrid]?.name || state.catalog?.abilityDetailMap?.[hrid]?.name || state.catalog?.combatMonsterDetailMap?.[hrid]?.name || hrid), onRecord: (record) => renderAuditStatus(record) }); state.abortController = new AbortController(); state.engines = []; elements["start-button"].disabled = true; elements["cancel-button"].hidden = false; elements["progress-track"].hidden = false; elements["progress-bar"].style.width = "1%"; elements["results-section"].hidden = false; renderAuditStatus(); renderTabs(); renderDetail();
  try {
    const concurrency = Math.max(1, Math.min(Number(elements["parallel-count"].value) || 1, monsterHrids.length)); let cursor = 0;
    const engine = new CombatEngine({ workerCount: CPU_WORKER_COUNT, minimumTrialsPerWorker: 2 });
    state.engines.push(engine);
    elements["run-status"].textContent = `正在初始化 ${CPU_WORKER_COUNT} 个 CPU Worker…`;
    await engine.initialize(state.catalog);
    const worker = async () => { while (cursor < monsterHrids.length) { checkAbort(); const position = cursor++; const hrid = monsterHrids[position]; const result = await runMonster(hrid, position, options, engine, monsterHrids.length); state.results[LABYRINTH_MONSTER_HRIDS.indexOf(hrid)] = result; state.monsterProgress.set(hrid, 1); state.activeMonster = LABYRINTH_MONSTER_HRIDS.indexOf(hrid); renderTabs(); renderDetail(); } };
    await Promise.all(Array.from({ length: concurrency }, worker)); elements["progress-bar"].style.width = "100%"; elements["run-status"].textContent = `已完成 ${monsterHrids.length} 个怪物的并行模拟`;
  } catch (error) { elements["run-status"].textContent = error.name === "AbortError" ? "模拟已停止，已完成的结果仍可查看" : `模拟失败：${error.message}`; }
  finally { state.engines.forEach((engine) => engine.terminate()); state.engines = []; state.abortController = null; elements["start-button"].disabled = false; elements["cancel-button"].hidden = true; }
}
elements["start-button"].addEventListener("click", runAll); elements["cancel-button"].addEventListener("click", () => { state.abortController?.abort(); state.engines.forEach((engine) => engine.terminate()); });
elements["export-button"].addEventListener("click", () => {
  const skillValues = selectedValues("skill-options");
  const payload = { reportType: "mwi_labyrinth_collapsible_summary_v025", gameVersion: state.catalog?.gameVersion, startedAt: state.startedAt, exportedAt: new Date().toISOString(), selectedMonsters: selectedValues("monster-options"), selectedEquipmentTypes: selectedValues("equipment-options"), optimizeAura: skillValues.includes("aura"), selectedActiveSlots: skillValues.filter((value) => value !== "aura").map(Number), fixedAbilityRules: state.fixedRules, trialsPerPlan: Math.max(10, Math.min(1000, Math.floor(Number(elements["trials-per-plan"].value) || 20))), parallelCount: Number(elements["parallel-count"].value), cpuWorkerCount: CPU_WORKER_COUNT, simulationAuditSummary: state.auditRecorder?.summary() || null, searchPolicy: { weaknessOrder: "普通怪物先闪避、后兼容抗性；宝箱怪固定反伤·荆棘；第二候选严格大于最低值两倍时淘汰", matchedPresetOnly: true, targetedDefense: true, mimicSpecialStrategy: "retaliation_thorns", interactionPairs: "每轮在定向候选中显式复测不同维度的双项联动", survivalSemantics: "死亡占优时按治疗、生命汲取、生命偷取及防御效果字段开放生存候选", adaptiveTrials: "低样本候选的 Wilson 区间重叠时追加独立试次", retentionRatio: 0.1, minimumRetainedPlans: 10, maximumRetainedPlans: 50, sharedPresetBeam: true, confidence: "90% 单侧 Wilson 下界", highestLevelCriterion: "达到观测目标胜率的最高怪物等级", boundaryReview: "最高等级边界相邻等级复核", recommendationCoverage: "装备、技能、战斗等级均衡抽样后逐项真实复测" }, results: state.results };
  downloadJson(payload, `mwi迷宫模拟报告-v025-${new Date().toISOString().slice(0, 10)}.json`);
});
elements["export-audit-button"].addEventListener("click", () => {
  if (!state.auditRecorder?.records.length) { elements["run-status"].textContent = "尚无模拟明细可下载"; return; }
  const payload = state.auditRecorder.exportPayload({
    gameVersion: state.catalog?.gameVersion,
    selectedMonsters: selectedValues("monster-options"),
    trialsPerPlan: Math.max(10, Math.min(1000, Math.floor(Number(elements["trials-per-plan"].value) || 20))),
  });
  downloadJson(payload, `mwi模拟审计日志-v025-${new Date().toISOString().slice(0, 10)}.json`);
});
  elements["export-loadout-button"].addEventListener("click", async () => { try { const ok = await downloadLoadouts(state.results, state.catalog, SLOT_NAMES, MONSTER_NAMES); elements["run-status"].textContent = ok ? "已导出全部怪物配装总表" : "尚无已完成的方案可导出"; } catch (error) { elements["run-status"].textContent = `配装总表导出失败：${error.message}`; } });
