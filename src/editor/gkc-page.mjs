/**
 * Pick / open the right Gimkit tab — never leave the bot on about:blank.
 */
import { CONFIG, log } from "./config.mjs";
import { scoreGkcPage } from "./gkc-knowledge.mjs";

/** All open pages across every context (handles CDP browsers with >1 context). */
export function listAllPages(src) {
  if (!src) return [];
  try {
    if (typeof src.contexts === "function") {
      return src
        .contexts()
        .flatMap((c) => c.pages())
        .filter((p) => !p.isClosed());
    }
    return src.pages().filter((p) => !p.isClosed());
  } catch {
    return [];
  }
}

export function pickCreativePage(src) {
  const pages = listAllPages(src);
  if (pages.length === 0) return null;

  const scored = pages.map((p) => ({
    page: p,
    score: scoreGkcPage(p.url(), ""),
    url: p.url(),
  }));
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score > -50) return best.page;

  const gimkit = scored.find((s) => /gimkit\.com/i.test(s.url));
  if (gimkit) return gimkit.page;

  return pages.find((p) => p.url() && p.url() !== "about:blank") || pages[0];
}

function resolveStartUrl() {
  if (process.env.GKC_HOST_URL) return process.env.GKC_HOST_URL;
  if (process.env.GKC_CREATIVE_URL) return process.env.GKC_CREATIVE_URL;
  return CONFIG.creativeUrl;
}

export async function ensureGimkitPage(context, preferredPage) {
  let page = preferredPage || pickCreativePage(context);
  if (!page) {
    page = await context.newPage();
  }

  let url = page.url() || "";
  const needsNav =
    !url ||
    url === "about:blank" ||
    /^chrome:/i.test(url) ||
    !/gimkit\.com/i.test(url);

  if (needsNav) {
    const target = resolveStartUrl();
    log(`Opening Gimkit (was "${url || "blank"}") → ${target}`);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(2000);
    url = page.url();
    log(`Now at: ${url}`);
  }

  await page.bringToFront().catch(() => {});
  return page;
}

/**
 * Pick the best existing page WITHOUT navigating. `src` may be a browser or context.
 * Navigation decisions are made by connectAndOpenGimkit (which can discover the HOST
 * map via the raw CDP endpoint even when Playwright can't see that tab).
 */
export async function warmBrowserContext(src, contextForNewPage) {
  const ctx = contextForNewPage || src;
  const pages = listAllPages(src);
  if (pages.length === 0) {
    log("No tabs in browser — opening one…");
    return ctx.newPage();
  }

  const urls = pages.map((p) => p.url()).filter(Boolean);
  log(`Browser tabs (${pages.length}): ${urls.length ? urls.join(" | ") : "(empty URLs)"}`);

  const existing = pickCreativePage(src);
  if (existing && /gimkit\.com\/(host|edit)/i.test(existing.url())) {
    log(`Using existing build tab: ${existing.url()}`);
    await existing.bringToFront().catch(() => {});
  }
  return existing || pages[0];
}
