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

export function simulationCombinationSignature(input) {
  const loadout = summarizeSimulationLoadout(input);
  const gear = loadout.equipment.map((item) => `${item.slot}=${item.hrid}@${item.enhancementLevel}`).join("|");
  const abilities = loadout.abilities.map((ability) => (
    `${ability.slot}=${ability.hrid}@${ability.level}:${triggerSignature(ability)}`
  )).join("|");
  const levels = Object.entries(loadout.combatLevels).map(([field, value]) => `${field}=${value}`).join("|");
  return `${input?.monsterHrid || ""}::${number(input?.roomLevel, 0)}::${gear}::${abilities}::${levels}`;
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
  const records = [];
  const repeats = new Map();
  const startedAt = options.startedAt || new Date().toISOString();
  let nextSequence = 1;

  const push = (record) => {
    records.push(record);
    options.onRecord?.(record);
  };

  return {
    async simulate(engine, input, context = {}) {
      const sequence = nextSequence++;
      const combinationSignature = simulationCombinationSignature(input);
      const repeatIndex = (repeats.get(combinationSignature) || 0) + 1;
      repeats.set(combinationSignature, repeatIndex);
      const beganAt = Date.now();
      const base = {
        schemaVersion: 2,
        sequence,
        timestamp: new Date().toISOString(),
        monsterHrid: input?.monsterHrid || context.monsterHrid || "",
        monsterName: options.resolveName ? options.resolveName(input?.monsterHrid || context.monsterHrid || "") : null,
        roomLevel: Math.max(0, Math.floor(number(input?.roomLevel, 0))),
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
        combinationSignature,
        repeatIndex,
        isRepeatedCombination: repeatIndex > 1,
        expectedRetest: Boolean(context.expectedRetest),
        repeatClassification: repeatIndex === 1 ? "first_test" : context.expectedRetest ? "expected_retest" : "suspicious_repeat",
        loadout: summarizeSimulationLoadout(input, options.resolveName),
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
      return [...records].sort((left, right) => left.sequence - right.sequence);
    },
    summary(filter = {}) {
      const selected = records.filter((record) => !filter.monsterHrid || record.monsterHrid === filter.monsterHrid);
      const byStage = {};
      for (const record of selected) byStage[record.stage] = (byStage[record.stage] || 0) + 1;
      return {
        startedAt,
        actualSimulationBatches: selected.length,
        completedBatches: selected.filter((record) => record.status === "completed").length,
        failedBatches: selected.filter((record) => record.status === "failed").length,
        uniqueCombinations: new Set(selected.map((record) => record.combinationSignature)).size,
        repeatedBatches: selected.filter((record) => record.isRepeatedCombination).length,
        expectedRetestBatches: selected.filter((record) => record.repeatClassification === "expected_retest").length,
        suspiciousRepeatBatches: selected.filter((record) => record.repeatClassification === "suspicious_repeat").length,
        byStage,
      };
    },
    exportPayload(extra = {}) {
      return {
        reportType: "mwi_labyrinth_simulation_audit_v030",
        schemaVersion: 2,
        startedAt,
        exportedAt: new Date().toISOString(),
        ...extra,
        summary: this.summary(),
        records: this.records,
      };
    },
  };
}
