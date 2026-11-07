// One ffmpeg call: footage segments -> 1080x1920 -> captions -> voice (+ music).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { FONTS_DIR, MUSIC_DIR } from "./config.mjs";
import { log } from "./log.mjs";
import { generateMusic } from "./music.mjs";

// Escapes a path for use inside a filtergraph option value.
const fpath = (p) => p.replace(/\\/g, "/").replace(/([:'\[\],;])/g, "\\$1");

export function pickMusic(dir = MUSIC_DIR, rand = Math.random) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f));
  if (!files.length) return null;
  return path.join(dir, files[Math.floor(rand() * files.length)]);
}

/** A real track from assets/music if any, else a generated one when the config asks for it. */
export function chooseMusic(cfg, workDir, seconds) {
  const real = pickMusic();
  if (real) return real;
  if (!cfg.video?.generateMusic) return null;
  const out = path.join(workDir, "music.wav");
  generateMusic(out, { seconds: seconds + 2, tempo: cfg.video.musicTempo || 104, seed: Math.floor(Math.random() * 1e9) });
  return out;
}

// Ken Burns variants so consecutive scenes don't all do the same thing.
// Each returns a zoompan expression set for `frames` output frames.
const MOTIONS = {
  zoom_in: (f) => ({ z: `1+0.12*on/${f}`, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" }),
  zoom_out: (f) => ({ z: `1.12-0.12*on/${f}`, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" }),
  pan_left: (f) => ({ z: "1.12", x: `(iw-iw/zoom)*(1-on/${f})`, y: "ih/2-(ih/zoom/2)" }),
  pan_right: (f) => ({ z: "1.12", x: `(iw-iw/zoom)*on/${f}`, y: "ih/2-(ih/zoom/2)" }),
  drift_up: (f) => ({ z: `1.08+0.04*on/${f}`, x: "iw/2-(iw/zoom/2)", y: `(ih-ih/zoom)*(1-on/${f})` }),
};
export const MOTION_NAMES = Object.keys(MOTIONS);

/**
 * Builds the ffmpeg argument list. Exported so tests can check it without
 * running ffmpeg.
 */
export function buildFfmpegArgs({ segments, audioPath, assPath, musicPath, outFile, cfg, totalDuration }) {
  const W = cfg.video.width;
  const H = cfg.video.height;
  const FPS = cfg.video.fps;
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-stats"];
  const filters = [];

  segments.forEach((s, i) => {
    const d = s.duration.toFixed(3);
    if (s.kind === "video") {
      args.push("-stream_loop", "-1", "-t", d, "-i", s.path);
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
      );
    } else if (s.kind === "image") {
      const frames = Math.max(1, Math.round(s.duration * FPS));
      const m = (MOTIONS[s.motion] || MOTIONS[MOTION_NAMES[i % MOTION_NAMES.length]])(frames);
      args.push("-loop", "1", "-framerate", String(FPS), "-t", d, "-i", s.path);
      // Scale up first so the motion doesn't jitter, then the Ken Burns move.
      filters.push(
        `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=1:s=${W}x${H}:fps=${FPS},trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
      );
    } else {
      const [c0, c1, c2] = s.colors;
      args.push("-f", "lavfi", "-t", d, "-i", `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:c2=${c2}:nb_colors=3:speed=0.02:rate=${FPS}:seed=${i * 7 + 1}`);
      filters.push(`[${i}:v]trim=duration=${d},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
    }
  });

  const vIn = segments.map((_, i) => `[v${i}]`).join("");
  filters.push(`${vIn}concat=n=${segments.length}:v=1:a=0[vcat]`);
  filters.push(`[vcat]ass='${fpath(assPath)}':fontsdir='${fpath(FONTS_DIR)}'[vout]`);

  const aIdx = segments.length;
  args.push("-i", audioPath);
  let audioOut = "[voice]";
  filters.push(`[${aIdx}:a]aresample=44100,apad=pad_dur=1[voice]`);
  if (musicPath) {
    args.push("-stream_loop", "-1", "-i", musicPath);
    const vol = cfg.video.musicVolume ?? 0.1;
    filters.push(`[${aIdx + 1}:a]aresample=44100,volume=${vol}[music]`);
    filters.push(`[voice][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`);
    audioOut = "[mix]";
  }
  const fadeStart = Math.max(0, totalDuration - 0.6).toFixed(3);
  filters.push(`${audioOut}afade=t=out:st=${fadeStart}:d=0.6[aout]`);

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-t", totalDuration.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
    "-movflags", "+faststart",
    outFile
  );
  return args;
}

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 20000) err = err.slice(-20000);
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${err.trim().split("\n").slice(-12).join("\n")}`))));
  });
}

export async function renderVideo(opts) {
  const args = buildFfmpegArgs(opts);
  log(`ffmpeg: ${opts.segments.length} segments, ${opts.totalDuration.toFixed(1)}s${opts.musicPath ? ", with music" : ""}`);
  await runFfmpeg(args);
  const size = fs.statSync(opts.outFile).size;
  if (size < 50_000) throw new Error(`render produced a suspiciously small file (${size} bytes)`);
  return opts.outFile;
}
