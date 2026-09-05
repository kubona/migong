// Sparse, weighted extra-randomized regression trees. Disagreement is a search
// heuristic, never a confidence bound for certification.
export function randomGenerator(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export function planFeatures(plan, catalog, level) {
  const x = { 'monster.level': level };
  for (const [slot, item] of Object.entries(plan.equipmentCandidate.equipment)) {
    x[`item:${slot}:${item.hrid}`] = 1;
    x[`enhancement:${slot}`] = item.enhancementLevel || 0;
    const d = catalog.itemDetailMap?.[item.hrid]?.equipmentDetail || {};
    const m = catalog.enhancementLevelTotalBonusMultiplierTable?.[item.enhancementLevel] || 0;
    for (const k of new Set([...Object.keys(d.combatStats || {}), ...Object.keys(d.combatEnhancementBonuses || {})])) {
      const v = Number(d.combatStats?.[k] || 0) + Number(d.combatEnhancementBonuses?.[k] || 0) * m;
      if (Number.isFinite(v)) { x[`slot:${slot}:${k}`] = v; x[`equipment.sum:${k}`] = (x[`equipment.sum:${k}`] || 0) + v; }
    }
  }
  plan.abilityOrder.abilities.forEach((a, i) => {
    if (!a) return;
    x[`skill:${a.hrid}`] = a.level || 1;
    x[`order:${i}:${a.hrid}`] = a.level || 1;
  });
  return x;
}

function leaf(rows) {
  const n = rows.reduce((s, r) => s + r.n, 0), w = rows.reduce((s, r) => s + r.w, 0);
  return { p: (w + 0.5) / (n + 1), n };
}
function impurity(rows) {
  const { p } = leaf(rows);
  return rows.reduce((s, r) => s + r.n * (r.w / r.n - p) ** 2, 0);
}
export function trainForest(rows, seed = 1, treeCount = 16) {
  const began = performance.now();
  rows = rows.filter(r => r.n > 0 && r.w >= 0 && r.w <= r.n);
  const rng = randomGenerator(seed);
  const features = [...new Set(rows.flatMap(r => Object.keys(r.x)))];
  function grow(data, depth) {
    if (depth >= 7 || data.length < 6 || !features.length) return leaf(data);
    let best = null;
    // Always consider level; other splits explore item identities and stats.
    const choices = ['monster.level', ...Array.from({ length: 24 }, () => features[Math.floor(rng() * features.length)])];
    for (const key of choices) {
      const a = data[Math.floor(rng() * data.length)].x[key] || 0;
      const b = data[Math.floor(rng() * data.length)].x[key] || 0;
      const threshold = a === b ? a : Math.min(a, b) + rng() * Math.abs(b - a);
      const left = [], right = [];
      for (const r of data) ((r.x[key] || 0) <= threshold ? left : right).push(r);
      if (left.length < 2 || right.length < 2) continue;
      const loss = impurity(left) + impurity(right);
      if (!best || loss < best.loss) best = { key, threshold, left, right, loss };
    }
    // Allow zero immediate gain: later splits can discover XOR-like synergies.
    if (!best) return leaf(data);
    return { key: best.key, threshold: best.threshold, left: grow(best.left, depth + 1), right: grow(best.right, depth + 1) };
  }
  const model = { schema: 1, samples: rows.length, trees: rows.length ? Array.from({ length: treeCount }, () => grow(Array.from({ length: rows.length }, () => rows[Math.floor(rng() * rows.length)]), 0)) : [] };
  model.trainingMilliseconds = performance.now() - began;
  return model;
}
export function predictForest(model, x) {
  const ps = (model?.trees || []).map(tree => {
    let node = tree;
    while (node.key) node = (x[node.key] || 0) <= node.threshold ? node.left : node.right;
    return node.p;
  });
  if (!ps.length) return { mean: 0.5, disagreement: 0.5 };
  const mean = ps.reduce((s, p) => s + p, 0) / ps.length;
  return { mean, disagreement: Math.sqrt(ps.reduce((s, p) => s + (p - mean) ** 2, 0) / ps.length) };
}

export class ModelTrainer {
  constructor() {
    this.worker = typeof Worker === 'function' ? new Worker(new URL('./learning-worker.js', import.meta.url), { type: 'module' }) : null;
  }
  async train(rows, seed) {
    if (!this.worker) return trainForest(rows, seed);
    return new Promise((resolve, reject) => {
      this.worker.onmessage = e => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.model);
      this.worker.onerror = e => reject(new Error(e.message || '学习模型训练失败'));
      this.worker.postMessage({ rows, seed });
    });
  }
  close() { this.worker?.terminate(); }
}
