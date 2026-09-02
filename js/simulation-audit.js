function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const STAGE_LABELS = {
  test: "测试阶段",
  review: "复核阶段",
  optimize: "优化阶段",
  unknown: "未标注阶段",
};

function sortedEntries(object) {
  return Object.entries(object || {}).sort(([left], [right]) => left.localeCompare(right));
}

function triggerSignature(ability) {
  const triggers = Array.isArray(ability?.triggers) ? ability.triggers : [];
  return JSON.stringify(triggers);
}

export function summarizeSimulationLoadout(input, resolveName = null) {
  const player = input?.playerDto || {};
  const equipment = sortedEntries(player.equipment).map(([slot, item]) => ({
    slot,
    hrid: item?.hrid || item?.itemHrid || "",
    name: resolveName ? resolveName(item?.hrid || item?.itemHrid || "") : null,
    enhancementLevel: Math.max(0, Math.floor(number(item?.enhancementLevel, 0))),
  }));
  const abilities = (player.abilities || []).map((ability, index) => ({
    slot: index + 1,
    slotType: index === 0 ? "special" : "active",
    hrid: ability?.hrid || ability?.abilityHrid || "",
    name: resolveName ? resolveName(ability?.hrid || ability?.abilityHrid || "") : null,
    level: Math.max(0, Math.floor(number(ability?.level, 0))),
    triggers: Array.isArray(ability?.triggers) ? ability.triggers : [],
  }));
  const combatLevels = Object.fromEntries([
    "attackLevel", "meleeLevel", "rangedLevel", "magicLevel", "defenseLevel", "staminaLevel", "intelligenceLevel",
  ].filter((field) => player[field] != null).map((field) => [field, number(player[field], 0)]));
  return { equipment, abilities, combatLevels };
}

export function simulationLoadoutSignature(input) {
  const loadout = summarizeSimulationLoadout(input);
  const gear = loadout.equipment.map((item) => `${item.slot}=${item.hrid}@${item.enhancementLevel}`).join("|");
  const abilities = loadout.abilities.map((ability) => (
    `${ability.slot}=${ability.hrid}@${ability.level}:${triggerSignature(ability)}`
  )).join("|");
  const levels = Object.entries(loadout.combatLevels).map(([field, value]) => `${field}=${value}`).join("|");
  return `${input?.monsterHrid || ""}::${gear}::${abilities}::${levels}`;
}

export function simulationCombinationSignature(input) {
  return `${simulationLoadoutSignature(input)}::Lv.${number(input?.roomLevel, 0)}`;
}

function summarizeResult(run, requestedTrials) {
  const trials = Math.max(0, Math.floor(number(run?.trials, requestedTrials)));
  const successes = Math.max(0, Math.floor(number(run?.successes, 0)));
  return {
    successes,
    trials,
    clearRate: trials > 0 ? successes / trials : 0,
    failedByDeath: Math.max(0, Math.floor(number(run?.failedByDeath, 0))),
    failedByTimeout: Math.max(0, Math.floor(number(run?.failedByTimeout, 0))),
    totalSpentSeconds: Math.max(0, number(run?.totalSpentSeconds, 0)),
    successfulSpentSeconds: Math.max(0, number(run?.successfulSpentSeconds, 0)),
    averageClearSeconds: Number.isFinite(Number(run?.averageClearSeconds)) ? Number(run.averageClearSeconds) : null,
    minElapsedSeconds: Math.max(0, number(run?.minElapsedSeconds, 0)),
    maxElapsedSeconds: Math.max(0, number(run?.maxElapsedSeconds, 0)),
    attackSummary: run?.attackSummary || null,
    damageSummary: run?.damageSummary || null,
    combatStats: run?.combatStats || null,
    debug: run?.debug || null,
  };
}

