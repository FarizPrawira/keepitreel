import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** One word as Whisper heard it. `word` keeps Whisper's leading space and punctuation. */
export interface Word {
  word: string;
  start: number;
  end: number;
}

/** One Whisper segment. Segments can split or join sentences, so see {@link toSentences}. */
export interface Segment {
  words: Word[];
}

export interface Sentence {
  words: Word[];
  /** The words through {@link normalize}, for matching. */
  tokens: string[];
  start: number;
  end: number;
  text: string;
}

export interface TranscribeOptions {
  /** A Python with faster-whisper installed, such as a project venv's interpreter. */
  python: string;

  /**
   * A faster-whisper model name. The `.en` models are English only, so pick a
   * multilingual one (`base`, `small`) for other languages.
   *
   * @default 'base.en'
   */
  model?: string;

  /** @default 'en' */
  language?: string;

  /**
   * Text Whisper reads as if it came before the audio. Without punctuated context,
   * Whisper often returns fast dialogue as one unpunctuated run, and sentence
   * boundaries are what clips are cut on. Pass one in the audio's language. Whisper can
   * read it back into long silences; see `transcribeOptions`.
   *
   * @default "Hello. How are you? I'm fine, thanks. Let's go!"
   */
  prompt?: string;

  /**
   * Passed to faster-whisper's `WhisperModel`, by its parameter names, such as
   * `{ device: "cuda", compute_type: "float16" }`.
   *
   * @default { device: "cpu", compute_type: "int8" }
   */
  modelOptions?: Record<string, unknown>;

  /**
   * Passed to faster-whisper's `transcribe`, by its parameter names, such as
   * `{ beam_size: 5 }` or `{ hallucination_silence_threshold: 1 }` (which skips silences
   * where Whisper seems to be making words up). `word_timestamps` stays on, since sentences
   * and subtitles are timed by word.
   */
  transcribeOptions?: Record<string, unknown>;

  /** Called as Whisper works through the audio, with the share done so far, from 0 to 1. */
  onProgress?: (fraction: number) => void;
}

// The script reports progress on stderr, a line at a time; any other stderr line is Whisper's own.
const PROGRESS = /^progress (\d+(?:\.\d+)?)\r?$/;
const SCRIPT = fileURLToPath(new URL("../../python/transcribe.py", import.meta.url));
const ENGLISH_PROMPT = "Hello. How are you? I'm fine, thanks. Let's go!";

/**
 * Transcribes a 16 kHz mono 16-bit WAV (see `extractAudio` in keepitreel/video) with
 * word timestamps. Runs on the CPU unless `modelOptions` says otherwise; the model
 * downloads on first use.
 */
export function transcribe(audioPath: string, options: TranscribeOptions): Promise<Segment[]> {
  const { python, model = "base.en", language = "en", prompt = ENGLISH_PROMPT, modelOptions = {}, transcribeOptions = {}, onProgress } = options;
  // The settings go through stdin, which avoids Windows' command-line quoting and length limits.
  const settings = { audio: audioPath, model, language, prompt, model_options: modelOptions, transcribe_options: transcribeOptions };
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [SCRIPT]);
    let stdout = "";
    let stderr = "";
    let partial = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => {
      const lines = (partial + d).split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        const progress = PROGRESS.exec(line);
        if (progress) onProgress?.(Number(progress[1]));
        else stderr += `${line}\n`;
      }
    });
    proc.on("error", reject);
    // A Python that exits early closes stdin; the exit code reports why.
    proc.stdin.on("error", () => {});
    proc.stdin.end(JSON.stringify(settings));
    proc.on("close", (code) => {
      stderr += partial;
      if (code !== 0) return reject(new Error(`Whisper failed (${code}): ${stderr.slice(-800)}`));
      try {
        resolve(JSON.parse(stdout) as Segment[]);
      } catch {
        reject(new Error(`Whisper printed no transcript: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Lowercase letters, digits and apostrophes, with the endings 's, 'll, 'd, 're, 've and 'm
 * dropped ("terrible's" is "terrible").
 */
export function normalize(word: string): string {
  return word
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/'(s|ll|d|re|ve|m)$/, "");
}

const SENTENCE_END = /[.?!]["']?$/;
// Whisper sometimes leaves long stretches unpunctuated; a segment break with at least
// this much silence after it is then treated as the end of a sentence.
const SEGMENT_PAUSE = 0.4;

/** Rebuilds sentences from punctuation and from segment breaks where the speaker pauses. */
export function toSentences(segments: Segment[]): Sentence[] {
  const sentences: Word[][] = [];
  let words: Word[] = [];
  segments.forEach((segment, s) => {
    segment.words.forEach((word, w) => {
      words.push(word);
      const segmentEnd = w === segment.words.length - 1;
      const nextStart = segments[s + 1]?.words[0]?.start ?? Infinity;
      if (SENTENCE_END.test(word.word.trim()) || (segmentEnd && nextStart - word.end >= SEGMENT_PAUSE)) {
        sentences.push(words);
        words = [];
      }
    });
  });
  if (words.length > 0) sentences.push(words);
  return sentences.map((ws) => ({
    words: ws,
    tokens: ws.map((w) => normalize(w.word)),
    start: ws[0]!.start,
    end: ws[ws.length - 1]!.end,
    text: ws.map((w) => w.word).join("").trim(),
  }));
}
