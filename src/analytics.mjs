// Pulls numbers for every uploaded video and turns them into the scores the
// topic picker uses. Safe to run any time; it never throws on missing scopes.
import { readHistory, writeHistory, writePerformance } from "./state.mjs";
import { computeScores } from "./topics.mjs";
import { fetchStats, fetchRetention, hasYouTubeCreds } from "./youtube.mjs";
import { log } from "./log.mjs";

export async function refreshAnalytics(cfg) {
  const history = readHistory();
  const uploaded = history.filter((h) => h.status === "uploaded" && h.videoId);
  if (!uploaded.length) {
    log("analytics: nothing uploaded yet");
    writePerformance(computeScores(history, cfg.picker?.recentWindow, cfg.mode || "facts"));
    return null;
  }
  if (!hasYouTubeCreds()) {
    log("analytics: no YouTube credentials, keeping old numbers");
    return null;
  }
  const ids = uploaded.map((h) => h.videoId);
  const stats = await fetchStats(ids);
  let retention = {};
  try {
    const oldest = uploaded.reduce((a, h) => (h.date < a ? h.date : a), uploaded[0].date).slice(0, 10);
    retention = await fetchRetention(ids, oldest);
  } catch (e) {
    log(`analytics: retention unavailable (${e.message.slice(0, 120)})`);
  }
  const now = new Date().toISOString();
  for (const h of history) {
    if (!h.videoId || !stats[h.videoId]) continue;
    h.stats = { ...(h.stats || {}), ...stats[h.videoId], ...(retention[h.videoId] || {}), at: now };
  }
  writeHistory(history);
  const scores = computeScores(history, cfg.picker?.recentWindow, cfg.mode || "facts");
  writePerformance(scores);

  const totalViews = uploaded.reduce((a, h) => a + (stats[h.videoId]?.views || 0), 0);
  log(`analytics: ${uploaded.length} videos, ${totalViews} views in total`);
  for (const [k, v] of Object.entries(scores.categories || {})) log(`  category ${k}: ${v.videos} videos, avg ${v.avgViews} views${v.avgViewPct != null ? `, ${v.avgViewPct}% watched` : ""}, score ${v.score}`);
  for (const [k, v] of Object.entries(scores.formats || {})) log(`  format ${k}: ${v.videos} videos, avg ${v.avgViews} views, score ${v.score}`);
  return scores;
}
