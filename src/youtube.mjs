// YouTube Data API v3 (upload, stats) and YouTube Analytics API (retention).
import fs from "node:fs";
import { google } from "googleapis";
import { env } from "./config.mjs";
import { log } from "./log.mjs";

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export function hasYouTubeCreds() {
  return !!(env("YT_CLIENT_ID") && env("YT_CLIENT_SECRET") && env("YT_REFRESH_TOKEN"));
}

export function oauthClient() {
  if (!hasYouTubeCreds()) throw new Error("YT_CLIENT_ID, YT_CLIENT_SECRET and YT_REFRESH_TOKEN are required (run: npm run auth)");
  const client = new google.auth.OAuth2(env("YT_CLIENT_ID"), env("YT_CLIENT_SECRET"), "http://127.0.0.1:8787/");
  client.setCredentials({ refresh_token: env("YT_REFRESH_TOKEN") });
  return client;
}

/** Title max 100 chars, no angle brackets (YouTube rejects them). */
export function cleanTitle(title, suffix = "") {
  let t = String(title || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const max = 100 - suffix.length;
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t + suffix;
}

export function buildDescription(script, cfg) {
  const tags = [...new Set([...(cfg.publish?.hashtags || []), ...script.tags.slice(0, 4).map((t) => "#" + t.replace(/\s+/g, "").toLowerCase())])];
  return [script.description.replace(/[<>]/g, "").trim(), "", tags.join(" ")].join("\n").slice(0, 4900);
}

export async function uploadVideo({ file, title, description, tags, cfg, publishAt }) {
  const auth = oauthClient();
  const youtube = google.youtube({ version: "v3", auth });
  const privacy = publishAt ? "private" : cfg.publish?.privacy || "public";
  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    notifySubscribers: true,
    requestBody: {
      snippet: {
        title,
        description,
        tags: tags.slice(0, 30),
        categoryId: cfg.publish?.categoryId || "27",
        defaultLanguage: cfg.channel.language || "hi",
        defaultAudioLanguage: cfg.channel.language || "hi",
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: !!cfg.publish?.madeForKids,
        ...(publishAt ? { publishAt } : {}),
      },
    },
    media: { body: fs.createReadStream(file) },
  });
  const id = res.data.id;
  if (!id) throw new Error("YouTube returned no video id");
  const url = `https://youtube.com/shorts/${id}`;
  log(`uploaded ${url} (${privacy}${publishAt ? ", scheduled " + publishAt : ""})`);
  return { videoId: id, url, privacy };
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** views/likes/comments per video id from the Data API. */
export async function fetchStats(videoIds) {
  const youtube = google.youtube({ version: "v3", auth: oauthClient() });
  const out = {};
  for (const ids of chunk(videoIds, 50)) {
    const res = await youtube.videos.list({ part: ["statistics", "status"], id: ids });
    for (const v of res.data.items || []) {
      out[v.id] = {
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0),
        privacy: v.status?.privacyStatus,
        uploadStatus: v.status?.uploadStatus,
      };
    }
  }
  return out;
}

/** Average view percentage etc. per video from the Analytics API (needs the analytics scope). */
export async function fetchRetention(videoIds, startDate) {
  const analytics = google.youtubeAnalytics({ version: "v2", auth: oauthClient() });
  const out = {};
  const endDate = new Date().toISOString().slice(0, 10);
  for (const ids of chunk(videoIds, 50)) {
    const res = await analytics.reports.query({
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: "views,averageViewPercentage,averageViewDuration,likes,shares,subscribersGained",
      dimensions: "video",
      filters: `video==${ids.join(",")}`,
      maxResults: 50,
    });
    const cols = (res.data.columnHeaders || []).map((h) => h.name);
    for (const row of res.data.rows || []) {
      const rec = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
      out[rec.video] = {
        avgViewPct: Number(rec.averageViewPercentage),
        avgViewSec: Number(rec.averageViewDuration),
        shares: Number(rec.shares || 0),
        subsGained: Number(rec.subscribersGained || 0),
      };
    }
  }
  return out;
}

export async function channelInfo() {
  const youtube = google.youtube({ version: "v3", auth: oauthClient() });
  const res = await youtube.channels.list({ part: ["snippet", "statistics"], mine: true });
  const ch = res.data.items?.[0];
  if (!ch) return null;
  return { id: ch.id, title: ch.snippet?.title, subscribers: Number(ch.statistics?.subscriberCount || 0), videos: Number(ch.statistics?.videoCount || 0) };
}
