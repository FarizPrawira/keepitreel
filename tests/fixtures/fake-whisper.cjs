// Preloaded into Node standing in for Python: prints what transcribe.py prints, progress lines
// (one with a Windows line ending) and a Whisper warning on stderr, the transcript on stdout.
process.stderr.write("progress 0.5000\r\nWarning: a Whisper notice\nprogress 1.0000\n");
process.stdout.write(JSON.stringify([{ words: [{ word: " Hi.", start: 0, end: 0.5 }] }]));
process.exit(0);
