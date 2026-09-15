/**
 * High-level Gimkit Creative actions ("verbs").
 *
 * Every verb has two halves:
 *   steps(action)         → the primitive click recipe (for dry-run / docs)
 *   execute(page, action) → performs it with the battle-tested editor primitives
 *
 * Positions are screen coordinates in the editor viewport. Use the Layout
 * helper (layout.mjs) to convert grid rows/cols into coordinates.
 */
import { CONFIG, log, getViewport } from "./editor/config.mjs";
import {
  placeOneDevice,
  dismissDevicePanel,
  clickAt,
  prepareEditor,
} from "./editor/editor-actions.mjs";
import {
  configurePropertyDevice,
  configureButtonChannel,
  configureTriggerChannel,
  configureTextLabel,
  openDeviceForItem,
  openDeviceAt,
  readPropertyPanel,
} from "./editor/device-editor.mjs";
import { openBlocksTab } from "./editor/block-builder-tabs.mjs";
import { countWorkspaceBlocks } from "./editor/blockly-automation.mjs";
import { ensureBlockWorkspace } from "./editor/block-code.mjs";
import { setDeviceOption } from "./editor/device-options.mjs";
import { GKC } from "./editor/gkc-knowledge.mjs";
import { buildProgramInWorkspace, parseProgram, formatProgram, estimateBlockCount } from "./blocks.mjs";

/** Gimkit Creative device palette (search-box names). Keys are lower-case aliases. */
const CANONICAL_DEVICES = [
  "Ball",
  "Ball Capture Zone",
  "Barrier",
  "Button",
  "Camera Point",
  "Camera View",
  "Checker",
  "Checkpoint",
  "Cosmetic Modifier",
  "Counter",
  "Crafting Recipe",
  "Crafting Table",
  "Damage Boost",
  "Damager",
  "Dialogue",
  "Dropped Item",
  "End Game",
  "End of Game Widget",
  "Flag",
  "Flag Capture Zone",
  "Game Overlay",
  "Health Granter",
  "Image",
  "Inventory Item Manager",
  "Item Granter",
  "Item Image",
  "Item Spawner",
  "Knockout Manager",
  "Laser Beam",
  "Laser Beam Manager",
  "Lifecycle",
  "Movement Meter",
  "Notification",
  "Player Appearance Modifier",
  "Player Coordinates",
  "Popup",
  "Property",
  "Questioner",
  "Queue",
  "Relay",
  "Repeater",
  "Respawn",
  "Score",
  "Sentry",
  "Shadow",
  "Speed Modifier",
  "Spawn Pad",
  "Starting Inventory",
  "Tag Zone",
  "Team Settings",
  "Team Switcher",
  "Teleporter",
  "Text",
  "Timer",
  "Trigger",
  "Vending Machine",
  "Voting",
  "Waypoint",
  "Wire Repeater",
  "XP Granter",
  "Zone",
];

const DEVICE_ALIASES = {
  prop: "Property",
  itemgranter: "Item Granter",
  granter: "Item Granter",
  overlay: "Game Overlay",
  wire: "Wire Repeater",
  vending: "Vending Machine",
  laser: "Laser Beam",
  spawn: "Spawn Pad",
  lifecyle: "Lifecycle",
  endgame: "End Game",
  "end of game": "End of Game Widget",
  "end game widget": "End of Game Widget",
  ko: "Knockout Manager",
  "ko manager": "Knockout Manager",
  "knockout": "Knockout Manager",
  "inventory manager": "Inventory Item Manager",
  "item manager": "Inventory Item Manager",
  "speed": "Speed Modifier",
  "health": "Health Granter",
  "xp": "XP Granter",
  "appearance": "Player Appearance Modifier",
  "appearance modifier": "Player Appearance Modifier",
  "camera": "Camera Point",
  "capture zone": "Flag Capture Zone",
  "coordinates": "Player Coordinates",
  "recipe": "Crafting Recipe",
  "widget": "End of Game Widget",
};

