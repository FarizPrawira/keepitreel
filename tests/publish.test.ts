import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  GoogleProvider,
  MetaProvider,
  Platform,
  PostPlatform,
  Provider,
  Publisher,
  PublishError,
  TikTokProvider,
  type AccountStore,
  type CheckOptionsArgs,
  type PostResult,
  type UploadArgs,
  type UploadResult,
} from "../src/publish/index.js";

const UPLOAD = "https://www.googleapis.com/auth/youtube.upload";
const READONLY = "https://www.googleapis.com/auth/youtube.readonly";
const ANALYTICS = "https://www.googleapis.com/auth/yt-analytics.readonly";
const PAGE_PERMISSIONS = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const signIn = { code: "c", redirectUri: "http://localhost/cb", verifier: "v" };

const reply = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// fetch answers each call with the next of `responses`.
function stubFetch(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected it to throw");
}

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  describe("when given a successful response", () => {
    it("should return its JSON", async () => {
      stubFetch(reply({ id: "1" }));
      expect(await api("https://example.com/x")).toEqual({ id: "1" });
    });

    it("should treat TikTok's ok code as success", async () => {
      stubFetch(reply({ data: { a: 1 }, error: { code: "ok", message: "" } }));
      expect((await api("https://open.tiktokapis.com/x")).data).toEqual({ a: 1 });
    });
  });

  describe("when given a form body", () => {
    it("should send it url-encoded without a charset, which TikTok's token endpoint refuses", async () => {
      const fetch = stubFetch(reply({}));
      await api("https://example.com/token", { method: "POST", form: { a: "1 2" }, token: "t" });
      const [, init] = fetch.mock.calls[0]!;
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(init.headers.Authorization).toBe("Bearer t");
      expect(init.body).toBe("a=1+2");
    });
  });

  describe("when given a JSON body", () => {
    it("should send it as UTF-8 JSON", async () => {
      const fetch = stubFetch(reply({}));
      await api("https://example.com/x", { method: "POST", json: { a: 1 } });
      const [, init] = fetch.mock.calls[0]!;
      expect(init.headers["Content-Type"]).toBe("application/json; charset=UTF-8");
      expect(init.body).toBe('{"a":1}');
    });
  });

  describe("when the platform refuses", () => {
    it("should throw with Google and Meta's own message", async () => {
      stubFetch(reply({ error: { message: "Invalid parameter" } }, 400));
      await expect(api("https://graph.facebook.com/x")).rejects.toThrow("graph.facebook.com answered 400: Invalid parameter");
    });

    it("should throw on a 200 that carries a TikTok error code", async () => {
      stubFetch(reply({ error: { code: "access_token_invalid", message: "The token is invalid" } }));
      await expect(api("https://open.tiktokapis.com/x")).rejects.toThrow("The token is invalid");
    });

    it("should throw on a 200 OAuth refusal", async () => {
      stubFetch(reply({ error: "invalid_grant", error_description: "Code expired" }));
      await expect(api("https://open.tiktokapis.com/oauth")).rejects.toThrow("Code expired");
    });

    it("should fall back to the body when the error is not JSON", async () => {
      stubFetch(reply("Bad Gateway", 502));
      await expect(api("https://example.com/x")).rejects.toThrow("example.com answered 502: Bad Gateway");
    });

    it.each([
      { what: "an expired Meta token", status: 400, body: { error: { message: "Session has expired", code: 190 } }, code: "reconnect" },
      { what: "a refused refresh token", status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." }, code: "reconnect" },
      { what: "an invalid TikTok token", status: 200, body: { error: { code: "access_token_invalid", message: "The token is invalid" } }, code: "reconnect" },
      { what: "a 401", status: 401, body: { error: { message: "Unauthorized" } }, code: "reconnect" },
      {
        what: "a missing Google scope",
        status: 403,
        body: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } },
        code: "missing_permission",
      },
      { what: "a missing Meta permission", status: 403, body: { error: { message: "(#200) Requires pages_manage_posts", code: 200 } }, code: "missing_permission" },
      { what: "a Meta app without the permission", status: 400, body: { error: { message: "(#10) No permission", code: 10 } }, code: "missing_permission" },
      { what: "a TikTok scope that was not granted", status: 200, body: { error: { code: "scope_not_authorized", message: "Not authorized" } }, code: "missing_permission" },
      { what: "any other refusal", status: 500, body: { error: { message: "Backend error" } }, code: "platform" },
    ])("should classify $what as $code", async ({ status, body, code }) => {
      stubFetch(reply(body, status));
      await expect(api("https://example.com/x")).rejects.toMatchObject({ name: "PublishError", code });
    });
  });
});

