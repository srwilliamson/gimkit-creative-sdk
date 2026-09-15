/**
 * Runner: resolves positions, executes (or dry-runs) actions with retries,
 * tracks named devices, and writes a report to build-output/run-report.json.
 *
 * Safety rails (all on by default):
 *  - validate(actions) runs a whole-script pass BEFORE touching the map:
 *    unknown positions, clicks outside the reachable map area, duplicate names,
 *    block programs that reference properties the script never places.
 *  - a device whose `place` failed marks every later command on the same
 *    position/name as skipped instead of clicking an empty spot.
 *  - stopOnFail aborts the remaining actions after the first failure.
 */
import fs from "fs";
import path from "path";
import { CONFIG, log, getViewport } from "./editor/config.mjs";
import { Layout } from "./layout.mjs";
import { describeAction, labelAction, executeAction, deviceExistsAt, BLOCK_DEVICES, NO_BLOCKS_DEVICES, isKnownDeviceType } from "./actions.mjs";
import { parseScript } from "./commands.mjs";
import { parseProgram, lintProgram, retypeProgram } from "./blocks.mjs";

const POSITIONAL = ["place", "property", "button", "trigger", "text", "blocks", "read", "option"];
const RETRIED = ["property", "button", "trigger", "blocks", "text", "option"];
/** Gimkit's documented ceiling on Property devices per map (approx.). */
export const PROPERTY_LIMIT = 128;

function safeLabel(a) {
  try {
    return labelAction(a);
  } catch {
    return `${a.kind}${a.name ? ` "${a.name}"` : ""}`;
  }
}

export class GkcRunner {
  /**
   * @param {object} opts
   * @param {import('playwright').Page|null} opts.page   live editor page (null for dry-run)
   * @param {boolean} opts.dryRun                         print primitive steps instead of clicking
   * @param {number}  opts.retries                        per-action retries for configure/wire/blocks
   * @param {Layout}  opts.layout
   * @param {boolean} opts.stopOnFail                     abort after the first failed action
   * @param {boolean} opts.strict                         treat validation warnings as errors
   */
  constructor({ page = null, dryRun = false, retries = 2, layout = new Layout(), verbose = true, stopOnFail = false, strict = false } = {}) {
    this.page = page;
    this.dryRun = dryRun || !page;
    this.retries = retries;
    this.layout = layout;
    this.verbose = verbose;
    this.stopOnFail = stopOnFail;
    this.strict = strict;
    this.results = [];
    this.warnings = [];
    this.failedPositions = new Set(); // "x,y" of devices whose placement failed
    this.viewport = null;
    this.aborted = false;
    this.anchor = null; // first device placed in this run — re-checked before configuring
    this.anchorChecked = false;
  }

  posKey(a) {
    return `${a.x},${a.y}`;
  }

  /** Fill in x/y from `at` spec or the action's own name. Returns a copy. */
  resolve(action) {
    const a = { ...action };
    if (a.kind === "layout") return a;
    if (Number.isFinite(a.x) && Number.isFinite(a.y)) return a;
    const pos = this.layout.resolve(a.at) || (a.name ? this.layout.resolve(a.name) : null);
    if (pos) {
      a.x = pos.x;
      a.y = pos.y;
    }
    return a;
  }

  needsPosition(a) {
    return POSITIONAL.includes(a.kind);
  }

  async ensureViewport() {
    if (!this.viewport) this.viewport = this.page ? await getViewport(this.page) : { width: 1500, height: 900 };
    return this.viewport;
  }

  /** Apply a layout action to a Layout instance (used by both run and validate). */
  async applyLayout(L, a, viewport) {
    if (a.originX != null) L.originX = a.originX;
    if (a.originY != null) L.originY = a.originY;
    if (a.gapX != null) L.gapX = a.gapX;
    if (a.gapY != null) L.gapY = a.gapY;
    if (a.fitRows && a.fitCols) L.fitToViewport(viewport, a.fitRows, a.fitCols);
  }

