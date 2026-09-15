/**
 * JSON map spec → actions. A declarative alternative to `.gkc` scripts.
 *
 * {
 *   "name": "XOR NN",
 *   "layout": { "origin": [72, 72], "gap": [95, 68] } | { "fit": [10, 3] },
 *   "place": true,                       // place devices before configuring (default true)
 *   "devices": [
 *     { "type": "property", "name": "input1", "at": "r1c0", "value": 0 },
 *     { "type": "property", "name": "weight1-1", "grid": [2, 0], "value": -80 },
 *     { "type": "button",   "name": "Run NN", "at": "r7c2", "transmits": "nn-forward" },
 *     { "type": "trigger",  "name": "Forward Pass", "at": "r6c0", "receives": "nn-forward",
 *       "blocks": "set A = {input1}\nproperty output1 = A",
 *       "options": { "Visible In-Game": false, "Trigger Delay": 2 } },
 *     { "type": "text", "text": "hello", "at": [400, 300],
 *       "on": "nn-done", "blocks": "text = \"XOR = \" + {net_output}" }
 *   ]
 * }
 *
 * Block-code events: "on": "<channel>" (when receiving on channel) or "when": "triggered".
 * "options": { "<sidebar label>": value } sets any device option (verified by reopening).
 */
import { normalizeDeviceType } from "./actions.mjs";
import { parseProgram, lintProgram } from "./blocks.mjs";

function eventOf(d) {
  if (d.on) return { kind: "channel", channel: String(d.on) };
  if (d.when) return String(d.when).toLowerCase() === "triggered" ? { kind: "triggered" } : { kind: "custom", label: String(d.when) };
  return undefined;
}

function posOf(d) {
  if (d.at != null) return Array.isArray(d.at) ? { x: d.at[0], y: d.at[1] } : d.at;
  if (Array.isArray(d.grid)) return { row: d.grid[0], col: d.grid[1] };
  if (Number.isFinite(d.row) && Number.isFinite(d.col)) return { row: d.row, col: d.col };
  if (Number.isFinite(d.x) && Number.isFinite(d.y)) return { x: d.x, y: d.y };
  return null;
}

export function specToActions(spec) {
  const actions = [];
  const L = spec.layout || {};
  if (L.origin || L.gap || L.fit) {
    actions.push({
      kind: "layout",
      originX: L.origin?.[0],
      originY: L.origin?.[1],
      gapX: L.gap?.[0],
      gapY: L.gap?.[1],
      fitRows: L.fit?.[0],
      fitCols: L.fit?.[1],
    });
  }
  const devices = spec.devices || [];
  const doPlace = spec.place !== false;

  // Phase 1 — placement (all devices first: the Devices panel stays open between placements).
  if (doPlace) {
    for (const d of devices) {
      actions.push({ kind: "place", deviceType: normalizeDeviceType(d.type), name: d.name || d.text, at: posOf(d) });
    }
  }
  // Phase 2 — properties + text.
  for (const d of devices) {
    const t = String(d.type).toLowerCase();
    if (t === "property") {
      const value = d.value ?? d.default ?? 0;
      actions.push({
        kind: "property",
        name: d.name,
        default: value,
        propertyType: d.propertyType || (typeof value === "number" ? "Number" : typeof value === "boolean" ? "True/False" : "Text"),
        scope: d.scope || "global",
        at: posOf(d),
      });
    } else if (t === "text") {
      actions.push({ kind: "text", text: d.text || d.name, name: d.text || d.name, at: posOf(d) });
    }
  }
  // Phase 3 — channels.
  for (const d of devices) {
    const t = String(d.type).toLowerCase();
    if (t === "button" && (d.transmits || d.channel)) {
      actions.push({ kind: "button", name: d.name, channel: d.transmits || d.channel, at: posOf(d) });
    } else if (t === "trigger" && (d.receives || d.channel)) {
      actions.push({ kind: "trigger", name: d.name, channel: d.receives || d.channel, at: posOf(d) });
    }
  }
  // Phase 3b — generic options by sidebar label.
  for (const d of devices) {
    if (d.options && typeof d.options === "object") {
      for (const [label, value] of Object.entries(d.options)) {
        actions.push({ kind: "option", name: d.name || d.text, label, value, at: posOf(d) });
      }
    }
  }
  // Phase 4 — block code. `blocks` may be a string or an array of lines. Replaces existing
  // code unless "appendBlocks": true. "on"/"when" pick the block-code event.
  for (const d of devices) {
    if (d.blocks) {
      const program = Array.isArray(d.blocks) ? d.blocks.join("\n") : String(d.blocks);
      const ast = parseProgram(program);
      const event = eventOf(d);
      actions.push({ kind: "blocks", name: d.name || d.text, program, ast, clear: !d.appendBlocks, at: posOf(d), warnings: lintProgram(ast).warnings, ...(event ? { event } : {}) });
    }
  }
  return actions;
}