/** Device palette names as they appear in the GKC Devices search box. */
export const DEVICE_TYPES = Object.fromEntries([
  ...CANONICAL_DEVICES.map((n) => [n.toLowerCase(), n]),
  ...Object.entries(DEVICE_ALIASES),
]);

/**
 * Device types known to have a Blocks tab (Gimkit docs / community wiki). Types in
 * neither set get a validation *warning*; types in NO_BLOCKS_DEVICES get an error.
 */
export const BLOCK_DEVICES = new Set(GKC.blockDevices);

/** Device types that definitely have NO Blocks tab — `blocks` on them is an error. */
export const NO_BLOCKS_DEVICES = new Set([
  "Property",
  "Button",
  "Counter",
  "Lifecycle",
  "Relay",
  "Repeater",
  "Wire Repeater",
  "Barrier",
  "Spawn Pad",
  "Teleporter",
  "Score",
  "Timer",
  "End Game",
  "Checker",
  "Sentry",
  "Shadow",
  "Image",
  "Item Image",
  "Camera Point",
  "Camera View",
  "Flag",
  "Ball",
  "Starting Inventory",
  "Team Settings",
  "Team Switcher",
  "Waypoint",
  "Speed Modifier",
  "Damage Boost",
  "Health Granter",
  "XP Granter",
  "Respawn",
  "Player Appearance Modifier",
  "Cosmetic Modifier",
  "Item Spawner",
  "Crafting Recipe",
  "Dropped Item",
  "Movement Meter",
  "Flag Capture Zone",
  "Ball Capture Zone",
  "Player Coordinates",
]);

