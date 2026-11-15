// The invite link's preview card (GET /invite/?code=…) and its JSON twin (GET /api/invite/preview).
//
// What must hold (fresh-insights PR "invite preview", Josh 2026-11-15):
//   - a recipe code's card says "<sender> sent you a recipe", the recipe's title, the recipe's photo
//   - a plan code's card says "<sender> invited you to plan meals together", "<plan> · <n> dinners, <range>"
//   - a general code, a failed lookup, missing secrets or no code serve the site's page unchanged
//   - every value from the lookup is escaped; a photo is used only when it is an https URL
//   - the code and the link's other parameters never appear in what is served
//   - a completed lookup is cached by code for minutes; a failed one is not
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { clearPreviewCache, lookupPreview, previewCard, dateRange, PREVIEW_TTL_MS, INVITE_PREVIEW_RPC } from "../src/invitePreview.js";
import { HTMLRewriterDouble } from "./htmlRewriterDouble.js";

const ORIGIN = "https://insights.freshfoodrecs.com";
const SUPABASE = "https://example-project.supabase.co";
const ANON = "anon-test-key";
const WORKER = "https://fresh-insights-engage.freshfoodrecs.workers.dev";

// The served page's head as GitHub Pages has it (2026-11-15), trimmed to the tags that matter.
const PAGE = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>You’re invited to FRESH – FRESH Insights</title>
<meta name="quarto:offset" content="../">
<meta property="og:title" content="You’re invited to FRESH">
<meta property="og:description" content="Understand nutrition, find recipes, plan meals, and eat a little healthier with less effort.">
<meta property="og:image" content="https://insights.freshfoodrecs.com/invite/invite-card.png">
<meta property="og:site_name" content="FRESH Insights">
<meta name="twitter:title" content="You’re invited to FRESH">
<meta name="twitter:image" content="https://insights.freshfoodrecs.com/invite/invite-card.png">
<meta name="twitter:card" content="summary_large_image">
</head><body><header id="quarto-header"></header>
<div class="fi-invite-mark"><img src="../fresh-mark.png" alt="FRESH"></div>
<h1 class="title">You’re invited to FRESH</h1>
</body></html>`;

const F = INVITE_PREVIEW_RPC.fields;
const RECIPE_ROW = {
  [F.kind]: "recipe", [F.senderName]: "Ana", [F.recipeTitle]: "Lemon chicken orzo",
  [F.recipePhotoUrl]: "https://images.example.com/orzo.jpg",
  [F.planName]: null, [F.dinnerCount]: null, [F.startsOn]: null, [F.endsOn]: null,
};
const PLAN_ROW = {
  [F.kind]: "plan", [F.senderName]: "Ana", [F.recipeTitle]: null, [F.recipePhotoUrl]: null,
  [F.planName]: "Week of Nov 17", [F.dinnerCount]: 5, [F.startsOn]: "2026-11-17", [F.endsOn]: "2026-11-21",
};
const GENERAL_ROW = { [F.kind]: "general", [F.senderName]: "Ana" };

let rpc; // what the fake Supabase returns: a row, an array, a Response, or a thrown error
let rpcCalls;

function env(overrides = {}) {
  return { SUPABASE_URL: SUPABASE, SUPABASE_ANON_KEY: ANON, INVITE_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN, ...overrides };
}

beforeEach(() => {
  clearPreviewCache();
  rpc = [RECIPE_ROW];
  rpcCalls = [];
  vi.stubGlobal("HTMLRewriter", HTMLRewriterDouble);
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === `${ORIGIN}/invite/`) {
      return new Response(PAGE, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"abc"' } });
    }
    if (url.startsWith(ORIGIN + "/invite/")) return new Response("png-bytes", { status: 200, headers: { "Content-Type": "image/png" } });
    if (url.startsWith(SUPABASE)) {
      rpcCalls.push({ url, init, body: JSON.parse(init.body) });
      if (rpc instanceof Error) throw rpc;
      if (rpc instanceof Response) return rpc;
      return new Response(JSON.stringify(rpc), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unexpected fetch " + url);
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

async function page(query = "?code=AB12-cd34&kind=recipe&from=recipe&by=Ana", host = WORKER, e = env()) {
  const res = await worker.fetch(new Request(`${host}/invite/${query}`), e);
  return { res, html: await res.text() };
}

function meta(html, key, val) {
  const m = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html);
  return val === undefined ? (m ? m[1] : null) : m;
}

describe("GET /invite/ — the link preview card", () => {
  it("recipe: sender sent you a recipe, the title, the photo", async () => {
    const { res, html } = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(meta(html, "og:title")).toBe("Ana sent you a recipe");
    expect(meta(html, "og:description")).toBe("Lemon chicken orzo");
    expect(meta(html, "og:image")).toBe("https://images.example.com/orzo.jpg");
    expect(meta(html, "twitter:title")).toBe("Ana sent you a recipe");
    expect(meta(html, "twitter:image")).toBe("https://images.example.com/orzo.jpg");
    expect(html).toContain("<title>Ana sent you a recipe</title>");
    // The general tags are gone, not left beside the new ones (a messenger may read the first).
    expect(html).not.toContain("You’re invited to FRESH\">");
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html.match(/<title>/g)).toHaveLength(1);
    // The page reads the same card.
    const data = /<script type="application\/json" id="fi-invite-preview-data">(.*?)<\/script>/.exec(html);
    expect(JSON.parse(data[1])).toEqual({
      kind: "recipe", title: "Ana sent you a recipe", description: "Lemon chicken orzo",
      image: "https://images.example.com/orzo.jpg", photo: true,
    });
    // Served from workers.dev, the page's relative links resolve against the site.
    expect(html).toContain(`<head><base href="${ORIGIN}/invite/">`);
    // The lookup: one RPC call, the code as its argument, the anon key in both headers.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].url).toBe(`${SUPABASE}/rest/v1/rpc/${INVITE_PREVIEW_RPC.fn}`);
    expect(rpcCalls[0].body).toEqual({ [INVITE_PREVIEW_RPC.codeParam]: "AB12-cd34" });
    expect(rpcCalls[0].init.headers.apikey).toBe(ANON);
    expect(rpcCalls[0].init.headers.Authorization).toBe(`Bearer ${ANON}`);
    // workerd rejects redirect: "error" (found under `wrangler dev`, where it threw and every card was general).
    expect(rpcCalls[0].init.redirect).toBe("manual");
  });

  it("plan: sender invited you to plan meals together, the plan's name and dinners", async () => {
    rpc = [PLAN_ROW];
    const { html } = await page("?code=PLAN1&kind=plan&by=Ana");
    expect(meta(html, "og:title")).toBe("Ana invited you to plan meals together");
    expect(meta(html, "og:description")).toBe("Week of Nov 17 · 5 dinners, Nov 17–21");
    expect(meta(html, "og:image")).toBe(`${ORIGIN}/fresh-mark.png`);
  });

  it("plan: one dinner reads singular; a missing part is left out", async () => {
    rpc = { ...PLAN_ROW, [F.dinnerCount]: 1, [F.startsOn]: null, [F.endsOn]: null, [F.senderName]: null };
    const { html } = await page("?code=PLAN2");
    expect(meta(html, "og:title")).toBe("A friend invited you to plan meals together");
    expect(meta(html, "og:description")).toBe("Week of Nov 17 · 1 dinner");
  });

  it("event: the same card as a plan, over the event's own days", async () => {
    rpc = [{ ...PLAN_ROW, [F.kind]: "event", [F.planName]: "Thanksgiving", [F.dinnerCount]: 3, [F.startsOn]: "2026-11-26", [F.endsOn]: "2026-11-28" }];
    const { html } = await page("?code=EVENT1");
    expect(meta(html, "og:title")).toBe("Ana invited you to plan meals together");
    expect(meta(html, "og:description")).toBe("Thanksgiving · 3 dinners, Nov 26–28");
  });

  it("plan with no dinners yet: the plan's name alone; with no name either, the general card", async () => {
    rpc = [{ ...PLAN_ROW, [F.dinnerCount]: 0, [F.startsOn]: null, [F.endsOn]: null }];
    expect(meta((await page("?code=EMPTY1")).html, "og:description")).toBe("Week of Nov 17");
    rpc = [{ ...PLAN_ROW, [F.planName]: null, [F.dinnerCount]: 0, [F.startsOn]: null, [F.endsOn]: null }];
    expect(meta((await page("?code=EMPTY2")).html, "og:title")).toBe("You’re invited to FRESH");
  });

  it("catalog recipe: no public photo, so the title over the general card picture", async () => {
    rpc = [{ ...RECIPE_ROW, [F.recipeTitle]: "Sheet-pan salmon", [F.recipePhotoUrl]: null }];
    const { html } = await page("?code=CAT1");
    expect(meta(html, "og:title")).toBe("Ana sent you a recipe");
    expect(meta(html, "og:description")).toBe("Sheet-pan salmon");
    expect(meta(html, "og:image")).toBe(`${ORIGIN}/invite/invite-card.png`);
  });

  it("general: the site's page as it is (the FRESH text and the FRESH mark card)", async () => {
    rpc = [GENERAL_ROW];
    const { html } = await page("?code=GEN1&kind=general&by=Ana");
    expect(meta(html, "og:title")).toBe("You’re invited to FRESH");
    expect(meta(html, "og:image")).toBe(`${ORIGIN}/invite/invite-card.png`);
    expect(html).not.toContain("fi-invite-preview-data");
    expect(rpcCalls).toHaveLength(1);
  });

  it("no code, or a code of the wrong shape: general, and no lookup", async () => {
    for (const q of ["", "?code=", "?code=%3Cscript%3E", "?code=" + "A".repeat(33)]) {
      const { html } = await page(q);
      expect(meta(html, "og:title")).toBe("You’re invited to FRESH");
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("failed lookup: an error status, a thrown fetch, an empty answer or missing secrets serve the general card", async () => {
    const cases = [
      () => { rpc = new Response("boom", { status: 500 }); },
      () => { rpc = new Error("network down"); },
      () => { rpc = []; },
      () => { rpc = new Response("not json", { status: 200 }); },
      () => { rpc = new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }); },
    ];
    for (const [i, set] of cases.entries()) {
      set();
      const { res, html } = await page(`?code=FAIL${i}`);
      expect(res.status).toBe(200);
      expect(meta(html, "og:title")).toBe("You’re invited to FRESH");
      expect(html).not.toContain("fi-invite-preview-data");
    }
    rpcCalls = [];
    rpc = [RECIPE_ROW];
    for (const e of [env({ SUPABASE_URL: undefined }), env({ SUPABASE_ANON_KEY: undefined }), env({ SUPABASE_URL: "http://plain.example.com" })]) {
      const { html } = await page("?code=NOSECRET", WORKER, e);
      expect(meta(html, "og:title")).toBe("You’re invited to FRESH");
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("injection: a hostile title, name and photo are escaped or refused", async () => {
    rpc = [{
      ...RECIPE_ROW,
      [F.senderName]: `Eve"><script>alert(1)</script>`,
      [F.recipeTitle]: `"><script>alert('x')</script><meta property="og:image" content="https://evil.example/x.png"> </script><!--`,
      [F.recipePhotoUrl]: `javascript:alert(1)`,
    }];
    const { html } = await page("?code=EVIL1");
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toContain(`content="https://evil.example/x.png"`);
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    // The photo was refused, so the image is the general card's.
    expect(meta(html, "og:image")).toBe(`${ORIGIN}/invite/invite-card.png`);
    expect(meta(html, "og:title")).toBe("Eve&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; sent you a recipe");
    // The inline JSON cannot close its script element or open a comment.
    const data = /<script type="application\/json" id="fi-invite-preview-data">(.*?)<\/script>/s.exec(html)[1];
    expect(data).not.toMatch(/[<>]/);
    expect(data).not.toContain(" ");
    expect(JSON.parse(data).description).toContain(`<script>alert('x')</script>`);
    expect(JSON.parse(data).photo).toBe(false);
  });

  it("photo: http, credentials and non-URLs are refused; https is kept", () => {
    for (const bad of ["http://images.example.com/a.jpg", "https://u:p@images.example.com/a.jpg", "data:image/png;base64,AAAA", "//images.example.com/a.jpg", 42]) {
      const card = previewCard({ ...RECIPE_ROW, [F.recipePhotoUrl]: bad });
      expect(card.photo).toBe(false);
      expect(card.image).toBe(`${ORIGIN}/invite/invite-card.png`);
    }
    expect(previewCard({ ...RECIPE_ROW, [F.recipePhotoUrl]: null }).photo).toBe(false);
  });

  it("never echoes the code or the link's other parameters", async () => {
    rpc = [{ ...RECIPE_ROW, [F.senderName]: "Ana" }];
    const { html } = await page("?code=ECHO-7731&kind=plan&from=household&by=Mallory");
    expect(html).not.toContain("ECHO-7731");
    expect(html).not.toContain("Mallory");
    expect(html).not.toContain("household");
    expect(meta(html, "og:title")).toBe("Ana sent you a recipe"); // the lookup's kind, not the link's
  });

  it("on the site's own host: no <base>, and the page's other files go straight to the site", async () => {
    const { html } = await page("?code=AB12", ORIGIN);
    expect(html).not.toContain("<base");
    expect(meta(html, "og:title")).toBe("Ana sent you a recipe");
    const img = await worker.fetch(new Request(`${ORIGIN}/invite/invite-card.png`), env());
    expect(await img.text()).toBe("png-bytes");
  });

  it("/invite redirects to /invite/ keeping the query", async () => {
    const res = await worker.fetch(new Request(`${WORKER}/invite?code=AB12`), env());
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/invite/?code=AB12");
  });
});

