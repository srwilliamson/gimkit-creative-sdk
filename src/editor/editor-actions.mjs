/**
 * Gimkit Creative editor UI — overlay-safe clicks, keeps Devices panel open between placements.
 */
import { CONFIG, log, getViewport } from "./config.mjs";
import { GKC, scanEditorState, parseMapId, navigateToEditUrl } from "./gkc-knowledge.mjs";

const CLICK_TIMEOUT = Number(process.env.GKC_CLICK_TIMEOUT_MS) || 2500;

export const REACT_CLICK_FN = `function reactClick(el) {
  if (!el) return false;
  const evt = {
    type: "click",
    preventDefault() {},
    stopPropagation() {},
    nativeEvent: new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
    target: el,
    currentTarget: el,
    bubbles: true,
    cancelable: true,
  };
  const fiberKey = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  let fiber = fiberKey ? el[fiberKey] : null;
  for (let d = 0; fiber && d < 45; d += 1) {
    const props = fiber.memoizedProps || fiber.pendingProps;
    if (props) {
      for (const name of ["onClick", "onPointerUp", "onMouseUp", "onTouchEnd"]) {
        if (typeof props[name] === "function") {
          props[name](evt);
          return true;
        }
      }
    }
    fiber = fiber.return;
  }
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const target = document.elementFromPoint(x, y) || el;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }),
    );
  }
  if (typeof target.click === "function") target.click();
  return true;
}`;

let devicesPanelReady = false;

export function resetPlacementSession() {

  devicesPanelReady = false;

}

export async function clickAt(page, x, y) {

  await page.mouse.click(x, y);

  await page.waitForTimeout(120);

}

export async function clickTextForce(page, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const pattern of list) {
    const loc = page.getByText(pattern, { exact: false }).first();
    if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
      await loc.click({ force: true, timeout: CLICK_TIMEOUT }).catch(() => {});
      return true;
    }
  }
  return false;
}

/**
 * Find the largest visible element whose text/aria-label satisfies `matcher(text, el, arg)`
 * and click it through React's handler. `matcher` is serialized into the page, so it
 * must not close over local variables — pass them via `arg` instead.
 */
