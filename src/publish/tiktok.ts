// Sends videos to TikTok either as an inbox draft the creator finishes in the TikTok app
// (video.upload), or posted straight away with the settings from the TikTok post screen
// (Direct Post, video.publish). Until TikTok audits the app, Direct Posts can only be
// "Only me", and the account must be private when posting.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { api, platformError, waitFor, type Json } from "./api.js";
import { requirePermissions } from "./errors.js";
import {
  Platform,
  Provider,
  type AuthUrlArgs,
  type CheckOptionsArgs,
  type ConnectArgs,
  type PublishText,
  type SaveAccount,
  type UploadArgs,
  type UploadResult,
} from "./provider.js";

const API = "https://open.tiktokapis.com/v2";
const TOKEN_URL = `${API}/oauth/token/`;
const MB = 1024 * 1024;
// Chunks must be 5 to 64 MB; a file up to 64 MB goes in one piece, and the last chunk absorbs
// the remainder.
const MAX_SINGLE = 64 * MB;
const CHUNK = 10 * MB;
// Drafts need these. video.publish only matters for Direct Posts, so it is not required.
const REQUIRED_SCOPES = ["user.info.basic", "video.upload"];

export interface TikTokAccount {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  name: string;
}

export interface TikTokOptions {
  clientKey: string | undefined;
  clientSecret: string | undefined;
}

/** What TikTok's post screen must show, fetched fresh each time as TikTok requires. */
export interface CreatorInfo {
  nickname: string;
  username: string;
  avatar: string;
  privacyOptions: string[];
  maxSeconds: number;
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
}

/**
 * The post screen's choices. With `mode: "direct"` the video is posted; otherwise it goes to
 * the inbox as a draft.
 */
export interface TikTokPostOptions {
  mode?: "direct" | "draft";
  privacy?: string;
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  /** Whether the post promotes something; then `yourBrand`, `branded` or both. */
  disclose?: boolean;
  yourBrand?: boolean;
  branded?: boolean;
}

const tokens = (t: Json) => ({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 });

/** TikTok Login Kit for the Content Posting API. */
export class TikTokProvider extends Provider<TikTokAccount> {
  readonly options: TikTokOptions;

  constructor(options: TikTokOptions) {
    super("tiktok", { clientKey: options.clientKey, clientSecret: options.clientSecret });
    this.options = options;
    this.platforms = [new TikTok(this)];
  }

  private get app() {
    return { client_key: this.options.clientKey ?? "", client_secret: this.options.clientSecret ?? "" };
  }