describe("sign-in", () => {
  const verifier = "v".repeat(43);
  const params = (url: string) => new URL(url).searchParams;

  describe("Google", () => {
    const url = params(
      new GoogleProvider({ clientId: "id", clientSecret: "secret" }).authUrl({ redirectUri: "http://localhost:3100/auth/google/callback", state: "s", verifier }),
    );

    it("should send the sign-in back to the loopback address", () => {
      expect(url.get("redirect_uri")).toBe("http://127.0.0.1:3100/auth/google/callback");
    });

    it("should protect it with a base64url PKCE challenge", () => {
      expect(url.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    });

    it("should ask for analytics along with the scopes posting needs", () => {
      expect(url.get("scope")!.split(" ")).toEqual([UPLOAD, READONLY, ANALYTICS]);
    });
  });

  describe("TikTok", () => {
    it("should protect the sign-in with a hex PKCE challenge", () => {
      const url = params(new TikTokProvider({ clientKey: "key", clientSecret: "secret" }).authUrl({ redirectUri: "http://localhost:3100/cb", state: "s", verifier }));
      expect(url.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("hex"));
    });
  });

  describe("Meta", () => {
    it("should ask for its permissions by scope", () => {
      const url = params(new MetaProvider({ appId: "a", appSecret: "s" }).authUrl({ redirectUri: "http://localhost/cb", state: "s", verifier }));
      expect(url.get("scope")!.split(",")).toEqual(expect.arrayContaining([...PAGE_PERMISSIONS, "instagram_content_publish", "read_insights"]));
    });

    it("should use a Login for Business configuration instead when one is given", () => {
      const url = params(new MetaProvider({ appId: "a", appSecret: "s", configId: "cfg" }).authUrl({ redirectUri: "http://localhost/cb", state: "s", verifier }));
      expect(url.get("config_id")).toBe("cfg");
      expect(url.get("scope")).toBeNull();
    });
  });

  describe("when given a provider without all its keys", () => {
    it("should not be configured, and should name the missing keys", () => {
      const google = new GoogleProvider({ clientId: "id", clientSecret: undefined });
      expect(google.configured).toBe(false);
      expect(google.missing).toEqual(["clientSecret"]);
    });
  });
});

describe("permissions", () => {
  describe("when given a Google sign-in", () => {
    const google = () => new GoogleProvider({ clientId: "id", clientSecret: "secret" });

    describe("when a scope posting needs was not granted", () => {
      it("should refuse with missing_permission, naming the scope", async () => {
        stubFetch(reply({ access_token: "a", refresh_token: "r", scope: READONLY }));
        await expect(google().connect(signIn)).rejects.toMatchObject({ code: "missing_permission", message: expect.stringContaining(UPLOAD) });
      });
    });

    describe("when only analytics was not granted", () => {
      it("should connect, and warn instead of failing", async () => {
        stubFetch(
          reply({ access_token: "a", refresh_token: "r", scope: `${UPLOAD} ${READONLY}` }),
          reply({ items: [{ id: "UC1", snippet: { title: "Channel" } }] }),
        );
        const provider = google();
        const account = await provider.connect(signIn);
        const youtube = provider.platforms[0]!;
        expect(youtube.target(account)).toBe("Channel");
        expect(account.scopes).toEqual([UPLOAD, READONLY]);
        expect(youtube.warning(account)).toMatch(/views, likes and comments only/);
      });
    });

    describe("when every scope was granted", () => {
      it("should connect without a warning", async () => {
        stubFetch(
          reply({ access_token: "a", refresh_token: "r", scope: `${UPLOAD} ${READONLY} ${ANALYTICS}` }),
          reply({ items: [{ id: "UC1", snippet: { title: "Channel" } }] }),
        );
        const provider = google();
        expect(provider.platforms[0]!.warning(await provider.connect(signIn))).toBeNull();
      });
    });
  });

  describe("when given YouTube stats", () => {
    const youtube = () => new GoogleProvider({ clientId: "id", clientSecret: "secret" }).platforms[0]!;
    const channel = { id: "UC1", name: "Channel" };
    const url = "https://youtube.com/shorts/v1";
    const statistics = () => reply({ items: [{ id: "v1", statistics: { viewCount: "10", likeCount: "2", commentCount: "1" } }] });

    describe("when analytics was not allowed", () => {
      it("should return the counts without asking analytics", async () => {
        const fetch = stubFetch(reply({ access_token: "a" }), statistics());
        const stats = await youtube().stats({ account: { refreshToken: "r", channel, scopes: [UPLOAD, READONLY] }, save: () => {}, urls: [url] });
        expect(stats.get(url)).toEqual({ views: 10, likes: 2, comments: 1 });
        expect(fetch).toHaveBeenCalledTimes(2);
      });
    });

    describe("when analytics answers", () => {
      it("should add engaged views, watch time, shares and follows", async () => {
        stubFetch(
          reply({ access_token: "a" }),
          statistics(),
          reply({
            columnHeaders: ["video", "views", "engagedViews", "averageViewDuration", "shares", "subscribersGained"].map((name) => ({ name })),
            rows: [["v1", 10, 8, 12.5, 3, 1]],
          }),
        );
        const stats = await youtube().stats({ account: { refreshToken: "r", channel }, save: () => {}, urls: [url] });
        expect(stats.get(url)).toEqual({ views: 10, likes: 2, comments: 1, engagedViews: 8, watchSeconds: 12.5, shares: 3, follows: 1 });
      });
    });

    describe("when an account without recorded scopes is refused by analytics", () => {
      it("should keep the counts", async () => {
        stubFetch(
          reply({ access_token: "a" }),
          statistics(),
          reply({ error: { code: 403, message: "Insufficient scopes", errors: [{ reason: "insufficientPermissions" }] } }, 403),
        );
        const stats = await youtube().stats({ account: { refreshToken: "r", channel }, save: () => {}, urls: [url] });
        expect(stats.get(url)).toEqual({ views: 10, likes: 2, comments: 1 });
      });
    });
  });

  describe("when given a Meta sign-in", () => {
    const meta = () => new MetaProvider({ appId: "a", appSecret: "s" });
    const grants = (granted: string[], declined: string[] = []) =>
      reply({ data: [...granted.map((permission) => ({ permission, status: "granted" })), ...declined.map((permission) => ({ permission, status: "declined" }))] });
    const pages = () => reply({ data: [{ id: "1", name: "Page", access_token: "t", instagram_business_account: { id: "2", username: "shop" } }] });

    describe("when Instagram's permissions were declined", () => {
      it("should still connect Facebook, and record only what was granted", async () => {
        stubFetch(reply({ access_token: "short" }), reply({ access_token: "long" }), grants(PAGE_PERMISSIONS, ["instagram_content_publish"]), pages());
        const account = await meta().connect(signIn);
        expect(account.page.name).toBe("Page");
        expect(account.instagram).toEqual({ id: "2", username: "shop" });
        expect(account.permissions).toEqual(PAGE_PERMISSIONS);
      });
    });

    describe("when a Page permission was not granted", () => {
      it("should refuse with missing_permission", async () => {
        stubFetch(reply({ access_token: "short" }), reply({ access_token: "long" }), grants(["pages_show_list"]));
        await expect(meta().connect(signIn)).rejects.toMatchObject({ code: "missing_permission", message: expect.stringContaining("pages_manage_posts") });
      });
    });
  });

  describe("when given a TikTok sign-in", () => {
    const tiktok = () => new TikTokProvider({ clientKey: "key", clientSecret: "secret" });
    const token = (scope: string) => reply({ access_token: "a", refresh_token: "r", expires_in: 86400, scope });

    describe("when video.upload was not granted", () => {
      it("should refuse with missing_permission", async () => {
        stubFetch(token("user.info.basic"));
        await expect(tiktok().connect(signIn)).rejects.toMatchObject({ code: "missing_permission", message: expect.stringContaining("video.upload") });
      });
    });

    describe("when only video.publish was not granted", () => {
      it("should connect, since drafts still work", async () => {
        stubFetch(token("user.info.basic,video.upload"), reply({ data: { user: { display_name: "Me" } }, error: { code: "ok" } }));
        expect((await tiktok().connect(signIn)).name).toBe("Me");
      });
    });
  });
});

interface FakeAccount {
  name: string;
}

class FakeVideo extends Platform<FakeAccount> {
  uploads: UploadArgs<FakeAccount>[] = [];
  fail: Error | null = null;
  checkFails: Error | null = null;
  warn: string | null = null;

  target(account: FakeAccount) {
    return account.name;
  }

  override warning() {
    return this.warn;
  }

  override async checkOptions(_args: CheckOptionsArgs<FakeAccount>) {
    if (this.checkFails) throw this.checkFails;
    return null;
  }

  async upload(args: UploadArgs<FakeAccount>): Promise<UploadResult> {
    this.uploads.push(args);
    if (this.fail) throw this.fail;
    args.log("sent");
    return { url: `https://${this.name}.example/1` };
  }
}

class FakeImages extends PostPlatform<FakeAccount> {
  posted: { urls: string[] | null }[] = [];

  target(account: FakeAccount) {
    return account.name;
  }

  async post({ urls }: { urls: string[] | null }): Promise<PostResult> {
    this.posted.push({ urls });
    return { url: `https://${this.name}.example/post`, media: [`${this.name}-photo`] };
  }

  override async imageUrls(_account: FakeAccount, media: unknown): Promise<string[]> {
    return (media as string[]).map((m) => `https://cdn.example/${m}.jpg`);
  }
}

class FakeProvider extends Provider<FakeAccount> {
  constructor(key: string | undefined = "key") {
    super("fake", { key });
    this.platforms = [
      new FakeVideo(this, { name: "short", label: "Short" }),
      new FakeVideo(this, { name: "later", label: "Later", schedules: true }),
    ];
    this.posters = [
      new FakeImages(this, { name: "copy", label: "Copy", imagesFrom: "feed" }),
      new FakeImages(this, { name: "feed", label: "Feed" }),
    ];
  }

  authUrl({ state }: { state: string }) {
    return `https://auth.example/?state=${state}`;
  }

  async connect({ code }: { code: string }) {
    return { name: `account-${code}` };
  }
}

class MemoryStore implements AccountStore {
  accounts = new Map<string, unknown>();
  account(provider: string) {
    return this.accounts.get(provider) ?? null;
  }
  saveAccount(provider: string, account: unknown) {
    this.accounts.set(provider, account);
  }
}

describe("Publisher", () => {
  let store: MemoryStore;
  let provider: FakeProvider;
  let publisher: Publisher;
  const dir = mkdtempSync(join(tmpdir(), "keepitreel-publish-"));
  const file = join(dir, "video.mp4");
  writeFileSync(file, Buffer.alloc(2048));
  const text = { title: "Title", caption: "Caption" };
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
  const video = (i: number) => provider.platforms[i] as FakeVideo;

  beforeEach(() => {
    store = new MemoryStore();
    provider = new FakeProvider();
    publisher = new Publisher({ providers: [provider], store });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const startAuth = () => new URL(publisher.startAuth("fake", "http://localhost/cb")).searchParams.get("state");
  const connect = () => publisher.finishAuth("fake", { state: startAuth(), code: "1" }, "http://localhost/cb");

  describe("when given a provider without its app keys", () => {
    it("should refuse to start a sign-in with not_configured", () => {
      const unconfigured = new Publisher({ providers: [new FakeProvider("")], store });
      expect(thrown(() => unconfigured.startAuth("fake", "x"))).toMatchObject({ code: "not_configured", message: "fake needs key" });
    });
  });

  describe("when connecting an account", () => {
    it("should complete the OAuth round trip and store the account", async () => {
      expect(await connect()).toEqual(["account-1", "account-1"]);
      expect(store.account("fake")).toEqual({ name: "account-1" });
    });

    it("should report every platform as connected", async () => {
      await connect();
      expect((await publisher.accounts()).every((a) => a.connected && a.target === "account-1" && a.problem === null)).toBe(true);
    });

    it("should refuse a callback it did not start", async () => {
      await expect(publisher.finishAuth("fake", { state: "nope", code: "1" }, "x")).rejects.toThrow("not started here");
    });

    it("should pass on the provider's reason when the user declined", async () => {
      const query = { state: startAuth(), error: "access_denied", error_description: "The user denied access" };
      await expect(publisher.finishAuth("fake", query, "x")).rejects.toThrow("The user denied access");
    });
  });

  describe("when given no connected account", () => {
    it("should list the platforms as not connected, without a problem", async () => {
      expect(await publisher.accounts()).toEqual([
        expect.objectContaining({ platform: "short", connected: false, problem: null, warning: null }),
        expect.objectContaining({ platform: "later", connected: false, problem: null, warning: null }),
      ]);
    });

    it("should report it as not connected from check()", async () => {
      expect(await publisher.check({ platforms: ["short"], seconds: 30 })).toBe("Short is not connected");
    });

    it("should fail publish() with not_connected, without uploading", async () => {
      const results = await publisher.publish({ platforms: ["short"], file, text });
      expect(results).toEqual([{ platform: "short", status: "failed", error: "Short is not connected", code: "not_connected" }]);
      expect(video(0).uploads).toHaveLength(0);
    });

    it("should fail post() with not_connected", async () => {
      const results = await publisher.post({ platforms: ["feed"], files: ["a.jpg"], caption: "c" });
      expect(results).toEqual([{ platform: "feed", status: "failed", error: "Feed is not connected", code: "not_connected" }]);
    });

    it("should reject stats() with not_connected", async () => {
      await expect(publisher.stats("short", [])).rejects.toMatchObject({ code: "not_connected" });
    });

    it("should reject creatorInfo() with not_connected", async () => {
      await expect(publisher.creatorInfo("short")).rejects.toMatchObject({ code: "not_connected" });
    });
  });

  describe("when given a connected account", () => {
    beforeEach(async () => {
      await connect();
    });

    describe("when checking a video", () => {
      it("should accept it on a connected platform", async () => {
        expect(await publisher.check({ platforms: ["short"], seconds: 30 })).toBeNull();
      });

      it("should put no limit on its length unless the app sets one", async () => {
        expect(await publisher.check({ platforms: ["short"], seconds: 600 })).toBeNull();
      });

      describe("when given a length limit set by the app", () => {
        const limited = () => new Publisher({ providers: [provider], store, maxSeconds: { short: 59 } });

        it("should refuse a video longer than the limit", async () => {
          expect(await limited().check({ platforms: ["short"], seconds: 61 })).toBe("Short takes videos up to 59s, and this one is 61s");
        });

        it("should accept a video up to the limit", async () => {
          expect(await limited().check({ platforms: ["short"], seconds: 59 })).toBeNull();
        });

        it("should leave the platforms it does not name without a limit", async () => {
          expect(await limited().check({ platforms: ["later"], seconds: 600 })).toBeNull();
        });
      });

      it("should ask for at least one platform", async () => {
        expect(await publisher.check({ platforms: [], seconds: 30 })).toBe("Pick at least one of short, later");
      });

      it("should name a platform it does not know", async () => {
        expect(await publisher.check({ platforms: ["nope"], seconds: 30 })).toBe('Unknown platform "nope"');
      });

      it("should accept a schedule on a platform that schedules", async () => {
        expect(await publisher.check({ platforms: ["later"], seconds: 30, publishAt: inAnHour() })).toBeNull();
      });

      it("should refuse a schedule on a platform that does not", async () => {
        expect(await publisher.check({ platforms: ["short"], seconds: 30, publishAt: inAnHour() })).toBe("Short cannot schedule a post; publish it now instead");
      });

      it("should refuse a time outside the scheduling window", async () => {
        expect(await publisher.check({ platforms: ["later"], seconds: 30, publishAt: new Date().toISOString() })).toMatch(/10 minutes to 29 days/);
      });

      it("should refuse a publishAt that is not a date", async () => {
        expect(await publisher.check({ platforms: ["later"], seconds: 30, publishAt: "soon" })).toBe('"publishAt" must be an ISO date and time');
      });
    });

    describe("when the platform's own settings cannot be checked", () => {
      it("should ask to connect again when the sign-in expired", async () => {
        video(0).checkFails = new PublishError("reconnect", "open.tiktokapis.com answered 401: expired");
        expect(await publisher.check({ platforms: ["short"], seconds: 30, options: { short: {} } })).toBe(
          "Short needs to be connected again (open.tiktokapis.com answered 401: expired)",
        );
      });

      it("should name the problem when a permission is missing", async () => {
        video(0).checkFails = new PublishError("missing_permission", "open.tiktokapis.com answered 200: Not authorized");
        expect(await publisher.check({ platforms: ["short"], seconds: 30, options: { short: {} } })).toBe(
          "Short is missing a permission (open.tiktokapis.com answered 200: Not authorized). Connect again and allow it.",
        );
      });

      it("should suggest trying again later for anything else", async () => {
        video(0).checkFails = new Error("timeout");
        expect(await publisher.check({ platforms: ["short"], seconds: 30, options: { short: {} } })).toBe("Short cannot take a post right now (timeout). Try again later.");
      });
    });

    describe("when publishing", () => {
      it("should upload to every platform and report each outcome", async () => {
        video(1).fail = new Error("refused");
        const results = await publisher.publish({ platforms: ["short", "later"], file, text });
        expect(results).toEqual([
          { platform: "short", status: "done", url: "https://short.example/1", note: null },
          { platform: "later", status: "failed", error: "refused" },
        ]);
      });

      it("should log each platform's steps under its label", async () => {
        video(1).fail = new Error("refused");
        const lines: string[] = [];
        await publisher.publish({ platforms: ["short", "later"], file, text, log: (l) => lines.push(l) });
        expect(lines).toContain("Short: sent");
        expect(lines).toContain("Later: failed: refused");
      });

      it("should pass the file size and the schedule to the platform", async () => {
        const publishAt = inAnHour();
        await publisher.publish({ platforms: ["later"], file, text, publishAt });
        expect(video(1).uploads[0]).toMatchObject({ size: 2048, publishAt: new Date(publishAt) });
      });
    });

    describe("when a platform has a limit that does not stop posting", () => {
      it("should show it as a warning, and the platform stays connected", async () => {
        video(0).warn = "Stats are limited";
        expect((await publisher.accounts())[0]).toMatchObject({ connected: true, warning: "Stats are limited" });
      });
    });

    describe("when posting images", () => {
      it("should post to the source platform first and hand its images on", async () => {
        const results = await publisher.post({ platforms: ["copy", "feed"], files: ["a.jpg"], caption: "c" });
        expect(results.map((r) => r.platform)).toEqual(["feed", "copy"]);
        expect((provider.posters[0] as FakeImages).posted[0]!.urls).toEqual(["https://cdn.example/feed-photo.jpg"]);
      });

      it("should fail a platform whose source post is missing", async () => {
        const [result] = await publisher.post({ platforms: ["copy"], files: ["a.jpg"], caption: "c" });
        expect(result).toMatchObject({ platform: "copy", status: "failed", error: expect.stringContaining("no images to take") });
      });

      it("should require the source post in checkPost() before one that takes its images", async () => {
        expect(await publisher.checkPost(["copy"])).toBe("Copy takes its images from the Feed post, so post to Feed first or together");
        expect(await publisher.checkPost(["copy"], { feed: ["earlier-photo"] })).toBeNull();
      });
    });
  });

  describe("when checking a title and caption", () => {
    it("should ignore the title for platforms other than YouTube", () => {
      expect(publisher.checkText({ title: "", caption: "c" }, ["short"])).toBeNull();
    });

    it("should require a title for YouTube", () => {
      expect(publisher.checkText({ title: "", caption: "c" }, ["youtube"])).toBe("YouTube needs a title");
    });

    it("should refuse an empty caption", () => {
      expect(publisher.checkText({ title: "t", caption: "  " }, ["short"])).toBe("The caption can't be empty");
    });

    it("should refuse a caption over Instagram's limit", () => {
      expect(publisher.checkText({ title: "t", caption: "x".repeat(2201) }, ["short"])).toMatch(/2201 characters/);
    });

    it("should refuse a translated title over YouTube's limit", () => {
      expect(publisher.checkText({ title: "t", caption: "c", titles: { id: "y".repeat(101) } }, ["youtube"])).toMatch(/The id title is 101 characters/);
    });

    it("should refuse < or > in a YouTube title", () => {
      expect(publisher.checkText({ title: "a <b>", caption: "c" }, ["youtube"])).toMatch(/< or > in the title/);
    });

    it("should refuse < or > in the caption when it goes to YouTube", () => {
      expect(publisher.checkText({ title: "t", caption: "a > b" }, ["youtube"])).toMatch(/< or > in the caption/);
    });
  });
});

describe("Publisher with Meta", () => {
  describe("when given a Page whose Instagram permissions were declined", () => {
    const store = new MemoryStore();
    store.saveAccount("meta", {
      page: { id: "1", name: "Page", token: "t" },
      instagram: { id: "2", username: "shop" },
      permissions: [...PAGE_PERMISSIONS, "instagram_basic"],
    });
    const publisher = new Publisher({ providers: [new MetaProvider({ appId: "a", appSecret: "s" })], store });

    it("should keep Facebook connected", async () => {
      const [facebook] = await publisher.accounts();
      expect(facebook).toMatchObject({ platform: "facebook", connected: true, problem: null });
      expect(await publisher.check({ platforms: ["facebook"], seconds: 30 })).toBeNull();
    });

    it("should show Instagram as not connected, naming the missing permission", async () => {
      const [, instagram] = await publisher.accounts();
      expect(instagram).toMatchObject({ platform: "instagram", target: "@shop", connected: false, problem: expect.stringContaining("instagram_content_publish") });
      expect(await publisher.check({ platforms: ["instagram"], seconds: 30 })).toMatch(/instagram_content_publish/);
    });

    it("should warn that Facebook stats need insights", async () => {
      const [facebook] = await publisher.accounts();
      expect(facebook!.warning).toMatch(/Insights were not allowed/);
    });
  });

  describe("when Instagram publishes a post but its link cannot be read", () => {
    const instagram = () => new MetaProvider({ appId: "a", appSecret: "s" }).posters[1]!;
    const account = { page: { id: "1", name: "Page", token: "t" }, instagram: { id: "2", username: "shop" } };

    it("should report it posted, linking to the profile, so a retry does not post it again", async () => {
      stubFetch(
        reply({ id: "c1" }),
        reply({ status_code: "FINISHED" }),
        reply({ id: "m1" }),
        reply({ error: { message: "Application request limit reached" } }, 403),
      );
      const result = await instagram().post({ account, files: [], urls: ["https://cdn.example/1.jpg"], caption: "Caption", log: () => {} });
      expect(result.url).toBe("https://www.instagram.com/shop/");
      expect(result.note).toMatch(/Application request limit reached/);
    });
  });
});

describe("paid promotion labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "keepitreel-paid-"));
  const file = join(dir, "video.mp4");
  writeFileSync(file, Buffer.alloc(2048));
  const args = { save: () => {}, file, size: 2048, text: { title: "Title", caption: "Caption" }, log: () => {}, publishAt: null };

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  describe("when YouTube is asked to flag paid promotion", () => {
    const youtube = () => new GoogleProvider({ clientId: "id", clientSecret: "secret" }).platforms[0]!;
    const account = { refreshToken: "r", channel: { id: "UC1", name: "Channel" } };
    const started = () => new Response(null, { status: 200, headers: { location: "https://upload.example/v1" } });
    const uploaded = (flagged: boolean) => reply({ id: "v1", status: { privacyStatus: "public" }, paidProductPlacementDetails: { hasPaidProductPlacement: flagged } });

    it("should send the flag in its part", async () => {
      const fetch = stubFetch(reply({ access_token: "a" }), started(), uploaded(true));
      const result = await youtube().upload({ ...args, account, options: { paidPromotion: true } });
      const [url, init] = fetch.mock.calls[1]!;
      expect(url).toContain("part=snippet,status,paidProductPlacementDetails");
      expect(JSON.parse(init.body).paidProductPlacementDetails).toEqual({ hasPaidProductPlacement: true });
      expect(result.note).toBeNull();
    });

    it("should say to tick it in YouTube Studio when YouTube drops it", async () => {
      stubFetch(reply({ access_token: "a" }), started(), uploaded(false));
      const result = await youtube().upload({ ...args, account, options: { paidPromotion: true } });
      expect(result.note).toMatch(/YouTube Studio/);
    });
  });

  describe("when Instagram is asked for the Paid partnership label", () => {
    const instagram = () => new MetaProvider({ appId: "a", appSecret: "s" }).platforms[1]!;
    const account = { page: { id: "1", name: "Page", token: "t" }, instagram: { id: "2", username: "shop" } };

    it("should send the label and the brands' ids as written", async () => {
      const fetch = stubFetch(
        reply({ id: "c1", uri: "https://rupload.example/c1" }),
        reply({ success: true }),
        reply({ status_code: "FINISHED" }),
        reply({ id: "m1" }),
        reply({ permalink: "https://www.instagram.com/reel/x/" }),
      );
      await instagram().upload({ ...args, account, options: { paidPartnership: true, sponsorIds: ["17841400008460056"] } });
      const form = new URLSearchParams(fetch.mock.calls[0]![1].body);
      expect(form.get("is_paid_partnership")).toBe("true");
      expect(form.get("branded_content_sponsor_ids")).toBe("[17841400008460056]");
    });

    it("should refuse more than 2 brands", async () => {
      const options = { sponsorIds: ["1", "2", "3"] };
      expect(await instagram().checkOptions({ account, save: () => {}, options, seconds: 30 })).toMatch(/at most 2 brands/);
    });
  });
});