export function createSimulationAuditRecorder(options = {}) {
  const activeRecords = [];
  const recordChunks = [];
  const repeats = new Map();
  const loadouts = new Map();
  const loadoutsById = [];
  const recordChunkSize = Math.max(2, Math.floor(number(options.recordChunkSize, 250)));
  const startedAt = options.startedAt || new Date().toISOString();
  let nextSequence = 1;
  let recordCount = 0;

  function createSummaryState() {
    return {
      actualSimulationBatches: 0,
      completedBatches: 0,
      failedBatches: 0,
      combinationSignatures: new Set(),
      loadoutSignatures: new Set(),
      requestedTrials: 0,
      completedTrials: 0,
      repeatedBatches: 0,
      expectedRetestBatches: 0,
      suspiciousRepeatBatches: 0,
      byStage: {},
      stageSummary: new Map(),
    };
  }

  const overallSummary = createSummaryState();
  const monsterSummaries = new Map();

  function updateSummary(state, record) {
    const completedTrials = record.status === "completed" ? Math.max(0, number(record.result?.trials, 0)) : 0;
    state.actualSimulationBatches += 1;
    state.completedBatches += record.status === "completed" ? 1 : 0;
    state.failedBatches += record.status === "failed" ? 1 : 0;
    state.combinationSignatures.add(record.combinationKey);
    state.loadoutSignatures.add(record.loadoutId);
    state.requestedTrials += Math.max(0, number(record.trialsRequested, 0));
    state.completedTrials += completedTrials;
    state.repeatedBatches += record.isRepeatedCombination ? 1 : 0;
    state.expectedRetestBatches += record.repeatClassification === "expected_retest" ? 1 : 0;
    state.suspiciousRepeatBatches += record.repeatClassification === "suspicious_repeat" ? 1 : 0;
    state.byStage[record.stage] = (state.byStage[record.stage] || 0) + 1;
    if (!state.stageSummary.has(record.stage)) {
      state.stageSummary.set(record.stage, { batches: 0, completedTrials: 0, loadoutSignatures: new Set() });
    }
    const stage = state.stageSummary.get(record.stage);
    stage.batches += 1;
    stage.completedTrials += completedTrials;
    stage.loadoutSignatures.add(record.loadoutId);
  }

  function snapshot(state) {
    return {
      startedAt,
      actualSimulationBatches: state.actualSimulationBatches,
      completedBatches: state.completedBatches,
      failedBatches: state.failedBatches,
      uniqueCombinations: state.combinationSignatures.size,
      uniqueLoadouts: state.loadoutSignatures.size,
      requestedTrials: state.requestedTrials,
      completedTrials: state.completedTrials,
      repeatedBatches: state.repeatedBatches,
      expectedRetestBatches: state.expectedRetestBatches,
      suspiciousRepeatBatches: state.suspiciousRepeatBatches,
      byStage: { ...state.byStage },
      stageSummary: Object.fromEntries([...state.stageSummary].map(([stage, entry]) => [stage, {
        batches: entry.batches,
        completedTrials: entry.completedTrials,
        uniqueLoadouts: entry.loadoutSignatures.size,
      }])),
    };
  }

  function flushRecordChunk() {
    if (!activeRecords.length) return;
    const json = JSON.stringify(activeRecords);
    recordChunks.push(new Blob([json.slice(1, -1)], { type: "application/json" }));
    activeRecords.length = 0;
  }

  function externalRecord(record) {
    const definition = loadoutsById[record.loadoutId - 1];
    return {
      ...record,
      combinationSignature: `${definition?.signature || ""}::Lv.${record.roomLevel}`,
      loadoutSignature: definition?.signature || "",
      loadout: definition?.loadout || null,
    };
  }

  const push = (record) => {
    const stored = { ...record, sequence: nextSequence++ };
    activeRecords.push(stored);
    recordCount += 1;
    updateSummary(overallSummary, stored);
    if (!monsterSummaries.has(stored.monsterHrid)) monsterSummaries.set(stored.monsterHrid, createSummaryState());
    updateSummary(monsterSummaries.get(stored.monsterHrid), stored);
    options.onRecord?.(stored);
    if (activeRecords.length >= recordChunkSize) flushRecordChunk();
  };

  return {
    async simulate(engine, input, context = {}) {
      const loadoutSignature = simulationLoadoutSignature(input);
      if (!loadouts.has(loadoutSignature)) {
        const definition = {
          id: loadoutsById.length + 1,
          signature: loadoutSignature,
          loadout: summarizeSimulationLoadout(input, options.resolveName),
        };
        loadouts.set(loadoutSignature, definition);
        loadoutsById.push(definition);
      }
      const loadoutId = loadouts.get(loadoutSignature).id;
      const roomLevel = Math.max(0, Math.floor(number(input?.roomLevel, 0)));
      const combinationKey = `${loadoutId}:${roomLevel}`;
      const repeatIndex = (repeats.get(combinationKey) || 0) + 1;
      repeats.set(combinationKey, repeatIndex);
      const beganAt = Date.now();
      const base = {
        schemaVersion: 3,
        timestamp: new Date().toISOString(),
        monsterHrid: input?.monsterHrid || context.monsterHrid || "",
        monsterName: options.resolveName ? options.resolveName(input?.monsterHrid || context.monsterHrid || "") : null,
        roomLevel,
        trialsRequested: Math.max(0, Math.floor(number(input?.trials, 0))),
        seed: number(input?.seed, 0),
        stage: context.stage || "unknown",
        stageLabel: STAGE_LABELS[context.stage || "unknown"] || context.stage || STAGE_LABELS.unknown,
        reason: context.reason || "未标注原因",
        candidateKind: context.candidateKind || "unknown",
        planId: context.planId || null,
        searchRound: context.searchRound == null ? null : Math.max(0, Math.floor(number(context.searchRound, 0))),
        direction: context.direction || null,
        changedDimensions: [...(context.changedDimensions || [])],
        combinationKey,
        loadoutId,
        repeatIndex,
        isRepeatedCombination: repeatIndex > 1,
        expectedRetest: Boolean(context.expectedRetest),
        repeatClassification: repeatIndex === 1 ? "first_test" : context.expectedRetest ? "expected_retest" : "suspicious_repeat",
      };
      try {
        const run = await engine.simulateRoom(input);
        push({
          ...base,
          status: "completed",
          durationMilliseconds: Math.max(0, Date.now() - beganAt),
          result: summarizeResult(run, input?.trials),
        });
        return run;
      } catch (error) {
        push({
          ...base,
          status: "failed",
          durationMilliseconds: Math.max(0, Date.now() - beganAt),
          result: null,
          error: { name: error?.name || "Error", message: error?.message || String(error) },
        });
        throw error;
      }
    },
    get records() {
      if (recordChunks.length) throw new Error("审计记录已压入低内存分块，请使用 exportBlob() 导出完整日志");
      return [...activeRecords].sort((left, right) => left.sequence - right.sequence).map(externalRecord);
    },
    get recordCount() {
      return recordCount;
    },
    summary(filter = {}) {
      if (!filter.monsterHrid) return snapshot(overallSummary);
      return snapshot(monsterSummaries.get(filter.monsterHrid) || createSummaryState());
    },
    exportPayload(extra = {}) {
      if (recordChunks.length) throw new Error("大型审计请使用 exportBlob() 导出");
      return {
        reportType: "mwi_labyrinth_simulation_audit_v037",
        schemaVersion: 3,
        startedAt,
        exportedAt: new Date().toISOString(),
        ...extra,
        summary: this.summary(),
        loadouts: loadoutsById,
        records: [...activeRecords],
      };
    },
    exportBlob(extra = {}) {
      const header = {
        reportType: "mwi_labyrinth_simulation_audit_v037",
        schemaVersion: 3,
        startedAt,
        exportedAt: new Date().toISOString(),
        ...extra,
        summary: this.summary(),
        loadouts: loadoutsById,
      };
      const replacer = (_key, value) => value instanceof Set ? [...value] : value;
      const parts = [`${JSON.stringify(header, replacer).slice(0, -1)},"records":[`];
      let hasRecords = false;
      for (const chunk of recordChunks) {
        if (hasRecords) parts.push(",");
        parts.push(chunk);
        hasRecords = true;
      }
      if (activeRecords.length) {
        if (hasRecords) parts.push(",");
        parts.push(JSON.stringify(activeRecords).slice(1, -1));
      }
      parts.push("]}");
      return new Blob(parts, { type: "application/json" });
    },
  };
}
