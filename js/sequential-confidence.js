// Chernoff/KL one-sided bounds with alpha spending over scheduled looks.
// sum_{look>=1} 1/(look*(look+1))=1. This remains valid under optional stopping.
export function binaryKL(q, p) {
  if (p <= 0) return q === 0 ? 0 : Infinity;
  if (p >= 1) return q === 1 ? 0 : Infinity;
  return (q ? q * Math.log(q / p) : 0) + (q < 1 ? (1 - q) * Math.log((1 - q) / (1 - p)) : 0);
}
export function sequentialInterval(wins, n, look = 1, alpha = 0.05) {
  if (!Number.isInteger(n) || n < 0 || !Number.isInteger(wins) || wins < 0 || wins > n || !(alpha > 0 && alpha < 1) || !Number.isInteger(look) || look < 1) throw new Error('无效的统计参数');
  if (!n) return { lower: 0, upper: 1 };
  const q = wins / n, bound = Math.log(2 * look * (look + 1) / alpha) / n;
  let lo = 0, hi = q;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (binaryKL(q, m) > bound) lo = m; else hi = m; }
  const lower = q === 0 ? 0 : hi;
  lo = q; hi = 1;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (binaryKL(q, m) > bound) hi = m; else lo = m; }
  return { lower, upper: q === 1 ? 1 : lo };
}