  /**
   * Whole-script static check. Simulates position resolution with a scratch
   * Layout so nothing is clicked. Returns { errors, warnings }; each entry is
   * "[line N] message" when the action came from a script.
   */
  async validate(actions) {
    const errors = [];
    const warnings = [];
    const vp = await this.ensureViewport();
    const L = new Layout({ originX: this.layout.originX, originY: this.layout.originY, gapX: this.layout.gapX, gapY: this.layout.gapY });
    for (const [k, v] of this.layout.named) L.named.set(k, v);
    const placed = new Map(); // name(lower) → { type, name, line }
    const placedAt = new Map(); // "x,y" → name
    const propsPlaced = new Set();
    const propsUsedInBlocks = new Map(); // prop → where
    const configured = new Set(); // name(lower) of devices that got a property/button/trigger/text/blocks/option command
    const tag = (a) => (a.line ? `[line ${a.line}] ` : "");

    // Pass 0: property declarations (types) and channel graph, so later checks see the whole script.
    const propTypes = new Map(); // exact name → "Number" | "Text" | "True/False"
    const propNamesLower = new Map(); // lower → exact
    const transmitted = new Map(); // channel → [where]
    const received = new Map(); // channel → [where]
    const add = (map, ch, where) => {
      if (!map.has(ch)) map.set(ch, []);
      map.get(ch).push(where);
    };
    for (const a of actions) {
      if (a.kind === "property" && a.name) {
        propTypes.set(a.name, a.propertyType || "Number");
        propNamesLower.set(a.name.toLowerCase(), a.name);
      }
      if (a.kind === "place" && a.deviceType === "Property" && a.name && !propNamesLower.has(a.name.toLowerCase())) propNamesLower.set(a.name.toLowerCase(), a.name);
      if (a.kind === "button" && a.channel) add(transmitted, a.channel, `${tag(a)}button "${a.name}"`);
      if (a.kind === "trigger" && a.channel) add(received, a.channel, `${tag(a)}trigger "${a.name}"`);
      if (a.kind === "blocks") {
        if (a.event && a.event.kind === "channel") add(received, a.event.channel, `${tag(a)}blocks "${a.name}"`);
        try {
          const lint = lintProgram(parseProgram(a.ast || a.program));
          for (const ch of lint.channelsBroadcast) add(transmitted, ch, `${tag(a)}blocks "${a.name}"`);
        } catch {
          /* reported below */
        }
      }
    }

    for (const raw of actions) {
      if (raw.kind === "layout") {
        await this.applyLayout(L, raw, vp);
        continue;
      }
      const a = { ...raw };
      if (!(Number.isFinite(a.x) && Number.isFinite(a.y))) {
        const pos = L.resolve(a.at) || (a.name ? L.resolve(a.name) : null);
        if (pos) Object.assign(a, pos);
      }
      const label = safeLabel(a);
      if (a.warning) warnings.push(`${tag(a)}${label}: ${a.warning}`);
      if (this.needsPosition(a)) {
        if (!(Number.isFinite(a.x) && Number.isFinite(a.y))) {
          errors.push(`${tag(a)}${a.kind}${a.name ? ` "${a.name}"` : ""}: no position — add "at r#c#" / "at x,y", or place a device with that name first`);
          continue;
        }
        if (!Layout.inSafeZone(a, vp)) {
          const z = Layout.safeZone(vp);
          errors.push(`${tag(a)}${label}: (${a.x},${a.y}) is outside the clickable map area x ${z.left}-${z.right}, y ${z.top}-${z.bottom} for a ${vp.width}x${vp.height} viewport — use "layout fit ROWSxCOLS" or smaller gaps`);
        }
      }
      if (a.kind === "place") {
        const key = this.posKey(a);
        if (placedAt.has(key)) errors.push(`${tag(a)}${label}: another device ("${placedAt.get(key)}") is already placed at (${a.x},${a.y})`);
        placedAt.set(key, a.name || a.deviceType);
        if (!isKnownDeviceType(a.deviceType)) {
          warnings.push(`${tag(a)}${label}: "${a.deviceType}" is not a known Gimkit Creative device${a.unknownType ? ' — if the last word is the device name, quote it: place damage boost "DB"' : ""}; the Devices search box will be tried as-is`);
        }
        if (a.name) {
          const lower = a.name.toLowerCase();
          if (placed.has(lower)) errors.push(`${tag(a)}duplicate device name "${a.name}" — later commands by name would hit the wrong device`);
          placed.set(lower, { type: a.deviceType, name: a.name, line: a.line });
          L.remember(a.name, { x: a.x, y: a.y }, a.deviceType);
          if (a.deviceType === "Property") propsPlaced.add(lower);
        }
      }
      if (a.kind === "text" && a.text) {
        L.remember(a.text, { x: a.x, y: a.y }, "Text");
        configured.add(a.text.toLowerCase());
      }
      if (["property", "button", "trigger", "blocks", "option"].includes(a.kind) && a.name) {
        const want = { property: "Property", button: "Button", trigger: "Trigger", blocks: null, option: null }[a.kind];
        const got = placed.get(a.name.toLowerCase())?.type;
        if (got && want && got !== want) errors.push(`${tag(a)}${label}: "${a.name}" was placed as a ${got}, not a ${want}`);
        if (a.kind === "property" && !got && !propsPlaced.has(a.name.toLowerCase()) && a.at == null) {
          warnings.push(`${tag(a)}${label}: "${a.name}" was not placed by this script — assuming it already exists at that spot`);
        }
        if (a.kind === "property") propsPlaced.add(a.name.toLowerCase());
        configured.add(a.name.toLowerCase());
      }
      if (a.kind === "property" && a.name) {
        const clash = [...propTypes.keys()].find((n) => n !== a.name && n.toLowerCase() === a.name.toLowerCase());
        if (clash) errors.push(`${tag(a)}${label}: property "${a.name}" and "${clash}" differ only by case — Gimkit names are case-sensitive, pick one spelling`);
      }
      if (a.kind === "blocks") {
        let prog;
        try {
          prog = retypeProgram(parseProgram(a.ast || a.program), propTypes);
        } catch (err) {
          errors.push(`${tag(a)}blocks "${a.name}": ${err.message}`);
          continue;
        }
        raw.ast = prog; // typed AST (text-property `+` → join) is what the executor builds
        const lint = lintProgram(prog, { propTypes });
        for (const e of lint.errors) errors.push(`${tag(a)}blocks "${a.name}": ${e}`);
        for (const w of lint.warnings) warnings.push(`${tag(a)}blocks "${a.name}": ${w}`);
        for (const p of [...lint.propsRead, ...lint.propsWritten]) {
          if (!propsUsedInBlocks.has(p)) propsUsedInBlocks.set(p, `${tag(a)}blocks "${a.name}"`);
          const exact = propNamesLower.get(p.toLowerCase());
          if (exact && exact !== p) errors.push(`${tag(a)}blocks "${a.name}": property {${p}} does not match "${exact}" — Gimkit property names are case-sensitive`);
        }
        if (a.clear === false) warnings.push(`${tag(a)}blocks "${a.name}" uses append — re-running the script will duplicate these blocks`);

        const devType = placed.get((a.name || "").toLowerCase())?.type;
        if (devType && NO_BLOCKS_DEVICES.has(devType)) errors.push(`${tag(a)}blocks "${a.name}": a ${devType} has no Blocks tab in Gimkit Creative — put the code on a Trigger that receives the channel instead`);
        else if (devType && !BLOCK_DEVICES.has(devType)) warnings.push(`${tag(a)}blocks "${a.name}": ${devType} is not known to have a Blocks tab; the live run fails with no-blocks-tab if it does not`);
        if (lint.setsText) {
          if (devType && devType !== "Text") warnings.push(`${tag(a)}blocks "${a.name}": "text = ..." (Set Text) only exists on Text devices, but "${a.name}" is a ${devType}`);
          if (!a.event) warnings.push(`${tag(a)}blocks "${a.name}" sets text but has no event — add "on <channel>" so the Text device runs it when the channel fires`);
        }
        if (a.event && a.event.kind === "channel" && devType === "Trigger") {
          const trig = actions.find((x) => x.kind === "trigger" && x.name === a.name);
          if (trig && trig.channel !== a.event.channel) warnings.push(`${tag(a)}blocks "${a.name}" runs on channel "${a.event.channel}" but the trigger receives "${trig.channel}" — fine if intended (two block codes), otherwise use the same channel`);
        }
      }
    }
    for (const [p, where] of propsUsedInBlocks) {
      if (!propsPlaced.has(p.toLowerCase())) warnings.push(`${where} uses property {${p}} but no "property ${p} = ..." exists in this script — Gimkit needs a Property device with exactly that name`);
    }

    // Channel graph: every transmitted channel should be received, and vice versa; catch case-only typos.
    const lowerKeys = (map) => new Map([...map.keys()].map((k) => [k.toLowerCase(), k]));
    const recvLower = lowerKeys(received);
    const sendLower = lowerKeys(transmitted);
    for (const [ch, wheres] of transmitted) {
      if (received.has(ch)) continue;
      const other = recvLower.get(ch.toLowerCase());
      if (other) warnings.push(`${wheres[0]} transmits "${ch}" but the receiver spells it "${other}" — Gimkit channels are case-sensitive`);
      else warnings.push(`${wheres[0]} transmits "${ch}" but nothing in this script receives it`);
    }
    for (const [ch, wheres] of received) {
      if (transmitted.has(ch)) continue;
      const other = sendLower.get(ch.toLowerCase());
      if (other) warnings.push(`${wheres[0]} receives "${ch}" but the transmitter spells it "${other}" — Gimkit channels are case-sensitive`);
      else warnings.push(`${wheres[0]} receives "${ch}" but nothing in this script transmits it (ok if a Lifecycle/other device fires it)`);
    }

    // Property count and never-configured devices.
    const propertyCount = new Set([...propsPlaced, ...[...propTypes.keys()].map((n) => n.toLowerCase())]).size;
    if (propertyCount > PROPERTY_LIMIT * 0.8) warnings.push(`${propertyCount} Property devices — Gimkit maps cap out around ${PROPERTY_LIMIT}; pack several values into one property or reuse variables`);
    for (const [lower, info] of placed) {
      if (configured.has(lower)) continue;
      if (["Property", "Button", "Trigger", "Text"].includes(info.type)) {
        const how = { Property: `property ${info.name} = 0`, Button: `button "${info.name}" transmits <channel>`, Trigger: `trigger "${info.name}" receives <channel>`, Text: `text "${info.name}"` }[info.type];
        warnings.push(`${info.line ? `[line ${info.line}] ` : ""}${info.type} "${info.name}" is placed but never configured — add: ${how}`);
      }
    }
    return { errors, warnings };
  }

