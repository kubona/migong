const RUNTIME_PRELUDE = `"use strict";
var __webpack_modules__ = {};
var __webpack_module_cache__ = {};
function __webpack_require__(moduleId) {
  var cached = __webpack_module_cache__[moduleId];
  if (cached !== undefined) return cached.exports;
  var module = (__webpack_module_cache__[moduleId] = { exports: {} });
  var factory = __webpack_modules__[moduleId];
  if (!factory) throw new Error("Missing webpack module: " + moduleId);
  factory(module, module.exports, __webpack_require__);
  return module.exports;
}
__webpack_require__.o = function (obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop); };
__webpack_require__.d = function (exports, definition) {
  for (var key in definition) if (__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
    Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
  }
};
__webpack_require__.r = function (exports) {
  if (typeof Symbol !== "undefined" && Symbol.toStringTag) Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  Object.defineProperty(exports, "__esModule", { value: true });
};
var __webpack_chunk_array__ = [];
__webpack_chunk_array__.push = function (data) {
  var modules = data[1] || {}, runtime = data[2];
  for (var id in modules) if (__webpack_require__.o(modules, id)) __webpack_modules__[id] = modules[id];
  if (runtime) runtime(__webpack_require__);
};
self["webpackChunkmwicombatsimulator"] = __webpack_chunk_array__;`;

