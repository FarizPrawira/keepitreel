import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { api, platformError } from "./api.js";
import { ifPermitted, requirePermissions } from "./errors.js";
import {
  Platform,
  Provider,
  type AuthUrlArgs,
  type ConnectArgs,
  type PostStats,
  type StatsArgs,
  type UploadArgs,
  type UploadResult,
} from "./provider.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// readonly shows which channel is connected (upload alone cannot list channels) and reads
// view counts, so posting needs both. yt-analytics reads watch time, shares and subscribers
// gained; stats work without it.
const REQUIRED_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
const ANALYTICS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
// A top-videos report returns at most 200 rows, so it is asked about at most 200 videos.
const MAX_REPORT_IDS = 200;
// Reports need a start date; any day before the channel's first upload covers its whole life.
const FIRST_DAY = "2020-01-01";
const VIDEOS_PER_LIST = 50;

// The OAuth client is a Desktop app: Google sends the sign-in back to a loopback IP address,
// not "localhost".
const loopback = (uri: string) => uri.replace("://localhost:", "://127.0.0.1:");

export interface GoogleAccount {
  refreshToken: string;
  channel: { id: string; name: string };
  /** The scopes the user granted. Left out, all are assumed. */
  scopes?: string[];
}

const analyticsGranted = (account: GoogleAccount) => account.scopes?.includes(ANALYTICS_SCOPE) ?? true;

export interface GoogleOptions {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** YouTube video category id, such as "27" (Education). Left out, YouTube uses its default. */
  categoryId?: string;
  /** Language of the title and audio, such as "en". Left out, YouTube guesses. */
  language?: string;
}

/** Google sign-in (a Desktop OAuth client) for YouTube Shorts. */
export class GoogleProvider extends Provider<GoogleAccount> {
  readonly options: GoogleOptions;

  constructor(options: GoogleOptions) {
    super("google", { clientId: options.clientId, clientSecret: options.clientSecret });
    this.options = options;
    this.platforms = [new YouTubeShorts(this)];
  }

  authUrl({ redirectUri, state, verifier }: AuthUrlArgs): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId ?? "",
      redirect_uri: loopback(redirectUri),
      response_type: "code",
      scope: [...REQUIRED_SCOPES, ANALYTICS_SCOPE].join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  token(params: Record<string, string>) {
    return api(TOKEN_URL, {
      method: "POST",
      form: { client_id: this.options.clientId ?? "", client_secret: this.options.clientSecret ?? "", ...params },
    });
  }

  async connect({ code, redirectUri, verifier }: ConnectArgs): Promise<GoogleAccount> {
    const t = await this.token({ code, redirect_uri: loopback(redirectUri), grant_type: "authorization_code", code_verifier: verifier });
    const scopes = String(t.scope).split(" ");
    requirePermissions("YouTube", REQUIRED_SCOPES, scopes);
    const { items } = await api("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { token: t.access_token });
    if (!items?.length) throw new Error("This Google account has no YouTube channel. Create one, then connect again.");
    return { refreshToken: t.refresh_token, channel: { id: items[0].id, name: items[0].snippet.title }, scopes };
  }

  async accessToken(account: GoogleAccount): Promise<string> {
    return (await this.token({ refresh_token: account.refreshToken, grant_type: "refresh_token" })).access_token;
  }
}

export class YouTubeShorts extends Platform<GoogleAccount> {
  declare readonly provider: GoogleProvider;

  constructor(provider: GoogleProvider) {
    super(provider, { name: "youtube", label: "YouTube Shorts", schedules: true });
  }

  target(account: GoogleAccount): string {
    return account.channel.name;
  }

  override warning(account: GoogleAccount): string | null {
    return analyticsGranted(account) ? null : "YouTube Analytics was not allowed, so stats have views, likes and comments only";
  }

  async upload({ account, file, size, text, publishAt }: UploadArgs<GoogleAccount>): Promise<UploadResult> {
    const accessToken = await this.provider.accessToken(account);
    const { categoryId, language } = this.provider.options;
    // Viewers whose YouTube is set to one of these languages see that title. The description
    // stays the caption.
    const translated = Object.entries(text.titles ?? {});
    const localizations = Object.fromEntries(translated.map(([lang, title]) => [lang, { title, description: text.caption }]));
    const parts = translated.length ? "snippet,status,localizations" : "snippet,status";
    const initUrl = `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=${parts}`;
    const init = await fetch(initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: {
          title: text.title,
          description: text.caption,
          ...(text.tags ? { tags: text.tags } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(language ? { defaultLanguage: language, defaultAudioLanguage: language } : {}),
        },
        // A scheduled video stays private until YouTube makes it public at publishAt.
        status: publishAt
          ? { privacyStatus: "private", publishAt: publishAt.toISOString(), selfDeclaredMadeForKids: false }
          : { privacyStatus: "public", selfDeclaredMadeForKids: false },
        ...(translated.length ? { localizations } : {}),
      }),
    });
    if (!init.ok) throw platformError(initUrl, init.status, await init.text());
    const video = await api(init.headers.get("location") as string, {
      method: "PUT",
      token: accessToken,
      headers: { "Content-Type": "video/mp4" },
      body: readFileSync(file),
    });
    const locked = publishAt ? !video.status?.publishAt : video.status?.privacyStatus !== "public";
    return {
      url: `https://youtube.com/shorts/${video.id}`,
      note: locked ? "YouTube keeps it private until Google audits this app" : null,
    };
  }

  override async stats({ account, urls }: StatsArgs<GoogleAccount>): Promise<Map<string, PostStats>> {
    const accessToken = await this.provider.accessToken(account);
    const urlById = new Map(urls.map((url) => [url.split("/").pop() as string, url]));
    const ids = [...urlById.keys()];
    // A channel can hide like counts, so a missing count stays null.
    const count = (n: unknown) => (n == null ? null : Number(n));
    const counts = new Map<string, PostStats>();
    for (let i = 0; i < ids.length; i += VIDEOS_PER_LIST) {
      const { items } = await api(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.slice(i, i + VIDEOS_PER_LIST).join(",")}`, { token: accessToken });
      for (const { id, statistics: s } of items) {
        counts.set(urlById.get(id) as string, { views: count(s.viewCount), likes: count(s.likeCount), comments: count(s.commentCount) });
      }
    }
    if (!analyticsGranted(account)) return counts;
    // Analytics lags a day or two, so a new video has no row yet and keeps only its counts.
    const endDate = new Date().toISOString().slice(0, 10);
    await ifPermitted(async () => {
      for (let i = 0; i < ids.length; i += MAX_REPORT_IDS) {
        const params = new URLSearchParams({
          ids: "channel==MINE", startDate: FIRST_DAY, endDate,
          metrics: "views,engagedViews,averageViewDuration,shares,subscribersGained",
          dimensions: "video", filters: `video==${ids.slice(i, i + MAX_REPORT_IDS).join(",")}`,
          sort: "-views", maxResults: String(MAX_REPORT_IDS),
        });
        const { columnHeaders, rows = [] } = await api(`${ANALYTICS_URL}?${params}`, { token: accessToken });
        const col: Record<string, number> = Object.fromEntries(columnHeaders.map((h: { name: string }, n: number) => [h.name, n]));
        for (const row of rows) {
          const c = counts.get(urlById.get(row[col.video!]) as string);
          if (c) {
            Object.assign(c, {
              engagedViews: row[col.engagedViews!], watchSeconds: row[col.averageViewDuration!], shares: row[col.shares!], follows: row[col.subscribersGained!],
            });
          }
        }
      }
    });
    return counts;
  }
}