  async runOne(rawAction) {
    if (this.aborted) {
      const r = { ok: false, skipped: true, action: rawAction, detail: "skipped: run aborted after earlier failure" };
      this.results.push(r);
      return r;
    }
    if (rawAction.kind === "layout") {
      const L = this.layout;
      await this.applyLayout(L, rawAction, await this.ensureViewport());
      const r = { ok: true, action: rawAction, detail: `origin (${L.originX},${L.originY}) gap ${L.gapX}x${L.gapY}` };
      this.results.push(r);
      if (this.verbose) log(`layout → ${r.detail}`);
      return r;
    }

    const a = this.resolve(rawAction);
    if (this.needsPosition(a) && !(Number.isFinite(a.x) && Number.isFinite(a.y))) {
      return this.fail(a, `no position for ${labelAction(a)} — add "at r#c#", "at x,y", or place it first`);
    }
    if (this.needsPosition(a) && a.kind !== "place" && this.failedPositions.has(this.posKey(a))) {
      const r = { ok: false, skipped: true, action: a, detail: `skipped ${labelAction(a)} — the device at (${a.x},${a.y}) was never placed` };
      this.results.push(r);
      if (this.verbose) log(`- ${r.detail}`);
      return r;
    }
    if (this.needsPosition(a) && !this.dryRun && !Layout.inSafeZone(a, await this.ensureViewport())) {
      return this.fail(a, `${labelAction(a)} is outside the clickable map area — see validate()`);
    }
    // Re-anchor check: before the first configure-phase action, confirm the first device
    // we placed is still where we placed it. If the map was panned/zoomed in between,
    // every later click would land on the wrong device.
    if (!this.dryRun && this.needsPosition(a) && a.kind !== "place" && this.anchor && !this.anchorChecked) {
      this.anchorChecked = true;
      const there = await deviceExistsAt(this.page, this.anchor.x, this.anchor.y).catch(() => false);
      if (!there) {
        this.aborted = true;
        return this.fail(a, `anchor check failed: no device at (${this.anchor.x},${this.anchor.y}) where "${this.anchor.name}" was placed — the map was panned or zoomed; reset the view and re-run (remaining actions skipped)`);
      }
      if (this.verbose) log(`  anchor ok: "${this.anchor.name}" still at (${this.anchor.x},${this.anchor.y})`);
    }
    for (const w of [...(a.warnings || []), ...(a.warning ? [a.warning] : [])]) {
      this.warnings.push(`${a.line ? `[line ${a.line}] ` : ""}${w}`);
      if (this.verbose) log(`  ! ${w}`);
    }

    // Remember named devices so later commands can reference them by name.
    if (a.name && this.needsPosition(a)) this.layout.remember(a.name, { x: a.x, y: a.y }, a.deviceType || a.kind);
    if (a.kind === "text" && a.text) this.layout.remember(a.text, { x: a.x, y: a.y }, "Text");

    if (this.dryRun) {
      const steps = describeAction(a);
      if (this.verbose) {
        log(`[dry-run] ${labelAction(a)}`);
        for (const s of steps) log(`    → ${s}`);
      }
      const r = { ok: true, dryRun: true, action: a, steps };
      this.results.push(r);
      return r;
    }

    const attempts = RETRIED.includes(a.kind) ? 1 + this.retries : a.kind === "place" ? 2 : 1;
    let last = null;
    for (let i = 1; i <= attempts; i += 1) {
      if (this.verbose) log(`${i > 1 ? `(retry ${i - 1}) ` : ""}${labelAction(a)}`);
      last = await executeAction(this.page, a);
      if (last.ok) break;
      if (this.verbose) log(`  ✗ ${last.detail || "failed"}`);
      if (i < attempts) await this.page.waitForTimeout(600);
    }
    const r = { ok: !!last?.ok, action: a, ...last };
    this.results.push(r);
    if (r.ok && this.verbose) log(`  ✓ ${a.kind} ok${r.detail ? ` (${r.detail})` : ""}`);
    if (r.ok && a.kind === "place" && !this.anchor) this.anchor = { x: a.x, y: a.y, name: a.name || a.deviceType };
    if (!r.ok) {
      if (a.kind === "place") this.failedPositions.add(this.posKey(a));
      if (this.stopOnFail) this.aborted = true;
    }
    return r;
  }