describe("dateRange (starts_on, ends_on as PostgREST sends dates)", () => {
  it("reads calendar days without a timezone shift", () => {
    expect(dateRange("2026-11-17", "2026-11-21")).toBe("Nov 17–21");
    expect(dateRange("2026-11-28", "2026-12-02")).toBe("Nov 28 – Dec 2");
    expect(dateRange("2026-12-29", "2027-01-02")).toBe("Dec 29 – Jan 2");
    expect(dateRange("2026-11-17", "2026-11-17")).toBe("Nov 17");
    expect(dateRange("2026-11-21", "2026-11-17")).toBe("Nov 17–21");
    expect(dateRange("2026-11-17", null)).toBe("Nov 17");
    expect(dateRange(null, null)).toBeNull();
    expect(dateRange("Nov 17", "<b>")).toBeNull();
  });
});

describe("the preview cache", () => {
  it("keeps a completed lookup for the TTL, by code", async () => {
    const t0 = 1_000_000;
    await lookupPreview("C1", env(), t0);
    await lookupPreview("C1", env(), t0 + PREVIEW_TTL_MS - 1);
    expect(rpcCalls).toHaveLength(1);
    await lookupPreview("C2", env(), t0);
    expect(rpcCalls).toHaveLength(2);
    await lookupPreview("C1", env(), t0 + PREVIEW_TTL_MS + 1);
    expect(rpcCalls).toHaveLength(3);
  });

  it("does not keep a failure", async () => {
    rpc = new Response("boom", { status: 503 });
    expect(await lookupPreview("C3", env())).toBeNull();
    rpc = [RECIPE_ROW];
    expect((await lookupPreview("C3", env())).title).toBe("Ana sent you a recipe");
    expect(rpcCalls).toHaveLength(2);
  });
});

describe("GET /api/invite/preview", () => {
  it("returns the same card as JSON, with CORS for the site", async () => {
    const res = await worker.fetch(new Request(`${WORKER}/api/invite/preview?code=AB12`, { headers: { Origin: ORIGIN } }), env());
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(await res.json()).toEqual({ preview: {
      kind: "recipe", title: "Ana sent you a recipe", description: "Lemon chicken orzo",
      image: "https://images.example.com/orzo.jpg", photo: true,
    } });
  });

  it("returns null for a general code or a failed lookup", async () => {
    rpc = [GENERAL_ROW];
    expect(await (await worker.fetch(new Request(`${WORKER}/api/invite/preview?code=G1`), env())).json()).toEqual({ preview: null });
    rpc = new Error("down");
    expect(await (await worker.fetch(new Request(`${WORKER}/api/invite/preview?code=G2`), env())).json()).toEqual({ preview: null });
  });
});
