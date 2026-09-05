import { fingerprint } from './run-storage.js';
import { mergeRoomResults } from './engine-adapter.js';

const ROOT = 'learning39/';
export function batchSeed(offset) { return Math.imul(offset >>> 0, 2654435761) >>> 0; }
export function normalizeEvidence(result) {
  return { ...result, clearRate: result.trials > 0 ? result.successes / result.trials : 0 };
}
function portablePlan(plan) {
  return { key: plan.key, baseKey: plan.baseKey, zeroCooldownHrid: plan.zeroCooldownHrid,
    equipmentCandidate: { equipment: Object.fromEntries(Object.entries(plan.equipmentCandidate.equipment).map(([slot, i]) => [slot, {hrid:i.hrid, enhancementLevel:i.enhancementLevel || 0}])) },
    abilityOrder: { abilities: plan.abilityOrder.abilities.map(a => a ? {hrid:a.hrid, level:a.level || 1} : null) } };
}

// Exact evidence is indexed by combat input, not by the current search settings.
// All independent trials consume disjoint seed positions, including validation.
export class LearningLibrary {
  constructor(store, family) { this.store = store; this.family = family; }
  prefix(suffix = '') { return `${ROOT}${this.family}/${suffix}`; }
  async reserve(trials) {
    return this.store.serial(async () => {
      const offset = await this.store.get(ROOT + 'seed-position') || 0;
      if (!Number.isInteger(trials) || trials < 1 || offset + trials >= 4294967296) throw new Error('独立随机样本序列已用尽，不能重复计数');
      await this.store.put(ROOT + 'seed-position', offset + trials);
      return offset;
    });
  }
  async getPair(pairId) { return this.store.get(this.prefix(`pair/${pairId}`)); }
  async add(record) {
    record = { family:record.family,pairId:record.pairId,monsterHrid:record.monsterHrid,level:record.level,
      plan:portablePlan(record.plan),x:record.x,purpose:record.purpose,offset:record.offset,result:normalizeEvidence(record.result) };
    const id = await fingerprint({ family: record.family, pairId: record.pairId, offset: record.offset, trials: record.result.trials, purpose: record.purpose });
    return this.store.serial(async () => {
      const key = `${ROOT}${record.family}/batch/${id}`;
      if (await this.store.get(key)) return false;
      // Partial overlapping imports cannot be counted as independent evidence.
      const pairKey = `${ROOT}${record.family}/pair/${record.pairId}`;
      const old = await this.store.get(pairKey);
      const end = record.offset + record.result.trials;
      if (old?.ranges?.some(([a, b]) => record.offset < b && end > a)) throw new Error('学习档案存在重叠随机样本，已拒绝重复计数');
      const ranges = [...(old?.ranges || []), [record.offset, end]].sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const range of ranges) { if (merged.length && merged.at(-1)[1] === range[0]) merged.at(-1)[1] = range[1]; else merged.push(range); }
      const pair = { family: record.family, pairId: record.pairId, monsterHrid: record.monsterHrid,
        plan: record.plan, level: record.level, x: record.x, ranges: merged,
        search: old?.search || null, searchBatches: old?.searchBatches || 0 };
      // Validation data is archived but deliberately never feeds the learner.
      if (record.purpose === 'search') {
        pair.search = normalizeEvidence(old?.search ? mergeRoomResults([old.search, record.result]) : record.result);
        pair.searchBatches++;
      }
      await this.store.batch([[key, { ...record, id }], [pairKey, pair]]);
      return true;
    });
  }
  async sample(monsterHrid, limit, rng) {
    const rows = []; let count = 0;
    for await (const [, row] of this.store.entries(this.prefix('pair/'))) {
      if (row.monsterHrid !== monsterHrid || !row.search) continue;
      count++;
      if (rows.length < limit) rows.push(row);
      else { const i = Math.floor(rng() * count); if (i < limit) rows[i] = row; }
    }
    return { rows, count };
  }
  async model(monsterHrid, value) {
    const key = this.prefix(`model/${monsterHrid}`);
    if (value !== undefined) await this.store.put(key, value);
    return this.store.get(key);
  }
}

export async function exportLearning(store, writable) {
  await writable.write(JSON.stringify({ format: 'mwi-learning', version: 1 }) + '\n');
  for await (const [key, value] of store.entries(ROOT)) {
    if (!key.includes('/batch/')) continue;
    const checksum = await fingerprint(value);
    await writable.write(JSON.stringify({ record: value, checksum }) + '\n');
  }
}

function validateRecord(r) {
  if (!r || !/^[a-f0-9]{64}$/.test(r.family) || !/^[a-f0-9]{64}$/.test(r.pairId)
      || !['search', 'validation'].includes(r.purpose) || !Number.isInteger(r.offset) || r.offset < 0
      || !Number.isInteger(r.result?.trials) || r.result.trials < 1 || r.result.trials > 100000
      || !Number.isInteger(r.result.successes) || r.result.successes < 0 || r.result.successes > r.result.trials
      || !Number.isInteger(r.result.failedByDeath) || r.result.failedByDeath < 0
      || !Number.isInteger(r.result.failedByTimeout) || r.result.failedByTimeout < 0
      || r.result.successes + r.result.failedByDeath + r.result.failedByTimeout !== r.result.trials
      || r.offset + r.result.trials >= 4294967296 || !Number.isInteger(r.level) || r.level < 1 || r.level > 5000
      || typeof r.monsterHrid !== 'string' || !r.monsterHrid.startsWith('/monsters/')
      || !r.plan?.equipmentCandidate?.equipment || !Array.isArray(r.plan?.abilityOrder?.abilities)
      || r.plan.abilityOrder.abilities.length !== 5 || !r.x || Object.values(r.x).some(v => !Number.isFinite(v))) throw new Error('学习档案记录格式无效');
}
export async function importLearning(store, file) {
  let buffer = '', header = false, imported = 0, duplicates = 0;
  // The first pass validates the entire stream; malformed tails cause no writes.
  async function pass(write) {
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    buffer = ''; header = false;
    async function line(text) {
      if (text.length > 4000000) throw new Error('学习档案单条记录过大');
      if (!text.trim()) return;
      const value = JSON.parse(text);
      if (!header) { if (value.format !== 'mwi-learning' || value.version !== 1) throw new Error('不是支持的学习档案'); header = true; return; }
      validateRecord(value.record);
      if (await fingerprint(value.record) !== value.checksum) throw new Error('学习档案校验失败');
      const r = value.record;
      if (write) {
        // Advance before insertion; a failed import may waste seeds, never reuse them.
        await store.serial(async () => {
          const old = await store.get(ROOT + 'seed-position') || 0;
          if (r.offset + r.result.trials > old) await store.put(ROOT + 'seed-position', r.offset + r.result.trials);
        });
        if (await new LearningLibrary(store, r.family).add(r)) imported++; else duplicates++;
      }
    }
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) { await line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
        if (buffer.length > 4000000) throw new Error('学习档案单条记录过大');
      }
      await line(buffer);
      if (!header) throw new Error('学习档案为空');
    } finally { await reader.cancel(); }
  }
  await pass(false); await pass(true);
  return { imported, duplicates };
}