  fail(a, detail) {
    const r = { ok: false, action: a, detail };
    this.results.push(r);
    log(`✗ ${detail}`);
    if (this.stopOnFail) this.aborted = true;
    return r;
  }

  /**
   * Validate, then run. Validation errors abort before the first click unless
   * `force` is set; warnings are recorded in the report (errors when strict).
   */
  async run(actions, { validate = true, force = false } = {}) {
    if (validate) {
      const v = await this.validate(actions);
      const blocking = this.strict ? [...v.errors, ...v.warnings] : v.errors;
      for (const w of v.warnings) this.warnings.push(w);
      if (this.verbose) {
        for (const e of v.errors) log(`✗ validate: ${e}`);
        for (const w of v.warnings) log(`! validate: ${w}`);
      }
      if (blocking.length && !force) {
        for (const e of blocking) this.results.push({ ok: false, action: { kind: "validate" }, detail: e });
        log(`Validation failed with ${blocking.length} problem(s) — nothing was executed. Fix them or run with force.`);
        return this.report();
      }
    }
    for (const a of actions) {
      await this.runOne(a);
      if (this.page && !this.dryRun && !this.aborted) await this.page.waitForTimeout(350);
    }
    return this.report();
  }

  /** Run a `.gkc` script string. */
  async runScript(src, opts) {
    return this.run(parseScript(src), opts);
  }