export function normalizeDeviceType(type) {
  if (!type) return null;
  const key = String(type).trim().toLowerCase().replace(/\s+/g, " ");
  if (DEVICE_TYPES[key]) return DEVICE_TYPES[key];
  // Unknown type: Title Case it and trust the search box.
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isKnownDeviceType(type) {
  return CANONICAL_DEVICES.includes(String(type));
}

function optionSteps(a) {
  return (a.options || []).map((o) => `Option "${o.display || o.label}" → ${JSON.stringify(o.value)} (find label, drive the control below it, reopen and read back)`);
}

export function describeEvent(event) {
  if (!event) return `Open the device's existing block code (or create one with its default event)`;
  if (event.kind === "channel") return `Block code for event "When receiving on channel" → channel "${event.channel}" (select existing entry or create it)`;
  if (event.kind === "triggered") return `Block code for event "When triggered" (select existing entry or create it)`;
  return `Block code for event "${event.label}" (select existing entry or create it)`;
}

const stepsFor = {
  property: (a) => [
    `Click the Property device at (${a.x}, ${a.y}) → settings sidebar opens`,
    `Click "All Options" tab`,
    `Property Type dropdown → "${a.propertyType || "Number"}"`,
    `Property Scope dropdown → "${a.scope || "global"}"`,
    `Property Name combobox → type "${a.name}" → Tab`,
    a.default != null ? `Default Value box → type "${a.default}" → Tab (real blur = Gimkit saves)` : null,
    `Escape, then re-open the device and read the sidebar back to verify it persisted`,
  ].filter(Boolean),
  button: (a) => [
    `Click the Button device at (${a.x}, ${a.y}) → sidebar`,
    `Click "All Options"`,
    `Under "When button pressed, transmit on" → open channel combobox`,
    `Type "${a.channel}" → pick/create the option → Tab`,
    `Escape, re-open, verify the channel chip reads "${a.channel}"`,
    ...optionSteps(a),
  ],
  trigger: (a) => [
    `Click the Trigger device at (${a.x}, ${a.y}) → sidebar`,
    `Click "All Options"`,
    `Under "When receiving on channel" → open channel combobox`,
    `Type "${a.channel}" → pick/create the option → Tab`,
    `Escape, re-open, verify the channel chip reads "${a.channel}"`,
    ...optionSteps(a),
  ],
  option: (a) => [
    `Click the device at (${a.x}, ${a.y}) → sidebar → "All Options"`,
    `Find the label matching "${a.display || a.label}" → nearest control below it (select / switch / input)`,
    `Set it to ${JSON.stringify(a.value)} with real clicks/typing → Tab`,
    `Escape, re-open, read the control back and compare`,
  ],
  place: (a) => [
    `Click (${a.x}, ${a.y}) once — if a device sidebar opens, something is already there (skip placement)`,
    `Escape any open device panel`,
    `Press E (or click + top-right) → Add menu`,
    `Click "Devices" category`,
    `Type "${a.deviceType}" in the Devices search box`,
    `Click the "${a.deviceType}" tile`,
    `Click the map at (${a.x}, ${a.y}) → device placed`,
    `Escape, then click (${a.x}, ${a.y}) again to verify a device sidebar opens`,
  ],
  text: (a) => [
    `Click the Text device at (${a.x}, ${a.y}) → sidebar`,
    `Click "All Options"`,
    `Click the text content box → Ctrl+A, Delete → type "${a.text}" → Tab (real blur = Gimkit saves)`,
    `Escape, re-open, verify the content reads "${a.text}"`,
    ...optionSteps(a),
  ],
  blocks: (a) => {
    const prog = parseProgram(a.ast || a.program);
    return [
      `Click the device at (${a.x}, ${a.y}) → sidebar`,
      `Click "Blocks" tab → list of block codes`,
      describeEvent(a.event),
      a.clear !== false ? `Remove existing statement blocks incl. the chain under the event hat (keep the hat)` : `Keep existing blocks; new chain goes after them`,
      `Blockly API: discover block types (set/get property, variables, math, logic, text, if)`,
      `Blockly API: build ${prog.statements.length} statements (~${estimateBlockCount(prog)} blocks) and chain them`,
      `Blockly API: attach the chain under the event hat block`,
      `Escape to close (Gimkit autosaves the workspace)`,
      ...formatProgram(prog).split("\n").map((l) => `    | ${l}`),
    ].filter(Boolean);
  },
  read: (a) => [`Click device at (${a.x}, ${a.y})`, `Read Property sidebar fields`, `Escape`],
  click: (a) => [`Mouse click at (${a.x}, ${a.y})`],
  press: (a) => [`Keyboard press "${a.key}"`],
  wait: (a) => [`Wait ${a.ms} ms`],
  screenshot: (a) => [`Save screenshot → build-output/${a.name || "screenshot"}.png`],
  prepare: () => [`Verify editor is in build mode (not playtest)`, `Click empty map area to focus the canvas`],
  note: (a) => [`# ${a.text}`],
};

/** Human-readable primitive plan for one action. */
export function describeAction(action) {
  const f = stepsFor[action.kind];
  return f ? f(action) : [`(unknown action kind ${action.kind})`];
}

function optionLabel(a) {
  if (!a.options || !a.options.length) return "";
  return ` [${a.options.map((o) => `${o.key}${o.value === true || o.value === false ? "" : `=${JSON.stringify(o.value)}`}`).join(", ")}]`;
}

/** Short one-line label for logs. */
export function labelAction(a) {
  switch (a.kind) {
    case "place":
      return `place ${a.deviceType}${a.name ? ` "${a.name}"` : ""} at (${a.x},${a.y})`;
    case "property":
      return `property "${a.name}" = ${a.default ?? 0} (${a.propertyType || "Number"}, ${a.scope || "global"}) at (${a.x},${a.y})`;
    case "button":
      return `button${a.name ? ` "${a.name}"` : ""} transmits "${a.channel}"${optionLabel(a)} at (${a.x},${a.y})`;
    case "trigger":
      return `trigger${a.name ? ` "${a.name}"` : ""} receives "${a.channel}"${optionLabel(a)} at (${a.x},${a.y})`;
    case "text":
      return `text "${a.text}"${optionLabel(a)} at (${a.x},${a.y})`;
    case "option":
      return `option "${a.name}" [${a.label}] = ${JSON.stringify(a.value)} at (${a.x},${a.y})`;
    case "blocks":
      return `blocks on${a.name ? ` "${a.name}"` : ""}${a.event ? ` ${a.event.kind === "channel" ? `on "${a.event.channel}"` : a.event.kind === "triggered" ? "when triggered" : `when "${a.event.label}"`}` : ""} at (${a.x},${a.y}) — ${parseProgram(a.ast || a.program).statements.length} statements${a.clear === false ? " (append)" : ""}`;
    case "read":
      return `read property at (${a.x},${a.y})`;
    case "click":
      return `click (${a.x},${a.y})`;
    case "press":
      return `press ${a.key}`;
    case "wait":
      return `wait ${a.ms}ms`;
    case "screenshot":
      return `screenshot ${a.name || "screenshot"}`;
    case "prepare":
      return `prepare editor`;
    case "note":
      return `# ${a.text}`;
    default:
      return JSON.stringify(a);
  }
}

// ---------------------------------------------------------------- executors
function itemFor(a) {
  // Shape expected by the device-editor primitives.
  const typeMap = { property: "property", button: "button", trigger: "trigger", text: "text", blocks: "trigger", read: "property", option: "trigger" };
  return {
    type: typeMap[a.kind] || "property",
    name: a.name || a.text || undefined,
    label: a.text,
    configureAt: { x: a.x, y: a.y },
    placeAt: { x: a.x, y: a.y },
  };
}

/** True when clicking (x,y) opens any device sidebar. Always leaves the panel closed. */
export async function deviceExistsAt(page, x, y) {
  await dismissDevicePanel(page);
  const opened = await openDeviceAt(page, x, y, { anyDevice: true });
  await dismissDevicePanel(page);
  return opened;
}

/** Apply `a.options` (from `hidden`, `delay N`, `message "..."`, ...) one by one; stop at the first failure. */
async function applyOptions(page, a) {
  const applied = [];
  for (const o of a.options || []) {
    const r = await setDeviceOption(page, itemFor(a), { label: o.display || o.key, labelPattern: o.label, value: o.value });
    applied.push({ key: o.key, ok: r.ok, read: r.read, label: r.label });
    if (!r.ok) return { ok: false, detail: `option-${o.key}:${r.reason}${r.labels ? ` (labels seen: ${r.labels.slice(0, 12).join(" | ")})` : ""}`, options: applied };
  }
  return { ok: true, options: applied };
}

const executors = {
  async prepare(page) {
    const r = await prepareEditor(page);
    await dismissDevicePanel(page);
    return { ok: !!(r?.ok || r?.state?.canPlace), state: r?.state };
  },

  async place(page, a) {
    // Placing on top of an existing device is a common re-run mistake: detect it first.
    const already = await deviceExistsAt(page, a.x, a.y);
    if (already) return { ok: true, x: a.x, y: a.y, detail: "already-present" };
    const picked = await placeOneDevice(page, a.deviceType, a.x, a.y);
    if (!picked) return { ok: false, detail: `device-type-not-found:${a.deviceType}` };
    await page.waitForTimeout(300);
    const present = await deviceExistsAt(page, a.x, a.y);
    return { ok: present, x: a.x, y: a.y, detail: present ? null : "placed-but-not-found-at-position" };
  },

  async property(page, a) {
    const r = await configurePropertyDevice(page, itemFor(a), a.default ?? 0, {
      propertyType: a.propertyType || "Number",
      scope: a.scope || "global",
    });
    return { ok: !!r.ok, detail: r.reason || null, panel: r.panel };
  },

  async button(page, a) {
    const r = await configureButtonChannel(page, itemFor(a), a.channel);
    if (!r.ok) return { ok: false, detail: r.reason || null, read: r.read };
    const o = await applyOptions(page, a);
    return { ok: o.ok, detail: o.detail || null, read: r.read, options: o.options };
  },

  async trigger(page, a) {
    const r = await configureTriggerChannel(page, itemFor(a), a.channel);
    if (!r.ok) return { ok: false, detail: r.reason || null, read: r.read };
    const o = await applyOptions(page, a);
    return { ok: o.ok, detail: o.detail || null, read: r.read, options: o.options };
  },

  async text(page, a) {
    const r = await configureTextLabel(page, itemFor(a), a.text);
    if (typeof r === "boolean") return { ok: r, detail: r ? null : "text-not-set" };
    if (!r.ok) return { ok: false, detail: r.reason || null, read: r.read };
    const o = await applyOptions(page, a);
    return { ok: o.ok, detail: o.detail || null, read: r.read, options: o.options };
  },

  async option(page, a) {
    const r = await setDeviceOption(page, itemFor(a), { label: a.label, value: a.value });
    return { ok: !!r.ok, detail: r.ok ? null : `${r.reason}${r.labels ? ` (labels seen: ${r.labels.slice(0, 12).join(" | ")})` : ""}`, read: r.read, label: r.label };
  },

  async blocks(page, a) {
    const opened = await openDeviceForItem(page, itemFor(a), { preferCoords: true });
    if (!opened.ok) return { ok: false, detail: `open-failed:${opened.method}` };
    if (!(await openBlocksTab(page))) {
      await dismissDevicePanel(page);
      return { ok: false, detail: "no-blocks-tab" };
    }
    await page.waitForTimeout(500);
    const ws = await ensureBlockWorkspace(page, { event: a.event || null, deviceName: a.name });
    if (!ws.ok) {
      await dismissDevicePanel(page);
      return { ok: false, detail: `${ws.reason || "no-block-workspace"}:${ws.method}`, seen: ws.seen };
    }
    const before = await countWorkspaceBlocks(page);
    const res = await buildProgramInWorkspace(page, a.ast || a.program, { clear: a.clear !== false });
    await page.waitForTimeout(400);
    const after = await countWorkspaceBlocks(page);
    await dismissDevicePanel(page);
    const base = { built: res.built, expected: res.expected, blocksBefore: before, blocksAfter: after, attachedHat: res.attachedHat, hatType: res.hatType, workspace: ws.method };
    if (!res.ok) return { ok: false, detail: res.reason, registrySample: res.registrySample, unsupported: res.unsupported, ...base };
    // Floating blocks are dead code in Gimkit — treat "built but not under the hat" as failure so the runner retries.
    if (!res.attachedHat) return { ok: false, detail: "not-attached-to-event-hat", ...base };
    if (res.overCap) return { ok: false, detail: `over-block-cap:${res.blockCount}`, ...base };
    return { ok: true, ...base };
  },

  async read(page, a) {
    await dismissDevicePanel(page);
    if (!(await openDeviceAt(page, a.x, a.y))) return { ok: false, detail: "no-panel" };
    const panel = await readPropertyPanel(page);
    await dismissDevicePanel(page);
    return { ok: !!panel.ok, panel };
  },

  async click(page, a) {
    await clickAt(page, a.x, a.y);
    return { ok: true };
  },

  async press(page, a) {
    await page.keyboard.press(a.key);
    await page.waitForTimeout(200);
    return { ok: true };
  },

  async wait(page, a) {
    await page.waitForTimeout(a.ms);
    return { ok: true };
  },

  async screenshot(page, a) {
    const fs = await import("fs");
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    const file = `${CONFIG.outputDir}/${a.name || "screenshot"}.png`;
    await page.screenshot({ path: file });
    return { ok: true, file };
  },

  async note() {
    return { ok: true };
  },
};

/** Execute one action against a live page. Never throws; returns { ok, ... }. */
export async function executeAction(page, action) {
  const fn = executors[action.kind];
  if (!fn) return { ok: false, detail: `unknown-kind:${action.kind}` };
  try {
    return await fn(page, action);
  } catch (err) {
    log(`  action error (${action.kind}): ${err.message}`);
    return { ok: false, detail: err.message };
  }
}

export { getViewport };
