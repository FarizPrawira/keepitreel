import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { permissionMessage, PublishError, type PublishErrorCode } from "./errors.js";
import type { Destination, Log, Platform, PostPlatform, PostStats, Provider, PublishText } from "./provider.js";

/** YouTube's title limit. */
export const MAX_TITLE = 100;
/** Instagram's caption limit, the tightest of the platforms that take a caption. */
export const MAX_CAPTION = 2200;
// Facebook schedules Reels from 10 minutes to 29 days ahead. YouTube has no limit, so the same
// window serves both.
const SCHEDULE_MIN_MINUTES = 10;
const SCHEDULE_MAX_DAYS = 29;

const codeOf = (err: unknown) => (err instanceof PublishError ? { code: err.code } : {});

/** Where connected accounts (tokens, page, channel) are kept, by provider name. */
export interface AccountStore {
  account(provider: string): unknown | Promise<unknown>;
  saveAccount(provider: string, account: unknown): void | Promise<void>;
}

export interface PublisherOptions {
  providers: Provider<any>[];
  store: AccountStore;
  /** Longest video each platform takes, in seconds, by platform name. Others have no limit. */
  maxSeconds?: Record<string, number>;
}

export interface AccountStatus {
  platform: string;
  label: string;
  provider: string;
  /** Whether the provider's app keys were given. */
  configured: boolean;
  connected: boolean;
  /** The account name posts go to. */
  target: string | null;
  /** Why a connected account still cannot post here. */
  problem: string | null;
  /** A limit that does not stop posting, such as stats the user did not allow. */
  warning: string | null;
}

export interface PublishResult {
  platform: string;
  status: "done" | "failed";
  url?: string | null;
  note?: string | null;
  /** For image posts: what a later post that takes its images from this one needs. */
  media?: unknown;
  error?: string;
  /** What the app can do about the error, when the failure was a {@link PublishError}. */
  code?: PublishErrorCode;
}

export interface CheckOptions {
  platforms: string[];
  /** Length of the video, for the platforms' limits. */
  seconds: number;
  /** Each platform's post screen settings, by platform name. */
  options?: Record<string, unknown>;
  /** An ISO date and time to make the video public at, on platforms that schedule. */
  publishAt?: string | null;
}

export interface PublishOptions {
  platforms: string[];
  file: string;
  text: PublishText;
  options?: Record<string, unknown>;
  publishAt?: string | null;
  log?: Log;
}

export interface PostOptions {
  platforms: string[];
  /** The images, in order. */
  files: string[];
  caption: string;
  /**
   * `media` of earlier image posts by platform name, for a platform that takes its images from
   * one posted before (Instagram from Facebook).
   */
  earlier?: Record<string, unknown>;
  log?: Log;
}

/** Posts videos and images to the platforms of the given providers. */
export class Publisher {
  readonly providers: Map<string, Provider<any>>;
  readonly platforms: Platform[];
  readonly posters: PostPlatform[];
  private readonly store: AccountStore;
  private readonly limits: Record<string, number>;
  // OAuth state -> sign-in started in this run.
  private readonly pending = new Map<string, { provider: string; verifier: string }>();

  constructor({ providers, store, maxSeconds = {} }: PublisherOptions) {
    this.providers = new Map(providers.map((p) => [p.name, p]));
    this.platforms = providers.flatMap((p) => p.platforms);
    this.posters = providers.flatMap((p) => p.posters);
    this.store = store;
    this.limits = maxSeconds;
  }

  platform(name: string): Platform | undefined {
    return this.platforms.find((p) => p.name === name);
  }

  poster(name: string): PostPlatform | undefined {
    return this.posters.find((p) => p.name === name);
  }

  private saver(provider: Provider) {
    return (account: unknown) => this.store.saveAccount(provider.name, account);
  }

  // Why `p` cannot post with this stored account, or null when it can.
  private connectionError(p: Destination, account: unknown): PublishError | null {
    if (!account || !p.target(account)) return new PublishError("not_connected", `${p.label} is not connected`);
    const missing = p.missingPermissions(account);
    return missing.length ? new PublishError("missing_permission", permissionMessage(p.label, missing)) : null;
  }

  private async requireConnected(p: Destination): Promise<unknown> {
    const account = await this.store.account(p.provider.name);
    const error = this.connectionError(p, account);
    if (error) throw error;
    return account;
  }

  private async status(p: Destination): Promise<AccountStatus> {
    const account = await this.store.account(p.provider.name);
    const target = account ? p.target(account) : null;
    const error = this.connectionError(p, account);
    let problem: string | null = null;
    if (account && error) problem = error.code === "missing_permission" ? error.message : p.missing;
    return {
      platform: p.name, label: p.label, provider: p.provider.name,
      configured: p.provider.configured, connected: !error, target: target || null,
      problem, warning: error ? null : p.warning(account),
    };
  }

