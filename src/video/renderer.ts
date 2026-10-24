import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Font } from "opentype.js";

const require = createRequire(import.meta.url);
// opentype.js is CommonJS whose named exports Node cannot detect, so it is required.
const opentype = require("opentype.js") as typeof import("opentype.js");

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;
export const MARGIN = 96;
export const TEXT_WIDTH = WIDTH - 2 * MARGIN;

const SAMPLE_RATE = 44100;
const AUDIO_ARGS = ["-c:a", "aac", "-ar", String(SAMPLE_RATE), "-ac", "2"];

/**
 * Shared encoding, so every segment can be joined with {@link Renderer.concat} without
 * re-encoding the video.
 */
export const OUTPUT_ARGS = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS),
  ...AUDIO_ARGS,
];

/**
 * Filter chain that centers a landscape picture over a blurred, cropped copy of itself to
 * fill 9:16.
 */
export const FILL_9_16 =
  `split[a][b];` +
  `[a]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=20:2[bg];` +
  `[b]scale=${WIDTH}:-2[fg];` +
  `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;

const TEXT_IN_SECONDS = 0.25;
const TEXT_RISE = 18;
const BEEP_HZ = 520;
const BEEP_LEVEL = 0.1;

export interface RendererOptions {
  /** Font files by key. Text lines and subtitle words name a font by its key. */
  fonts: Record<string, string>;

  /**
   * Color of ink layers and subtitle outlines, in ffmpeg's `0xRRGGBB` form.
   *
   * @default '0x14110D'
   */
  ink?: string;

  /** ffmpeg binary. Defaults to ffmpeg-static when it is installed, else `ffmpeg` on the PATH. */
  ffmpegPath?: string;
}

/** One line of text on a video. */
export interface TextLine {
  text: string;
  font: string;
  size: number;
  color: string;
  /** y of the text's baseline. */
  baseline: number;
  /** @default MARGIN */
  x?: number;
  /** Seconds before the line fades in. A delay of -0.25 has it fully in at the first frame. */
  delay?: number;
  /**
   * Pixels the line rises while it fades in.
   *
   * @default 18
   */
  rise?: number;
  /** [from, to) seconds the line is shown. */
  window?: [number, number];
}

/** Fades the text out over the last `seconds` before `end`. */
export interface FadeOut {
  end: number;
  seconds: number;
}

export interface InkLayerOptions {
  w: number;
  h: number;
  opacity: number;
  duration: number;
  fadeIn?: { start: number; seconds: number } | null;
  fadeOut?: { start: number; seconds: number } | null;
}

/** A word with clip-relative times. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** A word placed on the frame. */
export interface PlacedWord {
  text: string;
  font: string;
  color: string;
  size: number;
  baseline: number;
  x: number;
}

/** One line of subtitles, shown from `start` to `end` (clip-relative seconds). */
export interface SubtitleChunk {
  start: number;
  end: number;
  words: PlacedWord[];
}

export interface SubtitleOptions {
  words: TimedWord[];
  /** Length of the clip; no chunk stays up past it. */
  duration: number;
  font: string;
  color: string;
  /** Per-word font, color or text, such as a highlighted or blanked-out word. */
  style?: (word: TimedWord) => { font?: string; color?: string; text?: string };
  /** @default 56 */
  size?: number;
  /**
   * Below the picture of a 4:3 film (y 1365) and above the apps' bottom UI zone (y 1500).
   *
   * @default 1445
   */
  baseline?: number;
  /** @default 5 */
  maxWords?: number;
  /**
   * Seconds a chunk stays up after its last word when the next one is not right after.
   *
   * @default 0.6
   */
  hold?: number;
  /** @default TEXT_WIDTH */
  maxWidth?: number;
}

export interface ClipOptions {
  clipPath: string;
  /** Seconds into the clip. */
  start: number;
  end: number;
  /** Output is `<name>.mp4` in `workDir`, which also holds the text files ffmpeg reads. */
  workDir: string;
  name: string;
  /**
   * An ink box with text that fades in over the clip and out before it ends; with
   * `fade: false` it is up for the whole clip.
   */
  tag?: {
    box: { x: number; y: number; w: number; h: number; opacity: number };
    lines: TextLine[];
    delay?: number;
    outSeconds?: number;
    fade?: boolean;
  };
  /** A full-width ink band with text, up from the first frame, fading out before the clip ends. */
  hook?: {
    band: { y: number; h: number; opacity: number };
    lines: TextLine[];
    outSeconds: number;
  };
  /**
   * Seconds the first frame is held, silent, before the clip plays. Subtitles and mute
   * windows move with it.
   */
  hold?: number;
  subtitles?: SubtitleChunk[];
  /** [start, end] windows (clip-relative seconds) where the sound is replaced by a beep. */
  mute?: [number, number][];
}

function defaultFfmpeg(): string {
  try {
    return (require("ffmpeg-static") as string | null) ?? "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

const endsSentence = (text: string) => /[.?!]["']?$/.test(text);

/** Renders 1080x1920 reel segments with ffmpeg and joins them. */
export class Renderer {
  readonly ffmpegPath: string;
  readonly ink: string;
  private readonly fontFiles: Record<string, string>;
  private readonly fonts = new Map<string, Font>();

  constructor(options: RendererOptions) {
    this.fontFiles = options.fonts;
    this.ink = options.ink ?? "0x14110D";
    this.ffmpegPath = options.ffmpegPath ?? defaultFfmpeg();
  }

  private spawnFfmpeg(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((done, fail) => {
      const proc = spawn(this.ffmpegPath, ["-hide_banner", ...args], { cwd });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("error", fail);
      proc.on("close", (code) => done({ code, stdout, stderr }));
    });
  }

  /** Runs ffmpeg with `args`, rejecting with the end of its log when it fails. */
  async run(args: string[], cwd?: string): Promise<void> {
    const { code, stderr } = await this.spawnFfmpeg(["-y", ...args], cwd);
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}:\n${stderr.slice(-1500)}`);
  }

  private fontFile(key: string): string {
    const file = this.fontFiles[key];
    if (!file) throw new Error(`No font "${key}"; the fonts are: ${Object.keys(this.fontFiles).join(", ")}`);
    return file;
  }

  private font(key: string): Font {
    let font = this.fonts.get(key);
    if (!font) {
      const bytes = readFileSync(this.fontFile(key));
      font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      this.fonts.set(key, font);
    }
    return font;
  }

  // Absolute font path in the form drawtext accepts on Windows (C\:/...).
  private fontArg(key: string): string {
    return resolve(this.fontFile(key)).replace(/\\/g, "/").replace(/:/g, "\\:");
  }

  textWidth(text: string, font: string, size: number): number {
    return this.font(font).getAdvanceWidth(text, size);
  }

  /** Largest size up to `size` at which the text fits in `maxWidth`. */
  fitSize(text: string, font: string, size: number, maxWidth = TEXT_WIDTH): number {
    const width = this.textWidth(text, font, size);
    return width <= maxWidth ? size : Math.floor((size * maxWidth) / width);
  }

  /** A solid ink layer at `opacity`, as a filter source with optional alpha fades. */
  inkLayer({ w, h, opacity, duration, fadeIn, fadeOut }: InkLayerOptions): string {
    let src = `color=c=${this.ink}:s=${w}x${h}:r=${FPS}:d=${duration},format=rgba,colorchannelmixer=aa=${opacity}`;
    if (fadeIn) src += `,fade=t=in:st=${fadeIn.start}:d=${fadeIn.seconds}:alpha=1`;
    if (fadeOut) src += `,fade=t=out:st=${fadeOut.start}:d=${fadeOut.seconds}:alpha=1`;
    return src;
  }

  /**
   * drawtext filters for `lines`. Each line fades in (rising by `rise` px) from its `delay`;
   * with `out` it fades away before `out.end`. The text goes through files in `workDir`,
   * so it needs no escaping.
   */
  drawTexts(lines: TextLine[], out: FadeOut | null, workDir: string, name: string): string[] {
    return lines.map((line, i) => {
      const { x = MARGIN, baseline, delay = 0, rise = TEXT_RISE, window } = line;
      const p = `clip((t-${delay})/${TEXT_IN_SECONDS},0,1)`;
      const eased = `(${p}*(2-${p}))`;
      const alpha = out ? `${eased}*clip((${out.end}-t)/${out.seconds},0,1)` : eased;
      const y = rise ? `${baseline}-ascent+${rise}*(1-${eased})` : `${baseline}-ascent`;
      return this.drawtext(
        workDir,
        `${name}-line${i}.txt`,
        { ...line, x },
        `y='${y}':alpha='${alpha}'` +
          // Half-open, so lines with back-to-back windows never share a frame.
          (window ? `:enable='gte(t,${window[0]})*lt(t,${window[1]})'` : ""),
      );
    });
  }

  private drawtext(
    workDir: string,
    textFile: string,
    { text, font, size, color, x }: { text: string; font: string; size: number; color: string; x: number },
    rest: string,
  ): string {
    writeFileSync(join(workDir, textFile), text);
    return `drawtext=fontfile='${this.fontArg(font)}':textfile=${textFile}:fontsize=${Math.floor(size)}:fontcolor=${color}:x=${Math.round(x)}:${rest}`;
  }

  /**
   * Splits words into one-line, centered chunks of up to `maxWords`, breaking at sentence
   * ends. A longer sentence is cut into the fewest pieces that fit, differing by at most one
   * word ("I heard you / were in town."), so none is a single leftover word. A piece is split
   * further while it is wider than `maxWidth`.
   */
  subtitleChunks(options: SubtitleOptions): SubtitleChunk[] {
    const { words, duration, font, color, style, size = 56, baseline = 1445, maxWords = 5, hold = 0.6, maxWidth = TEXT_WIDTH } = options;
    const styled = words.map((w) => ({ ...w, font, color, ...style?.(w) }));
    const space = this.textWidth(" ", font, size);
    const width = (ws: typeof styled) =>
      ws.reduce((sum, w) => sum + this.textWidth(w.text, w.font, size), 0) + (ws.length - 1) * space;

    const sentences: (typeof styled)[] = [];
    let current: typeof styled = [];
    for (const word of styled) {
      current.push(word);
      if (endsSentence(word.text)) {
        sentences.push(current);
        current = [];
      }
    }
    if (current.length) sentences.push(current);

    const groups: (typeof styled)[] = [];
    for (const sentence of sentences) {
      let pieces = Math.ceil(sentence.length / maxWords);
      let split: (typeof styled)[];
      do {
        // Pieces differ by at most one word, the earlier ones taking the extra words.
        const share = Math.floor(sentence.length / pieces);
        const extra = sentence.length % pieces;
        split = [];
        for (let i = 0, from = 0; i < pieces; i++) {
          const to = from + share + (i < extra ? 1 : 0);
          split.push(sentence.slice(from, to));
          from = to;
        }
        pieces++;
      } while (split.some((g) => g.length > 1 && width(g) > maxWidth));
      groups.push(...split);
    }

    return groups.map((group, i) => {
      const first = group[0]!;
      const last = group[group.length - 1]!;
      const next = groups[i + 1]?.[0];
      const holdEnd = Math.min(duration, last.end + hold);
      const end = next ? Math.min(next.start, holdEnd) : holdEnd;
      let x = (WIDTH - width(group)) / 2;
      const placed = group.map((w) => {
        const word = { text: w.text, font: w.font, color: w.color, size, baseline, x };
        x += this.textWidth(w.text, w.font, size) + space;
        return word;
      });
      return { start: Math.max(0, first.start), end: Math.max(end, first.start + 0.1), words: placed };
    });
  }

  // Each word is its own drawtext so a word can take another color.
  private drawSubtitles(chunks: SubtitleChunk[], workDir: string, name: string): string[] {
    return chunks.flatMap((chunk, c) =>
      chunk.words.map((word, w) =>
        this.drawtext(
          workDir,
          `${name}-sub${c}-${w}.txt`,
          word,
          `y=${word.baseline}-ascent:borderw=3:bordercolor=${this.ink}@0.85:enable='between(t,${chunk.start.toFixed(3)},${chunk.end.toFixed(3)})'`,
        ),
      ),
    );
  }

  /**
   * Renders `start` to `end` of a clip as a 9:16 segment, with optional tag, hook, subtitles
   * and beeps. Returns the file name in `workDir`.
   */
  async renderClip({ clipPath, start, end, tag, hook, hold = 0, subtitles = [], mute = [], workDir, name }: ClipOptions): Promise<string> {
    const duration = end - start + hold;
    const subs = this.drawSubtitles(subtitles.map((c) => ({ ...c, start: c.start + hold, end: c.end + hold })), workDir, name);
    const withSubs = (chain: string) => (subs.length ? `${chain},${subs.join(",")}` : chain);
    const out = hook ? "[pre]" : "[v]";
    const input = `[0:v]${hold ? `tpad=start_duration=${hold.toFixed(3)}:start_mode=clone,` : ""}${FILL_9_16}`;
    const sound = `[0:a]aresample=${SAMPLE_RATE}${hold ? `,adelay=${Math.round(hold * 1000)}:all=1` : ""}`;
    let video = `${withSubs(input)}${out}`;
    if (tag) {
      const { box, lines, delay = 0, outSeconds = 0, fade = true } = tag;
      const outStart = Math.max(0, duration - outSeconds);
      const ink = this.inkLayer({
        w: box.w, h: box.h, opacity: box.opacity, duration,
        fadeIn: fade ? { start: delay, seconds: TEXT_IN_SECONDS } : null,
        fadeOut: fade ? { start: outStart, seconds: outSeconds } : null,
      });
      const texts = this.drawTexts(
        lines.map((l) => ({ ...l, delay: fade ? delay : -TEXT_IN_SECONDS, rise: 0 })),
        fade ? { end: duration, seconds: outSeconds } : null,
        workDir,
        name,
      );
      video = `${ink}[box];${input}[base];${withSubs(`[base][box]overlay=${box.x}:${box.y}:format=auto,${texts.join(",")}`)}${out}`;
    }
    if (hook) {
      const { band, lines, outSeconds } = hook;
      const ink = this.inkLayer({ w: WIDTH, h: band.h, opacity: band.opacity, duration, fadeOut: { start: duration - outSeconds, seconds: outSeconds } });
      const texts = this.drawTexts(lines.map((l) => ({ ...l, delay: -TEXT_IN_SECONDS, rise: 0 })), { end: duration, seconds: outSeconds }, workDir, `${name}-hook`);
      video += `;${ink}[band];[pre][band]overlay=0:${band.y}:format=auto,${texts.join(",")}[v]`;
    }

    let audio = `${sound}[a]`;
    if (mute.length) {
      const muted = `gt(${mute.map(([a, b]) => `between(t,${(a + hold).toFixed(3)},${(b + hold).toFixed(3)})`).join("+")},0)`;
      audio =
        `${sound},aformat=channel_layouts=stereo,volume=volume=0:enable='${muted}'[dry];` +
        `aevalsrc='${BEEP_LEVEL}*sin(2*PI*${BEEP_HZ}*t)*${muted}':c=stereo:s=${SAMPLE_RATE}:d=${duration.toFixed(3)}[beep];` +
        "[dry][beep]amix=inputs=2:normalize=0:duration=first[a]";
    }

    const output = `${name}.mp4`;
    await this.run(
      ["-ss", String(start), "-to", String(end), "-i", resolve(clipPath), "-filter_complex", `${video};${audio}`, "-map", "[v]", "-map", "[a]", ...OUTPUT_ARGS, output],
      workDir,
    );
    return output;
  }

  /**
   * 16 kHz mono 16-bit WAV of `input`, the format keepitreel/transcribe reads. Without
   * `start`/`end`, the whole file.
   */
  async extractAudio(input: string, output: string, range: { start?: number; end?: number } = {}): Promise<void> {
    const seek = [...(range.start != null ? ["-ss", String(range.start)] : []), ...(range.end != null ? ["-to", String(range.end)] : [])];
    await this.run([...seek, "-i", input, "-vn", "-ac", "1", "-ar", "16000", output]);
  }

  /** The frame at `at` seconds, as an image (the format follows `output`'s extension). */
  async extractFrame(input: string, at: number, output: string): Promise<void> {
    await this.run(["-ss", String(at), "-i", input, "-frames:v", "1", output]);
  }

  /** Length of a media file in seconds, from the Duration line ffmpeg prints about its input. */
  async probeSeconds(file: string): Promise<number> {
    const { stderr } = await this.spawnFfmpeg(["-i", file]);
    const m = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (!m) throw new Error(`Could not read the length of ${file}`);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  /** Number of video frames in a file, counted from its packets without decoding. */
  async videoFrames(file: string): Promise<number> {
    const { code, stdout } = await this.spawnFfmpeg(["-loglevel", "error", "-i", file, "-map", "0:v", "-c", "copy", "-f", "framecrc", "-"]);
    if (code !== 0) throw new Error(`Could not count the frames of ${file}`);
    return stdout.split("\n").filter((l) => /^\s*0,/.test(l)).length;
  }

  /**
   * Joins segments rendered with {@link OUTPUT_ARGS} (file names in `workDir`). Each segment's
   * AAC comes out a little longer or shorter than its video (encoder priming, partial last
   * frames), and joining the audio as is adds those up into drift players hear. So the video
   * is copied with each file placed at its exact frame length, and the audio is cut or padded
   * to that length per segment and encoded once. faststart puts the index at the front of
   * the file, which Instagram requires.
   */
  async concat(segments: string[], workDir: string, outputPath: string): Promise<void> {
    const seconds: number[] = [];
    for (const s of segments) seconds.push((await this.videoFrames(join(workDir, s))) / FPS);
    const listFile = "segments.txt";
    writeFileSync(join(workDir, listFile), segments.map((s, i) => `file '${s}'\nduration ${seconds[i]!.toFixed(6)}`).join("\n"));
    const audio =
      segments.map((_, i) => `[${i + 1}:a]asetpts=PTS-STARTPTS,apad,atrim=end=${seconds[i]!.toFixed(6)}[a${i}];`).join("") +
      `${segments.map((_, i) => `[a${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[a]`;
    await this.run(
      [
        "-f", "concat", "-safe", "0", "-i", listFile, ...segments.flatMap((s) => ["-i", s]),
        "-filter_complex", audio, "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", ...AUDIO_ARGS, "-movflags", "+faststart", resolve(outputPath),
      ],
      workDir,
    );
  }
}