export async function reactFindClick(page, matcher, arg = null) {
  return page.evaluate(
    ({ fnSource, matcherSource, arg: extra }) => {
      // eslint-disable-next-line no-eval
      eval(fnSource);
      // matcherSource is the source of an arrow function: evaluate it, then call it.
      const matchFn = new Function("return (" + matcherSource + ");")();
      const match = (t, el) => matchFn(t, el, extra);
      const hits = [];
      for (const el of document.querySelectorAll(
        "button, [role='button'], a, div, span, svg, img, h3, h4, p, [aria-label]",
      )) {
        const t = (el.getAttribute?.("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t && el.tagName !== "IMG" && el.tagName !== "SVG") continue;
        if (!match(t, el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        hits.push({ el, score: r.width * r.height, t });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits[0] ? reactClick(hits[0].el) : false;
    },
    { fnSource: REACT_CLICK_FN, matcherSource: matcher.toString(), arg },
  );
}

export async function readAddPanelState(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText?.slice(0, 4500) || "";
    const devicesOpen =
      /search for devices/i.test(body) ||
      /starting devices|interaction devices|inventory devices/i.test(body);
    const addOpen =
      devicesOpen ||
      (/terrain/i.test(body) && /props/i.test(body) && /devices/i.test(body));
    const deviceDetailOpen = /all options|blocks|when triggered|property name/i.test(body);
    return { addOpen, devicesOpen, deviceDetailOpen };
  });
}

export async function dismissDevicePanel(page) {
  const state = await readAddPanelState(page);
  if (state.deviceDetailOpen) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(250);
  }
}

export async function ensureEditMode(page) {
  const before = await scanEditorState(page);
  if (before.canPlace) {
    return {
      ok: true,
      state: before,
      action: before.isHostUrl ? "host-build-ready" : "edit-build-ready",
    };
  }
  if (before.inPlaytest) {
    log("Playtest running — stop game to return to build mode");
    return { ok: false, state: before, action: "in-playtest" };
  }
  const mapId = parseMapId(page.url());
  if (mapId && process.env.GKC_TRY_EDIT_URL === "1") {
    const nav = await navigateToEditUrl(page);
    if (nav.ok) return { ok: true, state: nav.state, action: "navigated-edit-url" };
  }
  return { ok: false, state: before, action: "cannot-build" };
}

export async function clickAddButton(page) {
  const vp = await getViewport(page);
  for (const pt of [
    { x: vp.width - 48, y: 52 },
    { x: vp.width - 72, y: 64 },
  ]) {
    await page.evaluate(
      ({ fnSource, x, y }) => {
        // eslint-disable-next-line no-eval
        eval(fnSource);
        const el = document.elementFromPoint(x, y);
        return el ? reactClick(el) : false;
      },
      { fnSource: REACT_CLICK_FN, x: pt.x, y: pt.y },
    );
    await page.waitForTimeout(400);
    if ((await readAddPanelState(page)).addOpen) return true;
  }
  return reactFindClick(page, (t) => /^\+$|^add$/i.test(t));
}

export async function openAddMenu(page) {
  const state = await readAddPanelState(page);
  if (state.devicesOpen) {
    devicesPanelReady = true;
    return true;
  }
  if (state.addOpen) return true;

  await page.keyboard.press(GKC.hotkeys.addMenu);
  await page.waitForTimeout(500);
  if ((await readAddPanelState(page)).addOpen) return true;
  return clickAddButton(page);
}

/** Click the "Devices" category tile with a real mouse click (works wherever it sits). */
export async function clickDevicesCategory(page) {
  const box = await page.evaluate(() => {
    const cands = [];
    for (const el of document.querySelectorAll("div, span, p, button, [role='button'], li")) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t !== "devices") continue; // exact label only — not "starting devices" etc.
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 16 || r.width > 320 || r.height > 320) continue;
      cands.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, area: r.width * r.height });
    }
    // smallest exact-text element = the category label/tile, not a big wrapper
    cands.sort((a, b) => a.area - b.area);
    return cands[0] || null;
  });
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(550);
  return true;
}

/** Must be on Devices sub-panel with search box — not just TERRAIN/PROPS/DEVICES tiles. */
export async function ensureDevicesPanel(page) {
  let state = await readAddPanelState(page);
  if (state.devicesOpen) {
    devicesPanelReady = true;
    return true;
  }

  await dismissDevicePanel(page);

  for (let round = 0; round < 5; round += 1) {
    if (!(await readAddPanelState(page)).addOpen) {
      await openAddMenu(page);
      await page.waitForTimeout(450);
    }

    // Click the Devices category tile (real mouse click).
    await clickDevicesCategory(page);
    if ((await readAddPanelState(page)).devicesOpen) {
      devicesPanelReady = true;
      return true;
    }

    // Fallback: React synthetic click on exact "Devices" text.
    await selectDevicesCategory(page);
    await page.waitForTimeout(450);
    if ((await readAddPanelState(page)).devicesOpen) {
      devicesPanelReady = true;
      return true;
    }

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }

  devicesPanelReady = false;
  return false;
}

export async function selectDevicesCategory(page) {
  const state = await readAddPanelState(page);
  if (state.devicesOpen) {
    devicesPanelReady = true;
    return true;
  }
  const hit = await reactFindClick(page, (t) => /^devices$/i.test(t));
  if (hit) {
    await page.waitForTimeout(450);
    devicesPanelReady = true;
    return true;
  }
  return clickTextForce(page, [/^devices$/i, "Devices"]);
}

