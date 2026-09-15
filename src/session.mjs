/**
 * Session: connect to Chrome (CDP or persistent profile), make sure we are
 * logged into Gimkit and sitting in a build-mode editor, hand back the page.
 */
import { log } from "./editor/config.mjs";
import { connectAndOpenGimkit, waitForGimkitLogin } from "./editor/browser-launch.mjs";
import { pickCreativePage } from "./editor/gkc-page.mjs";
import { ensureGimkitAuth, isLoggedOut, snapshotDashboardMaps } from "./editor/gkc-login.mjs";
import { prepareEditor, dismissDevicePanel } from "./editor/editor-actions.mjs";
import { scanEditorState } from "./editor/gkc-knowledge.mjs";
import { waitForSave } from "./editor/block-code.mjs";
import { CONFIG } from "./editor/config.mjs";

export class GkcSession {
  constructor({ hostUrl = process.env.GKC_HOST_URL || null, auto = true, editorTimeoutMs = 120000 } = {}) {
    this.hostUrl = hostUrl;
    this.auto = auto;
    this.editorTimeoutMs = editorTimeoutMs;
    this.context = null;
    this.browser = null;
    this.attached = false;
    this.page = null;
  }

  /** Connect + login + open the map. Resolves with the live editor page. */
  async open() {
    if (this.hostUrl) process.env.GKC_HOST_URL = this.hostUrl;
    const s = await connectAndOpenGimkit();
    this.context = s.context;
    this.browser = s.browser;
    this.attached = s.attached;
    this.page = s.page;
    const src = s.pagesSource || s.browser || s.context;

    await waitForGimkitLogin(this.page);
    if (this.auto) {
      await ensureGimkitAuth(this.page, { returnTo: this.hostUrl || this.page.url() });
    }

    // If we still are not on a map, try the configured host URL.
    if (this.hostUrl && !/gimkit\.com\/(host|edit)\b/i.test(this.page.url() || "")) {
      log(`Opening map → ${this.hostUrl}`);
      await this.page.goto(this.hostUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      await this.page.waitForTimeout(4000);
      if (await isLoggedOut(this.page)) {
        await ensureGimkitAuth(this.page, { returnTo: this.hostUrl });
      }
    }

    this.page = pickCreativePage(src) || this.page;
    await this.page.bringToFront().catch(() => {});
    return this.page;
  }

  /** Wait until the editor is in build mode (not playtest / dashboard). */
  async waitForEditor() {
    const deadline = Date.now() + this.editorTimeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await prepareEditor(this.page).catch((e) => ({ ok: false, error: e.message }));
      if (last?.ok || last?.state?.canPlace) {
        await dismissDevicePanel(this.page);
        return last.state || (await scanEditorState(this.page));
      }
      const state = last?.state || (await scanEditorState(this.page).catch(() => null));
      if (state?.mode === "dashboard" && !this.hostUrl) {
        await snapshotDashboardMaps(this.page, `${CONFIG.outputDir}/maps.json`);
        throw new Error("On the Creative dashboard with no GKC_HOST_URL set — pick a map from build-output/maps.json and set GKC_HOST_URL.");
      }
      log(`Editor not ready (${state?.mode || "?"}) — retrying in 5s${state?.inPlaytest ? " (stop the playtest)" : ""}`);
      await this.page.waitForTimeout(5000);
    }
    throw new Error("Timed out waiting for the Gimkit editor to be in build mode.");
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
