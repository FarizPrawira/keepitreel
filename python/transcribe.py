import json
import sys
import wave

import numpy as np
from faster_whisper import WhisperModel


# Input is a 16 kHz mono 16-bit WAV (keepitreel/video's extractAudio makes one), so it is
# read directly instead of through faster-whisper's PyAV decoder.
def read_wav(path):
    with wave.open(path, "rb") as wav:
        frames = wav.readframes(wav.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def main():
    settings = json.load(sys.stdin)
    model = WhisperModel(settings["model"], **{"device": "cpu", "compute_type": "int8", **settings["model_options"]})
    # Word timestamps stay on whatever the options say: sentences and subtitles are timed by word.
    options = {
        "language": settings["language"],
        "initial_prompt": settings["prompt"] or None,
        **settings["transcribe_options"],
        "word_timestamps": True,
    }
    segments, _ = model.transcribe(read_wav(settings["audio"]), **options)
    result = [
        {"words": [{"start": w.start, "end": w.end, "word": w.word} for w in segment.words]}
        for segment in segments
    ]
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
