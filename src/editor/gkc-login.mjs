/**
 * Gimkit authentication for unattended runs.
 *
 * Credentials come from the environment (Cursor Dashboard secrets or shell):
 *   GKC_EMAIL    — Gimkit account email (email login, NOT Google OAuth)
 *   GKC_PASSWORD — Gimkit account password
 *
 * Google OAuth does not work in automation ("browser may not be secure"),
 * so email login is the only hands-off path.
 */
import { log } from "./config.mjs";

function creds() {
  const email = (process.env.GKC_EMAIL || "").trim();
  const password = (process.env.GKC_PASSWORD || "").trim();
  return { email, password };
}

/** True when the page shows the "Logged Out" modal or sits on a login page. */
export async function isLoggedOut(page) {
  try {
    const url = page.url() || "";
    if (/gimkit\.com\/login/i.test(url)) return true;
    return await page.evaluate(() =>
      /you have been logged out of gimkit/i.test(document.body?.innerText || ""),
    );
  } catch {
    return false;
  }
}

/** True when the page looks like an authenticated Gimkit page (not logged out). */
export async function isAuthenticated(page) {
  return !(await isLoggedOut(page));
}

/** Click through the "Logged Out" modal if it is showing. */
export async function dismissLoggedOutModal(page) {
  if (!(await isLoggedOut(page))) return false;
  try {
    const ok = page.locator('button:has-text("OK")').first();
    if (await ok.isVisible({ timeout: 3000 }).catch(() => false)) {
      await ok.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  } catch {
    /* best effort */
  }
  return true;
}

/** Email-login flow. Assumes the page is already on a Gimkit login screen. */
async function emailLogin(page, email, password) {
  const emailInput = page.locator('input[placeholder*="Email" i]').first();
  await emailInput.waitFor({ state: "visible", timeout: 20000 });
  await emailInput.click();
  await page.keyboard.type(email, { delay: 25 });
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);

  const noAccount = await page
    .evaluate(() => /no account found/i.test(document.body?.innerText || ""))
    .catch(() => false);
  if (noAccount) {
    throw new Error(`No Gimkit account for ${email} — check GKC_EMAIL`);
  }

  const passInput = page.locator('input[type="password"]').first();
  await passInput.waitFor({ state: "visible", timeout: 20000 });
  await passInput.click();
  await page.keyboard.type(password, { delay: 25 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);

  if (await isLoggedOut(page)) {
    throw new Error("Gimkit login failed — wrong GKC_EMAIL/GKC_PASSWORD or extra verification needed");
  }
  log("Gimkit email login OK");
}

/** How long a run waits for a person to log in when no credentials are configured. */
export function loginTimeoutMs() {
  const n = Number(process.env.GKC_LOGIN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}

/** Poll until the page is authenticated (someone logged in by hand) or the timeout passes. */
async function waitForManualLogin(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let nextNote = 0;
  while (Date.now() < deadline) {
    if (page.isClosed?.()) throw new Error("The Gimkit window was closed before login finished.");
    if (await isAuthenticated(page)) return true;
    if (Date.now() >= nextNote) {
      const left = Math.round((deadline - Date.now()) / 60000);
      log(`Waiting for you to log in to Gimkit in the Chrome window (${left} min left; email login — Google sign-in is blocked in automated Chrome)…`);
      nextNote = Date.now() + 60000;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Guarantee an authenticated Gimkit session in this persistent context.
 * - Already logged in → returns immediately.
 * - Logged out + creds present → logs in via email, returns to `returnTo` URL.
 * - Logged out + no creds → waits for a manual login in the open window
 *   (GKC_LOGIN_TIMEOUT_MS, default 15 min), then throws with setup instructions.
 */
export async function ensureGimkitAuth(page, { returnTo = null } = {}) {
  if (await isAuthenticated(page)) return { ok: true, method: "existing-session" };

  await dismissLoggedOutModal(page);
  // Modal may have redirected to login; re-check.
  if (await isAuthenticated(page)) return { ok: true, method: "existing-session" };

  const backTo = returnTo || page.url();
  const { email, password } = creds();
  if (!email || !password) {
    if (!/gimkit\.com\/login/i.test(page.url() || "")) {
      await page.goto("https://www.gimkit.com/login?location=%2Fcreative", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    }
    await page.bringToFront().catch(() => {});
    const ok = await waitForManualLogin(page, loginTimeoutMs());
    if (!ok) {
      throw new Error(
        "Not logged in to Gimkit. Log in once in the Chrome window the SDK opens (the profile remembers it), " +
          "or set GKC_EMAIL + GKC_PASSWORD for unattended email login.",
      );
    }
    log("Gimkit login detected — continuing.");
    if (backTo && /gimkit\.com\/(host|edit)\b/i.test(backTo) && !/gimkit\.com\/(host|edit)\b/i.test(page.url() || "")) {
      await page.goto(backTo, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(4000);
    }
    return { ok: true, method: "manual-login" };
  }

  await page.goto("https://www.gimkit.com/login?location=%2Fcreative", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(4000);
  await emailLogin(page, email, password);

  if (backTo && /gimkit\.com\/(host|edit|creative)/i.test(backTo)) {
    await page.goto(backTo, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(4000);
  }
  return { ok: true, method: "email-login" };
}

/**
 * Fallback artifact: list maps visible on the /creative dashboard so a stale
 * host URL can be replaced with a live one (writes build-output/maps.json).
 */
export async function snapshotDashboardMaps(page, outPath) {
  const maps = [];
  try {
    await page.goto("https://www.gimkit.com/creative", { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(6000);
    const found = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        if (!/\/(host|edit)\b/i.test(href)) continue;
        const label = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        out.push({ label, href: href.startsWith("http") ? href : `https://www.gimkit.com${href}` });
      }
      return out;
    });
    const seen = new Set();
    for (const m of found || []) {
      if (seen.has(m.href)) continue;
      seen.add(m.href);
      maps.push(m);
    }
  } catch (err) {
    log(`Dashboard map scan failed: ${err.message}`);
  }
  try {
    const fs = await import("fs");
    fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), maps }, null, 2));
  } catch {
    /* best effort */
  }
  log(`Dashboard maps: ${maps.length} (see build-output/maps.json)`);
  return maps;
}