  /** TikTok's desktop flow wants the PKCE challenge hex encoded, not base64url as in RFC 7636. */
  authUrl({ redirectUri, state, verifier }: AuthUrlArgs): string {
    const params = new URLSearchParams({
      client_key: this.options.clientKey ?? "",
      scope: [...REQUIRED_SCOPES, "video.publish"].join(","),
      response_type: "code",
      redirect_uri: redirectUri,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("hex"),
      code_challenge_method: "S256",
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
  }

  async connect({ code, redirectUri, verifier }: ConnectArgs): Promise<TikTokAccount> {
    const t = await api(TOKEN_URL, {
      method: "POST",
      form: { ...this.app, code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: verifier },
    });
    requirePermissions("TikTok", REQUIRED_SCOPES, String(t.scope).split(","));
    const info = await api(`${API}/user/info/?fields=display_name`, { token: t.access_token });
    return { ...tokens(t), name: info.data.user.display_name };
  }

  /**
   * A current access token, refreshed and saved when it is about to expire. Access tokens
   * last 24 hours, refresh tokens a year.
   */
  async accessToken(account: TikTokAccount, save: SaveAccount<TikTokAccount>): Promise<string> {
    if (Date.now() < account.expiresAt - 60_000) return account.accessToken;
    const t = await api(TOKEN_URL, { method: "POST", form: { ...this.app, grant_type: "refresh_token", refresh_token: account.refreshToken } });
    await save({ ...account, ...tokens(t) });
    return t.access_token;
  }
}

export class TikTok extends Platform<TikTokAccount> {
  declare readonly provider: TikTokProvider;

  constructor(provider: TikTokProvider) {
    super(provider, { name: "tiktok", label: "TikTok" });
  }

  target(account: TikTokAccount): string {
    return account.name;
  }

  override async creatorInfo(account: TikTokAccount, save: SaveAccount<TikTokAccount>): Promise<CreatorInfo> {
    const token = await this.provider.accessToken(account, save);
    const { data } = await api(`${API}/post/publish/creator_info/query/`, { method: "POST", token, json: {} });
    return {
      nickname: data.creator_nickname, username: data.creator_username, avatar: data.creator_avatar_url,
      privacyOptions: data.privacy_level_options, maxSeconds: data.max_video_post_duration_sec,
      commentDisabled: data.comment_disabled, duetDisabled: data.duet_disabled, stitchDisabled: data.stitch_disabled,
    };
  }

  /** Why a Direct Post with these settings cannot go out, or null. */
  override async checkOptions({ account, save, options, seconds }: CheckOptionsArgs<TikTokAccount>): Promise<string | null> {
    const o = options as TikTokPostOptions | undefined;
    if (o?.mode !== "direct") return null;
    const creator = await this.creatorInfo(account, save);
    if (!o.privacy || !creator.privacyOptions.includes(o.privacy)) return "choose who can watch the post";
    if (seconds > creator.maxSeconds) return `this account takes videos up to ${creator.maxSeconds}s, and this one is ${Math.round(seconds)}s`;
    if (o.allowComment && creator.commentDisabled) return "comments are turned off in the account's settings";
    if (o.allowDuet && creator.duetDisabled) return "Duet is turned off in the account's settings";
    if (o.allowStitch && creator.stitchDisabled) return "Stitch is turned off in the account's settings";
    if (o.disclose && !o.yourBrand && !o.branded) return "You need to indicate if your content promotes yourself, a third party, or both.";
    if (o.disclose && o.branded && o.privacy === "SELF_ONLY") return "Branded content visibility cannot be set to private.";
    return null;
  }

  async upload({ account, save, file, size, text, options }: UploadArgs<TikTokAccount>): Promise<UploadResult> {
    const o = options as TikTokPostOptions | undefined;
    const token = await this.provider.accessToken(account, save);
    const direct = o?.mode === "direct";
    const chunkSize = size <= MAX_SINGLE ? size : CHUNK;
    const count = Math.floor(size / chunkSize);
    const sourceInfo = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count };
    const init = await api(`${API}/post/publish/${direct ? "video" : "inbox/video"}/init/`, {
      method: "POST",
      token,
      json: direct ? { post_info: postInfo(text, o), source_info: sourceInfo } : { source_info: sourceInfo },
    });
    const { publish_id: publishId, upload_url: uploadUrl } = init.data;

    const video = readFileSync(file);
    for (let i = 0; i < count; i++) {
      const first = i * chunkSize;
      const last = i === count - 1 ? size - 1 : first + chunkSize - 1;
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${first}-${last}/${size}` },
        body: video.subarray(first, last + 1),
      });
      if (!res.ok) throw platformError(uploadUrl, res.status, await res.text());
    }

    let result: Json;
    await waitFor(async () => {
      ({ data: result } = await api(`${API}/post/publish/status/fetch/`, { method: "POST", token, json: { publish_id: publishId } }));
      if (result.status === "FAILED") throw new Error(`TikTok could not process the video: ${result.fail_reason}`);
      return result.status === "SEND_TO_USER_INBOX" || result.status === "PUBLISH_COMPLETE";
    }, "TikTok to process the video");
    if (!direct) return { url: null, note: "In your TikTok inbox. Open TikTok, paste the caption and post it." };

    // A post only gets a public id once anyone but the creator can see it.
    const postId = result.publicaly_available_post_id?.[0];
    const { username } = await this.creatorInfo(account, save);
    return {
      url: postId ? `https://www.tiktok.com/@${username}/video/${postId}` : `https://www.tiktok.com/@${username}`,
      note: "TikTok can take a few minutes to process it before it shows on the profile.",
    };
  }
}

// The post screen's choices as TikTok's post_info. Interactions are off unless turned on.
function postInfo(text: PublishText, o: TikTokPostOptions) {
  return {
    title: text.caption,
    privacy_level: o.privacy,
    disable_comment: !o.allowComment,
    disable_duet: !o.allowDuet,
    disable_stitch: !o.allowStitch,
    brand_organic_toggle: !!(o.disclose && o.yourBrand),
    brand_content_toggle: !!(o.disclose && o.branded),
  };
}
