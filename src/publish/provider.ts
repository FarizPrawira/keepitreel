const abstract = (self: object, method: string) => new Error(`${self.constructor.name} does not implement ${method}`);

/** Stores a provider's account again, after a platform refreshed its tokens. */
export type SaveAccount<A> = (account: A) => void | Promise<void>;

/** Adds a line to the publishing log, for steps that take a while. */
export type Log = (message: string) => void;

/** What a video is published with. Only YouTube uses `title`, `tags` and `titles`. */
export interface PublishText {
  title: string;
  caption: string;
  tags?: string[];
  /**
   * The title in other languages, by language code. YouTube shows viewers the one their app
   * uses.
   */
  titles?: Record<string, string>;
}

export interface UploadResult {
  /** The post's link, or null where the platform gives none (a TikTok inbox draft). */
  url: string | null;
  note?: string | null;
}

/** A post's counts. Platforms that cannot read a count leave it null or out. */
export interface PostStats {
  views: number | null;
  likes: number | null;
  comments: number | null;
  plays?: number | null;
  reach?: number | null;
  shares?: number | null;
  saves?: number | null;
  follows?: number | null;
  /** Average seconds watched per view. */
  watchSeconds?: number | null;
  engagedViews?: number | null;
  skipRate?: number | null;
}

export interface AuthUrlArgs {
  redirectUri: string;
  state: string;
  /** The PKCE code verifier. */
  verifier: string;
}

export interface ConnectArgs {
  code: string;
  redirectUri: string;
  verifier: string;
}

/**
 * One OAuth app (Google, Meta, TikTok): signs the user in and owns the platforms that
 * account can post to. Subclasses fill `platforms` and `posters` in their constructor.
 */
export abstract class Provider<A = unknown> {
  readonly name: string;
  /** Where its account posts videos. */
  platforms: Platform<A>[] = [];
  /** Where its account posts images (feed posts), if anywhere. */
  posters: PostPlatform<A>[] = [];
  private readonly credentials: Record<string, string | undefined>;

  /** `credentials` are the app keys by name; a missing one leaves the provider unconfigured. */
  constructor(name: string, credentials: Record<string, string | undefined>) {
    this.name = name;
    this.credentials = credentials;
  }

  /** Names of the app keys that were not given. */
  get missing(): string[] {
    return Object.entries(this.credentials).filter(([, v]) => !v).map(([k]) => k);
  }

  get configured(): boolean {
    return this.missing.length === 0;
  }

  /** Where to send the user to sign in. */
  abstract authUrl(args: AuthUrlArgs): string;

  /** Turns the callback code into the account data uploads need (tokens, page, channel). */
  abstract connect(args: ConnectArgs): Promise<A>;
}

export interface DestinationOptions {
  name: string;
  label: string;
  /** Why a connected account still cannot post here. */
  missing?: string | null;
}

/** What video and image platforms share: a name, and the provider whose account posts there. */
export abstract class Destination<A = unknown> {
  readonly provider: Provider<A>;
  readonly name: string;
  readonly label: string;
  readonly missing: string | null;

  constructor(provider: Provider<A>, { name, label, missing = null }: DestinationOptions) {
    this.provider = provider;
    this.name = name;
    this.label = label;
    this.missing = missing;
  }

  /** The account name to show, or null when this account cannot post here. */
  abstract target(account: A): string | null;

  /** Permissions posting here needs that this account did not grant. */
  missingPermissions(_account: A): string[] {
    return [];
  }

  /** A limit that does not stop posting here, such as stats the user did not allow, or null. */
  warning(_account: A): string | null {
    return null;
  }
}

export interface PlatformOptions extends DestinationOptions {
  /** Whether the platform itself can make an upload public later. */
  schedules?: boolean;
}

export interface UploadArgs<A> {
  account: A;
  save: SaveAccount<A>;
  file: string;
  size: number;
  text: PublishText;
  log: Log;
  /** Settings from the platform's own post screen, if it has one. */
  options?: unknown;
  /** When the post goes public, on platforms that schedule. Null means now. */
  publishAt: Date | null;
}

export interface CheckOptionsArgs<A> {
  account: A;
  save: SaveAccount<A>;
  /** Settings from the platform's own post screen. */
  options: unknown;
  /** Length of the video. */
  seconds: number;
}

export interface StatsArgs<A> {
  account: A;
  save: SaveAccount<A>;
  urls: string[];
}

/** One place videos are posted to, using its provider's account. */
export abstract class Platform<A = unknown> extends Destination<A> {
  readonly schedules: boolean;

  constructor(provider: Provider<A>, options: PlatformOptions) {
    super(provider, options);
    this.schedules = options.schedules ?? false;
  }

  /**
   * Why the settings from this platform's own post screen cannot be used, or null. Checked
   * before anything is uploaded. Platforms without such a screen accept anything.
   */
  async checkOptions(_args: CheckOptionsArgs<A>): Promise<string | null> {
    return null;
  }

  /** What the platform's own post screen must show, for platforms that have one. */
  async creatorInfo(_account: A, _save: SaveAccount<A>): Promise<unknown> {
    throw abstract(this, "creatorInfo");
  }

  abstract upload(args: UploadArgs<A>): Promise<UploadResult>;

  /** The current counts of posts, by url. Platforms that cannot read them return an empty Map. */
  async stats(_args: StatsArgs<A>): Promise<Map<string, PostStats>> {
    return new Map();
  }
}

export interface PostPlatformOptions extends DestinationOptions {
  /**
   * A platform that downloads images instead of taking files names the poster it takes them
   * from, which must have posted them first.
   */
  imagesFrom?: string | null;
}

/**
 * The images, in order, with `caption`. `files` are the local JPEGs; with `imagesFrom`,
 * `urls` are the same images' public links there.
 */
export interface PostArgs<A> {
  account: A;
  files: string[];
  urls: string[] | null;
  caption: string;
  log: Log;
}

export interface PostResult {
  url: string;
  /** Whatever `imageUrls` needs to find the images again. */
  media?: unknown;
  note?: string | null;
}

/** One place image posts go, using its provider's account. */
export abstract class PostPlatform<A = unknown> extends Destination<A> {
  /** See {@link PostPlatformOptions.imagesFrom}. */
  readonly imagesFrom: string | null;

  constructor(provider: Provider<A>, options: PostPlatformOptions) {
    super(provider, options);
    this.imagesFrom = options.imagesFrom ?? null;
  }

  /** Posts the images, in order. */
  abstract post(args: PostArgs<A>): Promise<PostResult>;

  /** Public links of the images of an earlier post, from its `media`. */
  async imageUrls(_account: A, _media: unknown): Promise<string[]> {
    throw abstract(this, "imageUrls");
  }
}
