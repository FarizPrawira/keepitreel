<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/FarizPrawira/keepitreel@main/assets/logo.svg" width="120" height="120" alt="keepitreel logo" />
</p>

# keepitreel

[![npm version](https://img.shields.io/npm/v/keepitreel.svg)](https://www.npmjs.com/package/keepitreel)
[![npm downloads](https://img.shields.io/npm/dm/keepitreel.svg)](https://www.npmjs.com/package/keepitreel)
![types included](https://img.shields.io/badge/types-included-blue)
[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Building blocks for automated short-form video: Whisper transcription, ffmpeg reel rendering, and publishing to YouTube Shorts, Facebook, Instagram and TikTok.

Each part is its own entry point, so an app takes only what it uses:

- `keepitreel/transcribe`: word-timed transcripts from faster-whisper, rebuilt into sentences to cut on
- `keepitreel/video`: 1080x1920 segments with subtitles a few words at a time, a hook band, a tag and beeps, joined without audio drift
- `keepitreel/publish`: OAuth sign-in and uploads for YouTube Shorts, Facebook Reels and posts, Instagram Reels and posts, and TikTok, with scheduling on YouTube and Facebook, and stats for YouTube, Facebook Reels and Instagram Reels
- Errors carry a code your app can act on, and optional analytics permissions never block posting
- TypeScript-first, fully typed, ESM + CJS
- Node 22+

```ts
import { toSentences, transcribe } from "keepitreel/transcribe";
import { Renderer } from "keepitreel/video";

const renderer = new Renderer({ fonts: { display: "fonts/Inter-Bold.ttf" } });

await renderer.extractAudio("episode.mp4", "work/audio.wav", { start: 120, end: 160 });
const segments = await transcribe("work/audio.wav", { python: ".venv/Scripts/python.exe" });

const [first] = toSentences(segments);
const words = first.words.map((w) => ({ text: w.word.trim(), start: w.start - first.start, end: w.end - first.start }));
const subtitles = renderer.subtitleChunks({ words, duration: first.end - first.start, font: "display", color: "white" });

// Sentence times count from the start of the extracted range, 120 s into the episode.
await renderer.renderClip({ clipPath: "episode.mp4", start: 120 + first.start, end: 120 + first.end, subtitles, workDir: "work", name: "clip" });
//=> "clip.mp4", in work/
```

## Install

```sh
npm install keepitreel
# or
pnpm add keepitreel
# or
yarn add keepitreel
# or
bun add keepitreel
```

`keepitreel/video` runs ffmpeg. Install [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static), or have `ffmpeg` on the PATH:

```sh
npm install ffmpeg-static
```

`keepitreel/transcribe` runs Python. Make a venv with faster-whisper once per project:

```sh
python -m venv .venv
.venv/Scripts/python -m pip install faster-whisper numpy   # Windows
.venv/bin/python -m pip install faster-whisper numpy       # macOS, Linux
```

Both ESM and CommonJS are shipped:

```ts
import { Renderer } from "keepitreel/video";        // ESM / TypeScript
const { Renderer } = require("keepitreel/video");    // CommonJS
```

Requires Node 22+.

## keepitreel/transcribe

### transcribe(audioPath, options)

Returns a `Promise` of Whisper segments for a 16 kHz mono 16-bit WAV (make one with [`renderer.extractAudio`](#extractaudioinput-output-range)). Each segment is `{ words }`, and each word is `{ word, start, end }`, with Whisper's leading space and punctuation kept in `word`. Runs on the CPU unless `modelOptions` says otherwise; the model downloads on first use.

Rejects with the end of Python's error output when Whisper fails, and when it prints no transcript.

### options

Type: `object`

#### python

Type: `string`\
*Required*

A Python with faster-whisper installed, such as a project venv's interpreter.

#### model

Type: `string`\
Default: `'base.en'`

A faster-whisper model name. The `.en` models are English only, so pick a multilingual one (`base`, `small`) for other languages.

#### language

Type: `string`\
Default: `'en'`

#### prompt

Type: `string`\
Default: an English punctuated line

Text Whisper reads as if it came before the audio. Without punctuated context, Whisper often returns fast speech as one unpunctuated run, and sentences are what clips are cut on. Pass one in the audio's language.

Whisper can read the prompt back into a long silence, so a clip that ends in silence may get an extra "Hello. How are you?" sentence. See [`transcribeOptions`](#transcribeoptions) for the mitigation.

#### modelOptions

Type: `Record<string, unknown>`\
Default: `{ device: "cpu", compute_type: "int8" }`

Passed to faster-whisper's [`WhisperModel`](https://github.com/SYSTRAN/faster-whisper) by its parameter names, such as `{ device: "cuda", compute_type: "float16" }` for a GPU.

#### transcribeOptions

Type: `Record<string, unknown>`\
*Optional*

Passed to faster-whisper's `transcribe` by its parameter names, such as `{ beam_size: 5 }`. `word_timestamps` stays on whatever you pass, because sentences and subtitles are timed by word.

To keep Whisper from making words up in long silences, including the prompt read back, try `hallucination_silence_threshold`. It skips silences longer than that many seconds where the words look made up:

```ts
await transcribe("work/audio.wav", { python, transcribeOptions: { hallucination_silence_threshold: 1 } });
```

It is off by default because it can also change real words near a silence, so check it on your own audio first. Whisper's output also varies a little from run to run.

#### onProgress

Type: `(fraction: number) => void`\
*Optional*

Called after each segment Whisper finishes, with how far into the audio it is, from 0 to 1. Whisper returns nothing else until the end, so this is the only sign of progress on a long file:

```ts
await transcribe("work/audio.wav", { python, onProgress: (f) => console.log(`${Math.round(f * 100)}%`) });
```

### toSentences(segments)

Rebuilds sentences from punctuation, and from segment breaks followed by a pause of 0.4 s or more. Returns an array of `{ words, text, start, end, tokens }`, where `tokens` are the words through [`normalize`](#normalizeword), for matching.

```ts
toSentences(segments).map((s) => s.text);
//=> ['Good intentions are not enough.', 'You have to show up every day.']
```

### normalize(word)

Returns the word as lowercase letters, digits and apostrophes, with the endings `'s`, `'ll`, `'d`, `'re`, `'ve` and `'m` dropped. Other contractions stay whole.

```ts
normalize(" Terrible's");
//=> 'terrible'
normalize("Can't");
//=> "can't"
```

## keepitreel/video

### new Renderer(options)

Returns a renderer for 1080x1920 reel segments.

### options

Type: `object`

#### fonts

Type: `Record<string, string>`\
*Required*

Font files by key. Text lines and subtitle words name a font by its key. Asking for a key that is not here throws, naming the keys it has.

#### ink

Type: `string`\
Default: `'0x14110D'`

Color of ink layers and subtitle outlines, in ffmpeg's `0xRRGGBB` form.

#### ffmpegPath

Type: `string`\
Default: ffmpeg-static when it is installed, else `ffmpeg` on the PATH

The ffmpeg binary. See [Caveats](#caveats) for Linux.

### Instance

#### .renderClip(options)

Renders `start` to `end` of a clip as a 9:16 segment: the landscape picture sits over a blurred, cropped copy of itself. Returns a `Promise` of the file name, `<name>.mp4` in `workDir`.

| Option | Type | Default | |
|---|---|---|---|
| `clipPath` | `string` | required | The source video |
| `start`, `end` | `number` | required | Seconds into the clip |
| `workDir` | `string` | required | Where the output and the files ffmpeg reads go: the text, and the filter graph (`<name>.filter`), which keeps clips with hundreds of subtitle words within Windows' command-line limit |
| `name` | `string` | required | The output's base name |
| `subtitles` | `SubtitleChunk[]` | `[]` | From [`.subtitleChunks()`](#subtitlechunksoptions) |
| `hook` | `{ band?: { y, h, opacity }, lines, outSeconds? }` | | Text up from the first frame, on a full-width ink band when `band` is given, fading out `outSeconds` before the end. Without `outSeconds` it stays to the end |
| `tag` | `{ box: { x, y, w, h, opacity }, lines, delay?, outSeconds?, fade? }` | | An ink box with text that fades in after `delay` and out before the end. With `fade: false` it is up for the whole clip |
| `fill` | `string` | `FILL_9_16` | The filter chain that turns the source picture into the 1080x1920 frame, for a layout of your own (for example the picture cropped and placed higher, over a darker blur) |
| `hold` | `number` | `0` | Seconds the first frame is held, silent, before the clip plays. Subtitles and mute windows move with it |
| `mute` | `[number, number][]` | `[]` | Clip-relative windows where the sound is replaced by a beep |
| `loudness` | `number` | | Target loudness in LUFS, e.g. `-14`. The clip's sound is normalized to it before beeps are mixed in. Without it the sound is left as it is |

`lines` are [text lines](#text-lines).

#### .subtitleChunks(options)

Splits clip-relative words into one-line, centered chunks, breaking at sentence ends. A sentence longer than `maxWords` is cut into the fewest pieces that fit, differing by at most one word ("I heard you / were in town."): seven words become 4 + 3, and twenty-one become 5 + 4 + 4 + 4 + 4 rather than leaving one word over. A piece is split further while it is wider than `maxWidth`, so a word too wide to share a line gets one to itself. Returns an array of `{ start, end, words }`, where each word is placed with its `x`, `font`, `color` and `size`, plus `active: { start, end, color }` when `activeColor` is given.

| Option | Type | Default | |
|---|---|---|---|
| `words` | `{ text, start, end }[]` | required | Clip-relative seconds |
| `duration` | `number` | required | Length of the clip. No chunk stays up past it |
| `font`, `color` | `string` | required | A font key and an ffmpeg color |
| `style` | `(word) => { font?, color?, text?, activeColor? }` | | Per-word font, color or text, for a highlighted or blanked-out word. Its `activeColor` overrides the option for that word, and `null` keeps the word's own color while it is spoken |
| `activeColor` | `string` | | Karaoke style: each word takes this color while it is spoken, from its start to the next word's start (the line's end for the last word), so Whisper's early end times leave no gap. Without it words keep their color the whole line |
| `size` | `number` | `56` | |
| `baseline` | `number` | `1445` | Below the picture of a 4:3 film and above the apps' bottom UI zone |
| `maxWords` | `number` | `5` | |
| `hold` | `number` | `0.6` | Seconds a chunk stays up after its last word when the next one is not right after |
| `maxWidth` | `number` | `TEXT_WIDTH` | |
| `breakAfter` | `RegExp` | `/[.?!]["']?$/` | Words that end a piece, as sentence ends do. `/[.,?!]["']?$/` also breaks after commas |
| `pause` | `number` | | A silence longer than this many seconds between two words also ends a piece |
| `border` | `{ width, color }` | 3 px, the renderer's ink at 85% | The outline around each word |
| `shadow` | `{ x, y, color }` | | A shadow under each word, offset by `x` and `y` px |

#### .concat(segments, workDir, outputPath)

Joins segments rendered by this renderer (file names in `workDir`) into `outputPath`. Each segment's AAC runs a little longer or shorter than its video, and joining them as is adds up into drift you can hear, so each segment's audio is cut or padded to its exact frame length. The output starts with its index (`faststart`), which Instagram requires. Returns a `Promise<void>`.

#### .extractAudio(input, output, range?)

Writes a 16 kHz mono 16-bit WAV of `input`, the format `transcribe` reads. `range` is `{ start?, end? }` in seconds; without it, the whole file. Returns a `Promise<void>`.

#### .extractFrame(input, at, output)

Writes the frame at `at` seconds as an image. The format follows `output`'s extension. Returns a `Promise<void>`.

#### .probeSeconds(file)

Returns a `Promise` of a media file's length in seconds.

#### .videoFrames(file)

Returns a `Promise` of the number of video frames in a file, counted from its packets without decoding.

#### .textWidth(text, font, size)

Returns the width in pixels of `text` in the font with key `font` at `size`.

#### .fitSize(text, font, size, maxWidth?)

Returns the largest size up to `size` at which `text` fits in `maxWidth` (default `TEXT_WIDTH`).

#### .wrapText(text, font, size, options?)

Returns `text` wrapped into lines no wider than `maxWidth` (default `TEXT_WIDTH`). With `balance: true` the lines are as even as the fewest lines allow, instead of full lines and a short last one.

#### .printable(text, font)

Returns `text` without the characters the font has no glyph for, such as emoji, with spaces collapsed. ffmpeg draws those as empty boxes.

#### .capHeight(font, size)

Returns the height of the font's capital letters at `size`. `baseline = top + capHeight` places text by the top of its capitals.

#### .drawTexts(lines, out, workDir, name)

Returns ffmpeg `drawtext` filters for [text lines](#text-lines), for filter graphs of your own. Each line fades in, rising by `rise` pixels, from its `delay`. With `out` (`{ end, seconds }`) it fades away over the last `seconds` before `end`. The text goes through files in `workDir`, named after `name`, so it needs no escaping.

#### .inkLayer(options)

Returns an ffmpeg filter source for a solid ink layer: `{ w, h, opacity, duration, fadeIn?, fadeOut? }`, where each fade is `{ start, seconds }`.

#### .run(args, cwd?)

Runs ffmpeg with `args`. Returns a `Promise<void>` that rejects with the end of ffmpeg's log when it fails.

#### .ffmpegPath, .ink

The ffmpeg binary and ink color in use.

### Text lines

The `lines` of a hook or tag, and the input of `.drawTexts()`:

| Field | Type | Default | |
|---|---|---|---|
| `text` | `string` | required | |
| `font`, `color` | `string` | required | A font key and an ffmpeg color |
| `size` | `number` | required | |
| `baseline` | `number` | required | y of the text's baseline |
| `x` | `number` | `MARGIN` | |
| `delay` | `number` | `0` | Seconds before the line fades in. `-0.25` has it fully in at the first frame |
| `rise` | `number` | `18` | Pixels the line rises while it fades in |
| `window` | `[number, number]` | | Seconds the line is shown, from the first up to, not including, the second |
| `box` | `{ color, border }` | | A box behind the text, `border` px around it, or `[vertical, horizontal]` |

In a hook or tag, `.renderClip()` sets `delay` and `rise` itself: the lines follow the band's or box's fade and do not rise.

### Constants

| Constant | Value | |
|---|---|---|
| `WIDTH`, `HEIGHT` | `1080`, `1920` | The output frame |
| `FPS` | `30` | |
| `MARGIN` | `96` | Default left edge of text lines |
| `TEXT_WIDTH` | `888` | `WIDTH` less both margins |
| `OUTPUT_ARGS` | ffmpeg arguments | The shared encoding that lets `.concat()` copy the video without re-encoding |
| `FILL_9_16` | ffmpeg filter chain | Centers a landscape picture over a blurred, cropped copy of itself |

## keepitreel/publish

### new Publisher(options)

Returns a publisher that posts videos and images to the platforms of the given providers.

```ts
import { GoogleProvider, MetaProvider, Publisher, TikTokProvider } from "keepitreel/publish";

const publisher = new Publisher({
  providers: [
    new GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }),
    new MetaProvider({ appId: process.env.META_APP_ID, appSecret: process.env.META_APP_SECRET }),
    new TikTokProvider({ clientKey: process.env.TIKTOK_CLIENT_KEY, clientSecret: process.env.TIKTOK_CLIENT_SECRET }),
  ],
  store: { account: (name) => db.account(name), saveAccount: (name, data) => db.saveAccount(name, data) },
});
```

Publisher keeps no records. Your app stores the results it returns.

### options

Type: `object`

#### providers

Type: `Provider[]`\
*Required*

The OAuth apps to sign in with. See [Providers](#providers).

#### store

Type: `{ account(provider), saveAccount(provider, account) }`\
*Required*

Keeps each provider's account (tokens, page, channel) by provider name. Its methods may be sync or async. A platform saves the account again after it refreshes its tokens.

#### maxSeconds

Type: `Record<string, number>`\
*Optional*

Longest video each platform takes, in seconds, by platform name. `.check()` refuses a longer video. A platform you leave out has no limit.

What each platform documents. Limits change, so check the linked page before you rely on one:

| Platform | Documented length | Source |
|---|---|---|
| `youtube` | Up to 3 minutes for a square or vertical Short | [YouTube Help](https://support.google.com/youtube/answer/15424877) |
| `facebook` | 3 to 90 seconds for a Reel | [Reels Publishing API](https://developers.facebook.com/docs/video-api/guides/reels-publishing) |
| `instagram` | 3 seconds to 15 minutes for a Reel | [Instagram media reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media) |
| `tiktok` | Set per account, as `max_video_post_duration_sec`. Direct Posts are checked against it | [Creator info reference](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info) |

`maxSeconds` sets only the longest video; keepitreel does not check the shortest.

```ts
new Publisher({ providers, store, maxSeconds: { youtube: 180, facebook: 90, instagram: 900 } });
```

### Instance

#### .startAuth(provider, redirectUri)

Returns the URL to send the user to, to connect `provider`. `redirectUri` must be registered with the provider's app. Throws a `PublishError` with code `not_configured` when the provider's app keys are missing.

#### .finishAuth(provider, query, redirectUri)

Finishes a sign-in from the callback's query: checks the state, exchanges the code, checks the permissions and saves the account. Returns a `Promise` of the account names that can now post. Rejects when the sign-in was not started here, when the user declined, or with `missing_permission` when a permission signing in needs was not granted.

#### .accounts()

Returns a `Promise` of where videos can go, one status per platform:

| Field | |
|---|---|
| `platform`, `label`, `provider` | Which platform this is |
| `configured` | Whether the provider's app keys were given |
| `connected` | Whether this account can post here |
| `target` | The account name posts go to |
| `problem` | Why a connected account still cannot post here, such as a missing Instagram permission |
| `warning` | A limit that does not stop posting, such as stats the user did not allow |

#### .postAccounts()

The same as `.accounts()`, for image posts.

#### .checkText(text, platforms)

Returns an error message, or `null` when this title and caption can go to these platforms. `text` is `{ title, caption, tags?, titles? }`, where `titles` are the title in other languages by language code. Only YouTube uses `title`, `tags` and `titles`.

#### .check(options)

Returns a `Promise` of an error message, or `null` when a video can go. Checks that each platform is connected, the video's length against your [`maxSeconds`](#maxseconds), the schedule, and each platform's own post settings when `options` has them.

| Option | Type | |
|---|---|---|
| `platforms` | `string[]` | Platform names |
| `seconds` | `number` | Length of the video |
| `options` | `Record<string, unknown>` | Each platform's post screen settings, by platform name. See [TikTok](#tiktok-post-settings) and [paid promotion](#paid-promotion-labels) |
| `publishAt` | `string \| null` | An ISO date and time 10 minutes to 29 days ahead, on platforms that schedule |

#### .publish(options)

Uploads a video to every platform at once. Takes the options of `.check()` without `seconds`, plus `file`, `text` and an optional `log(line)`. Returns a `Promise` of one result per platform: `{ platform, status, url?, note?, error?, code? }`. A platform that fails does not stop the others. Run `.check()` first.

#### .checkPost(platforms, earlier?)

Returns a `Promise` of an error message, or `null` when an image post can go. A platform that takes its images from another (Instagram from Facebook) needs that one in `platforms`, or its earlier `media` in `earlier`.

#### .post(options)

Posts images, one platform after another, with the source platform first. Options are `{ platforms, files, caption, earlier?, log? }`, where `files` are local JPEGs in order. Returns a `Promise` of results like `.publish()`'s, each with the `media` a later post can take its images from. Run `.checkPost()` first.

#### .creatorInfo(platform)

Returns a `Promise` of what the platform's own post screen must show, fetched fresh. Only TikTok has one; see [CreatorInfo](#tiktok-post-settings).

#### .stats(platform, urls)

Returns a `Promise` of a `Map` from each post url to its counts: `views`, `likes`, `comments` and, where the platform reports them, `plays`, `reach`, `shares`, `saves`, `follows`, `watchSeconds`, `engagedViews` and `skipRate`. A count the platform cannot read is `null` or left out, and posts it cannot read are left out. TikTok reports no stats, so its `Map` is empty.

#### .platform(name), .poster(name)

Return the video platform or image platform with that name, or `undefined`.

#### .providers, .platforms, .posters

The providers by name, and every video and image platform.

### Providers

Each provider is one OAuth app. Its app keys may be `undefined`, for example an unset environment variable; the provider is then not configured, and `.accounts()` says so.

#### new GoogleProvider(options)

YouTube Shorts, signed in with a Desktop OAuth client. Options: `clientId`, `clientSecret`, and optionally `categoryId` (such as `'27'`, Education) and `language` (the title and audio language, such as `'en'`).

#### new MetaProvider(options)

Facebook Reels and posts on a Page, and Reels and posts on the Instagram account linked to it. Options: `appId`, `appSecret`, and optionally `configId` (a Facebook Login for Business configuration, for Business apps that sign in with one instead of scopes) and `pageId` (the Page to post to; left out, the first Page the account manages).

#### new TikTokProvider(options)

TikTok inbox drafts and Direct Posts. Options: `clientKey`, `clientSecret`.

#### Provider instance

| Member | |
|---|---|
| `.name` | `'google'`, `'meta'` or `'tiktok'`, the name the store uses |
| `.configured`, `.missing` | Whether all app keys were given, and the names of those that were not |
| `.platforms`, `.posters` | Where its account posts videos and images |
| `.authUrl({ redirectUri, state, verifier })` | The sign-in URL. `verifier` is the PKCE code verifier |
| `.connect({ code, redirectUri, verifier })` | Turns the callback code into the account uploads need |

Each of the three also has `.options`, the options it was made with.

`GoogleProvider` and `TikTokProvider` also have `.accessToken(account)`, which returns a current access token (TikTok's also takes `save`, and saves refreshed tokens). `GoogleProvider` has `.token(params)` for calls to Google's token endpoint. `MetaProvider` has the helpers its platforms share: `.sendFile()` for Meta's upload host, `.publishInstagram()`, and `.insights()`.

### Platforms

| Platform | Name | Provider | Schedules |
|---|---|---|---|
| `YouTubeShorts` | `youtube` | Google | Yes |
| `FacebookReels` | `facebook` | Meta | Yes |
| `InstagramReels` | `instagram` | Meta | No |
| `TikTok` | `tiktok` | TikTok | No |

Set the longest video each one takes with the [`maxSeconds`](#maxseconds) option.

Image posts go to `FacebookPosts` (`facebook`) and `InstagramPosts` (`instagram`, which takes its images from the Facebook post).

Every platform has `.name`, `.label`, `.provider`, `.missing` (why a connected account cannot post here) and these methods:

| Method | |
|---|---|
| `.target(account)` | The account name to show, or `null` when this account cannot post here |
| `.missingPermissions(account)` | Permissions posting here needs that this account did not grant |
| `.warning(account)` | A limit that does not stop posting, or `null` |

Video platforms also have `.schedules`, `.upload(args)`, `.stats(args)`, `.checkOptions(args)` and `.creatorInfo(account, save)`. Image platforms also have `.imagesFrom`, `.post(args)` and `.imageUrls(account, media)`.

To add a platform, extend `Provider` with `authUrl` and `connect`, and `Platform` with `target` and `upload` (or `PostPlatform` with `target` and `post`). The provider's constructor fills `this.platforms` and `this.posters` with its platforms. The argument types are exported: `AuthUrlArgs`, `ConnectArgs`, `UploadArgs`, `StatsArgs`, `CheckOptionsArgs` and `PostArgs`.

### TikTok post settings

`.creatorInfo('tiktok')` returns `{ nickname, username, avatar, privacyOptions, maxSeconds, commentDisabled, duetDisabled, stitchDisabled }`, which TikTok requires its post screen to show.

Pass the screen's choices to `.check()` and `.publish()` as `options.tiktok`:

| Field | |
|---|---|
| `mode` | `'direct'` posts the video; anything else sends it to the creator's inbox as a draft |
| `privacy` | One of `privacyOptions` |
| `allowComment`, `allowDuet`, `allowStitch` | Off unless turned on |
| `disclose` | Whether the post promotes something; then `yourBrand`, `branded` or both |

### Paid promotion labels

Pass these to `.check()` and `.publish()` as `options.youtube` and `options.instagram`. TikTok's is `disclose` in its [post settings](#tiktok-post-settings).

| Platform | Field | |
|---|---|---|
| `youtube` | `paidPromotion` | Ticks "Includes paid promotion" |
| `instagram` | `paidPartnership` | Shows the "Paid partnership" label |
| `instagram` | `sponsorIds` | Instagram user ids of up to 2 brands to name in the label, as strings. Find one by username with the Business Discovery API |

YouTube's docs do not list the paid promotion flag as settable on upload. keepitreel sends it and reads it back, and when YouTube drops it the result's `note` says to tick it in YouTube Studio.

Instagram refuses the post when the account has not turned on branded content tools. A brand that has not approved the account shows as "Paid partnership" until it does.

Facebook's Reels API has no branded content field, so label Facebook Reels on Facebook after posting.

### Errors and permissions

Errors the app can act on are `PublishError`s with a `code`:

| Code | |
|---|---|
| `not_configured` | The provider's app keys are missing |
| `not_connected` | No account is connected for the platform |
| `reconnect` | The sign-in expired or was revoked |
| `missing_permission` | The user did not allow something the call needs |
| `platform` | Anything else the platform refused, with its own message |

A failed `.publish()` or `.post()` result carries the same `code`.

Permissions are checked when an account connects. A permission that signing in needs stops the sign-in with `missing_permission`. Facebook and Instagram are checked apart: declining Instagram's permissions leaves Facebook connected, and `.accounts()` gives Instagram a `problem` naming what is missing. Analytics permissions are optional: without them the account still connects and posts, `.stats()` returns less, and `.accounts()` says so in each platform's `warning`.

### api(url, options?)

The fetch wrapper the platforms use, for calls of your own. Returns a `Promise` of the response's JSON, and throws a `PublishError` with the platform's own message when it refuses, including the 200 answers TikTok uses for some refusals.

Options: `method`, `token` (sent as a Bearer token), `form` (sent url-encoded), `json`, `headers` and `body`.

### waitFor(check, what, options?)

Polls `check()` until it returns `true`, every `everyMs` (default 3000) for up to `timeoutMs` (default 10 minutes), then throws "Gave up waiting for `what`".

### Constants

| Constant | Value | |
|---|---|---|
| `MAX_TITLE` | `100` | YouTube's title limit |
| `MAX_CAPTION` | `2200` | Instagram's caption limit, the tightest of the platforms that take a caption |

## Caveats

- **Each platform needs its own developer app.** Uploads stay private until Google audits the YouTube app, and TikTok Direct Posts are "Only me" until TikTok audits it.
- **Video length limits are yours to set.** keepitreel checks none by default, because the platforms change theirs. Set them with the `maxSeconds` option; its section lists what each platform documents.
- **Transcription runs Python**, so the package cannot install it. See [Install](#install).
- **Whisper can make words up in long silences**, often the `prompt` read back. `hallucination_silence_threshold` in [`transcribeOptions`](#transcribeoptions) reduces it; check it on your own audio.
- **On Linux, ffmpeg-static's binary has no `drawtext` filter**, which text lines and subtitles need. Install your distribution's ffmpeg (`apt install ffmpeg`) and pass it as `ffmpegPath`, or set `FFMPEG_BIN` to its path, which ffmpeg-static then returns.

## Related

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper): the Whisper implementation `keepitreel/transcribe` runs
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static): ffmpeg binaries for Node.js

## License

MIT
