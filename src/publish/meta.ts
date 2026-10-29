import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { api, waitFor, type Json } from "./api.js";
import { ifPermitted, requirePermissions } from "./errors.js";
import {
  Platform,
  PostPlatform,
  Provider,
  type AuthUrlArgs,
  type CheckOptionsArgs,
  type ConnectArgs,
  type Log,
  type PostArgs,
  type PostResult,
  type PostStats,
  type StatsArgs,
  type UploadArgs,
  type UploadResult,
} from "./provider.js";

const VERSION = "v25.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
// Signing in needs the Page permissions. The Instagram ones only gate the Instagram platforms,
// so declining them leaves Facebook connected. business_management only matters for Pages a
// business portfolio owns, and the insights permissions only for stats, so neither is required.
const PAGE_PERMISSIONS = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const INSTAGRAM_PERMISSIONS = ["instagram_basic", "instagram_content_publish"];
const SCOPES = [...PAGE_PERMISSIONS, ...INSTAGRAM_PERMISSIONS, "business_management", "read_insights", "instagram_manage_insights"];
const NO_INSIGHTS = "Insights were not allowed, so stats are not available";
// Both play counts include replays, like YouTube's views.
const FACEBOOK_METRICS = [
  "fb_reels_total_plays", "blue_reels_play_count", "post_video_avg_time_watched",
  "post_video_social_actions", "post_video_likes_by_reaction_type", "post_video_followers",
];
const INSTAGRAM_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "ig_reels_avg_watch_time", "reels_skip_rate"];

const auth = (token: string) => ({ Authorization: `OAuth ${token}` });
const UPLOAD_RETRY_SECONDS = [20, 40, 60];
const seconds = (ms: number | null | undefined) => (ms == null ? null : ms / 1000);
// Some metrics come as counts by type ({ like: 3, love: 1 }): `key` picks one type, or all
// are added up.
const tally = (value: unknown, key?: string): number | null => {
  if (value == null || typeof value !== "object") return (value as number | null | undefined) ?? null;
  const entries = Object.entries(value as Record<string, number>).filter(([k]) => !key || k.toLowerCase().includes(key));
  return entries.reduce((sum, [, n]) => sum + n, 0);
};

export interface MetaAccount {
  page: { id: string; name: string; token: string };
  instagram: { id: string; username: string } | null;
  /** The permissions the user granted. Left out, all are assumed. */
  permissions?: string[];
}

export interface MetaOptions {
  appId: string | undefined;
  appSecret: string | undefined;
  /**
   * A Facebook Login for Business configuration id, for Business-type apps that sign in with
   * one instead of scopes.
   */
  configId?: string;
  /** The Page to post to. Left out, the first Page the account manages. */
  pageId?: string;
}

export interface InstagramPostOptions {
  /** Shows the "Paid partnership" label. The account needs Instagram's branded content tools. */
  paidPartnership?: boolean;
  /** Instagram user ids of up to 2 brands to name in the label. */
  sponsorIds?: string[];
}

const MAX_SPONSORS = 2;

const NO_INSTAGRAM = "The Facebook Page has no linked Instagram Business or Creator account";
const instagramHandle = (account: MetaAccount) => account.instagram && `@${account.instagram.username}`;
const granted = (account: MetaAccount, permission: string) => account.permissions?.includes(permission) ?? true;
const missingInstagram = (account: MetaAccount) => (account.instagram ? INSTAGRAM_PERMISSIONS.filter((p) => !granted(account, p)) : []);

function instagramId(account: MetaAccount): string {
  if (!account.instagram) throw new Error(NO_INSTAGRAM);
  return account.instagram.id;
}

/** Facebook Login for a Page's Reels and feed, and the Instagram account linked to the Page. */
export class MetaProvider extends Provider<MetaAccount> {
  readonly options: MetaOptions;

  constructor(options: MetaOptions) {
    super("meta", { appId: options.appId, appSecret: options.appSecret });
    this.options = options;
    this.platforms = [new FacebookReels(this), new InstagramReels(this)];
    this.posters = [new FacebookPosts(this), new InstagramPosts(this)];
  }

  authUrl({ redirectUri, state }: AuthUrlArgs): string {
    const params = new URLSearchParams({ client_id: this.options.appId ?? "", redirect_uri: redirectUri, state, response_type: "code" });
    if (this.options.configId) params.set("config_id", this.options.configId);
    else params.set("scope", SCOPES.join(","));
    return `https://www.facebook.com/${VERSION}/dialog/oauth?${params}`;
  }

