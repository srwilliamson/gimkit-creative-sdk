/**
 * Virtual mouse + Blockly API automation for Gimkit Creative block editor.
 */
import { log } from "./config.mjs";

const MOUSE_STEP_MS = 80;

export async function probeBlockly(page) {
  return page.evaluate(() => {
    const B = window.Blockly;
    if (!B) return { ok: false, reason: "Blockly not on window" };
    const ws = B.getMainWorkspace?.() || B.mainWorkspace;
    const types = Object.keys(B.Blocks || {}).filter((t) => !t.startsWith("procedures_")).slice(0, 80);
    return { ok: !!ws, workspace: !!ws, typeCount: types.length, sampleTypes: types.slice(0, 15) };
  });
}

export async function getWorkspaceMetrics(page) {
  return page.evaluate(() => {
    const svg = document.querySelector(".blocklySvg, .injectionDiv svg");
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const flyout = document.querySelector(".blocklyFlyout, .blocklyFlyoutBackground")?.getBoundingClientRect();
    return {
      ws: { x: r.left + r.width * 0.55, y: r.top + r.height * 0.3, w: r.width, h: r.height },
      flyout: flyout ? { x: flyout.left + flyout.width / 2, y: flyout.top + 80 } : { x: r.left + 120, y: r.top + 120 },
    };
  });
}

export async function virtualDrag(page, fromX, fromY, toX, toY, { steps = 18 } = {}) {
  await page.mouse.move(fromX, fromY);
  await page.waitForTimeout(MOUSE_STEP_MS);
  await page.mouse.down();
  await page.waitForTimeout(MOUSE_STEP_MS);
  await page.mouse.move(toX, toY, { steps });
  await page.waitForTimeout(MOUSE_STEP_MS);
  await page.mouse.up();
  await page.waitForTimeout(350);
}

export async function virtualClick(page, x, y) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(60);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
  await page.waitForTimeout(280);
}

export async function openToolboxCategory(page, ...names) {
  const want = names.map((n) => n.toLowerCase());
  const hit = await page.evaluate(
    ({ terms }) => {
      for (const el of document.querySelectorAll(".blocklyTreeRow, .blocklyTreeLabel, .blocklyTreeIconClosed, .blocklyTreeIconOpen, [role='treeitem']")) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!t) continue;
        if (!terms.some((w) => t === w || t.startsWith(w))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }));
        return t;
      }
      return null;
    },
    { terms: want },
  );
  await page.waitForTimeout(400);
  return hit;
}

export async function findFlyoutBlock(page, ...searchTerms) {
  return page.evaluate(
    ({ terms }) => {
      const want = terms.map((t) => t.toLowerCase());
      const hits = [];
      for (const g of document.querySelectorAll(".blocklyFlyout .blocklyDraggable, .blocklyFlyout g.blocklyDraggable")) {
        const t = (g.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!t || t.length > 100) continue;
        if (!want.every((w) => t.includes(w)) && !want.some((w) => t.includes(w))) continue;
        const r = g.getBoundingClientRect();
        if (r.width < 15 || r.height < 10) continue;
        hits.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, t, area: r.width * r.height });
      }
      if (hits.length) {
        hits.sort((a, b) => b.area - a.area);
        return hits[0];
      }
      for (const el of document.querySelectorAll(".blocklyText, .blocklyLabel")) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!want.some((w) => t.includes(w))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 10) continue;
        hits.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, t, area: r.width * r.height });
      }
      hits.sort((a, b) => b.area - a.area);
      return hits[0] || null;
    },
    { terms: searchTerms },
  );
}

export async function dragFlyoutBlockToWorkspace(page, category, blockTerms, dropOffset = { x: 0.55, y: 0.28 }) {
  await openToolboxCategory(page, ...category);
  await page.waitForTimeout(300);
  const block = await findFlyoutBlock(page, ...blockTerms);
  if (!block) return { ok: false, reason: "flyout-block-not-found" };

  const m = await getWorkspaceMetrics(page);
  if (!m) return { ok: false, reason: "no-workspace" };

  const dropX = m.ws.x + dropOffset.x * 80;
  const dropY = m.ws.y + dropOffset.y * 60;
  await virtualDrag(page, block.x, block.y, dropX, dropY);
  return { ok: true, block: block.t, drop: { x: dropX, y: dropY } };
}

