# Shorts autopilot

A hands-off YouTube Shorts channel, running on GitHub Actions from this repo.
(It lived inside the `aiwrite` repo until November 2026; it moved here so it
gets the unlimited Actions minutes of a public repo.) Two profiles ship here:

- `config.json` (active): **Hindi facts and trending-topics Shorts** for a
  general audience (psychology, money, India, science, Bollywood and cricket,
  what India is searching today). Built for the Shorts feed.
- `config.kids.json`: **cartoon nursery rhymes for toddlers**. Ran for ten
  days in October 2026: 20 Shorts, 17 views, 2 to 4 percent watched. The
  Shorts feed audience swipes kids content away; that format belongs in
  long videos. Run it with `SHORTS_CONFIG=config.kids.json`.

Twice a day a GitHub Actions job:

1. **Picks a topic.** Category and format are chosen by how past videos
   performed (views per video, watch percentage). New ideas still get tried
   about a quarter of the time so the channel keeps learning. One category,
   "trending", pulls today's top Google searches in India and explains one
   of them, which is how the channel rides what people are already looking for.
2. **Writes a 30-second Hindi script** with a hook in the first sentence, short
   lines, concrete facts and a one-line follow prompt at the end.
3. **Voices it** with Gemini's free Hindi voice (Microsoft Edge voices are
   tried first and work locally; ElevenLabs is optional). Word timings for the
   captions come from the provider or from Groq Whisper.
4. **Makes the pictures.** Rhymes: one AI-drawn cartoon scene per line
   (Cloudflare Workers AI free tier, else Gemini's image model, else
   Pollinations, which stopped being free for anonymous use in 2026), with
   the same character description in every prompt so the characters match.
   Facts: Pexels or Pixabay stock video, then AI images. Animated gradients
   are the last resort. Everything is licensed for commercial use.
5. **Renders** 1080x1920 at 30 fps with a bold title banner at the top and
   word-by-word highlighted captions.
6. **Uploads** to your channel through the YouTube Data API.
7. **Logs** the run to `data/history.json` and refreshes `data/performance.json`
   from real YouTube numbers so the next pick is smarter.

Everything the channel has posted and learned lives in `data/`, committed back
by the workflow after each run.

## One-time setup (about 20 minutes)

### 1. Google Cloud project for the YouTube upload

1. Go to https://console.cloud.google.com and create a project (any name).
2. **APIs & Services → Library**: enable **YouTube Data API v3** and
   **YouTube Analytics API**.
3. **APIs & Services → OAuth consent screen**: External, fill in the app name
   and your email, add scopes later is fine. Under **Audience** add your own
   Google account as a test user. Then press **Publish app** so the refresh
   token does not expire after 7 days (an unverified app still works for the
   owner; you just click through the warning once).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Desktop app**. Copy the client ID and secret.

### 2. Get the refresh token (on your own computer, needs a browser)

```bash
npm install
YT_CLIENT_ID=... YT_CLIENT_SECRET=... npm run auth
```

Open the printed link, sign in with the account that owns the channel, allow
the permissions. The terminal prints `YT_REFRESH_TOKEN=...`. If you have a
brand channel, pick it on the account chooser.

### 3. Other keys

