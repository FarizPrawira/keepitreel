import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FPS, MARGIN, Renderer, WIDTH, type TimedWord } from "../src/video/index.js";

const font = fileURLToPath(new URL("./fixtures/fonts/Fraunces-SemiBold.ttf", import.meta.url));
const renderer = new Renderer({ fonts: { display: font } });

const timed = (text: string, from = 0, step = 0.3): TimedWord[] =>
  text.split(" ").map((t, i) => ({ text: t, start: from + i * step, end: from + i * step + 0.25 }));

const lineTexts = (chunks: { words: { text: string }[] }[]) => chunks.map((c) => c.words.map((w) => w.text).join(" "));

describe("Renderer", () => {
  describe("subtitleChunks", () => {
    const chunk = (words: TimedWord[], duration = 10) =>
      renderer.subtitleChunks({ words, duration, font: "display", color: "white" });

    describe("when given two short sentences", () => {
      it("should put each sentence on its own line", () => {
        expect(lineTexts(chunk(timed("Go home. Now.")))).toEqual(["Go home.", "Now."]);
      });
    });

    describe("when given a sentence longer than maxWords", () => {
      const sentence = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ") + ".";
      const sizes = (count: number, maxWords?: number) =>
        renderer
          .subtitleChunks({ words: timed(sentence(count)), duration: 30, font: "display", color: "white", ...(maxWords ? { maxWords } : {}) })
          .map((c) => c.words.length);

      it("should split it into the fewest pieces of at most maxWords", () => {
        expect(sizes(7)).toEqual([4, 3]);
      });

      it("should balance the pieces instead of leaving one word over", () => {
        expect(sizes(21)).toEqual([5, 4, 4, 4, 4]);
        expect(sizes(7, 3)).toEqual([3, 2, 2]);
      });

      it("should keep every word, in order", () => {
        const chunks = renderer.subtitleChunks({ words: timed(sentence(21)), duration: 30, font: "display", color: "white" });
        expect(lineTexts(chunks).join(" ")).toBe(sentence(21));
      });
    });

    describe("when given a line that fits", () => {
      it("should center it on the frame", () => {
        const [line] = chunk(timed("Hello there."));
        const first = line!.words[0]!;
        const last = line!.words[line!.words.length - 1]!;
        const right = last.x + renderer.textWidth(last.text, "display", 56);
        expect(first.x).toBeCloseTo(WIDTH - right, 5);
      });
    });

    describe("when given a pause before the next sentence", () => {
      it("should hold the line after its last word, then show the next one on time", () => {
        const [first, second] = chunk([...timed("Wait.", 0), ...timed("Then go.", 2)]);
        expect(first!.end).toBeCloseTo(0.25 + 0.6, 5);
        expect(second!.start).toBe(2);
      });
    });

    describe("when given a line whose hold would run past the clip", () => {
      it("should end it at the end of the clip", () => {
        const [only] = chunk(timed("Stop."), 0.5);
        expect(only!.end).toBe(0.5);
      });
    });

    describe("when given a word that starts before the clip", () => {
      it("should start the line at the first frame", () => {
        const [only] = chunk(timed("Early bird.", -0.2));
        expect(only!.start).toBe(0);
      });
    });

    describe("when given a style for one word", () => {
      it("should draw that word in its own color and text", () => {
        const [line] = renderer.subtitleChunks({
          words: timed("You look starving."),
          duration: 5,
          font: "display",
          color: "white",
          style: (w) => (w.text.startsWith("starving") ? { color: "amber", text: "______." } : {}),
        });
        expect(line!.words.map((w) => [w.text, w.color])).toEqual([
          ["You", "white"],
          ["look", "white"],
          ["______.", "amber"],
        ]);
      });
    });

    describe("when given an active color", () => {
      it("should color each word from its start to the next word's start, and the last to the line's end", () => {
        const [line] = renderer.subtitleChunks({ words: timed("Go home now."), duration: 10, font: "display", color: "white", activeColor: "amber" });
        expect(line!.words.map((w) => w.active)).toEqual([
          { start: 0, end: 0.3, color: "amber" },
          { start: 0.3, end: 0.6, color: "amber" },
          { start: 0.6, end: line!.end, color: "amber" },
        ]);
      });
    });

    describe("when given an active color and a style that opts one word out", () => {
      it("should keep that word's color while it is spoken", () => {
        const [line] = renderer.subtitleChunks({
          words: timed("You look starving."),
          duration: 5,
          font: "display",
          color: "white",
          activeColor: "teal",
          style: (w) => (w.text.startsWith("starving") ? { color: "amber", activeColor: null } : {}),
        });
        expect(line!.words.map((w) => w.active?.color)).toEqual(["teal", "teal", undefined]);
      });
    });

    describe("when given no active color", () => {
      it("should leave the words without an active window", () => {
        const [line] = chunk(timed("Go home now."));
        expect(line!.words.every((w) => w.active === undefined)).toBe(true);
      });
    });

    describe("when given a line too wide even under maxWords", () => {
      it("should split it further", () => {
        const wide = timed("Extraordinarily incomprehensibly uncharacteristically.");
        const chunks = renderer.subtitleChunks({ words: wide, duration: 5, font: "display", color: "white", size: 120 });
        expect(chunks.length).toBeGreaterThan(1);
      });
    });

    describe("when given breakAfter with commas", () => {
      it("should also end a line after a comma", () => {
        const chunks = renderer.subtitleChunks({ words: timed("Well, go home now."), duration: 5, font: "display", color: "white", breakAfter: /[.,?!]["']?$/ });
        expect(lineTexts(chunks)).toEqual(["Well,", "go home now."]);
      });
    });

    describe("when given a pause", () => {
      it("should end a line where the silence between two words is longer", () => {
        const words = [...timed("go home", 0), ...timed("right now.", 1.5)];
        expect(lineTexts(chunk(words))).toEqual(["go home right now."]);
        const paused = renderer.subtitleChunks({ words, duration: 5, font: "display", color: "white", pause: 0.35 });
        expect(lineTexts(paused)).toEqual(["go home", "right now."]);
      });
    });

    describe("when given a border and a shadow", () => {
      it("should put them on every word", () => {
        const border = { width: 7, color: "black" };
        const shadow = { x: 0, y: 6, color: "black@0.55" };
        const [line] = renderer.subtitleChunks({ words: timed("Go home."), duration: 5, font: "display", color: "white", border, shadow });
        expect(line!.words.every((w) => w.border === border && w.shadow === shadow)).toBe(true);
      });
    });

    describe("when given no border or shadow", () => {
      it("should leave them off the words", () => {
        const [line] = chunk(timed("Go home."));
        expect(line!.words.every((w) => !("border" in w) && !("shadow" in w))).toBe(true);
      });
    });
  });

  describe("printable", () => {
    describe("when given emoji and characters the font has no glyph for", () => {
      it("should leave them out and collapse the spaces", () => {
        expect(renderer.printable("Wait 🔥 for  it ✨", "display")).toBe("Wait for it");
      });
    });
  });

  describe("capHeight", () => {
    it("should scale the font's capital height with the size", () => {
      expect(renderer.capHeight("display", 100)).toBeCloseTo(2 * renderer.capHeight("display", 50), 5);
      expect(renderer.capHeight("display", 100)).toBeGreaterThan(50);
    });
  });

  describe("wrapText", () => {
    const text = "Why this one small mistake costs you every single time";

    describe("when given text wider than maxWidth", () => {
      it("should wrap it into lines that fit, keeping every word", () => {
        const lines = renderer.wrapText(text, "display", 80, { maxWidth: 700 });
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.every((l) => renderer.textWidth(l, "display", 80) <= 700)).toBe(true);
        expect(lines.join(" ")).toBe(text);
      });
    });

    describe("when asked to balance", () => {
      it("should keep the number of lines and make them more even", () => {
        const widths = (lines: string[]) => lines.map((l) => renderer.textWidth(l, "display", 80));
        const spread = (lines: string[]) => Math.max(...widths(lines)) - Math.min(...widths(lines));
        const plain = renderer.wrapText(text, "display", 80, { maxWidth: 800 });
        const even = renderer.wrapText(text, "display", 80, { maxWidth: 800, balance: true });
        expect(even).toHaveLength(plain.length);
        expect(spread(even)).toBeLessThan(spread(plain));
        expect(even.join(" ")).toBe(text);
      });
    });

    describe("when given text that fits", () => {
      it("should keep it on one line", () => {
        expect(renderer.wrapText("Short one", "display", 80, { balance: true })).toEqual(["Short one"]);
      });
    });
  });

  describe("fitSize", () => {
    describe("when given text that fits", () => {
      it("should keep the size", () => {
        expect(renderer.fitSize("Hello", "display", 56)).toBe(56);
      });
    });

    describe("when given text wider than the space", () => {
      it("should shrink it until it fits", () => {
        const size = renderer.fitSize("Hello there", "display", 56, 100);
        expect(size).toBeLessThan(56);
        expect(renderer.textWidth("Hello there", "display", size)).toBeLessThanOrEqual(100);
      });
    });
  });

  describe("when asked for a font key it does not have", () => {
    it("should name the fonts it has", () => {
      expect(() => renderer.textWidth("x", "nope", 10)).toThrow('No font "nope"; the fonts are: display');
    });
  });

  describe("inkLayer", () => {
    describe("when given no fades", () => {
      it("should be a solid layer at the opacity", () => {
        expect(renderer.inkLayer({ w: 100, h: 50, opacity: 0.5, duration: 2 })).toBe(
          `color=c=0x14110D:s=100x50:r=${FPS}:d=2,format=rgba,colorchannelmixer=aa=0.5`,
        );
      });
    });

    describe("when given a fade in and out", () => {
      it("should add alpha fades at those times", () => {
        const layer = renderer.inkLayer({
          w: 100, h: 50, opacity: 0.5, duration: 2,
          fadeIn: { start: 0.5, seconds: 0.25 }, fadeOut: { start: 1.5, seconds: 0.5 },
        });
        expect(layer).toContain(",fade=t=in:st=0.5:d=0.25:alpha=1");
        expect(layer).toContain(",fade=t=out:st=1.5:d=0.5:alpha=1");
      });
    });
  });

  describe("drawTexts", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "keepitreel-text-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    describe("when given a line of text", () => {
      it("should write the text to a file in workDir, so it needs no escaping", () => {
        renderer.drawTexts([{ text: "It's 100%: done", font: "display", size: 80, color: "white", baseline: 900 }], null, dir, "quote");
        expect(readFileSync(join(dir, "quote-line0.txt"), "utf8")).toBe("It's 100%: done");
      });

      it("should draw it at the left margin with a whole-number size", () => {
        const [filter] = renderer.drawTexts([{ text: "Hi", font: "display", size: 80.7, color: "white", baseline: 900 }], null, dir, "plain");
        expect(filter).toContain(`textfile=plain-line0.txt:fontsize=80:fontcolor=white:x=${MARGIN}:`);
      });
    });

    describe("when given a window", () => {
      it("should show the line only from its start up to, not including, its end", () => {
        const [filter] = renderer.drawTexts(
          [{ text: "1", font: "display", size: 80, color: "white", baseline: 900, window: [1, 2] }],
          null,
          dir,
          "count",
        );
        expect(filter).toContain(":enable='gte(t,1)*lt(t,2)'");
      });
    });

    describe("when given a box", () => {
      it("should draw it behind the text with the given border", () => {
        const line = { text: "Hook", font: "display", size: 80, color: "0x111111", baseline: 500 };
        const [even] = renderer.drawTexts([{ ...line, box: { color: "white", border: 18 } }], null, dir, "box");
        const [wide] = renderer.drawTexts([{ ...line, box: { color: "white", border: [18, 26] } }], null, dir, "box-wide");
        expect(even).toContain(":box=1:boxcolor=white:boxborderw=18");
        expect(wide).toContain(":box=1:boxcolor=white:boxborderw=18|26");
      });
    });

    describe("when given no box", () => {
      it("should draw no box", () => {
        const [filter] = renderer.drawTexts([{ text: "Hi", font: "display", size: 80, color: "white", baseline: 900 }], null, dir, "nobox");
        expect(filter).not.toContain("box=");
      });
    });
  });

  // The render tests need ffmpeg: ffmpeg-static after `node node_modules/ffmpeg-static/install.js`,
  // or ffmpeg on the PATH.
  const hasFfmpeg = spawnSync(renderer.ffmpegPath, ["-version"]).status === 0;

  describe.skipIf(!hasFfmpeg)("when given ffmpeg and a landscape source clip", () => {
    let dir: string;
    const source = () => join(dir, "source.mp4");
    const probe = (file: string) => spawnSync(renderer.ffmpegPath, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "keepitreel-"));
      await renderer.run([
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source(),
      ]);
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    describe("when rendering a clip with a hook, subtitles and a beep", () => {
      it("should make a 9:16 segment of the requested length", async () => {
        const subtitles = renderer.subtitleChunks({ words: timed("Watch this part."), duration: 2, font: "display", color: "white" });
        const file = await renderer.renderClip({
          clipPath: source(), start: 0.5, end: 2.5, workDir: dir, name: "one", subtitles, mute: [[1, 1.5]],
          hook: { band: { y: 680, h: 480, opacity: 0.66 }, lines: [{ text: "The best part", font: "display", size: 80, color: "white", baseline: 900 }], outSeconds: 0.4 },
        });
        expect(await renderer.probeSeconds(join(dir, file))).toBeCloseTo(2, 1);
        expect(probe(join(dir, file))).toMatch(/1080x1920/);
      }, 60_000);
    });

    describe("when rendering a clip with loudness and a beep in its last 3 seconds", () => {
      it("should silence the clip's own sound under the beep", async () => {
        const tone = join(dir, "tone.mp4");
        await renderer.run([
          "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4",
          "-f", "lavfi", "-i", "sine=frequency=2000:duration=4",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", tone,
        ]);
        const file = await renderer.renderClip({ clipPath: tone, start: 0, end: 4, loudness: -14, mute: [[2, 2.5]], workDir: dir, name: "late-beep" });
        // The highpass keeps the 2 kHz tone and drops the lower beep.
        const level = (from: number) => {
          const { stderr } = spawnSync(
            renderer.ffmpegPath,
            ["-hide_banner", "-ss", String(from), "-t", "0.3", "-i", join(dir, file), "-af", "highpass=f=1200,highpass=f=1200,volumedetect", "-f", "null", "-"],
            { encoding: "utf8" },
          );
          return Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1]);
        };
        expect(level(1)).toBeGreaterThan(-30);
        expect(level(2.1)).toBeLessThan(-40);
      }, 60_000);
    });

    describe("when rendering a clip with hundreds of subtitle words", () => {
      it("should render, with its filter graph read from a file in workDir", async () => {
        const words = timed(Array.from({ length: 400 }, (_, i) => `word${i}.`).join(" "), 0, 0.009);
        const subtitles = renderer.subtitleChunks({ words, duration: 3.6, font: "display", color: "white", maxWords: 1 });
        const file = await renderer.renderClip({ clipPath: source(), start: 0, end: 3.6, workDir: dir, name: "long", subtitles });
        expect(await renderer.probeSeconds(join(dir, file))).toBeCloseTo(3.6, 1);
        expect(readFileSync(join(dir, "long.filter"), "utf8").match(/drawtext=/g)).toHaveLength(400);
      }, 60_000);
    });

    describe("when rendering a clip with an active color and a hold", () => {
      it("should draw each word twice, its spoken window moved by the hold", async () => {
        const subtitles = renderer.subtitleChunks({ words: timed("Watch this."), duration: 2, font: "display", color: "white", activeColor: "yellow" });
        const file = await renderer.renderClip({ clipPath: source(), start: 0, end: 2, hold: 0.5, workDir: dir, name: "karaoke", subtitles });
        const graph = readFileSync(join(dir, "karaoke.filter"), "utf8");
        expect(await renderer.probeSeconds(join(dir, file))).toBeCloseTo(2.5, 1);
        expect(graph.match(/drawtext=/g)).toHaveLength(4);
        expect(graph).toContain("fontcolor=yellow");
        expect(graph).toContain("enable='gte(t,0.500)*lt(t,0.800)'");
      }, 60_000);
    });

    describe("when rendering a clip with a tag", () => {
      it("should make a 9:16 segment of the requested length", async () => {
        const file = await renderer.renderClip({
          clipPath: source(), start: 0, end: 1.5, workDir: dir, name: "tagged",
          tag: {
            box: { x: 96, y: 300, w: 888, h: 200, opacity: 0.7 },
            lines: [{ text: "Tagged", font: "display", size: 60, color: "white", baseline: 420 }],
            outSeconds: 0.3,
          },
        });
        expect(await renderer.probeSeconds(join(dir, file))).toBeCloseTo(1.5, 1);
        expect(probe(join(dir, file))).toMatch(/1080x1920/);
      }, 60_000);
    });

    describe("when rendering a clip with a hook without a band, its own fill, and outlined subtitles", () => {
      it("should make a 9:16 segment with the hook up to the end and the subtitles' border and shadow", async () => {
        const fill = `split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30[bg];[b]crop='min(iw,ih*3/2)':'min(ih,iw*2/3)',scale=1080:720,setsar=1[fg];[bg][fg]overlay=0:600,setsar=1`;
        const subtitles = renderer.subtitleChunks({
          words: timed("Watch this."), duration: 2, font: "display", color: "white",
          border: { width: 7, color: "black" }, shadow: { x: 0, y: 6, color: "black@0.55" },
        });
        const file = await renderer.renderClip({
          clipPath: source(), start: 0, end: 2, workDir: dir, name: "boxed", fill, subtitles,
          hook: { lines: [{ text: "The part", font: "display", size: 96, color: "0x111111", baseline: 500, x: 300, box: { color: "white", border: [21, 29] } }] },
        });
        const graph = readFileSync(join(dir, "boxed.filter"), "utf8");
        expect(await renderer.probeSeconds(join(dir, file))).toBeCloseTo(2, 1);
        expect(probe(join(dir, file))).toMatch(/1080x1920/);
        expect(graph).toContain("overlay=0:600");
        expect(graph).not.toContain("color=c=");
        expect(graph).toContain("borderw=7:bordercolor=black:shadowx=0:shadowy=6:shadowcolor=black@0.55");
        expect(graph).toContain("boxborderw=21|29");
      }, 60_000);
    });

    describe("when joining segments", () => {
      it("should keep the exact sum of their frames", async () => {
        const a = await renderer.renderClip({ clipPath: source(), start: 0, end: 1.3, workDir: dir, name: "a" });
        const b = await renderer.renderClip({ clipPath: source(), start: 1, end: 2.7, workDir: dir, name: "b", hold: 0.5 });
        const frames = (await renderer.videoFrames(join(dir, a))) + (await renderer.videoFrames(join(dir, b)));
        const output = join(dir, "joined.mp4");
        await renderer.concat([a, b], dir, output);
        expect(await renderer.videoFrames(output)).toBe(frames);
        expect(await renderer.probeSeconds(output)).toBeCloseTo(frames / FPS, 1);
      }, 60_000);
    });

    describe("when extracting audio for transcription", () => {
      it("should write a 16 kHz mono WAV of the range", async () => {
        const wav = join(dir, "audio.wav");
        await renderer.extractAudio(source(), wav, { start: 1, end: 3 });
        expect(probe(wav)).toMatch(/16000 Hz, (mono|1 channels)/);
        expect(await renderer.probeSeconds(wav)).toBeCloseTo(2, 1);
      }, 60_000);
    });

    describe("when extracting a frame", () => {
      it("should write an image of the source's size", async () => {
        const image = join(dir, "frame.png");
        await renderer.extractFrame(source(), 1, image);
        expect(probe(image)).toMatch(/1280x720/);
      }, 60_000);
    });
  });
});
