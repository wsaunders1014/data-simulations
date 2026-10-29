// Seeded PRNG (mulberry32) plus a few distribution helpers.
// Same SEED => same simulated world, which makes front-end bugs reproducible.

function createRng(seed = 42) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Standard normal via Box-Muller
  rng.gauss = () => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };

  // Number of events in an interval with expected count `lambda`
  rng.poisson = (lambda) => {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.gauss()));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng();
    } while (p > L);
    return k - 1;
  };

  rng.int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.weighted = (items, weightOf) => {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let r = rng() * total;
    for (const it of items) {
      r -= weightOf(it);
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  };
  rng.hex = (len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += Math.floor(rng() * 16).toString(16);
    return s;
  };

  return rng;
}

module.exports = { createRng };
