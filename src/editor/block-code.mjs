/**
 * Block-code workspaces. Gimkit's Blocks tab is a *list* of block codes: a fresh
 * device has none, and creating one means picking an event ("When triggered",
 * "When receiving on channel…", "When button pressed", …) and, for channel
 * events, typing the channel. Only then does a Blockly workspace exist.
 *
 * Nothing here is verified against the live editor yet (no session available
 * while this was written), so every step is discovery-driven and returns what
 * it saw; `gkc probe` dumps the same information for a data fix.
 */
import { cfgLog } from "./configure-log.mjs";
import { pickDropdownOption } from "./device-editor.mjs";

const CREATE_RE = /create\s*(new\s*)?block\s*code|add\s*(new\s*)?block\s*code|new\s*block\s*code|^\+?\s*block\s*code$|^create$|^add\s*blocks?$|^\+$/i;

/** True when a Blockly workspace with a visible SVG exists on the page. */
export async function hasBlocklyWorkspace(page) {
  return page.evaluate(() => {
    const B = window.Blockly;
    if (!B || !B.getMainWorkspace) return false;
    const ws = B.getMainWorkspace();
    if (!ws) return false;
    const svg = document.querySelector(".blocklySvg, .blocklyWorkspace");
    if (!svg) return true;
    const r = svg.getBoundingClientRect();
    return r.width > 50 && r.height > 50;
  });
}

async function waitForWorkspace(page, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await hasBlocklyWorkspace(page)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/** Short clickable texts visible in the right-hand sidebar (Blocks tab). */
export async function readSidebarTexts(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("button, [role='button'], [role='tab'], [role='menuitem'], [role='option'], li, div, span, p, h3, h4")) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.left < innerWidth * 0.4) continue;
      if (el.children.length > 3) continue;
      const t = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 90) continue;
      if (!out.includes(t)) out.push(t);
      if (out.length >= 80) break;
    }
    return out;
  });
}

/** Click the largest visible element (right of 40% width) whose text matches. */
async function clickSidebarText(page, pattern, { minLeft = 0.4 } = {}) {
  const pt = await page.evaluate(
    ({ src, left }) => {
      const re = new RegExp(src, "i");
      let best = null;
      for (const el of document.querySelectorAll("button, [role='button'], [role='tab'], [role='menuitem'], [role='option'], li, div, span, p, a")) {
        const t = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 90 || !re.test(t)) continue;
        if (el.children.length > 4) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.left < innerWidth * left) continue;
        const area = r.width * r.height;
        if (!best || area > best.area) best = { x: r.left + r.width / 2, y: r.top + r.height / 2, area, t };
      }
      return best;
    },
    { src: pattern.source || String(pattern), left: minLeft },
  );
  if (!pt) return null;
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(450);
  return pt.t;
}

/** Any visible menu/list options (ant-dropdown, listbox, modal buttons) with their text. */
async function readMenuOptions(page) {
  return page.evaluate(() => {
    const out = [];
    const sel = ".ant-dropdown:not(.ant-dropdown-hidden) [role='menuitem'], .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, [role='listbox'] [role='option'], .ant-modal button, .ant-modal [role='button'], .ant-popover button, .ant-popover li";
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  });
}

