// Writes the script with an LLM. Groq first (same key the main app uses),
// Gemini as fallback. Returns a validated, normalised script object:
// { topic, hook, lines: [{ text, visual }], cta, title, description, tags, keywords }
import { env, MOCK } from "./config.mjs";
import { log } from "./log.mjs";
import { groqCandidates, geminiCandidates, modelHintFromError } from "./models.mjs";

export function buildPrompt({ cfg, plan, maxWords, minWords, feedback }) {
  const { category, format, usedTopics, freshSeeds } = plan;
  const seeds = freshSeeds.slice(0, plan.trending ? 15 : 6).map((s) => `- ${s}`).join("\n") || "- (invent your own)";
  const brief = plan.trending
    ? `Category: TRENDING NOW. These are the top searches in India right now:
${seeds}
Pick the ONE trend you can make a genuinely interesting 30-second video about: what it is, why everyone is searching it today, and one fact most people don't know. Prefer entertainment, sport, tech, science, festivals and feel-good news. Skip anything about a death, crime, accident, religion dispute or politics. If a trend is a person, talk about their work, not their private life.`
    : `Category: ${category.label}
Pick ONE specific topic. Ideas you may use (or invent a better one in this category):
${seeds}`;
  const avoid = usedTopics.slice(-40).map((s) => `- ${s}`).join("\n") || "- (none yet)";
  return `You write YouTube Shorts scripts that get watched to the end. Channel: "${cfg.channel.name}".
Niche: ${cfg.channel.niche}.
Audience: ${cfg.channel.audience}.
Spoken language: ${cfg.channel.languageName}.

TODAY'S BRIEF
${brief}
Format: ${format.label}. Structure: ${format.structure}
Topics already covered, do NOT repeat or rephrase these:
${avoid}

RULES THAT DECIDE IF PEOPLE KEEP WATCHING
1. The hook is the first spoken sentence. Max 12 words. It must create a question in the viewer's head or state something that sounds impossible. Proven patterns: a shocking number ("हर साल 3 लाख लोग..."), a direct challenge ("99% लोग ये गलत करते हैं"), a forbidden-sounding claim ("ये बात आपको कोई नहीं बताएगा"), or a contradiction ("गरम पानी ठंडे से पहले जमता है"). Never start with a greeting, "aaj hum", "is video mein", "kya aap jaante hain" or any intro.
2. Short sentences. One idea per sentence. Concrete numbers, names and places beat adjectives.
3. Total spoken words between ${minWords} and ${maxWords} (count every word). This is a 30 second video.
4. Every claim must be true and checkable. If unsure, choose a different topic.
5. End with "cta": one short line (max 8 words) that asks to follow for more, phrased naturally.
6. Write spoken text in Devanagari script. Keep English words that Indians normally say in English (bank, phone, UPI, scientist) as plain English in Latin script inside the Hindi sentence. Never romanise Hindi.
7. No emojis in spoken text.

OUTPUT: a single JSON object, nothing else:
{
  "topic": "one line in English describing the specific topic",
  "hook": "first spoken sentence",
  "lines": [ { "text": "next spoken sentence(s), 8-20 words", "visual": "3-5 literal English words to search stock footage for this moment, e.g. 'indian railway station crowd'" }, ... 3 to 7 items ... ],
  "cta": "final spoken line",
  "onscreen_title": "3 to 6 words shown as a bold banner at the top of the video for its whole length, Hindi in Devanagari or Hinglish, no punctuation except ? or !, written to stop the scroll",
  "title": "YouTube title in Hinglish (Latin script), max 60 characters, curiosity gap, no clickbait lies, no quotes",
  "description": "2 short lines in Hinglish for the description, then the single most relevant hashtag",
  "tags": ["8 to 12 tags, mix of Hindi, Hinglish and English, no # symbol"],
  "keywords": ["3 to 5 English words that describe the overall visual theme"]
}${feedback ? `\n\nYour previous attempt was rejected: ${feedback}. Fix that and answer again.` : ""}`;
}

const wordCount = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;

