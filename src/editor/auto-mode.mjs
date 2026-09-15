/**
 * Shared unattended-run helpers for the Gimkit NN builder.
 *
 * Auto mode is enabled with any of:
 *   $env:GKC_AUTO="1" | $env:GKC_NO_PROMPT="1" | $env:GKC_UNATTENDED="1"
 *   node src/index.mjs --configure-only --auto
 *
 * In auto mode every interactive ENTER prompt becomes a short timed pause so
 * the full pipeline (configure -> wire -> blocks -> self-check) can run without
 * a person at the keyboard. Interactive behaviour is unchanged otherwise.
 */
import readline from "readline";
import { log } from "./config.mjs";

function envFlag(name) {
  const v = (process.env[name] || "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

export function isAutoMode(argv = process.argv.slice(2)) {
  if (envFlag("GKC_AUTO") || envFlag("GKC_NO_PROMPT") || envFlag("GKC_UNATTENDED")) return true;
  return argv.some((a) => ["--auto", "--no-prompt", "--unattended", "--yes", "-y"].includes(a));
}

export function autoDelayMs() {
  const n = Number(process.env.GKC_AUTO_DELAY_MS);
  if (Number.isFinite(n) && n >= 0) return n;
  return 3000;
}

export function loginTimeoutMs() {
  const n = Number(process.env.GKC_LOGIN_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return 180000;
}

export function editorReadyTimeoutMs() {
  const n = Number(process.env.GKC_EDITOR_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return 120000;
}

function waitForEnterInteractive(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/** ENTER prompt in interactive mode, timed pause in auto mode. */
export async function waitForEnterOrAuto(prompt, { delayMs = autoDelayMs() } = {}) {
  if (!isAutoMode()) return waitForEnterInteractive(prompt);
  log(`${prompt} (auto: continuing in ${Math.round(delayMs / 1000)}s — set GKC_AUTO_DELAY_MS to change)`);
  await new Promise((r) => setTimeout(r, delayMs));
}

/** Poll until the page URL looks like a Gimkit build/login-complete page. */
export async function waitForGimkitReady(page, { timeoutMs = loginTimeoutMs() } = {}) {
  if (!isAutoMode()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const url = page.url() || "";
      if (/gimkit\.com\/(host|edit|creative|dashboard)/i.test(url)) return true;
    } catch {
      /* page may be navigating */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    "Timed out waiting for Gimkit (auto mode). Open the HOST map in Chrome first, or set $env:GKC_HOST_URL to the map URL.",
  );
}

/**
 * Poll prepareEditor() until the editor reports canPlace (auto mode only).
 * Returns the last prepare result. Interactive callers keep their own flow.
 */
export async function waitForEditorReady(page, prepareEditor, { timeoutMs = editorReadyTimeoutMs() } = {}) {
  const first = await prepareEditor(page);
  if (!isAutoMode() || first?.state?.canPlace || first?.ok) return first;
  const deadline = Date.now() + timeoutMs;
  let last = first;
  while (Date.now() < deadline) {
    log("Editor not in build mode yet (auto: retrying in 5s — stop playtest / open HOST map)...");
    await new Promise((r) => setTimeout(r, 5000));
    try {
      last = await prepareEditor(page);
    } catch (err) {
      log(`Editor probe failed: ${err.message}`);
      continue;
    }
    if (last?.state?.canPlace || last?.ok) return last;
  }
  return last;
}