function eventPattern(event) {
  if (!event) return null;
  if (event.kind === "channel") return /receiv|channel|signal/i;
  if (event.kind === "triggered") return /when\s*triggered|triggered/i;
  if (event.kind === "custom") return new RegExp(String(event.label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return null;
}

/**
 * Make sure a Blockly workspace for `event` is open in the device's Blocks tab.
 *   1. Workspace already open → done (unless a block-code list shows several and one matches the channel).
 *   2. Existing list entry matching the channel/event → click it.
 *   3. Otherwise: click "create block code", choose the event, type the channel.
 * Returns { ok, method, seen } — `seen` carries the sidebar texts for diagnosis.
 */
export async function ensureBlockWorkspace(page, { event = null, deviceName = "" } = {}) {
  const seen = { sidebar: [], menu: [] };
  const evRe = eventPattern(event);

  if (await hasBlocklyWorkspace(page)) {
    // A list of block codes may still be showing; prefer the one for our channel.
    if (event && event.kind === "channel") {
      const entry = await clickSidebarText(page, new RegExp(String(event.channel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).catch(() => null);
      if (entry) cfgLog(`  [blocks] selected block code entry "${entry}"`);
    }
    return { ok: true, method: "already-open", seen };
  }

  seen.sidebar = await readSidebarTexts(page);
  cfgLog(`  [blocks] no workspace yet; sidebar: ${JSON.stringify(seen.sidebar.slice(0, 25))}`);

  // 2. Existing block-code entry for this channel/event?
  if (event && event.kind === "channel") {
    const hit = await clickSidebarText(page, new RegExp(String(event.channel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    if (hit && (await waitForWorkspace(page, 2500))) return { ok: true, method: `existing-entry:${hit}`, seen };
  } else if (evRe) {
    const hit = await clickSidebarText(page, evRe);
    if (hit && (await waitForWorkspace(page, 2500))) return { ok: true, method: `existing-entry:${hit}`, seen };
  } else {
    // No event given: open the first existing block code if any ("When ..." entries).
    const hit = await clickSidebarText(page, /^when\s/i);
    if (hit && (await waitForWorkspace(page, 2500))) return { ok: true, method: `existing-entry:${hit}`, seen };
  }

  // 3. Create a new block code.
  const created = await clickSidebarText(page, CREATE_RE);
  if (!created) {
    return { ok: false, method: "no-create-button", seen, reason: "no-block-workspace" };
  }
  cfgLog(`  [blocks] clicked "${created}"`);
  await page.waitForTimeout(500);

  // Event chooser: a menu/list/modal with "When ..." options, or a select.
  seen.menu = await readMenuOptions(page);
  if (!seen.menu.length) seen.menu = (await readSidebarTexts(page)).filter((t) => /^when\s|receiv|trigger/i.test(t));
  cfgLog(`  [blocks] event options: ${JSON.stringify(seen.menu.slice(0, 15))}`);
  let chosen = null;
  if (evRe) {
    chosen = (await clickSidebarText(page, evRe, { minLeft: 0 })) || null;
    if (!chosen) {
      const opt = seen.menu.find((t) => evRe.test(t));
      if (opt && (await pickDropdownOption(page, opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))) chosen = opt;
    }
  } else if (seen.menu.length) {
    chosen = (await clickSidebarText(page, new RegExp(seen.menu[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), { minLeft: 0 })) || null;
  }
  if (chosen) cfgLog(`  [blocks] chose event "${chosen}"`);
  await page.waitForTimeout(500);

  // Channel prompt (channel events): type the channel into the focused/nearest input, confirm.
  if (event && event.kind === "channel") {
    const typed = await page.evaluate(() => {
      const active = document.activeElement;
      const isField = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "checkbox";
      let field = isField(active) ? active : null;
      if (!field) {
        const cands = [...document.querySelectorAll(".ant-modal input, .ant-popover input, input:not([type='hidden']):not([type='checkbox'])")].filter((i) => {
          const r = i.getBoundingClientRect();
          return r.width > 60 && r.height > 10 && r.left > innerWidth * 0.3;
        });
        field = cands[cands.length - 1] || null;
      }
      if (!field) return false;
      field.focus();
      const r = field.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (typed) {
      await page.mouse.click(typed.x, typed.y);
      await page.waitForTimeout(150);
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await page.keyboard.type(String(event.channel), { delay: 40 });
      await page.waitForTimeout(400);
      if (!(await pickDropdownOption(page, String(event.channel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))) {
        await page.keyboard.press("Enter").catch(() => {});
      }
      await page.waitForTimeout(300);
      await page.keyboard.press("Tab").catch(() => {});
    }
    // Confirm buttons, if a modal is used.
    await clickSidebarText(page, /^(create|confirm|done|save|ok|add)$/i, { minLeft: 0 }).catch(() => null);
  } else {
    await clickSidebarText(page, /^(create|confirm|done|save|ok|add)$/i, { minLeft: 0 }).catch(() => null);
  }

  if (await waitForWorkspace(page, 5000)) return { ok: true, method: `created:${created}${chosen ? `→${chosen}` : ""}`, seen };
  seen.after = await readSidebarTexts(page);
  return { ok: false, method: "created-but-no-workspace", seen, reason: "no-block-workspace" };
}

/**
 * Dump the live Blockly registry: for each type, its inputs (name, kind, check),
 * fields (name, value, dropdown options) and rendered text. Used by `gkc probe`.
 */
export async function dumpBlockRegistry(page) {
  return page.evaluate(() => {
    const B = window.Blockly;
    if (!B) return { ok: false, reason: "no-blockly" };
    const ws = B.getMainWorkspace && B.getMainWorkspace();
    if (!ws) return { ok: false, reason: "no-workspace" };
    const out = {};
    for (const type of Object.keys(B.Blocks || {})) {
      try {
        const b = ws.newBlock(type);
        const inputs = [];
        const fields = [];
        for (const inp of b.inputList || []) {
          if (inp.connection) inputs.push({ name: inp.name, kind: inp.connection.type === B.INPUT_VALUE ? "value" : "statement", check: inp.connection.check_ || inp.connection.getCheck?.() || null });
          for (const f of inp.fieldRow || []) {
            if (!f.name) continue;
            let options = null;
            try {
              if (f.getOptions) options = f.getOptions(false).map((o) => (Array.isArray(o) ? { label: typeof o[0] === "string" ? o[0] : "(img)", value: o[1] } : o));
            } catch (e) {
              options = null;
            }
            fields.push({ name: f.name, value: f.getValue ? f.getValue() : null, options });
          }
        }
        out[type] = {
          text: (b.toString ? b.toString() : "").slice(0, 160),
          tooltip: typeof b.tooltip === "string" ? b.tooltip.slice(0, 160) : undefined,
          output: !!b.outputConnection,
          statement: !!b.previousConnection,
          hat: !!b.nextConnection && !b.previousConnection && !b.outputConnection,
          inputs,
          fields,
        };
        b.dispose(false);
      } catch (e) {
        out[type] = { error: String(e && e.message).slice(0, 120) };
      }
    }
    const tops = (ws.getTopBlocks ? ws.getTopBlocks(true) : []).map((t) => ({ type: t.type, text: (t.toString ? t.toString() : "").slice(0, 120) }));
    return { ok: true, count: Object.keys(out).length, topBlocks: tops, blocks: out };
  });
}

/**
 * Wait until Gimkit's save indicator ("Saving…", "Unsaved changes") disappears,
 * then a short idle, so the last edit is not lost when the browser closes.
 */
export async function waitForSave(page, { maxMs = 8000, idleMs = 1500 } = {}) {
  const t0 = Date.now();
  let sawSaving = false;
  while (Date.now() - t0 < maxMs) {
    const saving = await page
      .evaluate(() => /saving|unsaved|not saved/i.test(document.body?.innerText?.slice(0, 6000) || ""))
      .catch(() => false);
    if (!saving) break;
    sawSaving = true;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(idleMs).catch(() => {});
  return { waitedMs: Date.now() - t0, sawSaving };
}