const WEAK_OPENERS = [
  /^(क्या आप(को|ने)? ?(सच में |कभी )?(जानते|जानती|पता|विश्वास करेंगे|मानेंगे|सोच सकते)( हैं| है| हो)?( कि| की)?[,!?]?\s*)/u,
  /^(kya aap(ko)? ?(jaante|jante|pata|vishwas karenge)( hain| hai| ho)?( ki)?[,!?]?\s*)/iu,
  /^((aaj hum|आज हम|is video (mein|me)|इस वीडियो में|नमस्ते( दोस्तों)?|hello( friends| doston)?|दोस्तों)[,!]?\s*)/iu,
];

/** "क्या आप जानते हैं कि X" -> "X". Exported for tests. */
export function stripWeakOpener(hook) {
  let h = String(hook || "").trim();
  for (let i = 0; i < 2; i++) for (const re of WEAK_OPENERS) h = h.replace(re, "").trim();
  if (h && /[\u0900-\u097F]/.test(h) === false) h = h.charAt(0).toUpperCase() + h.slice(1);
  return h;
}

const normLine = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Removes lines that repeat the hook or the previous line (models do this). */
export function dedupeLines(hook, lines) {
  const seen = new Set([normLine(hook)].filter(Boolean));
  const out = [];
  for (const l of lines) {
    const n = normLine(l.text);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(l);
  }
  return out;
}

/** Prompt for "rhymes" mode: an original or public-domain nursery rhyme with scene descriptions. */
export function buildRhymePrompt({ cfg, plan, maxWords, minWords, feedback, lang }) {
  const { category, format, usedTopics, freshSeeds } = plan;
  const seeds = freshSeeds.slice(0, 8).map((s) => `- ${s}`).join("\n") || "- (invent your own)";
  const avoid = usedTopics.slice(-40).map((s) => `- ${s}`).join("\n") || "- (none yet)";
  const hindi = lang === "hi";
  return `You write nursery rhymes for a children's YouTube channel called "${cfg.channel.name}".
Channel: ${cfg.channel.niche}.
Audience: ${cfg.channel.audience}.
Language of the lyrics: ${hindi ? "simple Hindi in Devanagari script, words a 3-year-old Indian child knows" : cfg.channel.languageName}.

TODAY'S BRIEF
Category: ${category.label}
Format: ${format.label}. Structure: ${format.structure}
${category.strictSeeds ? "Pick ONE rhyme from this list, exactly as named (no invented rhymes in this category):" : "Pick ONE rhyme. Ideas (or invent a better one in this category):"}
${seeds}
Already made, do NOT repeat these:
${avoid}

LYRICS RULES
1. For a classic rhyme, use ONLY the traditional public-domain words everyone knows. Never copy a modern channel's rewritten version, added verses or branded characters. You may shorten it to fit.
2. For an original rhyme, write fresh lyrics. Rhyming couplets (AABB), 4 to 8 words per line, lots of repetition, one simple idea per line.
3. ${minWords} to ${maxWords} words in total across all lines. 8 to 16 lines. This is a ${cfg.video.targetSeconds}-second video.
4. Happy, gentle, safe. No fear, no violence, no food brands, no celebrities, no screens.
5. The first line must be the catchiest line, usually the chorus.

VISUAL RULES
6. "characters": ONE sentence describing 1 or 2 recurring cartoon characters in detail (species or child, age, hair, skin, clothes with exact colours, one accessory). The same sentence is reused for every scene so they look the same.
7. "setting": one sentence describing the place and time of day, with colours.
8. Each line gets "visual": what is happening in that moment, 10 to 20 words, naming the characters exactly as in "characters", concrete and drawable. No text or letters in the picture.

OUTPUT: a single JSON object, nothing else:
{
  "topic": "name of the rhyme in English",
  "title": "YouTube title, max 45 characters, the rhyme's name plus a tiny hook, e.g. 'Wheels on the Bus | Fun Bus Ride Song'",
  "onscreen_title": "2 to 5 words shown in a banner at the top, e.g. 'Wheels on the Bus'",
  "characters": "one sentence",
  "setting": "one sentence",
  "lines": [ { "text": "one sung line", "visual": "scene for this line" }, ... ],
  "description": "two short friendly lines for parents, then one hashtag",
  "tags": ["10 to 14 tags such as nursery rhymes, kids songs, baby songs, toddler songs, the rhyme's name, cartoon for kids, learning for kids"]
}${feedback ? `\n\nYour previous attempt was rejected: ${feedback}. Fix that and answer again.` : ""}`;
}

