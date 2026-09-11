// P(Binomial(n,p) <= wins), summed in log space to support extreme probabilities.
export function binomialLowerTail(wins, n, p) {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(wins) || wins < 0 || wins > n || p < 0 || p > 1) throw Error('无效二项参数');
  if (wins === n || p === 0) return 1;
  if (p === 1) return 0;
  let term = n * Math.log1p(-p), sum = term;
  for (let k = 1; k <= wins; k++) {
    term += Math.log(n-k+1)-Math.log(k)+Math.log(p)-Math.log1p(-p);
    const high = Math.max(sum, term);
    sum = high + Math.log1p(Math.exp(Math.min(sum, term)-high));
  }
  return Math.min(1, Math.exp(sum));
}

export function coarseRejected(wins, n, target) {
  const threshold = Math.max(0, target - .02);
  // Strictly below the one-sided 95% exact upper limit, not a point estimate.
  return threshold > 0 && binomialLowerTail(wins, n, threshold) < .05;
}

export function stageStatus(result, target) {
  const wins = result.successes, n = result.trials;
  if (wins + 1e-9 >= target*n) return 'passed';
  if (wins + 1e-9 >= Math.max(0, target-.01)*n) return 'tolerance';
  return 'failed';
}
