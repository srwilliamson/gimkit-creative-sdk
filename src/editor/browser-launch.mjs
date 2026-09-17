/**
 * Launch Chrome for Gimkit — attach over CDP when GKC_CDP_PORT/URL is set,
 * otherwise launch the installed Chrome with the SDK's persistent profile
 * (browser-profile/ or GKC_PROFILE_DIR), which keeps the Gimkit login between runs.
 */
import { chromium } from "playwright";
import { CONFIG, log } from "./config.mjs";
import { warmBrowserContext, ensureGimkitPage } from "./gkc-page.mjs";

const STEALTH_INIT = `
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  window.chrome = window.chrome || { runtime: {} };
`;

async function launchPersistent() {
  const profileDir = CONFIG.profileDir;
  log(`Browser profile: ${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: process.env.GKC_HEADLESS === "1",
    viewport: { width: 1500, height: 950 },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-popup-blocking",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  await context.addInitScript(STEALTH_INIT);
  return { context, browser: null, attached: false, mode: "playwright" };
}

async function tryConnectCdp(cdpRaw) {
  const url = cdpRaw.startsWith("http") ? cdpRaw : `http://127.0.0.1:${cdpRaw}`;
  log(`Connecting to Chrome at ${url} …`);
  const browser = await chromium.connectOverCDP(url);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error("CDP connected but Chrome returned no contexts — close Chrome and run launch-chrome-debug.ps1");
  }
  // Prefer the context that already has a Gimkit HOST/edit tab open.
  let context = contexts[0];
  for (const c of contexts) {
    if (c.pages().some((p) => /gimkit\.com\/(host|edit)/i.test(p.url()))) {
      context = c;
      break;
    }
  }
  log(`CDP attached: ${contexts.length} context(s), ${browser.contexts().flatMap((c) => c.pages()).length} tab(s)`);
  return { context, browser, attached: true, mode: "cdp" };
}

export async function launchGimkitBrowser() {
  const cdp = process.env.GKC_CDP_URL || process.env.GKC_CDP_PORT;

  if (cdp) {
    try {
      return await tryConnectCdp(String(cdp));
    } catch (err) {
      log(`CDP connect failed: ${err.message}`);
      log("Chrome must be running WITH --remote-debugging-port BEFORE you start the bot.");
      log("Run: powershell -ExecutionPolicy Bypass -File launch-chrome-debug.ps1");
      log("Falling back to Playwright Chrome (use email login, not Google).");
    }
  }

  return launchPersistent();
}

/** Ask the Chrome DevTools endpoint for an open HOST/edit map URL (Playwright sometimes can't see it). */
async function discoverHostUrlViaCdp(cdpRaw) {
  if (!cdpRaw) return null;
  try {
    const base = String(cdpRaw).startsWith("http") ? String(cdpRaw) : `http://127.0.0.1:${cdpRaw}`;
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(4000) });
    const list = await res.json();
    const pages = (list || []).filter((t) => t.type === "page" && t.url);
    const host = pages.find((t) => /gimkit\.com\/(host|edit)\b/i.test(t.url));
    return host ? host.url : null;
  } catch {
    return null;
  }
}

/** Connect browser and ensure we are not stuck on about:blank. */
export async function connectAndOpenGimkit() {
  const session = await launchGimkitBrowser();
  // Search across ALL contexts (CDP can expose the host tab in a non-default context).
  const src = session.browser || session.context;
  let page = await warmBrowserContext(src, session.context);

  // If Playwright didn't land on a real build tab, find the HOST map via the raw
  // CDP endpoint and navigate our controllable page straight to it.
  if (!/gimkit\.com\/(host|edit)\b/i.test(page.url() || "")) {
    const cdp = process.env.GKC_CDP_URL || process.env.GKC_CDP_PORT;
    const hostUrl = await discoverHostUrlViaCdp(cdp);
    if (hostUrl) {
      log(`Discovered HOST map via CDP → ${hostUrl}`);
      await page.goto(hostUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(2500);
      log(`Now at: ${page.url()}`);
    } else {
      page = await ensureGimkitPage(session.context, page);
    }
  }
  return { ...session, page, pagesSource: src };
}

export async function isGoogleLoginBlocked(page) {
  if (!page || page.isClosed()) return false;
  if (!/accounts\.google\.com/i.test(page.url())) return false;
  return page.evaluate(() =>
    /couldn'?t sign you in|may not be secure|browser or app may not be secure/i.test(
      document.body?.innerText || "",
    ),
  );
}

/** Explain the one login path that does not work in automated Chrome. */
export async function noteLoginHints(page) {
  if (await isGoogleLoginBlocked(page)) {
    log("Google blocked sign-in in this Chrome. Go back and use 'Continue with email' on Gimkit,");
    log("or attach to your own Chrome instead: start it with --remote-debugging-port=9222 and set GKC_CDP_PORT=9222.");
  }
}