export function validateRhyme(raw, { minWords, maxWords, lang }) {
  if (!raw || typeof raw !== "object") return { error: "not a JSON object" };
  const lines = Array.isArray(raw.lines)
    ? raw.lines.map((l) => ({ text: String(l?.text || "").replace(/\s+/g, " ").trim(), visual: String(l?.visual || "").trim() })).filter((l) => l.text)
    : [];
  const s = {
    kind: "rhyme",
    topic: String(raw.topic || "").trim(),
    title: String(raw.title || "").replace(/["“”]/g, "").trim(),
    onscreenTitle: String(raw.onscreen_title || "").replace(/["“”]/g, "").replace(/\s+/g, " ").trim().slice(0, 40),
    characters: String(raw.characters || "").trim(),
    setting: String(raw.setting || "").trim(),
    lines: lines.map((l) => ({ ...l, visual: l.visual || l.text })),
    hook: lines[0]?.text || "",
    cta: "",
    description: String(raw.description || "").trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, 15) : [],
    keywords: ["cartoon", "kids"],
  };
  if (!s.topic) return { error: "missing topic" };
  if (!s.title) return { error: "missing title" };
  if (s.lines.length < 6) return { error: "fewer than 8 lines" };
  if (s.lines.length > 20) return { error: "more than 16 lines" };
  if (!s.characters) return { error: "missing characters description" };
  const total = s.lines.reduce((a, l) => a + wordCount(l.text), 0);
  if (total < minWords * 0.75) return { error: `only ${total} words, need at least ${minWords}` };
  if (total > maxWords * 1.15) return { error: `${total} words, maximum is ${maxWords}` };
  const spoken = s.lines.map((l) => l.text).join(" ");
  if (lang === "hi" && !/[\u0900-\u097F]/.test(spoken)) return { error: "lyrics must be in Devanagari script" };
  if (lang !== "hi" && /[\u0900-\u097F]/.test(spoken)) return { error: "lyrics must be in English" };
  if (!s.onscreenTitle) s.onscreenTitle = s.topic.slice(0, 40);
  if (s.title.length > 60) s.title = s.title.slice(0, 57).trimEnd() + "...";
  s.wordCount = total;
  return { script: s };
}

export const MOCK_RHYME = {
  topic: "mock: The Little Red Bus",
  title: "The Little Red Bus | Beep Beep Song",
  onscreen_title: "The Little Red Bus",
  characters: "Bunny, a small white rabbit toddler with long floppy ears, big blue eyes, a yellow t-shirt and red shorts.",
  setting: "A sunny green park with a smooth grey road, fluffy white clouds and a bright blue sky.",
  lines: [
    { text: "The little red bus goes beep beep beep,", visual: "Bunny waves at a smiling little red bus driving along the grey road under a blue sky" },
    { text: "beep beep beep, beep beep beep.", visual: "close up of the little red bus honking, with musical notes floating in the air" },
    { text: "The little red bus goes beep beep beep,", visual: "Bunny climbs the steps of the little red bus, holding the yellow rail" },
    { text: "all around the town.", visual: "the little red bus drives past colourful houses and a tall green tree" },
    { text: "The wheels on the bus go round and round,", visual: "big black wheels of the red bus spinning on the road, Bunny looking out of the window" },
    { text: "round and round, round and round.", visual: "the bus turning a corner past a pink flower garden" },
    { text: "The wheels on the bus go round and round,", visual: "Bunny clapping happily on the bus seat" },
    { text: "all around the town.", visual: "the red bus arriving at a small blue bus stop while the sun shines" },
  ],
  description: "Sing along with Bunny on the little red bus!\nA happy rhyme for toddlers.\n#nurseryrhymes",
  tags: ["nursery rhymes", "kids songs", "baby songs", "bus song", "toddler songs", "cartoon for kids", "wheels on the bus", "sing along"],
};

export function validateScript(raw, { minWords, maxWords }) {
  if (!raw || typeof raw !== "object") return { error: "not a JSON object" };
  const s = {
    topic: String(raw.topic || "").trim(),
    hook: String(raw.hook || "").trim(),
    lines: Array.isArray(raw.lines)
      ? raw.lines
          .map((l) => ({ text: String(l?.text || "").trim(), visual: String(l?.visual || "").trim() }))
          .filter((l) => l.text)
      : [],
    cta: String(raw.cta || "").trim(),
    onscreenTitle: String(raw.onscreen_title || raw.onscreenTitle || "").replace(/["“”]/g, "").replace(/\s+/g, " ").trim().slice(0, 48),
    title: String(raw.title || "").replace(/["“”]/g, "").trim(),
    description: String(raw.description || "").trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, 15) : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 6) : [],
  };
  if (!s.topic) return { error: "missing topic" };
  if (!s.hook) return { error: "missing hook" };
  s.lines = dedupeLines(s.hook, s.lines);
  if (wordCount(s.hook) > 16) return { error: "hook longer than 12 words" };
  // The weak openers the prompt bans; the model still slips them in sometimes.
  // Strip them instead of failing the run; reject only if nothing is left.
  s.hook = stripWeakOpener(s.hook);
  if (!s.hook || wordCount(s.hook) < 3) return { error: "hook was only a filler opener; start with the shocking claim itself" };
  if (s.lines.length < 2) return { error: "fewer than 3 lines" };
  if (!s.cta) return { error: "missing cta" };
  if (!s.title) return { error: "missing title" };
  const total = wordCount(s.hook) + s.lines.reduce((a, l) => a + wordCount(l.text), 0) + wordCount(s.cta);
  if (total < minWords * 0.8) return { error: `only ${total} spoken words, need at least ${minWords}` };
  if (total > maxWords * 1.15) return { error: `${total} spoken words, maximum is ${maxWords}` };
  // Hindi check: at least some Devanagari in the spoken text.
  const spoken = [s.hook, ...s.lines.map((l) => l.text), s.cta].join(" ");
  if (!/[ऀ-ॿ]/.test(spoken)) return { error: "spoken text must be in Devanagari script" };
  if (s.title.length > 70) s.title = s.title.slice(0, 67).trimEnd() + "...";
  s.wordCount = total;
  return { script: s };
}

/** All spoken sentences in order: hook, lines, cta (a rhyme is just its lines). */
export function spokenLines(script) {
  if (script.kind === "rhyme") return script.lines.map((l) => ({ ...l }));
  return [
    { text: script.hook, visual: script.lines[0]?.visual || script.keywords.join(" ") },
    ...script.lines,
    { text: script.cta, visual: script.keywords.join(" ") || script.lines[script.lines.length - 1]?.visual || "" },
  ];
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(cleaned.slice(a, b + 1));
    } catch {}
  }
  return null;
}

async function groqOnce(key, model, prompt, strictJson) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      max_tokens: 4000,
      // gpt-oss spends tokens on reasoning; keep that short so the JSON fits.
      ...(/gpt-oss/i.test(model) ? { reasoning_effort: "low" } : {}),
      ...(strictJson ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: "You output exactly one JSON object and nothing else: no prose, no markdown fences, no comments." },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.json().catch(() => null);
  return { res, body };
}

async function callGroq(prompt) {
  const key = env("GROQ_API_KEY");
  if (!key) return null;
  let lastErr = "";
  const models = await groqCandidates();
  for (const model of models) {
    // Plain mode first (gpt-oss trips Groq's strict JSON validator often); strict mode as the retry.
    for (const strict of [false, true]) {
      const { res, body } = await groqOnce(key, model, prompt, strict);
      if (res.ok) {
        const json = extractJson(body?.choices?.[0]?.message?.content);
        if (json) return json;
        lastErr = "Groq returned no JSON";
        continue;
      }
      lastErr = body?.error?.message || `Groq ${res.status}`;
      log(`Groq ${model}${strict ? "" : " (plain)"} failed: ${lastErr.slice(0, 160)}`);
      if (res.status === 401) throw new Error(lastErr);
      if (!/json/i.test(lastErr)) break; // model missing, rate limit, etc: next model
    }
  }
  throw new Error(lastErr || "Groq failed");
}

async function callGemini(prompt) {
  const key = env("GEMINI_API_KEY");
  if (!key) return null;
  let lastErr = "";
  const models = await geminiCandidates("text");
  for (let i = 0; i < models.length && i < 8; i++) {
    const model = models[i];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, responseMimeType: "application/json", maxOutputTokens: 2000 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
      const json = extractJson(text);
      if (json) return json;
      lastErr = "Gemini returned no JSON";
      continue;
    }
    lastErr = body?.error?.message || `Gemini ${res.status}`;
    log(`Gemini ${model} failed: ${lastErr.slice(0, 160)}`);
    // "use models/gemini-x" in the error: try that one next.
    const hint = modelHintFromError(lastErr);
    if (hint && !models.includes(hint)) models.splice(i + 1, 0, hint);
  }
  throw new Error(lastErr || "Gemini failed");
}

async function askLLM(prompt) {
  const errors = [];
  for (const fn of [callGroq, callGemini]) {
    try {
      const out = await fn(prompt);
      if (out) return out;
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`No LLM available. ${errors.join(" | ") || "Set GROQ_API_KEY or GEMINI_API_KEY."}`);
}

export const MOCK_SCRIPT = {
  topic: "mock: why UPI makes you spend more than cash",
  hook: "UPI से पैसे देना आपको हर महीने गरीब बना रहा है।",
  lines: [
    { text: "Research कहती है, cash देते समय दिमाग में हल्का सा दर्द महसूस होता है।", visual: "hand paying cash rupees" },
    { text: "इसे कहते हैं pain of paying। यही दर्द हमें रोकता है।", visual: "brain neurons animation" },
    { text: "UPI में सिर्फ एक tap है। दर्द गायब, और खर्च बीस percent तक बढ़ जाता है।", visual: "phone upi payment scan qr" },
    { text: "Trick simple है। हर payment से पहले amount को ज़ोर से बोलो।", visual: "person thinking with phone" },
  ],
  cta: "ऐसे facts रोज़ चाहिए तो follow करो।",
  onscreen_title: "UPI आपको गरीब बना रहा है?",
  title: "UPI se paisa jaldi kyu khatam hota hai?",
  description: "Cash vs UPI: dimaag ka chhota sa trick jo aapka kharcha badha deta hai.\nRoz ek naya fact.\n#paisa",
  tags: ["upi", "paise kaise bachaye", "money facts hindi", "psychology facts", "savings tips", "finance hindi", "facts", "shorts"],
  keywords: ["mobile payment", "money", "india"],
};

/**
 * Generates a script for the plan. Retries once with the validation error as
 * feedback. `maxWords` can be lowered by the caller when the voice ran long.
 */
export async function writeScript({ cfg, plan, maxWords, minWords, lang }) {
  const rhymes = cfg.mode === "rhymes";
  const bounds = { minWords, maxWords, lang: lang || cfg.channel.language };
  const validate = rhymes ? validateRhyme : validateScript;
  if (MOCK()) {
    const v = validate(rhymes ? MOCK_RHYME : MOCK_SCRIPT, bounds);
    if (v.error) throw new Error(`mock script invalid: ${v.error}`);
    return v.script;
  }
  let feedback = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = rhymes ? buildRhymePrompt({ cfg, plan, maxWords, minWords, feedback, lang: bounds.lang }) : buildPrompt({ cfg, plan, maxWords, minWords, feedback });
    const raw = await askLLM(prompt);
    const v = validate(raw, bounds);
    if (!v.error) return v.script;
    log(`script attempt ${attempt} rejected: ${v.error}`);
    feedback = v.error;
  }
  throw new Error(`Could not get a valid script after 3 attempts (${feedback})`);
}
