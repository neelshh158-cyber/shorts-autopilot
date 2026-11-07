// Tiny logger: timestamps, and a step() helper that times a stage.
const t0 = Date.now();

export function log(...args) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[${s}s]`, ...args);
}

export async function step(name, fn) {
  log(`▶ ${name}`);
  const start = Date.now();
  try {
    const out = await fn();
    log(`✔ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return out;
  } catch (e) {
    log(`✖ ${name}: ${e?.message || e}`);
    throw e;
  }
}