/** Click a dropdown/field on the topmost workspace block matching text. */
export async function clickWorkspaceBlockField(page, blockHint, fieldHint) {
  return page.evaluate(
    ({ blockHint, fieldHint }) => {
      const bh = blockHint.toLowerCase();
      const fh = (fieldHint || "").toLowerCase();
      for (const block of document.querySelectorAll(".blocklyDraggable")) {
        const t = (block.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!t.includes(bh)) continue;
        for (const field of block.querySelectorAll(".blocklyEditableText, .blocklyDropdownText, rect, text")) {
          const ft = (field.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (fh && !ft.includes(fh) && field.tagName !== "rect") continue;
          const r = field.getBoundingClientRect();
          if (r.width < 4) continue;
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          return { x, y, text: ft || t.slice(0, 40) };
        }
      }
      return null;
    },
    { blockHint, fieldHint },
  );
}

export async function selectDropdownOption(page, optionText) {
  const opt = await page.evaluate(
    ({ want }) => {
      for (const el of document.querySelectorAll(".blocklyDropDownDiv, .goog-menu, .blocklyMenu, div, span")) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t.toLowerCase() !== want.toLowerCase() && !t.toLowerCase().includes(want.toLowerCase())) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, t };
      }
      return null;
    },
    { want: optionText },
  );
  if (!opt) return false;
  await virtualClick(page, opt.x, opt.y);
  return true;
}

export async function typeIntoFocusedField(page, text) {
  await page.keyboard.press("Control+a").catch(() => page.keyboard.press("Meta+a").catch(() => {}));
  await page.waitForTimeout(80);
  await page.keyboard.type(String(text), { delay: 40 });
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(200);
}

export async function snapBlockToStack(page, fromY, stackX) {
  const m = await getWorkspaceMetrics(page);
  if (!m) return false;
  await virtualDrag(page, stackX, fromY, stackX, m.ws.y + m.ws.h * 0.15, { steps: 8 });
  return true;
}

/** Try Blockly API to create+connect block (fast path). */
export async function createBlockApi(page, typeCandidates, fields = {}, xy = { x: 30, y: 30 }) {
  return page.evaluate(
    ({ types, fields, xy }) => {
      const B = window.Blockly;
      if (!B) return { ok: false, reason: "no-blockly" };
      const ws = B.getMainWorkspace?.();
      if (!ws) return { ok: false, reason: "no-workspace" };

      for (const type of types) {
        if (!B.Blocks[type]) continue;
        try {
          const block = ws.newBlock(type);
          block.initSvg();
          block.render();
          block.moveBy(xy.x, xy.y);
          for (const [k, v] of Object.entries(fields)) {
            try {
              block.setFieldValue(String(v), k);
            } catch {
              /* field name varies */
            }
          }
          ws.render();
          return { ok: true, type, id: block.id };
        } catch (e) {
          /* try next type */
        }
      }
      return { ok: false, reason: "no-matching-type", tried: types };
    },
    { types: typeCandidates, fields, xy },
  );
}

export async function connectBlockToEvent(page) {
  return page.evaluate(() => {
    const B = window.Blockly;
    const ws = B?.getMainWorkspace?.();
    if (!ws) return { ok: false };
    const top = ws.getTopBlocks?.(true) || [];
    let eventBlock = null;
    let actionBlock = null;
    for (const b of top) {
      const t = (b.toString?.() || b.type || "").toLowerCase();
      if (/receiv|trigger|when|event|channel/.test(t) || b.type?.includes("event")) eventBlock = b;
      else actionBlock = b;
    }
    if (!eventBlock && top.length >= 2) {
      eventBlock = top[0];
      actionBlock = top[1];
    }
    if (eventBlock && actionBlock) {
      try {
        const next = eventBlock.nextConnection;
        const prev = actionBlock.previousConnection;
        if (next && prev && next.connect(prev)) {
          ws.render();
          return { ok: true, method: "connect" };
        }
      } catch {
        /* fall through */
      }
    }
    return { ok: false };
  });
}

export async function clearWorkspace(page) {
  return page.evaluate(() => {
    const B = window.Blockly;
    const ws = B?.getMainWorkspace?.();
    if (!ws) return false;
    ws.clear?.();
    ws.render?.();
    return true;
  });
}

export async function countWorkspaceBlocks(page) {
  return page.evaluate(() => {
    const ws = window.Blockly?.getMainWorkspace?.();
    if (!ws) return 0;
    return ws.getAllBlocks?.(false)?.length || document.querySelectorAll(".blocklyDraggable").length;
  });
}

export async function logBlocklyProbe(page) {
  const p = await probeBlockly(page);
  if (p.ok) log(`  Blockly API: workspace OK, ~${p.typeCount} block types`);
  else log(`  Blockly API: ${p.reason || "unavailable"} — using virtual mouse`);
  return p;
}