  async connect({ code, redirectUri }: ConnectArgs): Promise<MetaAccount> {
    const app = { client_id: this.options.appId ?? "", client_secret: this.options.appSecret ?? "" };
    const short = await api(`${GRAPH}/oauth/access_token?${new URLSearchParams({ ...app, redirect_uri: redirectUri, code })}`);
    // A Page token taken from a long-lived user token does not expire.
    const long = await api(`${GRAPH}/oauth/access_token?${new URLSearchParams({ ...app, grant_type: "fb_exchange_token", fb_exchange_token: short.access_token })}`);
    const { data: grants } = await api(`${GRAPH}/me/permissions`, { token: long.access_token });
    const permissions: string[] = grants.filter((g: Json) => g.status === "granted").map((g: Json) => g.permission);
    requirePermissions("Facebook", PAGE_PERMISSIONS, permissions);
    const { data: pages } = await api(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}`, { token: long.access_token });

    const wanted = this.options.pageId;
    const page = wanted ? pages.find((p: Json) => p.id === wanted) : pages[0];
    if (!page) {
      if (!pages.length) throw new Error("This Facebook account manages no Pages. Reels can only be posted to a Page.");
      throw new Error(`No Page with id ${wanted}. Your Pages: ${pages.map((p: Json) => `${p.name} (${p.id})`).join(", ")}`);
    }
    const ig = page.instagram_business_account;
    return {
      page: { id: page.id, name: page.name, token: page.access_token },
      instagram: ig ? { id: ig.id, username: ig.username } : null,
      permissions,
    };
  }

  /** Sends a video to Meta's upload host, which Facebook and Instagram share. */
  sendFile(url: string, token: string, file: string, size: number) {
    return api(url, { method: "POST", headers: { ...auth(token), offset: "0", file_size: String(size) }, body: readFileSync(file) });
  }

  /** Waits for Instagram to process a container, publishes it, and returns the post's link. */
  async publishInstagram(account: MetaAccount, containerId: string, log: Log, what: string): Promise<{ url: string; note: string | null }> {
    const igId = instagramId(account);
    const { token } = account.page;
    log(`waiting for Instagram to process the ${what}`);
    await waitFor(async () => {
      const s = await api(`${GRAPH}/${containerId}?fields=status_code,status`, { headers: auth(token) });
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Instagram could not process the ${what}: ${s.status}`);
      return s.status_code === "FINISHED";
    }, `Instagram to process the ${what}`);
    log("processed, publishing");
    const media = await api(`${GRAPH}/${igId}/media_publish`, { method: "POST", form: { creation_id: containerId, access_token: token } });
    // The post is live from here, so a failed lookup (often the app's rate limit) must not fail
    // the publish: a retry would post it again.
    try {
      const { permalink } = await api(`${GRAPH}/${media.id}?fields=permalink`, { headers: auth(token) });
      return { url: permalink, note: null };
    } catch (err) {
      return {
        url: `https://www.instagram.com/${account.instagram!.username}/`,
        note: `Posted, but its link could not be read (${(err as Error).message}), so this links to the profile`,
      };
    }
  }

  /**
   * Lifetime insights of one Facebook video (`video_insights`) or Instagram media
   * (`insights`), by metric name.
   */
  async insights(id: string, edge: string, metrics: string[], token: string): Promise<Record<string, Json>> {
    const { data } = await api(`${GRAPH}/${id}/${edge}?metric=${metrics.join(",")}`, { headers: auth(token) });
    return Object.fromEntries(data.map((m: Json) => [m.name, m.values?.[0]?.value ?? null]));
  }
}

export class FacebookReels extends Platform<MetaAccount> {
  declare readonly provider: MetaProvider;

  constructor(provider: MetaProvider) {
    super(provider, { name: "facebook", label: "Facebook Reels", schedules: true });
  }

  target(account: MetaAccount): string {
    return account.page.name;
  }

  override warning(account: MetaAccount): string | null {
    return granted(account, "read_insights") ? null : NO_INSIGHTS;
  }

