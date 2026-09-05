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

// Mixture likelihood-ratio confidence sequence. The Beta(1/2,1/2)
// mixing distribution is fixed BEFORE sampling, not a fitted Bayesian prior.
function logGamma(z) {
  const c = [676.5203681218851,-1259.1392167224028,771.3234287776531,-176.6150291621406,
    12.507343278686905,-0.13857109526572012,9.984369578019572e-6,1.5056327351493116e-7];
  if(z<.5)return Math.log(Math.PI)-Math.log(Math.sin(Math.PI*z))-logGamma(1-z);
  z--;let x=.99999999999980993;
  for(let i=0;i<c.length;i++)x+=c[i]/(z+i+1);
  const t=z+7.5;return .5*Math.log(2*Math.PI)+(z+.5)*Math.log(t)-t+Math.log(x);
}
export function anytimeInterval(wins,n,alpha=.05) {
  if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(wins)||wins<0||wins>n||!(alpha>0&&alpha<1))throw new Error('无效的统计参数');
  if(!n)return{lower:0,upper:1};
  const base=logGamma(wins+.5)+logGamma(n-wins+.5)-logGamma(n+1)-Math.log(Math.PI);
  const limit=Math.log(1/alpha),q=wins/n;
  const value=p=>base-(wins? wins*Math.log(p):0)-(n-wins?(n-wins)*Math.log1p(-p):0);
  let a=0,b=q;
  for(let i=0;i<60;i++){const m=(a+b)/2;if(value(m)>limit)a=m;else b=m;}
  const lower=wins?b:0;a=q;b=1;
  for(let i=0;i<60;i++){const m=(a+b)/2;if(value(m)>limit)b=m;else a=m;}
  return{lower,upper:wins===n?1:a};
}
