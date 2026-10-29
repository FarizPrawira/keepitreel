import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalize, toSentences, transcribe, type Segment } from "../src/transcribe/index.js";

// Real faster-whisper base.en output for a 7 s film line.
const segments = JSON.parse(
  readFileSync(new URL("./fixtures/whisper-segments.json", import.meta.url), "utf8"),
) as Segment[];

const word = (text: string, start: number, end: number) => ({ word: text, start, end });

describe("normalize", () => {
  describe("when given a word with punctuation, capitals or an English contraction", () => {
    it("should return the bare lowercase word", () => {
      expect(normalize(" Terrible's")).toBe("terrible");
      expect(normalize("They’ve")).toBe("they");
      expect(normalize("enough.")).toBe("enough");
    });
  });

  describe("when given a word with letters outside ASCII", () => {
    it("should keep those letters", () => {
      expect(normalize("Café!")).toBe("café");
    });
  });
});

describe("toSentences", () => {
  describe("when given real Whisper segments", () => {
    const sentences = toSentences(segments);

    it("should split them at sentence punctuation", () => {
      expect(sentences.map((s) => s.text)).toEqual([
        "Good old.",
        "Good intentions are not enough.",
        "They've never put an onion in the soup yet.",
        "You'll have to.",
      ]);
    });

    it("should time each sentence from its first and last word", () => {
      expect(sentences[1]!.start).toBe(1.02);
      expect(sentences[1]!.end).toBe(2.82);
    });

    it("should give each sentence its normalized tokens", () => {
      expect(sentences[1]!.tokens).toEqual(["good", "intentions", "are", "not", "enough"]);
    });
  });

  describe("when given unpunctuated segments with a pause between them", () => {
    it("should end a sentence at the segment break", () => {
      const unpunctuated: Segment[] = [{ words: [word(" so we went", 0, 1)] }, { words: [word(" and then", 1.5, 2)] }];
      expect(toSentences(unpunctuated).map((s) => s.text)).toEqual(["so we went", "and then"]);
    });
  });

  describe("when given segments that follow each other without a pause", () => {
    it("should join them into one sentence", () => {
      const split: Segment[] = [{ words: [word(" so we", 0, 1)] }, { words: [word(" went.", 1.1, 2)] }];
      expect(toSentences(split).map((s) => s.text)).toEqual(["so we went."]);
    });
  });

  describe("when given a closing quote after the end punctuation", () => {
    it("should still end the sentence there", () => {
      const quoted: Segment[] = [{ words: [word(' "Go."', 0, 0.5), word(" Now", 0.6, 1)] }];
      expect(toSentences(quoted).map((s) => s.text)).toEqual(['"Go."', "Now"]);
    });
  });

  describe("when given no segments", () => {
    it("should return no sentences", () => {
      expect(toSentences([])).toEqual([]);
    });
  });
});

describe("transcribe", () => {
  describe("when given a Python that cannot run the script", () => {
    it("should reject with the end of its error output", async () => {
      // Node is on every machine that runs the tests, and fails on the Python script.
      await expect(transcribe("missing.wav", { python: process.execPath })).rejects.toThrow(/^Whisper failed \(1\)/);
    });
  });

  describe("when given a Python that does not exist", () => {
    it("should reject with the spawn error", async () => {
      await expect(transcribe("missing.wav", { python: "keepitreel-no-such-python" })).rejects.toThrow(/ENOENT/);
    });
  });

  describe("when the script reports progress", () => {
    it("should pass each share to onProgress and still resolve to the transcript", async () => {
      // NODE_OPTIONS reads a backslash in quotes as an escape, so Windows paths go with forward slashes.
      const fake = fileURLToPath(new URL("./fixtures/fake-whisper.cjs", import.meta.url)).replaceAll("\\", "/");
      const before = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = `--require "${fake}"`;
      const shares: number[] = [];
      try {
        const result = await transcribe("missing.wav", { python: process.execPath, onProgress: (s) => shares.push(s) });
        expect(shares).toEqual([0.5, 1]);
        expect(result).toEqual([{ words: [{ word: " Hi.", start: 0, end: 0.5 }] }]);
      } finally {
        if (before === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = before;
      }
    });
  });
});
