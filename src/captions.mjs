// Word-timed captions as an ASS subtitle file: 2-3 words on screen at a time,
// the word being spoken highlighted. This style keeps eyes on the video and is
// what the best-performing faceless Shorts use.

export function chunkWords(words, { maxWords = 3, maxChars = 20 } = {}) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
    chars = 0;
  };
  for (const w of words) {
    const len = w.text.length;
    if (cur.length && (cur.length >= maxWords || chars + 1 + len > maxChars)) flush();
    cur.push(w);
    chars += (cur.length > 1 ? 1 : 0) + len;
    if (/[।.!?]$/.test(w.text) || (w.punctAfter && /[।.!?]/.test(w.punctAfter))) flush();
  }
  flush();
  return chunks;
}

function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

const escapeAss = (t) => t.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\s+/g, " ").trim();

/**
 * Re-attaches the script's punctuation to the TTS words so captions read
 * naturally (Edge strips it). Both lists are in spoken order.
 */
export function restorePunctuation(words, scriptText) {
  const tokens = scriptText.split(/\s+/).filter(Boolean);
  if (tokens.length !== words.length) return words; // different split; keep TTS text
  return words.map((w, i) => ({ ...w, text: tokens[i] }));
}

export function buildAss({ words, cfg, lang = "hi", width = 1080, height = 1920, title = "", duration = 0 }) {
  const c = cfg.captions || {};
  const font = lang === "hi" ? c.fontHindi || "Noto Sans Devanagari" : c.fontLatin || "Poppins";
  const size = c.fontSize || 78;
  const highlight = c.highlightColor || "&H0000E5FF";
  const textColor = c.textColor || "&H00FFFFFF";
  const outline = c.outlineColor || "&H00000000";
  // Captions sit a bit below centre: clear of the title/handle overlay at the
  // bottom and of the top status bar, where thumbs don't cover them.
  const marginV = Math.round(height * 0.33);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font},${size},${textColor},&H000000FF,${outline},&H96000000,-1,0,0,0,100,100,0,0,1,6,3,2,60,60,${marginV},1
Style: Title,${font},${c.titleFontSize || 60},&H00000000,&H000000FF,${highlight},${highlight},-1,0,0,0,100,100,0,0,3,14,0,8,90,90,${Math.round(height * 0.12)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];
  if (title && duration > 0) {
    // Banner at the top for the whole video: yellow box, black bold text, wraps if long.
    events.push(`Dialogue: 1,${assTime(0)},${assTime(duration)},Title,,0,0,0,,{\\q0\\fad(120,0)}${escapeAss(title)}`);
  }
  const chunks = chunkWords(words, { maxWords: c.maxWordsPerLine || 3, maxChars: c.maxCharsPerLine || 20 });
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    // Never overlap the next group: libass would stack the two and shift one up.
    const nextStart = chunks[ci + 1]?.[0].start ?? Infinity;
    const chunkEnd = Math.min(chunk[chunk.length - 1].end + 0.12, nextStart);
    for (let j = 0; j < chunk.length; j++) {
      const start = chunk[j].start;
      const end = j < chunk.length - 1 ? chunk[j + 1].start : chunkEnd;
      if (end - start < 0.03) continue;
      const text = chunk
        .map((w, k) => {
          const t = escapeAss(w.text);
          return k === j ? `{\\1c${highlight}&\\fscx108\\fscy108}${t}{\\1c${textColor}&\\fscx100\\fscy100}` : t;
        })
        .join(" ");
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,{\\fad(40,0)}${text}`);
    }
  }
  return header + events.join("\n") + "\n";
}