  async upload({ account, file, size, text, publishAt }: UploadArgs<MetaAccount>): Promise<UploadResult> {
    const { id: pageId, token } = account.page;
    const start = await api(`${GRAPH}/${pageId}/video_reels`, { method: "POST", form: { upload_phase: "start", access_token: token } });
    await this.provider.sendFile(start.upload_url, token, file, size);
    const when: Record<string, string> = publishAt
      ? { video_state: "SCHEDULED", scheduled_publish_time: String(Math.floor(publishAt.getTime() / 1000)) }
      : { video_state: "PUBLISHED" };
    await api(`${GRAPH}/${pageId}/video_reels`, {
      method: "POST",
      form: { upload_phase: "finish", video_id: start.video_id, ...when, description: text.caption, access_token: token },
    });
    return { url: `https://www.facebook.com/reel/${start.video_id}`, note: publishAt ? null : "Facebook may take a few minutes to process it" };
  }

  override async stats({ account, urls }: StatsArgs<MetaAccount>): Promise<Map<string, PostStats>> {
    const counts = new Map<string, PostStats>();
    if (!granted(account, "read_insights")) return counts;
    await ifPermitted(async () => {
      for (const url of urls) {
        const m = await this.provider.insights(url.split("/").pop() as string, "video_insights", FACEBOOK_METRICS, account.page.token);
        counts.set(url, {
          views: m.fb_reels_total_plays,
          plays: m.blue_reels_play_count,
          likes: tally(m.post_video_likes_by_reaction_type),
          comments: tally(m.post_video_social_actions, "comment"),
          shares: tally(m.post_video_social_actions, "share"),
          follows: m.post_video_followers,
          watchSeconds: seconds(m.post_video_avg_time_watched),
        });
      }
    });
    return counts;
  }
}

export class InstagramReels extends Platform<MetaAccount> {
  declare readonly provider: MetaProvider;

  constructor(provider: MetaProvider) {
    super(provider, { name: "instagram", label: "Instagram Reels", missing: NO_INSTAGRAM });
  }

  target(account: MetaAccount): string | null {
    return instagramHandle(account);
  }

  override missingPermissions(account: MetaAccount): string[] {
    return missingInstagram(account);
  }

  override warning(account: MetaAccount): string | null {
    return granted(account, "instagram_manage_insights") ? null : NO_INSIGHTS;
  }

  override async checkOptions({ options }: CheckOptionsArgs<MetaAccount>): Promise<string | null> {
    const o = options as InstagramPostOptions | undefined;
    return (o?.sponsorIds?.length ?? 0) > MAX_SPONSORS ? `Instagram takes at most ${MAX_SPONSORS} brands per post` : null;
  }

  async upload({ account, file, size, text, log, options }: UploadArgs<MetaAccount>): Promise<UploadResult> {
    const o = options as InstagramPostOptions | undefined;
    // The ids go as written, since they are too long for a JavaScript number.
    const partnership = {
      ...(o?.paidPartnership ? { is_paid_partnership: "true" } : {}),
      ...(o?.sponsorIds?.length ? { branded_content_sponsor_ids: `[${o.sponsorIds.join(",")}]` } : {}),
    };
    const { token } = account.page;
    const igId = instagramId(account);
    // Instagram's upload host sometimes refuses a good file ("Request processing failed") for a
    // few minutes, then takes it. Each try gets a fresh container, since a refused one stays stuck.
    let container: Json;
    for (let tries = 0; ; tries++) {
      container = await api(`${GRAPH}/${igId}/media`, {
        method: "POST",
        form: { media_type: "REELS", upload_type: "resumable", caption: text.caption, share_to_feed: "true", ...partnership, access_token: token },
      });
      try {
        await this.provider.sendFile(container.uri, token, file, size);
        break;
      } catch (err) {
        const wait = UPLOAD_RETRY_SECONDS[tries];
        if (wait === undefined) throw err;
        log(`upload refused (${(err as Error).message}), trying again in ${wait}s`);
        await sleep(wait * 1000);
      }
    }
    log("uploaded");
    return this.provider.publishInstagram(account, container.id, log, "video");
  }

