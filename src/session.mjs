/**
 * Session: connect to Chrome (CDP or persistent profile), make sure we are
 * logged into Gimkit and sitting in a build-mode editor, hand back the page.
 */
import { log } from "./editor/config.mjs";
import { connectAndOpenGimkit, noteLoginHints } from "./editor/browser-launch.mjs";
import { pickCreativePage } from "./editor/gkc-page.mjs";
import { ensureGimkitAuth, isLoggedOut, snapshotDashboardMaps } from "./editor/gkc-login.mjs";
import { prepareEditor, dismissDevicePanel } from "./editor/editor-actions.mjs";
import { scanEditorState } from "./editor/gkc-knowledge.mjs";
import { waitForSave } from "./editor/block-code.mjs";
import { CONFIG } from "./editor/config.mjs";

const MAP_URL_RE = /gimkit\.com\/(host|edit)\b/i;

/** How long a run waits for the editor to reach build mode (or for a person to open a map). */
export function editorTimeoutMs() {
  const n = Number(process.env.GKC_EDITOR_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
}

export class GkcSession {
  constructor({ hostUrl = process.env.GKC_HOST_URL || null, auto = true, editorTimeoutMs: timeout = editorTimeoutMs() } = {}) {
    this.hostUrl = hostUrl;
    this.auto = auto;
    this.editorTimeoutMs = timeout;
    this.context = null;
    this.browser = null;
    this.attached = false;
    this.page = null;
    this.pagesSource = null;
  }

  /** Connect + login + open the map. Resolves with the live editor page. */
  async open() {
    if (this.hostUrl) process.env.GKC_HOST_URL = this.hostUrl;
    const s = await connectAndOpenGimkit();
    this.context = s.context;
    this.browser = s.browser;
    this.attached = s.attached;
    this.page = s.page;
    this.pagesSource = s.pagesSource || s.browser || s.context;

    await noteLoginHints(this.page);
    if (this.auto) {
      await ensureGimkitAuth(this.page, { returnTo: this.hostUrl || this.page.url() });
    }

    // If we still are not on a map, try the configured host URL.
    if (this.hostUrl && !MAP_URL_RE.test(this.page.url() || "")) {
      log(`Opening map → ${this.hostUrl}`);
      await this.page.goto(this.hostUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      await this.page.waitForTimeout(4000);
      if (await isLoggedOut(this.page)) {
        await ensureGimkitAuth(this.page, { returnTo: this.hostUrl });
      }
    }

    this.page = pickCreativePage(this.pagesSource) || this.page;
    await this.page.bringToFront().catch(() => {});
    return this.page;
  }

  /** If a map got opened in another tab (a person clicked it on the dashboard), follow it. */
  adoptMapTab() {
    if (MAP_URL_RE.test(this.page?.url?.() || "")) return false;
    const best = pickCreativePage(this.pagesSource);
    if (best && best !== this.page && MAP_URL_RE.test(best.url() || "")) {
      log(`Following the map tab → ${best.url()}`);
      this.page = best;
      return true;
    }
    return false;
  }

  /**
   * Wait until the editor is in build mode (not playtest / dashboard). On the
   * dashboard with no GKC_HOST_URL it waits for a map to be opened in the window
   * (and lists the visible maps in build-output/maps.json meanwhile).
   */
  async waitForEditor() {
    const deadline = Date.now() + this.editorTimeoutMs;
    let last = null;
    let askedForMap = false;
    while (Date.now() < deadline) {
      this.adoptMapTab();
      last = await prepareEditor(this.page).catch((e) => ({ ok: false, error: e.message }));
      if (last?.ok || last?.state?.canPlace) {
        await dismissDevicePanel(this.page);
        return last.state || (await scanEditorState(this.page));
      }
      const state = last?.state || (await scanEditorState(this.page).catch(() => null));
      if (state?.mode === "dashboard" && !this.hostUrl) {
        if (!askedForMap) {
          askedForMap = true;
          const maps = await snapshotDashboardMaps(this.page, `${CONFIG.outputDir}/maps.json`);
          log(`On the Creative dashboard: open the map to build in this Chrome window (or set GKC_HOST_URL). ${maps.length} map link(s) listed in build-output/maps.json.`);
        }
      } else {
        log(`Editor not ready (${state?.mode || "?"}) — retrying in 5s${state?.inPlaytest ? " (stop the playtest)" : ""}`);
      }
      await this.page.waitForTimeout(5000);
    }
    throw new Error(`Timed out after ${Math.round(this.editorTimeoutMs / 60000)} min waiting for the Gimkit editor to be in build mode (GKC_EDITOR_TIMEOUT_MS).`);
  }

  /**
   * Close the session. Always waits for Gimkit's save indicator to clear (plus a
   * short idle) first so the last blocks/option edit is not lost — the editor
   * autosaves asynchronously after the panel closes.
   */
  async close({ keepBrowser = true, waitForSave: doWait = true } = {}) {
    if (doWait && this.page && !this.page.isClosed?.()) {
      await dismissDevicePanel(this.page).catch(() => {});
      const r = await waitForSave(this.page).catch(() => null);
      if (r?.sawSaving) log(`Waited ${r.waitedMs} ms for Gimkit to finish saving.`);
    }
    if (this.attached || keepBrowser) {
      log("Leaving Chrome open (map stays loaded).");
      return;
    }
    await this.context?.close().catch(() => {});
  }
}
