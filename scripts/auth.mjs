#!/usr/bin/env node
// One-time: get a YouTube refresh token for the channel. Run this on YOUR
// computer (it opens a browser):  npm run auth
import http from "node:http";
import { google } from "googleapis";
import { loadDotEnv, env } from "../src/config.mjs";
import { SCOPES } from "../src/youtube.mjs";

loadDotEnv();
const clientId = env("YT_CLIENT_ID") || process.argv[2];
const clientSecret = env("YT_CLIENT_SECRET") || process.argv[3];
if (!clientId || !clientSecret) {
  console.error("Usage: YT_CLIENT_ID=... YT_CLIENT_SECRET=... npm run auth   (or put them in shorts/.env)");
  process.exit(1);
}
const PORT = 8787;
const redirect = `http://127.0.0.1:${PORT}/`;
const client = new google.auth.OAuth2(clientId, clientSecret, redirect);
const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  const code = u.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Missing code");
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const yt = google.youtube({ version: "v3", auth: client });
    const ch = (await yt.channels.list({ part: ["snippet"], mine: true })).data.items?.[0];
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<h2>Done. You can close this tab.</h2><p>Channel: ${ch?.snippet?.title || "unknown"}</p>`);
    console.log("\nAuthorised channel:", ch?.snippet?.title || "(unknown)", ch?.id || "");
    if (!tokens.refresh_token) {
      console.log("\nNo refresh token came back. Remove the app's access at https://myaccount.google.com/permissions and run again.");
    } else {
      console.log("\nAdd these to .env and to the GitHub repository secrets:\n");
      console.log(`YT_CLIENT_ID=${clientId}`);
      console.log(`YT_CLIENT_SECRET=${clientSecret}`);
      console.log(`YT_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }
  } catch (e) {
    res.writeHead(500).end("Token exchange failed: " + e.message);
    console.error(e);
  } finally {
    server.close();
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this link in your browser and sign in with the Google account that owns the YouTube channel:\n");
  console.log(url + "\n");
});