  report() {
    const okCount = this.results.filter((r) => r.ok).length;
    const failed = this.results.filter((r) => !r.ok && !r.skipped);
    const skipped = this.results.filter((r) => r.skipped);
    const report = {
      at: new Date().toISOString(),
      dryRun: this.dryRun,
      total: this.results.length,
      ok: okCount,
      skipped: skipped.length,
      failed: failed.map((r) => ({ action: safeLabel(r.action), detail: r.detail || null })),
      warnings: [...new Set(this.warnings)],
      devices: [...this.layout.named.entries()].map(([name, p]) => ({ name, ...p })),
      results: this.results.map((r) => ({ ok: r.ok, skipped: !!r.skipped, action: safeLabel(r.action), detail: r.detail ?? null })),
    };
    try {
      fs.mkdirSync(CONFIG.outputDir, { recursive: true });
      fs.writeFileSync(path.join(CONFIG.outputDir, "run-report.json"), JSON.stringify(report, null, 2));
    } catch {
      /* best effort */
    }
    log(
      `=== ${this.dryRun ? "Dry-run" : "Run"} summary: ${okCount}/${this.results.length} ok${failed.length ? `, ${failed.length} failed` : ""}${skipped.length ? `, ${skipped.length} skipped` : ""}${report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""} ===`,
    );
    for (const f of failed) log(`  ✗ ${f.detail || labelAction(f.action)}`);
    return report;
  }
}
