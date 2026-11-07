// Decides WHAT the next video is about. Pure functions so they can be tested.
//
// Category and format are chosen by a simple bandit: mostly pick what has
// performed best so far (views per video, relative to the channel average),
// sometimes explore something else so new ideas get a chance. With no data
// yet, everything is equally likely.

function weightedPick(items, weightOf, rand) {
  const weights = items.map((it) => Math.max(0.05, weightOf(it)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * scores: { categories: { key: { score } }, formats: { key: { score } } }
 * where score is "views relative to channel average" (1 = average). Missing = unknown.
 */
export function pickPlan(cfg, scores = {}, history = [], rand = Math.random) {
  const explore = rand() < (cfg.picker?.exploreRate ?? 0.25);
  const catScore = (c) => scores.categories?.[c.key]?.score;
  const fmtScore = (f) => scores.formats?.[f.key]?.score;

  // Unknown things get a slightly optimistic weight so they get tried.
  // A category's configured `weight` is a standing multiplier (trending = more often).
  const weightOf = (s, base = 1) => base * (typeof s === "number" ? s * s : 1.2);

  // Don't repeat the same category as the last video unless it is the only one.
  const last = history.length ? history[history.length - 1] : null;
  const cats = cfg.categories.filter((c) => cfg.categories.length === 1 || c.key !== last?.category);

  const category = explore ? cats[Math.floor(rand() * cats.length)] : weightedPick(cats, (c) => weightOf(catScore(c), c.weight ?? 1), rand);
  const format = explore
    ? cfg.formats[Math.floor(rand() * cfg.formats.length)]
    : weightedPick(cfg.formats, (f) => weightOf(fmtScore(f)), rand);

  const avoid = cfg.picker?.avoidRepeatTopics ?? 80;
  const usedTopics = history
    .slice(-avoid)
    .map((h) => h.topic)
    .filter(Boolean);

  // Seeds the LLM has not used yet come first; it may also invent its own.
  const usedLower = new Set(usedTopics.map((t) => t.toLowerCase()));
  const freshSeeds = (category.seeds || []).filter((s) => !usedLower.has(s.toLowerCase()));

  return { category, format, usedTopics, freshSeeds, explored: explore };
}

/** Rebuilds category/format scores from history entries that have view counts. */
export function computeScores(history, recentWindow = 60, mode = null) {
  const withViews = history
    .filter((h) => h.status === "uploaded" && typeof h.stats?.views === "number" && (!mode || (h.mode || "facts") === mode))
    .slice(-recentWindow);
  const out = { categories: {}, formats: {}, videosCounted: withViews.length, updatedAt: new Date().toISOString() };
  if (withViews.length < 3) return out; // too little to learn from

  const mean = withViews.reduce((a, h) => a + h.stats.views, 0) / withViews.length;
  if (!(mean > 0)) return out;

  const group = (key) => {
    const buckets = {};
    for (const h of withViews) {
      const k = h[key];
      if (!k) continue;
      (buckets[k] ||= []).push(h);
    }
    const res = {};
    for (const [k, items] of Object.entries(buckets)) {
      const avgViews = items.reduce((a, h) => a + h.stats.views, 0) / items.length;
      const avgPct = items.filter((h) => typeof h.stats.avgViewPct === "number");
      res[k] = {
        videos: items.length,
        avgViews: Math.round(avgViews),
        avgViewPct: avgPct.length ? +(avgPct.reduce((a, h) => a + h.stats.avgViewPct, 0) / avgPct.length).toFixed(1) : null,
        // Shrink towards 1 when there are few samples so one lucky video doesn't dominate.
        score: +((avgViews / mean) * (items.length / (items.length + 2)) + 1 * (2 / (items.length + 2))).toFixed(3),
      };
    }
    return res;
  };
  out.categories = group("category");
  out.formats = group("format");
  return out;
}