export function mulberry32(seed) {
  let value = Number(seed) >>> 0;
  return function random() {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function summarizeAttackMap(attacks, playerHrid = "player1") {
  const summary = { hits: 0, misses: 0, total: 0, hitRate: 0, byAbility: {} };
  const targets = attacks?.[playerHrid] || {};
  for (const abilities of Object.values(targets)) {
    for (const [ability, buckets] of Object.entries(abilities || {})) {
      const slot = summary.byAbility[ability] || { hits: 0, misses: 0 };
      let localHits = 0;
      let localMisses = 0;
      for (const [bucket, rawCount] of Object.entries(buckets || {})) {
        const count = Math.max(0, Number(rawCount) || 0);
        if (bucket === "miss") localMisses += count;
        else localHits += count;
      }
      slot.hits += localHits;
      slot.misses += localMisses;
      summary.hits += localHits;
      summary.misses += localMisses;
      summary.byAbility[ability] = slot;
    }
  }
  summary.total = summary.hits + summary.misses;
  summary.hitRate = summary.total > 0 ? summary.hits / summary.total : 0;
  return summary;
}

export function summarizeDamageMap(attacks, playerHrid = "player1") {
  const counterAbilities = new Set(["physicalThorns", "elementalThorns", "retaliation"]);
  const summary = { totalDamage: 0, counterDamage: 0, byAbility: {} };
  const targets = attacks?.[playerHrid] || {};
  for (const abilities of Object.values(targets)) {
    for (const [ability, buckets] of Object.entries(abilities || {})) {
      const slot = summary.byAbility[ability] || { damage: 0, hits: 0 };
      for (const [bucket, rawCount] of Object.entries(buckets || {})) {
        if (bucket === "miss") continue;
        const damage = Number(bucket);
        const count = Math.max(0, Number(rawCount) || 0);
        if (!Number.isFinite(damage) || damage < 0 || count <= 0) continue;
        slot.damage += damage * count;
        slot.hits += count;
      }
      summary.byAbility[ability] = slot;
    }
  }
  summary.totalDamage = Object.values(summary.byAbility).reduce((total, entry) => total + entry.damage, 0);
  for (const ability of counterAbilities) {
    summary.counterDamage += summary.byAbility[ability]?.damage || 0;
  }
  return summary;
}

function engineWorkerMain() {
  var Player = null;
  var CombatSimulator = null;
  var Labyrinth = null;
  var gameVersion = "";
  var ONE_SECOND_NS = 1e9;

  function finite(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clone(value) {
    if (value === null || value === undefined) return value;
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function seededRandom(seed) {
    var value = Number(seed) >>> 0;
    return function () {
      value += 0x6d2b79f5;
      var mixed = value;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  function installCatalog(catalog) {
    var dataModules = {
      abilityDetailMap: "./src/combatsimulator/data/abilityDetailMap.json",
      achievementDetailMap: "./src/combatsimulator/data/achievementDetailMap.json",
      achievementTierDetailMap: "./src/combatsimulator/data/achievementTierDetailMap.json",
      actionDetailMap: "./src/combatsimulator/data/actionDetailMap.json",
      combatMonsterDetailMap: "./src/combatsimulator/data/combatMonsterDetailMap.json",
      combatStyleDetailMap: "./src/combatsimulator/data/combatStyleDetailMap.json",
      combatTriggerDependencyDetailMap: "./src/combatsimulator/data/combatTriggerDependencyDetailMap.json",
      enhancementLevelTotalBonusMultiplierTable: "./src/combatsimulator/data/enhancementLevelTotalBonusMultiplierTable.json",
      houseRoomDetailMap: "./src/combatsimulator/data/houseRoomDetailMap.json",
      itemDetailMap: "./src/combatsimulator/data/itemDetailMap.json",
      labyrinthCrateDetailMap: "./src/combatsimulator/data/labyrinthCrateDetailMap.json",
    };
    Object.keys(dataModules).forEach(function (field) {
      var moduleId = dataModules[field];
      if (catalog[field] === undefined) throw new Error("init_client_data missing " + field);
      var moduleValue = catalog[field];
      __webpack_modules__[moduleId] = function (module) { module.exports = moduleValue; };
      delete __webpack_module_cache__[moduleId];
    });
    Player = __webpack_require__("./src/combatsimulator/player.js").default;
    CombatSimulator = __webpack_require__("./src/combatsimulator/combatSimulator.js").default;
    Labyrinth = __webpack_require__("./src/combatsimulator/labyrinth.js").default;
    installMonsterHalfCooldown();
    gameVersion = String(catalog.gameVersion || "");
  }

  function installMonsterHalfCooldown() {
    var CombatUnit = __webpack_require__("./src/combatsimulator/combatUnit.js").default;
    if (CombatUnit.prototype.__calculatorHalfCooldown) return;
    var originalReset = CombatUnit.prototype.resetCooldowns;
    // Match calculator 1.5.13, including the original reset's RNG consumption.
    // This is an explicitly selected compatibility rule, not verified server behavior.
    CombatUnit.prototype.resetCooldowns = function (currentTime) {
      var result = originalReset.apply(this, arguments);
      if (!this.isPlayer && Array.isArray(this.abilities)) {
        var time = finite(currentTime, 0);
        var haste = finite(this.combatDetails && this.combatDetails.combatStats
          ? this.combatDetails.combatStats.abilityHaste : 0, 0);
        this.abilities.filter(function (ability) { return ability != null; }).forEach(function (ability) {
          var cooldown = finite(ability.cooldownDuration, 0);
          if (haste > 0) cooldown = cooldown * 100 / (100 + haste);
          ability.lastUsed = time - Math.floor(cooldown * 0.5);
        });
      }
      return result;
    };
    CombatUnit.prototype.__calculatorHalfCooldown = true;
  }

  function normalizeBuffs(raw) {
    var result = [], seen = Object.create(null);
    (Array.isArray(raw) ? raw : []).forEach(function (buff) {
      var normalized = {
        uniqueHrid: String((buff && buff.uniqueHrid) || ""),
        typeHrid: String((buff && buff.typeHrid) || ""),
        ratioBoost: finite(buff && buff.ratioBoost, 0),
        ratioBoostLevelBonus: finite(buff && buff.ratioBoostLevelBonus, 0),
        flatBoost: finite(buff && buff.flatBoost, 0),
        flatBoostLevelBonus: finite(buff && buff.flatBoostLevelBonus, 0),
        startTime: String((buff && buff.startTime) || "0001-01-01T00:00:00Z"),
        duration: Math.max(0, finite(buff && buff.duration, 0)),
      };
      if (!normalized.typeHrid) return;
      var key = [normalized.typeHrid, normalized.ratioBoost, normalized.ratioBoostLevelBonus, normalized.flatBoost, normalized.flatBoostLevelBonus, normalized.duration].join("|");
      if (!seen[key]) { seen[key] = true; result.push(normalized); }
    });
    return result;
  }

  function ensureRecorder() {
    if (CombatSimulator.prototype.__fullSearchRecorder) return;
    var originalStart = CombatSimulator.prototype.startNewEncounter;
    var originalEnd = CombatSimulator.prototype.checkEncounterEnd;
    CombatSimulator.prototype.startNewEncounter = function () {
      var result = originalStart.apply(this, arguments);
      if (this.labyrinth) {
        this.__fullSearchStats = this.__fullSearchStats || { completed: [], currentStartNs: null };
        this.__fullSearchStats.currentStartNs = Math.max(0, finite(this.simulationTime, 0));
      }
      return result;
    };
    CombatSimulator.prototype.checkEncounterEnd = function () {
      var before = Math.max(0, Math.floor(finite(this && this.simResult && this.simResult.encounters, 0)));
      var stats = this.__fullSearchStats || { completed: [], currentStartNs: null };
      this.__fullSearchStats = stats;
      var start = finite(stats.currentStartNs, finite(this.simulationTime, 0));
      var ended = originalEnd.apply(this, arguments);
      if (ended && this.labyrinth) {
        var after = Math.max(0, Math.floor(finite(this && this.simResult && this.simResult.encounters, 0)));
        var reason = after > before ? "success" : this.allPlayersDead === true ? "death" : "timeout";
        var end = Math.max(0, finite(this.simulationTime, 0));
        stats.completed.push({ reason: reason, durationNs: Math.max(0, end - start) });
        stats.currentStartNs = null;
        if (this.__stopAfterFirstEncounter) {
          var stopError = new Error("independent trial completed");
          stopError.__independentTrialCompleted = true;
          throw stopError;
        }
      }
      return ended;
    };
    CombatSimulator.prototype.__fullSearchRecorder = true;
  }

  function attackSummary(attacks, playerHrid) {
    var summary = { hits: 0, misses: 0, total: 0, hitRate: 0, byAbility: {} };
    var targets = attacks && attacks[playerHrid] ? attacks[playerHrid] : {};
    Object.keys(targets).forEach(function (target) {
      Object.keys(targets[target] || {}).forEach(function (ability) {
        var values = targets[target][ability] || {};
        var hits = 0, misses = 0;
        Object.keys(values).forEach(function (bucket) {
          var count = Math.max(0, finite(values[bucket], 0));
          if (bucket === "miss") misses += count;
          else hits += count;
        });
        summary.hits += hits;
        summary.misses += misses;
        var slot = summary.byAbility[ability] || { hits: 0, misses: 0 };
        slot.hits += hits; slot.misses += misses; summary.byAbility[ability] = slot;
      });
    });
    summary.total = summary.hits + summary.misses;
    summary.hitRate = summary.total > 0 ? summary.hits / summary.total : 0;
    return summary;
  }

  async function simulate(params) {
    if (!Player) throw new Error("engine is not initialized");
    var requestedTrials = Math.max(1, Math.floor(finite(params.trials, 1)));
    var trialOffset = Math.max(0, Math.floor(finite(params.trialOffset, 0)));
    var durationSeconds = Math.max(1, finite(params.roomDurationSeconds, 120));
    var crates = Array.from(new Set((params.mazeCrateItemHrids || []).filter(Boolean)));
    ensureRecorder();
    var originalRandom = Math.random;
    var completed = [];
    var aggregateAttacks = { hits: 0, misses: 0, total: 0, hitRate: 0, byAbility: {} };
    var aggregateDamage = { totalDamage: 0, counterDamage: 0, byAbility: {} };
    var combatStats = null;
    var ranOutOfMana = false;
    var simulatedSeconds = 0;
    var normalizedBuffs = normalizeBuffs((params.extraBuffs || []).concat(params.labyrinthCombatBuffs || []));
    try {
      for (var trialIndex = 0; trialIndex < requestedTrials; trialIndex += 1) {
        var player = Player.createFromDTO(clone(params.playerDto));
        player.food = [null, null, null];
        player.drinks = [null, null, null];
        player.extraBuffs = clone(normalizedBuffs);
        var labyrinth = new Labyrinth(String(params.monsterHrid || ""), Math.max(1, Math.floor(finite(params.roomLevel, 1))), crates);
        player.zoneBuffs = Array.isArray(labyrinth.buffs) ? labyrinth.buffs : [];
        var simulator = new CombatSimulator([player], null, labyrinth, { enableHpMpVisualization: false });
        simulator.__fullSearchStats = { completed: [], currentStartNs: null };
        simulator.__stopAfterFirstEncounter = true;
        Math.random = seededRandom((finite(params.seed, 0) + (trialOffset + trialIndex) * 2654435761) >>> 0);
        var result = null;
        try {
          result = await simulator.simulate(Math.floor(durationSeconds * ONE_SECOND_NS));
        } catch (error) {
          if (!error || !error.__independentTrialCompleted) throw error;
          result = simulator.simResult || result;
        }
        var entry = (simulator.__fullSearchStats.completed || [])[0];
        if (!entry) entry = { reason: "timeout", durationNs: durationSeconds * ONE_SECOND_NS };
        completed.push(entry);
        simulatedSeconds += Math.max(0, finite(simulator.simulationTime, entry.durationNs)) / ONE_SECOND_NS;
        var localAttacks = attackSummary(result && result.attacks, String(player.hrid || "player1"));
        var localDamage = summarizeDamageMap(result && result.attacks, String(player.hrid || "player1"));
        aggregateAttacks.hits += localAttacks.hits;
        aggregateAttacks.misses += localAttacks.misses;
        Object.keys(localAttacks.byAbility || {}).forEach(function (ability) {
          var target = aggregateAttacks.byAbility[ability] || { hits: 0, misses: 0 };
          target.hits += localAttacks.byAbility[ability].hits;
          target.misses += localAttacks.byAbility[ability].misses;
          aggregateAttacks.byAbility[ability] = target;
        });
        aggregateDamage.totalDamage += localDamage.totalDamage;
        aggregateDamage.counterDamage += localDamage.counterDamage;
        Object.keys(localDamage.byAbility || {}).forEach(function (ability) {
          var target = aggregateDamage.byAbility[ability] || { damage: 0, hits: 0 };
          target.damage += localDamage.byAbility[ability].damage;
          target.hits += localDamage.byAbility[ability].hits;
          aggregateDamage.byAbility[ability] = target;
        });
        if (!combatStats) combatStats = clone(player.combatDetails && player.combatDetails.combatStats);
        ranOutOfMana = ranOutOfMana || Boolean(result && result.playerRanOutOfMana && result.playerRanOutOfMana[player.hrid]);
      }
    } finally {
      Math.random = originalRandom;
    }
    aggregateAttacks.total = aggregateAttacks.hits + aggregateAttacks.misses;
    aggregateAttacks.hitRate = aggregateAttacks.total > 0 ? aggregateAttacks.hits / aggregateAttacks.total : 0;
    var successes = completed.filter(function (entry) { return entry.reason === "success"; }).length;
    var failedByDeath = completed.filter(function (entry) { return entry.reason === "death"; }).length;
    var failedByTimeout = completed.filter(function (entry) { return entry.reason === "timeout"; }).length;
    var durations = completed.map(function (entry) { return Math.max(0, finite(entry.durationNs, 0)) / ONE_SECOND_NS; });
    var totalSpentSeconds = durations.reduce(function (sum, value) { return sum + value; }, 0);
    var successfulSpentSeconds = completed.reduce(function (sum, entry) {
      return sum + (entry.reason === "success" ? Math.max(0, finite(entry.durationNs, 0)) / ONE_SECOND_NS : 0);
    }, 0);
    return {
      successes: successes,
      trials: completed.length,
      failedByDeath: failedByDeath,
      failedByTimeout: failedByTimeout,
      totalSpentSeconds: totalSpentSeconds,
      successfulSpentSeconds: successfulSpentSeconds,
      averageClearSeconds: successes > 0 ? successfulSpentSeconds / successes : Infinity,
      minElapsedSeconds: durations.length ? Math.min.apply(Math, durations) : 0,
      maxElapsedSeconds: durations.length ? Math.max.apply(Math, durations) : 0,
      attackSummary: aggregateAttacks,
      damageSummary: aggregateDamage,
      combatStats: combatStats,
      debug: {
        requestedTrials: requestedTrials,
        trialOffset: trialOffset,
        attemptCount: requestedTrials,
        encounters: successes,
        simulatedSeconds: simulatedSeconds,
        independentTrials: true,
        ranOutOfMana: ranOutOfMana,
      },
    };
  }

  self.onmessage = async function (event) {
    var data = event && event.data ? event.data : {};
    try {
      if (data.type === "engine_init") {
        installCatalog(data.catalog || {});
        self.postMessage({ type: "engine_ready", requestId: data.requestId, gameVersion: gameVersion });
      } else if (data.type === "simulate_batch") {
        var results = [];
        for (var shard of data.shards) results.push(await simulate(Object.assign({}, data.params, shard)));
        self.postMessage({type:'batch_result', requestId:data.requestId, results:results});
      } else if (data.type === "simulate_room") {
        var result = await simulate(data);
        self.postMessage(Object.assign({ type: "room_result", requestId: data.requestId }, result));
      }
    } catch (error) {
      self.postMessage({ type: "engine_error", requestId: data.requestId, error: error && error.message ? error.message : String(error) });
    }
  };
}

export function buildEngineWorkerSource(vendorChunkSource, workerChunkSource) {
  return [
    RUNTIME_PRELUDE,
    String(vendorChunkSource || ""),
    String(workerChunkSource || ""),
    summarizeDamageMap.toString(),
    `(${engineWorkerMain.toString()})();`,
  ].join("\n\n");
}

export function recommendedWorkerCount(logicalProcessors = globalThis.navigator?.hardwareConcurrency, resourceUtilization = 80) {
  const logical = Math.max(1, Math.floor(Number(logicalProcessors) || 4));
  const profile = [50, 80, 100].includes(Number(resourceUtilization)) ? Number(resourceUtilization) : 80;
  // “100%”仍是安全满载：高线程桌面 CPU 至少给系统留下 4 个逻辑线程，
  // 中低端 CPU 也始终保留 1–2 个逻辑线程，不会把所有处理器交给网页。
  const reserved = logical >= 16 ? 4 : logical >= 8 ? 2 : 1;
  const safeMaximum = Math.max(1, logical - reserved);
  const requested = profile === 100 ? safeMaximum : Math.max(1, Math.floor(logical * profile / 100));
  return Math.max(1, Math.min(safeMaximum, requested));
}

export function splitTrials(trials, workerCount, minimumTrialsPerWorker = 2) {
  const total = Math.max(1, Math.floor(Number(trials) || 1));
  const workers = Math.max(1, Math.floor(Number(workerCount) || 1));
  const minimum = Math.max(1, Math.floor(Number(minimumTrialsPerWorker) || 1));
  const shardCount = Math.max(1, Math.min(workers, total, Math.ceil(total / minimum)));
  const base = Math.floor(total / shardCount);
  const remainder = total % shardCount;
  let offset = 0;
  return Array.from({ length: shardCount }, (_entry, index) => {
    const shardTrials = base + (index < remainder ? 1 : 0);
    const shard = { trials: shardTrials, trialOffset: offset };
    offset += shardTrials;
    return shard;
  });
}

function mergeAbilityCounters(results, summaryName, valueNames) {
  const merged = {};
  for (const result of results) {
    for (const [ability, source] of Object.entries(result?.[summaryName]?.byAbility || {})) {
      const target = merged[ability] || Object.fromEntries(valueNames.map((name) => [name, 0]));
      for (const name of valueNames) target[name] += Math.max(0, Number(source?.[name]) || 0);
      merged[ability] = target;
    }
  }
  return merged;
}

export function mergeRoomResults(results, metadata = {}) {
  const shards = (results || []).filter(Boolean);
  const sum = (field) => shards.reduce((total, result) => total + Math.max(0, Number(result?.[field]) || 0), 0);
  const successes = sum("successes");
  const trials = sum("trials");
  const successfulSpentSeconds = sum("successfulSpentSeconds");
  const attackByAbility = mergeAbilityCounters(shards, "attackSummary", ["hits", "misses"]);
  const damageByAbility = mergeAbilityCounters(shards, "damageSummary", ["damage", "hits"]);
  const hits = shards.reduce((total, result) => total + Math.max(0, Number(result?.attackSummary?.hits) || 0), 0);
  const misses = shards.reduce((total, result) => total + Math.max(0, Number(result?.attackSummary?.misses) || 0), 0);
  const elapsedMins = shards.map((result) => Number(result?.minElapsedSeconds)).filter(Number.isFinite);
  const elapsedMaxes = shards.map((result) => Number(result?.maxElapsedSeconds)).filter(Number.isFinite);
  return {
    successes,
    trials,
    failedByDeath: sum("failedByDeath"),
    failedByTimeout: sum("failedByTimeout"),
    totalSpentSeconds: sum("totalSpentSeconds"),
    successfulSpentSeconds,
    averageClearSeconds: successes > 0 ? successfulSpentSeconds / successes : Infinity,
    minElapsedSeconds: elapsedMins.length ? Math.min(...elapsedMins) : 0,
    maxElapsedSeconds: elapsedMaxes.length ? Math.max(...elapsedMaxes) : 0,
    attackSummary: { hits, misses, total: hits + misses, hitRate: hits + misses > 0 ? hits / (hits + misses) : 0, byAbility: attackByAbility },
    damageSummary: {
      totalDamage: shards.reduce((total, result) => total + Math.max(0, Number(result?.damageSummary?.totalDamage) || 0), 0),
      counterDamage: shards.reduce((total, result) => total + Math.max(0, Number(result?.damageSummary?.counterDamage) || 0), 0),
      byAbility: damageByAbility,
    },
    combatStats: shards.find((result) => result?.combatStats)?.combatStats || null,
    debug: {
      requestedTrials: trials,
      attemptCount: shards.reduce((total, result) => total + Math.max(0, Number(result?.debug?.attemptCount) || 0), 0),
      encounters: shards.reduce((total, result) => total + Math.max(0, Number(result?.debug?.encounters) || 0), 0),
      simulatedSeconds: shards.reduce((total, result) => total + Math.max(0, Number(result?.debug?.simulatedSeconds) || 0), 0),
      independentTrials: shards.every((result) => result?.debug?.independentTrials === true),
      ranOutOfMana: shards.some((result) => result?.debug?.ranOutOfMana === true),
      workerCount: Math.max(1, Math.floor(Number(metadata.workerCount) || 1)),
      parallelShards: shards.length,
      shardTrials: shards.map((result) => Math.max(0, Number(result?.trials) || 0)),
    },
  };
}

export class CombatEngine {
  constructor(options = {}) {
    this.vendorUrl = options.vendorUrl || "./engine/vendors-heap.bundle.js";
    this.workerChunkUrl = options.workerChunkUrl || "./engine/src_worker_js.bundle.js";
    this.workerCount = Math.max(1, Math.floor(Number(options.workerCount) || recommendedWorkerCount()));
    this.minimumTrialsPerWorker = Math.max(1, Math.floor(Number(options.minimumTrialsPerWorker) || 2));
    this.workers = [];
    this.workerUrl = "";
    this.pending = new Map();
    this.queue = [];
    this.counter = 0;
    this.initialized = false;
    this.planScheduling = Boolean(options.planScheduling);
    this.metrics = { jobs:0, computeMilliseconds:0, queuedMilliseconds:0, maxQueue:0 };
  }

  async initialize(catalog) {
    if (this.initialized) return;
    const [vendorResponse, workerResponse] = await Promise.all([fetch(this.vendorUrl), fetch(this.workerChunkUrl)]);
    if (!vendorResponse.ok || !workerResponse.ok) throw new Error("无法读取本地战斗引擎文件");
    const source = buildEngineWorkerSource(await vendorResponse.text(), await workerResponse.text());
    this.workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    this.workers = Array.from({ length: this.workerCount }, () => {
      const slot = { worker: new Worker(this.workerUrl), busy: false };
      slot.worker.addEventListener("message", (event) => this.#handleMessage(slot, event.data || {}));
      slot.worker.addEventListener("error", (event) => this.#handleWorkerFailure(new Error(event.message || "战斗引擎异常")));
      return slot;
    });
    try {
      await Promise.all(this.workers.map((slot) => this.#dispatch(slot, { type: "engine_init", catalog })));
      this.initialized = true;
    } catch (error) {
      this.terminate();
      throw error;
    }
  }

  async simulateRoom(params) {
    if (!this.initialized) throw new Error("战斗引擎尚未初始化");
    const shards = splitTrials(params?.trials, this.workers.length, this.minimumTrialsPerWorker);
    if(this.planScheduling) {
      // Preserve the old shard boundaries and merge order exactly. Several
      // adjacent shards travel in one message while other plans run in parallel.
      const desired = Math.max(1,Math.min(shards.length,Math.floor(this.workerCount / Math.max(1,params.plannedConcurrency || this.workerCount))));
      const groups = Array.from({length:desired},(_,i)=>shards.slice(Math.floor(i*shards.length/desired),Math.floor((i+1)*shards.length/desired)));
      const batches = await Promise.all(groups.map(group=>this.#enqueue({type:'simulate_batch',params,shards:group})));
      return mergeRoomResults(batches.flatMap(batch=>batch.results),{workerCount:this.workers.length});
    }
    const results = await Promise.all(shards.map((shard) => this.#enqueue({ type: "simulate_room", ...params, ...shard })));
    return mergeRoomResults(results, { workerCount: this.workers.length });
  }

  terminate() {
    for (const slot of this.workers) slot.worker.terminate();
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workers = [];
    this.workerUrl = "";
    this.initialized = false;
    this.#failAll(new Error("模拟已取消"));
  }

  #dispatch(slot, message, external = null) {
    const requestId = `r${Date.now()}_${++this.counter}`;
    slot.busy = true;
    slot.startedAt = performance.now();
    this.metrics.jobs++;
    if(external?.queuedAt) this.metrics.queuedMilliseconds += slot.startedAt-external.queuedAt;
    if (external) {
      this.pending.set(requestId, { ...external, slot });
      slot.worker.postMessage({ ...message, requestId });
      return undefined;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, slot });
      slot.worker.postMessage({ ...message, requestId });
    });
  }

  #enqueue(message) {
    return new Promise((resolve, reject) => {
      this.queue.push({ message, resolve, reject, queuedAt:performance.now() });
      this.metrics.maxQueue = Math.max(this.metrics.maxQueue,this.queue.length);
      this.#pump();
    });
  }

  #pump() {
    for (const slot of this.workers) {
      if (slot.busy || this.queue.length === 0) continue;
      const job = this.queue.shift();
      this.#dispatch(slot, job.message, job);
    }
  }

  #handleMessage(slot, message) {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    this.metrics.computeMilliseconds += performance.now()-slot.startedAt;
    slot.busy = false;
    if (message.type === "engine_error") pending.reject(new Error(message.error || "战斗引擎异常"));
    else pending.resolve(message);
    this.#pump();
  }

  #failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const job of this.queue) job.reject(error);
    this.queue = [];
    for (const slot of this.workers) slot.busy = false;
  }

  #handleWorkerFailure(error) {
    for (const slot of this.workers) slot.worker.terminate();
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workers = [];
    this.workerUrl = "";
    this.initialized = false;
    this.#failAll(error);
  }

  stats() { return {...this.metrics, busyWorkers:this.workers.filter(s=>s.busy).length, totalWorkers:this.workers.length, pendingTasks:this.queue.length}; }
}