| Secret | Needed? | Where |
| --- | --- | --- |
| `GROQ_API_KEY` | yes | script writing and Whisper word timings; you already use it in the main app |
| `GEMINI_API_KEY` | yes on GitHub Actions | the voice (Microsoft's free voice is blocked from GitHub's servers); free at https://aistudio.google.com/apikey |
| `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN` | yes | step 1 and 2 |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN` | recommended for the rhymes profile, free tier | you already have these in Vercel; without them scenes come from Pollinations, which is slower and sometimes busy |
| `PIXABAY_API_KEY` | facts profile, free | sign in at https://pixabay.com then open https://pixabay.com/api/docs/ (the key is shown under "key" in the parameters table) |
| `PEXELS_API_KEY` | optional, free, tried first when set | https://www.pexels.com/api/ (new keys were paused in late 2026) |
| `ELEVENLABS_API_KEY` | optional better voice | set `channel.elevenLabsVoiceId` in `config.json` too |

### 4. Put the secrets in GitHub

Repository → **Settings → Secrets and variables → Actions → New repository
secret**, one per row above. Then **Actions → Shorts autopilot → Run workflow**
with upload = `false` for a dry run. The rendered mp4 is attached to the run
under "Artifacts". When you like it, run again with upload = `true`, or wait
for the schedule.

## Running locally

```bash
cp .env.example .env     # fill in keys
npm install
npm run mock             # no network: canned script, beep voice, gradients
npm run preview          # real script, voice and footage, no upload
npm run run              # the full thing, uploads
npm run analytics        # just refresh the numbers and scores
npm test
```

Finished videos land in `out/`. Add `--keep` to keep the work folder
with the script, voice and subtitle files.

## Tuning for views

Everything editable is in `config.json`:

- `channel.niche`, `audience`, `categories[].seeds`: the brain of the channel.
  Tighter niche = better distribution. Add seeds whenever you see a topic
  working elsewhere. `categories[].weight` is a standing multiplier on how
  often a category is picked (trending is 1.8, history 0.9).
- Why no movie, cartoon or meme clips: they are copyrighted. Content ID
  claims the video and sends the revenue to the owner, and three strikes
  delete the channel. Facts *about* films and cricket are fine, and that
  category is in.
- `channel.geminiVoice`: the Gemini voice. `Puck` (upbeat male), `Charon`
  (informative male), `Kore` (firm female), `Aoede` (bright female) and
  `Fenrir` (excitable male) all handle Hindi well. `channel.voiceStyle` is the
  spoken-style instruction. `channel.ttsOrder` sets which providers to try.
- `channel.voice`: the Edge voice used when Edge is reachable, e.g.
  `hi-IN-MadhurNeural` (male) or `hi-IN-SwaraNeural` (female).
- `video.targetSeconds`: 25 to 35 keeps completion rate high; the picker
  learns from `avgViewPct`, so watch that number in `data/performance.json`.
- `captions.*`: size, colours, words per line.
- `publish.privacy`: set to `private` while testing on the real channel.
- Posting frequency: the two `cron` lines in `.github/workflows/shorts.yml`
  (UTC). Three a day is fine once the first ones look right.

Drop royalty-free music into `assets/music/` to have it mixed quietly under
the voice (see the README there about licences). The rhymes profile has
`video.generateMusic: true`, so when that folder is empty it composes its own
soft music-box track for each video, a different tune every time.

## Kids content: what to know

- Videos are uploaded with `selfDeclaredMadeForKids: true`, which COPPA
  requires. YouTube then serves non-personalised ads only, so revenue per
  view is lower than on general content. Comments are off automatically.
- YouTube removes monetisation from channels that mass-produce near-identical
  AI videos. This pipeline changes the rhyme, characters, setting, voice
  style and music every time, and mixes classic and original rhymes. Keep it
  that way; don't shrink the category list to one rhyme.
- Classic rhymes use traditional public-domain lyrics only. The prompt
  forbids copying a modern channel's rewritten verses or characters.

## What the numbers mean

`data/performance.json` holds a score per category and per format. `1.0` is
the channel average, `2.0` means those videos get double the views. Scores
shrink towards 1 when there are few videos so one lucky hit does not take
over. The picker squares the score when weighting, so good performers win
clearly but nothing is ever excluded.

## Monetisation reality check

The YouTube Partner Program needs 1,000 subscribers plus 10 million public
Shorts views in 90 days (or 4,000 watch hours on long videos). Shorts ad
revenue in India is roughly ₹5 to ₹20 per 10,000 views. The pipeline gives
you volume and consistency; the niche, hooks and thumbnails-free retention
decide the rest. Check the first 10 videos by hand and fix the script prompt
in `src/script.mjs` if the hooks are weak.