  /** Where videos can go, and whether each is connected. */
  accounts(): Promise<AccountStatus[]> {
    return Promise.all(this.platforms.map((p) => this.status(p)));
  }

  /** Where image posts can go, and whether each is connected. */
  postAccounts(): Promise<AccountStatus[]> {
    return Promise.all(this.posters.map((p) => this.status(p)));
  }

  /**
   * The URL to send the user to, to connect `provider`. `redirectUri` must be registered with
   * the provider's app.
   */
  startAuth(provider: string, redirectUri: string): string {
    const p = this.providers.get(provider);
    if (!p) throw new Error(`Unknown provider "${provider}"`);
    if (!p.configured) throw new PublishError("not_configured", `${provider} needs ${p.missing.join(" and ")}`);
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, { provider, verifier });
    return p.authUrl({ redirectUri, state, verifier });
  }

  /**
   * Finishes a sign-in from the callback's query. Returns the names of the accounts now
   * connected.
   */
  async finishAuth(provider: string, query: Record<string, unknown>, redirectUri: string): Promise<string[]> {
    const started = this.pending.get(String(query.state));
    this.pending.delete(String(query.state));
    if (!started || started.provider !== provider) throw new Error("This sign-in was not started here, or the app restarted. Start it again.");
    if (query.error) throw new Error(String(query.error_description || query.error));
    const p = this.providers.get(provider)!;
    const account = await p.connect({ code: String(query.code), redirectUri, verifier: started.verifier });
    await this.store.saveAccount(provider, account);
    return p.platforms.filter((pl) => !this.connectionError(pl, account)).map((pl) => pl.target(account) as string);
  }

  /** What a platform's own post screen needs, fetched fresh (TikTok's creator info). */
  async creatorInfo(platform: string): Promise<unknown> {
    const p = this.platform(platform);
    if (!p) throw new Error(`Unknown platform "${platform}"`);
    return p.creatorInfo(await this.requireConnected(p), this.saver(p.provider));
  }

  /**
   * An error message, or null when this title and caption can go to these platforms. Only
   * YouTube uses the title.
   */
  checkText({ title, caption, titles }: PublishText, platforms: string[]): string | null {
    const youtube = platforms.includes("youtube");
    const captionLength = caption.trim().length;
    if (youtube && !title.trim()) return "YouTube needs a title";
    if (!captionLength) return "The caption can't be empty";
    if (captionLength > MAX_CAPTION) return `The caption is ${captionLength} characters; Instagram allows ${MAX_CAPTION}`;
    if (!youtube) return null;
    for (const [lang, t] of [["", title], ...Object.entries(titles ?? {})] as [string, string][]) {
      const which = lang ? `The ${lang} title` : "The title";
      const length = t.trim().length;
      if (!length) return `${which} can't be empty`;
      if (length > MAX_TITLE) return `${which} is ${length} characters; YouTube allows ${MAX_TITLE}`;
      if (/[<>]/.test(t)) return `YouTube does not allow < or > in ${which.toLowerCase()}`;
    }
    if (/[<>]/.test(caption)) return "YouTube does not allow < or > in the caption, which becomes the video description";
    return null;
  }

  /** An error message, or null when a video can go to these platforms with these settings. */
  async check({ platforms, seconds, options = {}, publishAt = null }: CheckOptions): Promise<string | null> {
    if (!platforms.length) return `Pick at least one of ${this.platforms.map((p) => p.name).join(", ")}`;
    if (publishAt != null) {
      const ahead = Date.parse(publishAt) - Date.now();
      if (Number.isNaN(ahead)) return `"publishAt" must be an ISO date and time`;
      if (ahead < SCHEDULE_MIN_MINUTES * 60_000 || ahead > SCHEDULE_MAX_DAYS * 86_400_000) {
        return `A post can be scheduled from ${SCHEDULE_MIN_MINUTES} minutes to ${SCHEDULE_MAX_DAYS} days ahead`;
      }
      const unscheduled = platforms.map((name) => this.platform(name)).find((p) => p && !p.schedules);
      if (unscheduled) return `${unscheduled.label} cannot schedule a post; publish it now instead`;
    }
    for (const name of platforms) {
      const p = this.platform(name);
      if (!p) return `Unknown platform "${name}"`;
      const account = await this.store.account(p.provider.name);
      const error = this.connectionError(p, account);
      if (error) return error.message;
      const maxSeconds = this.limits[name];
      if (maxSeconds !== undefined && seconds > maxSeconds) return `${p.label} takes videos up to ${maxSeconds}s, and this one is ${Math.round(seconds)}s`;
      if (options[name] !== undefined) {
        try {
          const why = await p.checkOptions({ account, save: this.saver(p.provider), options: options[name], seconds });
          if (why) return `${p.label}: ${why}`;
        } catch (err) {
          const message = (err as Error).message;
          if (err instanceof PublishError && err.code === "reconnect") return `${p.label} needs to be connected again (${message})`;
          if (err instanceof PublishError && err.code === "missing_permission") {
            return `${p.label} is missing a permission (${message}). Connect again and allow it.`;
          }
          return `${p.label} cannot take a post right now (${message}). Try again later.`;
        }
      }
    }
    return null;
  }

  /**
   * Uploads a video to every platform at once. A platform that fails does not stop the others;
   * each one's outcome is in the result. With `publishAt`, the platforms keep the video private
   * and make it public then. Run {@link check} first.
   */
  async publish({ platforms, file, text, options = {}, publishAt = null, log = () => {} }: PublishOptions): Promise<PublishResult[]> {
    const at = publishAt == null ? null : new Date(publishAt);
    const size = statSync(file).size;
    return Promise.all(
      platforms.map(async (name): Promise<PublishResult> => {
        const p = this.platform(name);
        if (!p) return { platform: name, status: "failed", error: `Unknown platform "${name}"` };
        const line = (msg: string) => log(`${p.label}: ${msg}`);
        try {
          const account = await this.requireConnected(p);
          line(`uploading ${(size / 1024 / 1024).toFixed(1)} MB`);
          const { url, note = null } = await p.upload({ account, save: this.saver(p.provider), file, size, text, log: line, options: options[name], publishAt: at });
          line(url ? `${at ? `scheduled for ${at.toISOString()}` : "posted"}, ${url}` : `done${note ? `. ${note}` : ""}`);
          return { platform: name, status: "done", url, note };
        } catch (err) {
          line(`failed: ${(err as Error).message}`);
          return { platform: name, status: "failed", error: (err as Error).message, ...codeOf(err) };
        }
      }),
    );
  }

  /** An error message, or null when an image post can go to these platforms. */
  async checkPost(platforms: string[], earlier: Record<string, unknown> = {}): Promise<string | null> {
    if (!platforms.length) return `Pick at least one of ${this.posters.map((p) => p.name).join(", ")}`;
    for (const name of platforms) {
      const p = this.poster(name);
      if (!p) return `Unknown platform "${name}"`;
      const error = this.connectionError(p, await this.store.account(p.provider.name));
      if (error) return error.message;
      const from = p.imagesFrom;
      if (from && !platforms.includes(from) && earlier[from] === undefined) {
        const source = this.poster(from)?.label ?? from;
        return `${p.label} takes its images from the ${source} post, so post to ${source} first or together`;
      }
    }
    return null;
  }

  /**
   * Posts images, one platform after another: a platform that takes its images from another
   * goes after it. Run {@link checkPost} first.
   */
  async post({ platforms, files, caption, earlier = {}, log = () => {} }: PostOptions): Promise<PublishResult[]> {
    const posters = platforms
      .map((n) => this.poster(n))
      .filter((p): p is PostPlatform => !!p)
      .sort((a, b) => Number(!!a.imagesFrom) - Number(!!b.imagesFrom));
    const media: Record<string, unknown> = { ...earlier };
    const results: PublishResult[] = [];
    for (const p of posters) {
      const line = (msg: string) => log(`${p.label}: ${msg}`);
      try {
        const account = await this.requireConnected(p);
        let urls: string[] | null = null;
        if (p.imagesFrom) {
          if (media[p.imagesFrom] === undefined) throw new Error(`the ${this.poster(p.imagesFrom)?.label ?? p.imagesFrom} post failed, so there are no images to take`);
          urls = await this.poster(p.imagesFrom)!.imageUrls(account, media[p.imagesFrom]);
        }
        line(`posting ${files.length === 1 ? "1 image" : `${files.length} images`}`);
        const result = await p.post({ account, files, urls, caption, log: line });
        if (result.media !== undefined) media[p.name] = result.media;
        line(`posted, ${result.url}`);
        results.push({ platform: p.name, status: "done", url: result.url, note: result.note ?? null, media: result.media });
      } catch (err) {
        line(`failed: ${(err as Error).message}`);
        results.push({ platform: p.name, status: "failed", error: (err as Error).message, ...codeOf(err) });
      }
    }
    return results;
  }

  /**
   * Current counts of posts on one platform, by url. Posts the platform cannot read are left
   * out.
   */
  async stats(platform: string, urls: string[]): Promise<Map<string, PostStats>> {
    const p = this.platform(platform);
    if (!p) throw new Error(`Unknown platform "${platform}"`);
    return p.stats({ account: await this.requireConnected(p), save: this.saver(p.provider), urls });
  }
}
