/**
 * Gimkit Creative (GKC) — URLs, UI modes, hotkeys, device workflow.
 * Sources: GKC docs, beginner handbooks, forum NN builds.
 */

export const GKC = {
  urls: {
    creative: "https://www.gimkit.com/creative",
    edit: (mapId) => `https://www.gimkit.com/edit?id=${mapId}`,
    host: (mapId) => `https://www.gimkit.com/host?id=${mapId}`,
  },

  /** Documented editor hotkeys */
  hotkeys: {
    addMenu: "e",
    wireMenu: "z",
    eraser: "q",
    duplicateDevice: "c",
    dismissMenu: "Escape",
  },

  /** Corner UI (edit/build mode) */
  ui: {
    add: { corner: "top-right", label: "+ / Add", hotkey: "e" },
    erase: { corner: "top-left", label: "Eraser" },
    layers: { corner: "top-left", label: "Layers" },
    options: { corner: "bottom-left", label: "Gear / Options" },
    playtest: { corner: "bottom-right", label: "Start Game" },
    mapCode: { corner: "top-center", label: "Map / join code" },
  },

  /** Add menu categories */
  addCategories: ["Terrain", "Props", "Devices", "Wires"],

  /** Device palette search names (exact UI labels) */
  deviceNames: {
    property: "Property",
    trigger: "Trigger",
    button: "Button",
    counter: "Counter",
    text: "Text",
    lifecycle: "Lifecycle",
  },

  /** Devices that support Blockly (single source of truth — actions.mjs derives BLOCK_DEVICES from it) */
  blockDevices: [
    "Trigger",
    "Item Granter",
    "Text",
    "Knockout Manager",
    "Popup",
    "Notification",
    "Questioner",
    "Game Overlay",
    "Tag Zone",
    "Inventory Item Manager",
    "Zone",
    "Vending Machine",
    "Dialogue",
    "Voting",
    "Queue",
    "Crafting Table",
  ],

  /** Block-code events as they appear in the Blocks tab's "create block code" chooser */
  blockEvents: {
    channel: "When receiving on channel",
    triggered: "When triggered",
    buttonPressed: "When button pressed",
  },

  /** Block limits */
  limits: {
    blockPiecesPerWorkspace: 75,
    memoryPerBlockWorkspace: 500,
    mapMemoryCap: 100_000,
    propertyDevicesApprox: 128,
  },

  /** Device placement workflow from community guides */
  placeWorkflow: [
    "Open Add menu (+ top-right, or press E)",
    "Click Devices category (right panel — use search box)",
    "Type device name in search (Property, Trigger, Button, Text)",
    "Click the device tile in the right panel",
    "Click on the map to place",
    "Click placed device → All Options to rename/configure; Blocks tab for triggers",
  ],

  /** Editing placed devices */
  editDevice: {
    open: "Click the device on the map → left/right settings panel opens",
    tabs: ["All Options", "Blocks", "Appearance"],
    property: {
      nameField: "Property name (global string key used in block code Get Property)",
      defaultValue: "Starting number value",
      scope: "Global / Player / Team — use Global for NN",
    },
    trigger: {
      channels: "All Options → When receiving on channel → type channel name",
      blocks: "Blocks tab → When triggered / When receiving on channel → stack blocks",
    },
    button: {
      channel: "All Options → When button pressed → Transmit on channel",
    },
    text: {
      content: "All Options → text field",
    },
    duplicate: "Hover device → press C → click to place copy",
    erase: "Q for eraser, or top-left eraser button",
    layers: "Top-left layers button — reorder props/devices",
  },

  /** Gear menu (bottom-left) */
  optionsMenu: {
    mapOptions: "Teams, duration, win condition",
    editingOptions: "Grid snap, show grid, player speed while editing, memory bar",
    permissions: "Who can edit when collaborating on host",
    publish: "Showcase & save / publish to Discovery",
  },
};