const PROP_TYPES = new Set(["Number", "Text", "True/False"]);
const PROP_SCOPES = new Set(["global", "player", "team"]);

export function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") return ["spec must be an object"];
  if (!Array.isArray(spec.devices)) errors.push("spec.devices must be an array");
  const names = new Set();
  const spots = new Map();
  for (const [i, d] of (spec.devices || []).entries()) {
    const who = `devices[${i}] (${d.name || d.text || d.type})`;
    if (!d.type) errors.push(`devices[${i}] missing type`);
    const pos = posOf(d);
    if (!pos) errors.push(`${who} has no position (at / grid / x,y)`);
    else {
      const key = JSON.stringify(pos);
      if (spots.has(key)) errors.push(`${who} shares position ${key} with ${spots.get(key)}`);
      spots.set(key, who);
    }
    const key = (d.name || d.text || "").toLowerCase();
    if (key) {
      if (names.has(key)) errors.push(`duplicate device name "${d.name || d.text}"`);
      names.add(key);
    }
    const t = String(d.type).toLowerCase();
    if (t === "property") {
      if (!d.name) errors.push(`devices[${i}] property needs a name`);
      const value = d.value ?? d.default ?? 0;
      if (typeof value === "number" && !Number.isInteger(value)) errors.push(`${who} default ${value} is not an integer — Gimkit stores whole numbers (scale ×100)`);
      if (d.propertyType && !PROP_TYPES.has(d.propertyType)) errors.push(`${who} propertyType must be Number, Text or True/False`);
      if (d.scope && !PROP_SCOPES.has(String(d.scope).toLowerCase())) errors.push(`${who} scope must be global, player or team`);
    }
    if (t === "text" && !(d.text || d.name)) errors.push(`${who} text device needs "text"`);
    if (d.blocks) {
      try {
        parseProgram(Array.isArray(d.blocks) ? d.blocks.join("\n") : String(d.blocks));
      } catch (err) {
        errors.push(`${who} blocks: ${err.message}`);
      }
    }
    if ((d.transmits || d.receives) && !["button", "trigger"].includes(t)) errors.push(`${who}: transmits/receives is only wired for button/trigger devices`);
    if (d.on != null && typeof d.on !== "string") errors.push(`${who}: "on" must be a channel name string`);
    if (d.when != null && typeof d.when !== "string") errors.push(`${who}: "when" must be an event name string (e.g. "triggered")`);
    if (d.options != null && (typeof d.options !== "object" || Array.isArray(d.options))) errors.push(`${who}: "options" must be an object of { "Sidebar Label": value }`);
    if (d.options && typeof d.options === "object" && !Array.isArray(d.options)) {
      for (const [label, value] of Object.entries(d.options)) {
        if (!["number", "string", "boolean"].includes(typeof value)) errors.push(`${who}: option "${label}" must be a number, string or boolean`);
      }
    }
  }
  return errors;
}
