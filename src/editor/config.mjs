import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** SDK package root (…/gimkit-creative-sdk). */
export const ROOT = path.resolve(__dirname, "..", "..");

export const CONFIG = {
  profileDir: process.env.GKC_PROFILE_DIR || path.join(ROOT, "browser-profile"),
  creativeUrl: process.env.GKC_CREATIVE_URL || "https://www.gimkit.com/creative",
  outputDir: process.env.GKC_OUTPUT_DIR || path.join(ROOT, "build-output"),
  placeDelayMs: Number(process.env.GKC_PLACE_DELAY_MS) || 900,
  searchTimeoutMs: Number(process.env.GKC_SEARCH_TIMEOUT_MS) || 4000,
  /** Map zoom factor in GKC editor (0.3 = zoomed out to 30%). Screen clicks scale by this. */
  mapZoom: Number(process.env.GKC_ZOOM || process.env.GKC_ZOOM_OUT) || 0.3,
  /** Min pixels between device clicks at low zoom (icons overlap below ~90px). */
  minScreenGapX: Number(process.env.GKC_MIN_GAP_X) || 95,
  minScreenGapY: Number(process.env.GKC_MIN_GAP_Y) || 68,
  /** Grid step when scanning map for devices after user pans (pixels). */
  mapScanStep: Number(process.env.GKC_SCAN_STEP) || 44,
};

let quiet = false;
export function setQuiet(v) {
  quiet = !!v;
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (!quiet) console.log(line);
  try {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    fs.appendFileSync(path.join(CONFIG.outputDir, "build.log"), line + "\n", "utf8");
  } catch {
    /* logging must never crash the bot */
  }
}

/** Real viewport size — page.viewportSize() is null under CDP attach, so read innerWidth. */
export async function getViewport(page) {
  try {
    const v = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (v && v.width > 200 && v.height > 200) return v;
  } catch {
    /* fall through */
  }
  return page.viewportSize() || { width: 1500, height: 900 };
}
