/**
 * Layout: turn grid positions (row/col) into editor screen coordinates that
 * fit the current viewport, and remember named device positions.
 */
import { CONFIG } from "./editor/config.mjs";

export class Layout {
  constructor({ originX = 72, originY = 72, gapX = CONFIG.minScreenGapX, gapY = CONFIG.minScreenGapY } = {}) {
    this.originX = originX;
    this.originY = originY;
    this.gapX = gapX;
    this.gapY = gapY;
    this.named = new Map(); // name(lower) → { x, y, type }
  }

  /** Grid → screen coords. */
  grid(row, col) {
    return { x: Math.round(this.originX + col * this.gapX), y: Math.round(this.originY + row * this.gapY) };
  }

  /** Shrink gaps so `rows × cols` fits inside the viewport (keeps the right sidebar clear). */
  fitToViewport(viewport, rows, cols) {
    const vp = viewport || { width: 1500, height: 900 };
    const margin = { top: 78, bottom: 105, left: 55, right: 380 };
    const availW = Math.max(140, vp.width - margin.left - margin.right);
    const availH = Math.max(140, vp.height - margin.top - margin.bottom);
    const maxCol = Math.max(cols - 1, 1);
    const maxRow = Math.max(rows - 1, 1);
    this.gapX = Math.max(48, Math.min(CONFIG.minScreenGapX, Math.floor(availW / maxCol)));
    this.gapY = Math.max(42, Math.min(CONFIG.minScreenGapY, Math.floor(availH / maxRow)));
    this.originX = margin.left + Math.max(0, Math.floor((availW - maxCol * this.gapX) / 2));
    this.originY = margin.top;
    return this;
  }

  /**
   * The part of the editor where clicks reach the map: right of the left toolbar,
   * below the top bar, left of the device sidebar (which opens at ~52% width and
   * swallows clicks), above the bottom bar. openDeviceAt silently re-targets
   * clicks past the sidebar edge — so a device placed there is unreachable later.
   */
  static safeZone(viewport) {
    const vp = viewport || { width: 1500, height: 900 };
    return { left: 40, top: 60, right: Math.floor(vp.width * 0.52) - 10, bottom: vp.height - 60 };
  }
  static inSafeZone(pos, viewport) {
    const z = Layout.safeZone(viewport);
    return pos.x >= z.left && pos.x <= z.right && pos.y >= z.top && pos.y <= z.bottom;
  }

  remember(name, pos, type) {
    if (!name) return;
    this.named.set(String(name).toLowerCase(), { ...pos, type });
  }

  lookup(name) {
    if (!name) return null;
    return this.named.get(String(name).toLowerCase()) || null;
  }

  /**
   * Resolve a position spec:
   *   { x, y } | { row, col } | { at: "Device Name" } | "r1c2" | "400,300" | "Device Name"
   */
  resolve(spec) {
    if (!spec) return null;
    if (typeof spec === "object") {
      if (Number.isFinite(spec.x) && Number.isFinite(spec.y)) return { x: spec.x, y: spec.y };
      if (Number.isFinite(spec.row) && Number.isFinite(spec.col)) return this.grid(spec.row, spec.col);
      if (spec.at) return this.resolve(spec.at);
      return null;
    }
    const s = String(spec).trim();
    let m;
    if ((m = s.match(/^(-?\d+)\s*[, ]\s*(-?\d+)$/))) return { x: Number(m[1]), y: Number(m[2]) };
    if ((m = s.match(/^r(\d+)\s*c(\d+)$/i))) return this.grid(Number(m[1]), Number(m[2]));
    if ((m = s.match(/^(?:row\s*)?(\d+)\s*[, ]\s*(?:col\s*)?(\d+)$/i)) && /row|col/i.test(s)) return this.grid(Number(m[1]), Number(m[2]));
    const named = this.lookup(s.replace(/^["']|["']$/g, ""));
    return named ? { x: named.x, y: named.y } : null;
  }
}