  override async stats({ account, urls }: StatsArgs<MetaAccount>): Promise<Map<string, PostStats>> {
    const { token } = account.page;
    const counts = new Map<string, PostStats>();
    if (!granted(account, "instagram_manage_insights")) return counts;
    // Publishing keeps only the permalink, so the media ids come from the account's media list.
    const wanted = new Set(urls);
    const ids = new Map<string, string>();
    let next: string | undefined = `${GRAPH}/${instagramId(account)}/media?fields=id,permalink&limit=100`;
    while (next && ids.size < wanted.size) {
      const { data, paging }: Json = await api(next, { headers: auth(token) });
      for (const media of data) if (wanted.has(media.permalink)) ids.set(media.permalink, media.id);
      next = paging?.next;
    }
    await ifPermitted(async () => {
      for (const [url, id] of ids) {
        const m = await this.provider.insights(id, "insights", INSTAGRAM_METRICS, token);
        counts.set(url, {
          views: m.views, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saved, reach: m.reach,
          watchSeconds: seconds(m.ig_reels_avg_watch_time), skipRate: m.reels_skip_rate,
        });
      }
    });
    return counts;
  }
}

export class FacebookPosts extends PostPlatform<MetaAccount> {
  constructor(provider: MetaProvider) {
    super(provider, { name: "facebook", label: "Facebook" });
  }

  target(account: MetaAccount): string {
    return account.page.name;
  }

  private uploadPhoto(pageId: string, token: string, file: string, fields: Record<string, string>) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...fields, access_token: token })) form.append(key, value);
    form.append("source", new Blob([readFileSync(file)], { type: "image/jpeg" }), basename(file));
    return api(`${GRAPH}/${pageId}/photos`, { method: "POST", body: form });
  }

  async post({ account, files, caption, log }: PostArgs<MetaAccount>): Promise<PostResult> {
    const { id: pageId, token } = account.page;
    let postId: string;
    let media: string[];
    if (files.length === 1) {
      const photo = await this.uploadPhoto(pageId, token, files[0]!, { message: caption, published: "true" });
      postId = photo.post_id;
      media = [photo.id];
    } else {
      // A multi-photo post: each photo is uploaded held back, then all are published with the post.
      media = [];
      for (const [i, file] of files.entries()) {
        log(`uploading photo ${i + 1} of ${files.length}`);
        media.push((await this.uploadPhoto(pageId, token, file, { published: "false" })).id);
      }
      const form: Record<string, string> = { message: caption, access_token: token };
      media.forEach((id, i) => (form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
      postId = (await api(`${GRAPH}/${pageId}/feed`, { method: "POST", form })).id;
    }
    const { permalink_url: url } = await api(`${GRAPH}/${postId}?fields=permalink_url`, { headers: auth(token) });
    return { url, media };
  }

  /** The largest size of each photo, on Facebook's public image host. */
  override async imageUrls(account: MetaAccount, media: unknown): Promise<string[]> {
    const urls: string[] = [];
    for (const id of media as string[]) {
      const { images } = await api(`${GRAPH}/${id}?fields=images`, { headers: auth(account.page.token) });
      urls.push(images.reduce((a: Json, b: Json) => (b.width > a.width ? b : a)).source);
    }
    return urls;
  }
}

/**
 * Instagram downloads images from a public link, so it takes the copies Facebook made when
 * the same post went there.
 */
export class InstagramPosts extends PostPlatform<MetaAccount> {
  declare readonly provider: MetaProvider;

  constructor(provider: MetaProvider) {
    super(provider, {
      name: "instagram",
      label: "Instagram",
      missing: NO_INSTAGRAM,
      imagesFrom: "facebook",
    });
  }

  target(account: MetaAccount): string | null {
    return instagramHandle(account);
  }

  override missingPermissions(account: MetaAccount): string[] {
    return missingInstagram(account);
  }

  async post({ account, urls, caption, log }: PostArgs<MetaAccount>): Promise<PostResult> {
    const { token } = account.page;
    const igId = instagramId(account);
    const images = urls ?? [];
    const create = (form: Record<string, string>) => api(`${GRAPH}/${igId}/media`, { method: "POST", form: { ...form, access_token: token } });
    let container: Json;
    if (images.length === 1) {
      container = await create({ image_url: images[0]!, caption });
    } else {
      const children: string[] = [];
      for (const url of images) children.push((await create({ image_url: url, is_carousel_item: "true" })).id);
      container = await create({ media_type: "CAROUSEL", children: children.join(","), caption });
    }
    return this.provider.publishInstagram(account, container.id, log, images.length === 1 ? "image" : "carousel");
  }
}