export async function searchDevice(page, query) {
  const ok = await page.evaluate(
    ({ q }) => {
      for (const input of document.querySelectorAll("input")) {
        const ph = (input.placeholder || "").toLowerCase();
        if (!ph.includes("search") && !ph.includes("device")) continue;
        const r = input.getBoundingClientRect();
        if (r.width < 40) continue;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, q);
        else input.value = q;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: q }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    },
    { q: query },
  );
  if (ok) {
    await page.waitForTimeout(650);
    return true;
  }

  const search = page.locator('input[placeholder*="Search" i], input[placeholder*="device" i]').first();
  if (await search.count().catch(() => 0)) {
    await search.scrollIntoViewIfNeeded().catch(() => {});
    await search.fill(query, { force: true, timeout: CLICK_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(650);
    return true;
  }
  return false;
}

export async function pickDeviceFromResults(page, deviceName) {
  const want = deviceName.trim().toLowerCase();
  const hit = await page.evaluate(
    ({ fnSource, name }) => {
      // eslint-disable-next-line no-eval
      eval(fnSource);
      const hits = [];
      for (const el of document.querySelectorAll("button, [role='button'], div, span, p, li")) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 50) continue;
        const tl = t.toLowerCase();
        if (tl === name || tl.startsWith(name)) {
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 14) continue;
          if (r.left < innerWidth * 0.45) continue;
          hits.push({ el, area: r.width * r.height, left: r.left });
        }
      }
      hits.sort((a, b) => b.left - a.left || b.area - a.area);
      return hits[0] ? reactClick(hits[0].el) : false;
    },
    { fnSource: REACT_CLICK_FN, name: want },
  );
  if (hit) {
    await page.waitForTimeout(400);
    return true;
  }
  return reactFindClick(page, (t, el, name) => t.toLowerCase() === name, want);
}

export function clampPlacementToViewport(vp, x, y) {
  const pad = { left: 50, top: 76, right: 390, bottom: 102 };
  const w = vp?.width || 1500;
  const h = vp?.height || 900;
  return {
    x: Math.round(Math.min(Math.max(x, pad.left), w - pad.right)),
    y: Math.round(Math.min(Math.max(y, pad.top), h - pad.bottom)),
  };
}

export async function placeDeviceAt(page, x, y) {
  const vp = await getViewport(page);
  const pt = clampPlacementToViewport(vp, x, y);
  if (pt.x !== Math.round(x) || pt.y !== Math.round(y)) {
    log(`  Clamped click (${x},${y}) -> (${pt.x},${pt.y}) — was off-screen`);
  }
  await clickAt(page, pt.x, pt.y);

  await page.waitForTimeout(CONFIG.placeDelayMs);

  await dismissDevicePanel(page);

}

export async function prepareEditor(page) {
  resetPlacementSession();
  const edit = await ensureEditMode(page);
  if (!edit.ok) {
    for (const h of edit.state.hints) log(`  ${h}`);
    return edit;
  }
  const vp = await getViewport(page);
  await clickAt(page, Math.round(vp.width * 0.42), Math.round(vp.height * 0.55));
  await page.waitForTimeout(300);
  return edit;
}

export async function placeOneDevice(page, gkcDeviceType, x, y) {
  await dismissDevicePanel(page);

  if (!(await ensureDevicesPanel(page))) {
    log(`  Could not open Devices panel — press E → Devices manually if stuck`);
    devicesPanelReady = false;
    return false;
  }

  if (!(await searchDevice(page, gkcDeviceType))) {
    log(`  Search box missing — reopening Devices`);
    devicesPanelReady = false;
    if (!(await ensureDevicesPanel(page))) return false;
    if (!(await searchDevice(page, gkcDeviceType))) return false;
  }

  const picked = await pickDeviceFromResults(page, gkcDeviceType);
  if (!picked) log(`  Could not pick "${gkcDeviceType}" — check Devices search`);

  await placeDeviceAt(page, x, y);
  devicesPanelReady = true;
  return picked;
}

export { scanEditorState };