export function parseMapId(url) {
  try {
    const u = new URL(url);
    const id = u.searchParams.get("id");
    if (id) return id;
    const m = url.match(/[?&]id=([a-f0-9]+)/i);
    return m?.[1] || null;
  } catch {
    return null;
  }
}

export function classifyGkcUrl(url) {
  if (!url || !/gimkit\.com/i.test(url)) return "external";
  if (/\/edit\b/i.test(url)) return "edit";
  if (/\/host\b/i.test(url)) return "host";
  if (/\/creative\b/i.test(url)) return "dashboard";
  if (/\/play\b/i.test(url)) return "play";
  if (/\/join\b/i.test(url)) return "join";
  return "gimkit-other";
}

/**
 * Detect build mode vs playtest vs dashboard.
 * Note: GKC collaborative sessions use /host?id= WITH a join code while still building.
 */
export async function scanEditorState(page) {
  if (!page || page.isClosed()) {
    return { mode: "closed", canPlace: false, hints: [] };
  }

  return page.evaluate(({ hotkeyAdd }) => {
    const body = document.body?.innerText?.slice(0, 5000) || "";
    const url = location.href;
    const path = location.pathname.toLowerCase();

    const hasJoinCode = /\bjoin code\b/i.test(body);
    const hasStartGame = /start game/i.test(body);
    const hasPlayHud = /answer questions|while running|travel further|shop\b|energy\b/i.test(body);
    const hasEditChrome =
      hasStartGame ||
      /editing options|grid snap|show grid|showcase|permissions/i.test(body);

    const isHostUrl = /\/host\b/i.test(path) || /\/host\b/i.test(url);
    const isEditUrl = /\/edit\b/i.test(path) || /\/edit\b/i.test(url);
    const isCreativeDash = /\/creative\b/i.test(path);

    // Host + edit URLs are both valid build surfaces (host shows join code while editing)
    const onBuildUrl = isHostUrl || isEditUrl;
    const inPlaytest = hasPlayHud && !hasJoinCode;

    let mode = "unknown";
    if (isEditUrl) mode = "edit";
    else if (isHostUrl) mode = hasJoinCode ? "host" : "host";
    else if (isCreativeDash) mode = "dashboard";
    else if (inPlaytest) mode = "play";

    const canPlace = onBuildUrl && !inPlaytest;

    const hints = [];
    if (isHostUrl && hasJoinCode) {
      hints.push("Host session (join code visible) — OK for placing devices if you are the map owner");
    }
    if (isEditUrl) {
      hints.push("Edit URL — build mode");
    }
    if (!canPlace && isCreativeDash) {
      hints.push("Open a map from Creative — click a map card to enter host/edit");
    }
    if (inPlaytest) {
      hints.push("Stop playtest (play button) to return to build mode");
    }
    if (canPlace) {
      hints.push(`Press ${hotkeyAdd.toUpperCase()} or + (top-right) → Devices → search → click map`);
    }

    return {
      mode,
      canPlace,
      url,
      isHostUrl,
      isEditUrl,
      hasJoinCode,
      hasStartGame,
      hasEditChrome,
      inPlaytest,
      hints,
    };
  }, { hotkeyAdd: GKC.hotkeys.addMenu });
}

export function scoreGkcPage(url, title = "") {
  let score = 0;
  if (/gimkit\.com/i.test(url)) score += 20;
  if (/\/edit\b/i.test(url)) score += 80;
  if (/\/host\b/i.test(url)) score += 75;
  if (/\/creative\b/i.test(url)) score += 40;
  if (/host\s*\|\s*gimkit/i.test(title)) score += 30;
  if (/creative|gimkit creative/i.test(title)) score += 10;
  if (url === "about:blank") score -= 100;
  return score;
}

/** Optional: try /edit URL if /host placement fails */
export async function navigateToEditUrl(page) {
  const mapId = parseMapId(page.url());
  if (!mapId) return { ok: false, reason: "no-map-id" };
  const editUrl = GKC.urls.edit(mapId);
  await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(2000);
  const state = await scanEditorState(page);
  return { ok: state.canPlace, editUrl, state };
}
