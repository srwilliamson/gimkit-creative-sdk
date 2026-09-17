/**
 * Configure Gimkit Creative devices — sidebar-only editing with verification.
 */
import {
  clickAt,
  dismissDevicePanel,
  reactFindClick,
  REACT_CLICK_FN,
} from "./editor-actions.mjs";
import { log, getViewport } from "./config.mjs";
import { cfgLog, cfgLogPanel, cfgLogProbe, cfgLogSummary, probeConfigureUi, resetConfigureLog } from "./configure-log.mjs";

const SIDEBAR_MIN_LEFT = 0.52;

/** GKC Property panel: ant-select[0]=Name, [1]=Type, [2]=Scope, [3]=Broadcast */
const PROP_SELECT = { name: 0, type: 1, scope: 2, broadcast: 3 };
const FIELD_MS = 1500;

/** Smallest right-side Property sidebar — not the full page wrapper. */
async function getDevicePanel(page, { silent = false } = {}) {
  const info = await page.evaluate(() => {
    const vpW = innerWidth;
    let best = null;
    let bestArea = Infinity;
    for (const el of document.querySelectorAll("div, aside, section")) {
      const t = el.innerText || "";
      if (!/property name/i.test(t) || !/property type/i.test(t) || !/default value/i.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < vpW * 0.4) continue;
      if (r.width < 140 || r.width > 640) continue;
      if (r.height < 120 || r.height > 960) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        bestArea = area;
        best = el;
      }
    }
    if (!best) return { found: false };
    document.querySelectorAll("[data-gkc-device-panel]").forEach((e) => {
      e.removeAttribute("data-gkc-device-panel");
    });
    best.setAttribute("data-gkc-device-panel", "1");
    const r = best.getBoundingClientRect();
    return { found: true, x: r.x, y: r.y, w: r.width, h: r.height };
  });

  if (!info?.found) {
    if (!silent) cfgLog("getDevicePanel: no sidebar (x>40% width, w 140-640)");
    return null;
  }
  if (!silent) {
    cfgLog(
      `getDevicePanel: (${Math.round(info.x)},${Math.round(info.y)}) ${Math.round(info.w)}x${Math.round(info.h)}`,
    );
  }
  return page.locator('[data-gkc-device-panel="1"]');
}

function valuesMatch(want, got) {
  if (String(want) === String(got)) return true;
  const a = parseFloat(want);
  const b = parseFloat(got);
  return !Number.isNaN(a) && !Number.isNaN(b) && Math.abs(a - b) < 1e-5;
}

/** Tag name vs default inputs — name is ant-select[0]; default is plain input between Type and Scope. */
async function tagPropertyFieldInputs(page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-gkc-device-panel='1']");
    if (!root) return { ok: false };

    root.querySelectorAll("[data-gkc-name-input],[data-gkc-default-input]").forEach((el) => {
      el.removeAttribute("data-gkc-name-input");
      el.removeAttribute("data-gkc-default-input");
    });

    const selects = [...root.querySelectorAll(".ant-select")].filter((s) => s.getBoundingClientRect().width > 40);
    const nameSelect = selects[0];
    const typeSelect = selects[1];
    const scopeSelect = selects[2];

    const nameInput = nameSelect?.querySelector("input:not([type='hidden']):not([type='checkbox'])") ?? null;
    const typeBottom = typeSelect?.getBoundingClientRect().bottom ?? 0;
    const scopeTop = scopeSelect?.getBoundingClientRect().top ?? Infinity;

    let defaultInput = null;
    for (const inp of root.querySelectorAll("input:not([type='hidden']):not([type='checkbox'])")) {
      if (nameSelect?.contains(inp) || typeSelect?.contains(inp) || scopeSelect?.contains(inp)) continue;
      const r = inp.getBoundingClientRect();
      if (r.width < 20 || r.height < 8) continue;
      if (r.top < typeBottom - 2) continue;
      if (Number.isFinite(scopeTop) && r.top > scopeTop - 2) continue;
      defaultInput = inp;
      break;
    }

    if (nameInput) nameInput.setAttribute("data-gkc-name-input", "1");
    if (defaultInput) defaultInput.setAttribute("data-gkc-default-input", "1");

    const chip = (i) => (selects[i]?.querySelector(".ant-select-selection-item")?.textContent || "").trim();
    return {
      ok: true,
      hasName: !!nameInput,
      hasDefault: !!defaultInput,
      name: ((nameInput?.value || chip(0) || "") + "").trim(),
      type: chip(1),
      value: ((defaultInput?.value ?? "") + "").trim(),
      scope: chip(2),
    };
  });
}

/** Instant DOM read — uses tagged fields so default never reads as property name. */
async function readPanelFields(page) {
  await getDevicePanel(page, { silent: true });
  const tagged = await tagPropertyFieldInputs(page);
  if (!tagged.ok) return { ok: false };
  return { ok: true, name: tagged.name, type: tagged.type, value: tagged.value, scope: tagged.scope };
}

async function waitForDefaultValueField(page) {
  for (let i = 0; i < 10; i += 1) {
    const tagged = await tagPropertyFieldInputs(page);
    if (tagged.hasDefault && tagged.value !== "") return tagged.value;
    if (tagged.hasDefault) return "0";
    await page.waitForTimeout(200);
  }
  return "0";
}

async function fillPropertyName(page, panel, name) {
  const tagged = await tagPropertyFieldInputs(page);
  if (!tagged.hasName) {
    cfgLog(`  [Property Name] FAIL: name combobox input not found`);
    return false;
  }
  const input = panel.locator("[data-gkc-name-input='1']");
  try {
    await input.click({ force: true, timeout: FIELD_MS });
    await input.fill(String(name));
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    const readBack = (await tagPropertyFieldInputs(page)).name;
    const ok = readBack.toLowerCase() === String(name).toLowerCase();
    cfgLog(`  [Property Name] fill="${name}" wrote=${ok} readBack="${readBack}"`);
    return ok;
  } catch (e) {
    cfgLog(`  [Property Name] FAIL: ${e.message?.slice(0, 80) || "unknown"}`);
    return false;
  }
}

async function fillDefaultValue(page, panel, value) {
  const prep = await tagPropertyFieldInputs(page);
  if (!prep.hasDefault) {
    cfgLog(`  [Default Value] FAIL: numeric input between Type and Scope not found`);
    return false;
  }

  if (valuesMatch(value, prep.value)) {
    cfgLog(`  [Default Value] already "${prep.value}"`);
    return true;
  }
  if (prep.value !== "") cfgLog(`  [Default Value] replacing "${prep.value}" with ${value}`);

  const str = String(value);
  const input = panel.locator("[data-gkc-default-input='1']");

  // REAL interaction only — synthetic .value writes read back fine but Gimkit does
  // NOT persist them (proven: synthetic value failed self-check, real name/type saved).
  try {
    await input.click({ force: true, timeout: FIELD_MS, clickCount: 3 });
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await page.waitForTimeout(80);
    await page.keyboard.type(str, { delay: 50 });
    await page.waitForTimeout(150);
    await page.keyboard.press("Tab"); // real blur → Gimkit saves
    await page.waitForTimeout(300);
  } catch (e) {
    cfgLog(`  [Default Value] type failed: ${e.message?.slice(0, 60)}`);
  }

  const readBack = (await tagPropertyFieldInputs(page)).value ?? "";
  const ok = valuesMatch(value, readBack);
  cfgLog(`  [Default Value] typed "${str}" wrote=${ok} readBack="${readBack}"`);
  if (!ok) cfgLog(`  [Default Value] FAIL: readback mismatch`);
  return ok;
}

/** Read/write fields — GKC puts Name + Default Value inputs inside .ant-select comboboxes. */
async function readLabeledField(panel, labelText, kind = "input") {
  const label = labelText.toLowerCase();
  const t = { timeout: FIELD_MS };
  if (kind === "input") {
    if (label === "property name") {
      const inputVal = (
        await panel.locator("input:not([type='checkbox']):not([type='hidden'])").first().inputValue(t).catch(() => "")
      ).trim();
      if (inputVal) return inputVal;
      return (
        (await panel
          .locator(".ant-select")
          .nth(PROP_SELECT.name)
          .locator(".ant-select-selection-item")
          .textContent(t)
          .catch(() => "")) || ""
      ).trim();
    }
    if (label === "default value") {
      const n = await panel.locator("input:not([type='checkbox']):not([type='hidden'])").count();
      if (n < 2) return "";
      return (await panel.locator("input:not([type='checkbox']):not([type='hidden'])").nth(1).inputValue(t).catch(() => "")).trim();
    }
    return "";
  }
  if (kind === "select") {
    const idx =
      label === "property type" ? PROP_SELECT.type : label === "property scope" ? PROP_SELECT.scope : null;
    if (idx == null) return "";
    const n = await panel.locator(".ant-select").count();
    if (n <= idx) return "";
    return (
      (await panel.locator(".ant-select").nth(idx).locator(".ant-select-selection-item").textContent(t).catch(() => "")) ||
      ""
    ).trim();
  }
  return "";
}

async function fillLabeledInput(page, panel, labelText, value) {
  const label = labelText.toLowerCase();
  if (label === "default value") return fillDefaultValue(page, panel, value);
  if (label === "property name") return fillPropertyName(page, panel, value);
  cfgLog(`  [${labelText}] FAIL: unknown input label`);
  return false;
}

async function pickDropdownOption(page, optionText) {
  await page.waitForTimeout(400);
  const re = new RegExp(`^${optionText}$`, "i");

  const scan = await page.evaluate(() => {
    const opts = [];
    for (const dd of document.querySelectorAll(".ant-select-dropdown")) {
      const hidden = dd.classList.contains("ant-select-dropdown-hidden");
      const r = dd.getBoundingClientRect();
      if (hidden || r.height < 4) continue;
      for (const item of dd.querySelectorAll(".ant-select-item-option, [role='option']")) {
        const t = (item.textContent || "").replace(/\s+/g, " ").trim();
        if (t) opts.push(t);
      }
    }
    return opts;
  });
  cfgLog(`  dropdown scan: ${JSON.stringify(scan)}`);

  const tries = [
    page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: re }),
    page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item").filter({ hasText: re }),
    page.getByRole("option", { name: optionText, exact: true }),
    page.locator("[role='listbox'] [role='option']").filter({ hasText: re }),
  ];

  for (const loc of tries) {
    try {
      const target = loc.first();
      if (await target.isVisible({ timeout: 1200 }).catch(() => false)) {
        await target.click({ force: true, timeout: 2500 });
        await page.waitForTimeout(400);
        cfgLog(`  picked "${optionText}" via Playwright`);
        return true;
      }
    } catch {
      /* next */
    }
  }

  cfgLog(`  dropdown miss for "${optionText}" — coordinate click`);
  const picked = await page.evaluate((opt) => {
    const want = opt.toLowerCase();
    for (const item of document.querySelectorAll(".ant-select-item-option, [role='option']")) {
      const t = (item.textContent || "").replace(/\s+/g, " ").trim();
      if (t.toLowerCase() !== want) continue;
      const r = item.getBoundingClientRect();
      if (r.width < 8 || r.height < 6) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, optionText);

  if (picked) {
    await page.mouse.click(picked.x, picked.y);
    await page.waitForTimeout(400);
    cfgLog(`  clicked "${optionText}" at (${Math.round(picked.x)},${Math.round(picked.y)})`);
    return true;
  }
  return false;
}

function selectIndexForLabel(labelText) {
  const label = labelText.toLowerCase();
  if (label === "property type") return PROP_SELECT.type;
  if (label === "property scope") return PROP_SELECT.scope;
  if (/broadcast/i.test(label)) return PROP_SELECT.broadcast;
  return PROP_SELECT.type;
}

async function readSelectChip(panel, idx) {
  return ((await panel.locator(".ant-select").nth(idx).locator(".ant-select-selection-item").textContent({ timeout: FIELD_MS }).catch(() => "")) || "").trim();
}

async function setLabeledSelect(page, panel, labelText, optionText, idxOverride = null) {
  const idx = idxOverride ?? selectIndexForLabel(labelText);
  const selectCount = await panel.locator(".ant-select").count();
  if (selectCount <= idx) {
    cfgLog(`  [${labelText}] FAIL: only ${selectCount} selects in panel (need idx ${idx})`);
    return false;
  }
  const select = panel.locator(".ant-select").nth(idx);
  const readCurrent = () => (idxOverride != null ? readSelectChip(panel, idx) : readLabeledField(panel, labelText, "select"));
  const current = (await readCurrent()) || "";
  cfgLog(`  [${labelText}] current="${current || "?"}" want="${optionText}" (select idx ${idx})`);
  if (new RegExp(`^${optionText}$`, "i").test(current)) {
    cfgLog(`  [${labelText}] already "${optionText}"`);
    return true;
  }

  try {
    await select.locator(".ant-select-selector").click({ force: true, timeout: 3000 });
  } catch (e) {
    cfgLog(`  [${labelText}] FAIL: could not click select — ${e.message?.slice(0, 60)}`);
    return false;
  }
  cfgLog(`  [${labelText}] opened dropdown`);
  await page.waitForTimeout(650);

  if (await pickDropdownOption(page, optionText)) {
    await page.waitForTimeout(400);
    const after = await readCurrent();
    const ok = new RegExp(`^${optionText}$`, "i").test(after);
    cfgLog(`  [${labelText}] after pick="${after}" ok=${ok}`);
    return ok;
  }

  if (/^number$/i.test(optionText)) {
    cfgLog(`  [${labelText}] keyboard fallback on select idx ${idx}`);
    await select.locator(".ant-select-selector").click({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const after = await readCurrent();
    const ok = /^number$/i.test(after);
    cfgLog(`  [${labelText}] after keyboard="${after}" ok=${ok}`);
    return ok;
  }
  cfgLog(`  [${labelText}] FAIL: pickDropdownOption returned false`);
  return false;
}

async function setSelectInPanel(panel, page, index, optionText) {
  const labels = ["Property Type", "Property Scope"];
  const label = labels[index];
  if (!label) return false;
  return setLabeledSelect(page, panel, label, optionText);
}

async function fillInputInPanel(page, panel, index, value) {
  const labels = ["Property Name", "Default Value"];
  const label = labels[index];
  if (!label) return false;
  return fillLabeledInput(page, panel, label, value);
}

/** Open a labeled dropdown row inside the device sidebar only. */
async function openSidebarDropdown(page, rowLabelPattern) {
  const pattern = rowLabelPattern.source || rowLabelPattern;
  return page.evaluate(
    ({ minLeft, rowLabel }) => {
      const panels = [...document.querySelectorAll("div, aside, section")].filter((d) => {
        const r = d.getBoundingClientRect();
        return r.left > innerWidth * minLeft && r.width > 220 && r.height > 280;
      });
      const sb = panels[0];
      if (!sb) return false;
      const re = new RegExp(rowLabel, "i");
      let best = null;
      let bestArea = Infinity;
      for (const row of sb.querySelectorAll("div, section, label, span, p")) {
        const txt = (row.innerText || "").trim();
        if (!txt || txt.length > 70) continue;
        if (!re.test(txt)) continue;
        if (/property scope/i.test(txt) && /property type/i.test(rowLabel)) continue;
        const sel =
          row.querySelector(".ant-select-selector, .ant-select, [role='combobox']") ||
          row.parentElement?.querySelector(".ant-select-selector, .ant-select, [role='combobox']") ||
          row.closest("div")?.querySelector(".ant-select-selector, .ant-select, [role='combobox']");
        if (!sel) continue;
        const r = sel.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > 0 && area < bestArea) {
          best = sel;
          bestArea = area;
        }
      }
      if (!best) return false;
      best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      best.click();
      return true;
    },
    { minLeft: SIDEBAR_MIN_LEFT, rowLabel: pattern },
  );
}

async function selectSidebarDropdown(page, rowLabelPattern, optionText) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const opened = await openSidebarDropdown(page, rowLabelPattern);
    if (!opened) {
      await page.waitForTimeout(300);
      continue;
    }
    if (await pickDropdownOption(page, optionText)) return true;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }
  return false;
}

async function readPropertyPanel(page) {
  const panel = await getDevicePanel(page, { silent: true });
  if (!panel) return { ok: false };
  const fields = await readPanelFields(page);
  if (!fields.ok) return { ok: false };
  return { ...fields, channel: "" };
}

async function isDevicePanelOpen(page) {
  return page.evaluate(() => {
    const vpW = innerWidth;
    for (const el of document.querySelectorAll("div, aside, section")) {
      const t = el.innerText || "";
      if (!/property name/i.test(t) || !/property type/i.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < vpW * 0.38 || r.width < 120 || r.height < 100) continue;
      return true;
    }
    const body = document.body?.innerText?.slice(0, 2500) || "";
    return /property name/i.test(body) && /property type|default value/i.test(body);
  });
}

/** Generic: ANY device settings sidebar open (property, trigger, button, text). */
async function isAnyDevicePanelOpen(page) {
  return page.evaluate(() => {
    const vpW = innerWidth;
    const vpH = innerHeight;
    const re =
      /property name|when receiving on channel|when getting a signal|when button pressed|when the button is pressed|transmit on channel|broadcast on|all options|appearance|device options|edit wire/i;
    for (const el of document.querySelectorAll("div, aside, section")) {
      const r = el.getBoundingClientRect();
      if (r.left < vpW * 0.38) continue;
      if (r.width < 160 || r.width > 720) continue;
      if (r.height < 170 || r.height > vpH + 60) continue;
      if (re.test(el.innerText || "")) return true;
    }
    return false;
  });
}

async function clickAllOptionsTab(page) {
  const hit = await reactFindClick(page, (t) => /^all options$/i.test(t));
  if (!hit) {
    await page.getByRole("tab", { name: /all options/i }).first().click({ force: true, timeout: 2000 }).catch(() => {});
  }
  await page.waitForTimeout(400);
}

async function panelIsTarget(page, targetName, deviceType) {
  if (!targetName || deviceType === "text") return true;
  // Triggers/buttons have no "Property Name" field — accept any device panel open.
  if (deviceType === "trigger" || deviceType === "button") {
    return isAnyDevicePanelOpen(page);
  }
  const panel = await readPropertyPanel(page);
  if (!panel.ok) return false;
  const want = targetName.toLowerCase();
  const got = (panel.name || "").toLowerCase();
  if (got === want) return true;
  if (!got || got === "text here..." || got === "property..." || got === "property") return false;
  return false;
}

export async function openDeviceByMapLabel(page, labelText) {
  if (!labelText) return false;
  await dismissDevicePanel(page);

  const clicked = await page.evaluate(
    ({ label, fnSource }) => {
      eval(fnSource);
      const want = label.trim().toLowerCase();
      const hits = [];
      for (const el of document.querySelectorAll("div, span, p, label")) {
        const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (raw.toLowerCase() !== want) continue;
        const r = el.getBoundingClientRect();
        if (r.left > innerWidth * 0.62 || r.top < 60 || r.bottom > innerHeight - 70) continue;
        if (r.width > 120 || r.height > 36) continue;
        hits.push({ el, area: r.width * r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 + 14 });
      }
      hits.sort((a, b) => a.area - b.area);
      if (!hits[0]) return null;
      reactClick(hits[0].el);
      return { x: hits[0].x, y: hits[0].y };
    },
    { label: labelText, fnSource: REACT_CLICK_FN },
  );

  if (!clicked) return false;
  await page.waitForTimeout(550);
  if (!(await isDevicePanelOpen(page))) {
    await clickAt(page, clicked.x, clicked.y);
    await page.waitForTimeout(500);
  }
  if (await isDevicePanelOpen(page)) {
    await clickAllOptionsTab(page);
    return true;
  }
  return false;
}

function isPlaceholderName(name) {
  const n = (name || "").toLowerCase().trim();
  return !n || n === "property..." || n === "property" || n === "text here..." || n === "text here";
}

function* spiralOffsets(maxRadius = 72, step = 12) {
  yield { dx: 0, dy: 0 };
  for (let r = step; r <= maxRadius; r += step) {
    for (let dx = -r; dx <= r; dx += step) {
      yield { dx, dy: -r };
      yield { dx, dy: r };
    }
    for (let dy = -r + step; dy <= r - step; dy += step) {
      yield { dx: -r, dy };
      yield { dx: r, dy };
    }
  }
}

async function readOpenedPanelName(page) {
  await getDevicePanel(page, { silent: true });
  const fields = await readPanelFields(page);
  return (fields.name || "").toLowerCase().trim();
}

/** Open by known placement coords first — skip slow label search + spiral when coords work. */
export async function openDeviceForConfigure(page, item, { takenNames = new Set() } = {}) {
  const label = item.name || item.label;
  const anchor = item.configureAt || item.placeAt || { x: 400, y: 400 };
  const { x: baseX, y: baseY } = anchor;
  const want = (label || "").toLowerCase();

  await dismissDevicePanel(page);
  if (await openDeviceAt(page, baseX, baseY)) {
    await clickAllOptionsTab(page);
    const got = await readOpenedPanelName(page);
    if (!got || got === want || isPlaceholderName(got)) {
      cfgLog(`  open "${label}" via coords click (${baseX},${baseY}) panelName="${got || "(empty)"}"`);
      return { ok: true, method: "coords", click: { x: baseX, y: baseY } };
    }
    if (takenNames.has(got)) {
      log(`  Coords hit "${got}" (taken) — spiral search for "${label}"`);
    } else {
      log(`  Coords hit "${got}" not "${label}" — spiral search`);
    }
    await dismissDevicePanel(page);
  }

  const vp = await getViewport(page);
  let baseXClamped = baseX;
  if (baseXClamped > vp.width * 0.52) baseXClamped = Math.round(vp.width * 0.38);

  const seen = new Set();
  let opens = 0;
  const MAX_OPENS = 14; // cap so a missing device fails fast instead of looping

  for (const { dx, dy } of spiralOffsets(40, 12)) {
    if (dx === 0 && dy === 0) continue; // coords already tried above
    const x = baseXClamped + dx;
    const y = baseY + dy;
    if (x < 40 || y < 60 || x > vp.width * 0.58 || y > vp.height - 60) continue;

    await dismissDevicePanel(page);
    await clickAt(page, x, y);
    await page.waitForTimeout(320);
    if (!(await isDevicePanelOpen(page))) continue;

    opens += 1;
    const got = await readOpenedPanelName(page);
    if (got && got !== want && !isPlaceholderName(got)) {
      seen.add(got);
      await dismissDevicePanel(page);
      if (opens >= MAX_OPENS) break;
      continue;
    }

    await clickAllOptionsTab(page);
    cfgLog(`  open "${label}" via spiral click (${x},${y}) panelName="${got || "(empty)"}"`);
    return { ok: true, method: "spiral", click: { x, y } };
  }

  cfgLog(
    `  open "${label}" FAIL: no panel after spiral around (${baseXClamped},${baseY}); saw [${[...seen].join(", ")}]`,
  );
  return { ok: false, method: "no-panel" };
}

export async function openDeviceAt(page, x, y, { anyDevice = false } = {}) {
  await dismissDevicePanel(page);
  const vp = await getViewport(page);
  if (x > vp.width * 0.52) x = Math.round(vp.width * 0.38);

  const detect = anyDevice ? isAnyDevicePanelOpen : isDevicePanelOpen;
  for (const pt of [
    { x, y },
    { x, y: y + 8 },
    { x, y: y - 8 },
  ]) {
    await clickAt(page, pt.x, pt.y);
    await page.waitForTimeout(450);
    if (await detect(page)) {
      await clickAllOptionsTab(page);
      return true;
    }
  }
  return false;
}

export async function openDeviceForItem(page, item, { preferLabel = true, preferCoords = false } = {}) {
  const label = item.name || item.label;
  await dismissDevicePanel(page);

  const anyDevice = item.type !== "property";
  const tryCoords = async () => {
    const { x, y } = item.configureAt || item.placeAt || { x: 400, y: 400 };
    if (await openDeviceAt(page, x, y, { anyDevice })) {
      if (await panelIsTarget(page, label, item.type)) return { ok: true, method: "coords" };
      const panel = await readPropertyPanel(page);
      log(`  Coords (${x},${y}) opened "${panel.name || "?"}" not "${label}" - skipped`);
      await dismissDevicePanel(page);
      return { ok: false, method: "wrong-device" };
    }
    return { ok: false, method: "no-panel" };
  };

  if (preferCoords) return tryCoords();

  if (preferLabel && label && !String(label).startsWith("===")) {
    if (await openDeviceByMapLabel(page, label)) {
      if (await panelIsTarget(page, label, item.type)) return { ok: true, method: "label" };
      const panel = await readPropertyPanel(page);
      log(`  Label "${label}" opened "${panel.name || "?"}" - wrong device, trying coords`);
      await dismissDevicePanel(page);
    }
  }

  return tryCoords();
}

async function selectDropdownOption(page, rowLabel, optionText) {
  return selectSidebarDropdown(page, rowLabel, optionText);
}

async function fillSidebarInput(page, labelPattern, value) {
  const panel = await getDevicePanel(page);
  if (!panel) return false;

  const pattern = labelPattern.source || labelPattern;
  if (/property name/i.test(pattern)) return fillInputInPanel(page, panel, 0, value);
  if (/default value/i.test(pattern)) return fillInputInPanel(page, panel, 1, value);

  const filled = await page.evaluate(
    ({ label, val }) => {
      const panels = [...document.querySelectorAll("div, aside, section")].filter((d) => {
        const t = (d.innerText || "").slice(0, 900);
        return /property name/i.test(t);
      });
      const sb = panels[0];
      if (!sb) return null;
      const re = new RegExp(label, "i");
      for (const input of sb.querySelectorAll("input:not([type='hidden']):not([type='checkbox'])")) {
        let ctx = "";
        let p = input.parentElement;
        for (let d = 0; p && d < 12; d += 1) ctx += " " + (p.innerText || "").slice(0, 90), (p = p.parentElement);
        if (!re.test(ctx)) continue;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, String(val));
        else input.value = String(val);
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    },
    { label: pattern, val: value },
  );
  return !!filled;
}

const typeMatches = (got, want) => new RegExp(`^${String(want).replace(/[/]/g, "\\/")}$`, "i").test(String(got || "").trim());

async function ensurePropertyType(page, wantType = "Number") {
  const panel = await getDevicePanel(page);
  if (!panel) {
    log("  WARN: device panel not found for type change");
    return false;
  }

  let state = await readPropertyPanel(page);
  if (typeMatches(state.type, wantType)) return true;

  log(`  Setting Property Type -> ${wantType}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await setLabeledSelect(page, panel, "Property Type", wantType);
    await page.waitForTimeout(600);
    state = await readPropertyPanel(page);
    if (typeMatches(state.type, wantType)) return true;
  }

  log(`  WARN: Property Type still "${state.type || "?"}" after retries (wanted ${wantType})`);
  return false;
}
const ensurePropertyTypeNumber = (page) => ensurePropertyType(page, "Number");

/** Scope is ant-select[2], except for True/False properties where the default dropdown shifts it to [3]. */
async function scopeSelectIndex(panel) {
  const n = await panel.locator(".ant-select").count();
  return n >= 4 ? 3 : PROP_SELECT.scope;
}
async function readScope(panel) {
  const idx = await scopeSelectIndex(panel);
  return ((await panel.locator(".ant-select").nth(idx).locator(".ant-select-selection-item").textContent({ timeout: FIELD_MS }).catch(() => "")) || "").trim();
}

async function ensurePropertyScope(page, wantScope = "global") {
  const panel = await getDevicePanel(page);
  if (!panel) return false;
  if (typeMatches(await readScope(panel), wantScope)) return true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await setLabeledSelect(page, panel, "Property Scope", wantScope, await scopeSelectIndex(panel))) return true;
    await page.waitForTimeout(400);
  }
  return false;
}
const ensurePropertyScopeGlobal = (page) => ensurePropertyScope(page, "global");

/** Does the panel's current default match the requested one, honouring the property type? */
function defaultMatches(type, want, got) {
  if (/true\/false/i.test(type)) {
    const norm = (v) => (/^(true|yes|on|1)$/i.test(String(v).trim()) ? "true" : /^(false|no|off|0)$/i.test(String(v).trim()) ? "false" : String(v).trim().toLowerCase());
    return norm(want) === norm(got);
  }
  if (/text/i.test(type)) return String(want).trim() === String(got ?? "").trim();
  return valuesMatch(want, got);
}

async function fillPropertyFields(page, name, defaultValue, { propertyType = "Number", scope = "global" } = {}) {
  cfgLog(`--- fillPropertyFields name="${name}" default=${defaultValue} type=${propertyType} scope=${scope} ---`);
  await clickAllOptionsTab(page);
  await page.waitForTimeout(350);

  let panel = await getDevicePanel(page);
  if (!panel) {
    cfgLog("FAIL: getDevicePanel returned null");
    cfgLogProbe("no-panel", await probeConfigureUi(page));
    log("  WARN: no device panel — is a device selected?");
    return { nameOk: false, valOk: false, typeOk: false, panel: { ok: false } };
  }

  const before = await readPropertyPanel(page);
  cfgLogPanel("before", before);

  await ensurePropertyType(page, propertyType);
  await page.waitForTimeout(500);
  panel = await getDevicePanel(page, { silent: true });
  if (!panel) {
    cfgLog("FAIL: panel lost after type change");
    return { nameOk: false, valOk: false, typeOk: false, scopeOk: false, panel: { ok: false } };
  }

  const isBool = /true\/false/i.test(propertyType);
  if (!isBool) {
    const autoDefault = await waitForDefaultValueField(page);
    cfgLog(`  [Default Value] after ${propertyType} type GKC shows "${autoDefault || "0"}"`);
  }

  await ensurePropertyScope(page, scope);
  await page.waitForTimeout(300);
  panel = await getDevicePanel(page, { silent: true });

  await fillLabeledInput(page, panel, "Property Name", name);
  await page.waitForTimeout(350);
  panel = await getDevicePanel(page, { silent: true });
  if (isBool) await setBooleanDefault(page, panel, defaultValue);
  else await fillLabeledInput(page, panel, "Default Value", defaultValue);
  await page.waitForTimeout(350);

  const after = await readPropertyPanel(page);
  if (isBool) after.value = await readBooleanDefault(page, panel);
  cfgLogPanel("after", after);
  if (!after.type || !typeMatches(after.type, propertyType) || !after.name) {
    cfgLogProbe("after-fail", await probeConfigureUi(page));
  }

  return {
    nameOk: (after.name || "").toLowerCase() === name.toLowerCase(),
    valOk: defaultMatches(propertyType, defaultValue, after.value),
    typeOk: typeMatches(after.type, propertyType),
    scopeOk: typeMatches(after.scope, scope),
    panel: after,
  };
}

/**
 * True/False properties show the default as a dropdown between Type and Scope
 * (so ant-select[2] becomes the default and [3] the scope). Best-effort: we
 * pick the option whose text matches true/false (or yes/no).
 */
async function booleanDefaultSelect(panel) {
  const n = await panel.locator(".ant-select").count();
  if (n < 4) return null;
  return panel.locator(".ant-select").nth(2);
}
async function readBooleanDefault(page, panel) {
  const sel = await booleanDefaultSelect(panel);
  if (!sel) return "";
  return ((await sel.locator(".ant-select-selection-item").textContent({ timeout: FIELD_MS }).catch(() => "")) || "").trim();
}
async function setBooleanDefault(page, panel, value) {
  const want = /^(true|yes|on|1)$/i.test(String(value)) ? "true" : "false";
  const sel = await booleanDefaultSelect(panel);
  if (!sel) {
    cfgLog(`  [Default Value] FAIL: no boolean default dropdown found (need 4 selects)`);
    return false;
  }
  const current = await readBooleanDefault(page, panel);
  if (defaultMatches("True/False", want, current)) return true;
  await sel.locator(".ant-select-selector").click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  for (const opt of want === "true" ? ["True", "true", "Yes"] : ["False", "false", "No"]) {
    if (await pickDropdownOption(page, opt)) break;
  }
  await page.waitForTimeout(300);
  const after = await readBooleanDefault(page, panel);
  const ok = defaultMatches("True/False", want, after);
  cfgLog(`  [Default Value] boolean want=${want} readBack="${after}" ok=${ok}`);
  return ok;
}

async function enableCheckboxNear(page, labelPattern) {
  return page.evaluate(
    ({ minLeft, label }) => {
      const panels = [...document.querySelectorAll("div, aside, section")].filter((d) => {
        const r = d.getBoundingClientRect();
        return r.left > innerWidth * minLeft && r.width > 220 && r.height > 280;
      });
      const sb = panels[0];
      if (!sb) return false;
      const re = new RegExp(label, "i");
      for (const row of sb.querySelectorAll("div, label, span, p")) {
        const t = (row.innerText || "").slice(0, 120);
        if (!re.test(t)) continue;
        const box = row.querySelector("input[type='checkbox']")
          || row.parentElement?.querySelector("input[type='checkbox']");
        if (box) {
          if (!box.checked) box.click();
          return true;
        }
      }
      return false;
    },
    { minLeft: SIDEBAR_MIN_LEFT, label: labelPattern.source || labelPattern },
  );
}

/**
 * Locate the channel field, which in Gimkit is an Ant-design combobox (".ant-select")
 * sitting directly under a section header:
 *   Button  → "When button pressed, transmit on"
 *   Trigger → "When receiving on channel"
 * The visible "Channel name…" is the ant-select placeholder (NOT an <input> placeholder),
 * which is why a plain-input search wrongly grabbed "Button Message". We find the header,
 * then take the nearest .ant-select (or input) just below it, and tag it.
 */
async function focusChannelInput(page, kind) {
  return page.evaluate(
    ({ minLeft, wantKind }) => {
      const headerRe = wantKind === "out" ? /transmit on/i : /receiving on|getting a signal/i;
      // section headers we must NOT target (avoid activate/deactivate rows for buttons)
      const avoidRe = wantKind === "out" ? /activate|deactivate|receiving/i : /deactivate|activate/i;

      const panels = [...document.querySelectorAll("div, aside, section")].filter((d) => {
        const r = d.getBoundingClientRect();
        return r.left > innerWidth * minLeft && r.width > 160 && r.width < 800 && r.height > 180;
      });
      panels.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      const sb = panels[0];
      if (!sb) return { ok: false, reason: "no-sidebar" };

      // Find the section header element (short text).
      let header = null;
      for (const el of sb.querySelectorAll("div, span, p, label, h1, h2, h3, strong, b")) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 70) continue;
        if (avoidRe.test(t)) continue;
        if (headerRe.test(t)) {
          header = el;
          break;
        }
      }
      if (!header) return { ok: false, reason: "no-header" };
      const ht = header.getBoundingClientRect();

      // Nearest ant-select or wide input just below the header.
      const cands = [
        ...sb.querySelectorAll(
          ".ant-select, input:not([type='hidden']):not([type='checkbox']):not([type='radio'])",
        ),
      ];
      let best = null;
      let bestDy = Infinity;
      for (const c of cands) {
        const r = c.getBoundingClientRect();
        if (r.width < 60 || r.height < 10) continue;
        const dy = r.top - ht.bottom;
        if (dy < -6 || dy > 220) continue; // must be right under this header
        if (dy < bestDy) {
          bestDy = dy;
          best = c;
        }
      }
      if (!best) return { ok: false, reason: "no-field-below-header" };

      const isSelect = best.classList.contains("ant-select") || !!best.querySelector?.(".ant-select");
      sb.querySelectorAll("[data-gkc-channel-field]").forEach((e) =>
        e.removeAttribute("data-gkc-channel-field"),
      );
      best.setAttribute("data-gkc-channel-field", "1");

      // Click point: for ant-select use the selector box; else the input.
      const clickEl = isSelect ? best.querySelector(".ant-select-selector") || best : best;
      const r = clickEl.getBoundingClientRect();
      return {
        ok: true,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        isSelect,
        header: (header.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      };
    },
    { minLeft: SIDEBAR_MIN_LEFT, wantKind: kind },
  );
}

/** Click the channel option in the open ant-select dropdown (commits Gimkit's onChange). */
async function pickChannelOption(page, channel) {
  await page.waitForTimeout(350);
  const want = channel.toLowerCase();
  const scan = await page.evaluate(() => {
    const out = [];
    for (const dd of document.querySelectorAll(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden), [role='listbox']",
    )) {
      for (const item of dd.querySelectorAll(".ant-select-item-option, [role='option'], li")) {
        const t = (item.textContent || "").replace(/\s+/g, " ").trim();
        if (t) out.push(t);
      }
    }
    return out;
  });
  cfgLog(`  [channel] dropdown options: ${JSON.stringify(scan.slice(0, 8))}`);

  const picked = await page.evaluate((ch) => {
    const w = ch.toLowerCase();
    const dds = [
      ...document.querySelectorAll(
        ".ant-select-dropdown:not(.ant-select-dropdown-hidden), [role='listbox']",
      ),
    ];
    // Prefer exact channel text; then "create …" option; then first containing it.
    const score = (t) => {
      const tl = t.toLowerCase();
      if (tl === w) return 3;
      if (/create|add/i.test(tl) && tl.includes(w)) return 2;
      if (tl.includes(w)) return 1;
      return 0;
    };
    let best = null;
    let bestScore = 0;
    for (const dd of dds) {
      for (const item of dd.querySelectorAll(".ant-select-item-option, [role='option'], li")) {
        const t = (item.textContent || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        const s = score(t);
        if (s <= bestScore) continue;
        const r = item.getBoundingClientRect();
        if (r.width < 8 || r.height < 6) continue;
        best = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        bestScore = s;
      }
    }
    return best;
  }, want);

  if (!picked) return false;
  await page.mouse.click(picked.x, picked.y);
  await page.waitForTimeout(350);
  return true;
}

async function fillChannelField(page, channel, kind) {
  await clickAllOptionsTab(page);
  await page.waitForTimeout(250);

  const focus = await focusChannelInput(page, kind);
  if (!focus.ok) {
    cfgLog(`  [channel ${kind}] FAIL: ${focus.reason}`);
    return "";
  }
  cfgLog(`  [channel ${kind}] header="${focus.header}" isSelect=${focus.isSelect}`);

  // Open the combobox and type the channel name (real keyboard).
  await page.mouse.click(focus.x, focus.y);
  await page.waitForTimeout(350);
  await page.keyboard.press("Control+A").catch(() => {});
  await page.waitForTimeout(50);
  await page.keyboard.press("Delete").catch(() => {});
  await page.keyboard.type(String(channel), { delay: 50 });

  // Poll for the create/matching dropdown option (it can take a moment to appear).
  let clicked = false;
  for (let i = 0; i < 4 && !clicked; i += 1) {
    await page.waitForTimeout(300);
    clicked = await pickChannelOption(page, channel);
  }
  if (!clicked) {
    cfgLog(`  [channel ${kind}] no dropdown option — Enter to create`);
    await page.keyboard.press("Enter").catch(() => {});
  }
  await page.waitForTimeout(250);
  // Real blur via Tab — this is what makes Gimkit persist the value (synthetic blur does not).
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(300);

  const readBack = await readChannelField(page);
  cfgLog(`  [channel ${kind}] committed "${channel}" readBack="${readBack}"`);
  return readBack || "";
}

/** Reopen a device by coords and read back its saved channel (true persistence check). */
async function reopenAndReadChannel(page, item, kind) {
  await dismissDevicePanel(page);
  const at = item.configureAt || item.placeAt || { x: 400, y: 400 };
  if (!(await openDeviceAt(page, at.x, at.y, { anyDevice: true }))) return "";
  await clickAllOptionsTab(page);
  await page.waitForTimeout(200);
  // tag the field (focusChannelInput tags it; ignore the click-open side effect)
  await focusChannelInput(page, kind);
  await page.waitForTimeout(150);
  const v = await readChannelField(page);
  await page.keyboard.press("Escape").catch(() => {}); // close any opened dropdown
  return v;
}

export { readPropertyPanel, clickAllOptionsTab, pickDropdownOption, tagGenericPanel, isAnyDevicePanelOpen, SIDEBAR_MIN_LEFT };

/** Read the channel text from the exact field we just targeted. */
async function readChannelField(page) {
  return page.evaluate(() => {
    const el = document.querySelector("[data-gkc-channel-field='1']");
    if (!el) return "";
    // Ant-select: value renders as a selection-item chip.
    const chip = el.querySelector?.(".ant-select-selection-item");
    if (chip) {
      const t = (chip.textContent || "").trim();
      if (t && !/channel name/i.test(t)) return t;
    }
    // Plain input case.
    if (el.tagName === "INPUT") {
      const v = (el.value || "").trim();
      if (v) return v;
    }
    const inner = el.querySelector?.("input");
    if (inner && inner.value) return inner.value.trim();
    return "";
  });
}

export async function configurePropertyDevice(
  page,
  item,
  defaultValue,
  { takenNames = new Set(), propertyType = "Number", scope = "global" } = {},
) {
  cfgLog(`========== Property "${item.name}" default=${defaultValue} type=${propertyType} scope=${scope} ==========`);
  const opened = await openDeviceForConfigure(page, item, { takenNames });
  if (!opened.ok) {
    cfgLogSummary(`FAIL Property "${item.name}" — open failed (${opened.method})`);
    return { ok: false, reason: opened.method };
  }
  cfgLog(`  open OK via ${opened.method}${opened.click ? ` @ (${opened.click.x},${opened.click.y})` : ""}`);

  const check = await fillPropertyFields(page, item.name, defaultValue, { propertyType, scope });
  await dismissDevicePanel(page);

  // Verify by REOPENING the device — confirms the value actually persisted.
  const v = await reopenAndReadProperty(page, item, propertyType);
  await dismissDevicePanel(page);
  let ok;
  let detail;
  if (v && v.ok) {
    const nameOk = (v.name || "").toLowerCase() === item.name.toLowerCase();
    const typeOk = typeMatches(v.type, propertyType);
    const valOk = defaultMatches(propertyType, defaultValue, v.value);
    const scopeOk = typeMatches(v.scope, scope);
    ok = nameOk && typeOk && valOk && scopeOk;
    detail = `name=${nameOk} val=${valOk} type=${typeOk} scope=${scopeOk}`;
    cfgLog(`  VERIFY reopen: name="${v.name}" type="${v.type}" val="${v.value}" scope="${v.scope}" -> ${ok}`);
  } else {
    ok = check.nameOk && check.valOk && check.typeOk && check.scopeOk !== false;
    detail = `name=${check.nameOk} val=${check.valOk} type=${check.typeOk} scope=${check.scopeOk} (no-reopen)`;
  }

  if (ok) {
    takenNames.add(item.name.toLowerCase());
    cfgLogSummary(`OK Property "${item.name}" ${propertyType}=${defaultValue} ${scope}`);
  } else {
    // Negative defaults are the classic Gimkit gotcha: the field accepts "-80" but some
    // editor builds store 0 or strip the sign. Report the fix Gimkit users rely on.
    const readBack = v && v.ok ? v.value : check.panel?.value;
    if (typeof defaultValue === "number" && defaultValue < 0 && !defaultMatches(propertyType, defaultValue, readBack)) {
      detail += ` — negative default did not persist (read "${readBack ?? ""}"). Workaround: keep the default 0 and set it at game start: place a Lifecycle (event "Game Start") transmitting "init", a trigger receiving "init" with blocks "Init" { property ${item.name} = ${defaultValue} }`;
    }
    cfgLogSummary(`FAIL Property "${item.name}" — ${detail}`);
  }
  return { ok, reason: ok ? null : detail, ...check };
}

/** Reopen device by coords and read its property panel (true persistence check). */
async function reopenAndReadProperty(page, item, propertyType = "Number") {
  await dismissDevicePanel(page);
  const at = item.configureAt || item.placeAt || { x: 400, y: 400 };
  if (!(await openDeviceAt(page, at.x, at.y))) return null;
  await page.waitForTimeout(200);
  const fields = await readPanelFields(page);
  if (fields.ok && /true\/false/i.test(propertyType)) {
    const panel = await getDevicePanel(page, { silent: true });
    if (panel) {
      fields.value = await readBooleanDefault(page, panel);
      fields.scope = await readScope(panel);
    }
  }
  return fields;
}

/** Find the right-hand sidebar of a non-Property device (Text, Button, ...). Tags it. */
async function tagGenericPanel(page) {
  return page.evaluate((minLeft) => {
    document.querySelectorAll("[data-gkc-generic-panel]").forEach((e) => e.removeAttribute("data-gkc-generic-panel"));
    let best = null;
    let bestArea = Infinity;
    for (const el of document.querySelectorAll("div, aside, section")) {
      const r = el.getBoundingClientRect();
      if (r.left < innerWidth * minLeft || r.width < 160 || r.width > 800 || r.height < 180) continue;
      if (!el.querySelector("input:not([type='hidden']):not([type='checkbox']), textarea")) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        bestArea = area;
        best = el;
      }
    }
    if (!best) return false;
    best.setAttribute("data-gkc-generic-panel", "1");
    return true;
  }, SIDEBAR_MIN_LEFT);
}

/** Locate the Text device's content field inside the tagged generic panel and tag it. */
async function tagTextContentField(page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-gkc-generic-panel='1']");
    if (!root) return { ok: false, reason: "no-panel" };
    root.querySelectorAll("[data-gkc-text-field]").forEach((e) => e.removeAttribute("data-gkc-text-field"));
    const fields = [...root.querySelectorAll("textarea, input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='color']):not([type='range'])")].filter((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 60 && r.height > 10;
    });
    if (!fields.length) return { ok: false, reason: "no-text-field" };
    const labelOf = (f) => {
      let ctx = "";
      let p = f.parentElement;
      for (let d = 0; p && d < 6; d += 1) {
        ctx += " " + (p.innerText || "").slice(0, 120);
        p = p.parentElement;
      }
      return ctx;
    };
    const scored = fields.map((f) => ({
      f,
      score: (f.tagName === "TEXTAREA" ? 3 : 0) + (/\btext\b|content|message|label/i.test(labelOf(f)) ? 2 : 0) - (/font|size|color|rotation|opacity/i.test(labelOf(f).slice(0, 60)) ? 2 : 0),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].f;
    best.setAttribute("data-gkc-text-field", "1");
    const r = best.getBoundingClientRect();
    return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: best.tagName, value: best.value ?? "" };
  });
}

/**
 * Set a Text device's content with REAL typing (synthetic .value writes do not
 * persist in Gimkit), then reopen the device and read the field back.
 */
export async function configureTextLabel(page, item, label) {
  const want = String(label);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const opened = await openDeviceForItem(page, item, { preferLabel: false, preferCoords: true });
    if (!opened.ok) return { ok: false, reason: `open-failed:${opened.method}` };
    await clickAllOptionsTab(page);
    await page.waitForTimeout(300);
    if (!(await tagGenericPanel(page))) {
      await dismissDevicePanel(page);
      return { ok: false, reason: "no-text-panel" };
    }
    const field = await tagTextContentField(page);
    if (!field.ok) {
      await dismissDevicePanel(page);
      return { ok: false, reason: field.reason };
    }
    if (field.value.trim() !== want.trim()) {
      await page.mouse.click(field.x, field.y);
      await page.waitForTimeout(150);
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await page.waitForTimeout(80);
      await page.keyboard.type(want, { delay: 30 });
      await page.waitForTimeout(150);
      await page.keyboard.press("Tab").catch(() => {});
      await page.waitForTimeout(300);
    }
    await dismissDevicePanel(page);

    // Reopen → read back.
    const at = item.configureAt || item.placeAt || { x: 400, y: 400 };
    let read = "";
    if (await openDeviceAt(page, at.x, at.y, { anyDevice: true })) {
      await page.waitForTimeout(200);
      if (await tagGenericPanel(page)) {
        const again = await tagTextContentField(page);
        read = again.ok ? again.value : "";
      }
    }
    await dismissDevicePanel(page);
    cfgLog(`  [text] want="${want}" readBack="${read}" attempt=${attempt}`);
    if (read.trim() === want.trim()) return { ok: true, read };
  }
  return { ok: false, reason: "text-not-persisted" };
}

export async function configureButtonChannel(page, item, channelOut) {
  const opened = await openDeviceForItem(page, item, { preferCoords: true });
  if (!opened.ok) return { ok: false, reason: opened.method };
  return setAndVerifyChannel(page, item, channelOut, "out");
}

export async function configureTriggerChannel(page, item, channelIn) {
  const opened = await openDeviceForItem(page, item, { preferCoords: true });
  if (!opened.ok) return { ok: false, reason: opened.method };
  return setAndVerifyChannel(page, item, channelIn, "in");
}

/** Set channel, then reopen the device to confirm it PERSISTED; retry once if not. */
async function setAndVerifyChannel(page, item, channel, kind) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await fillChannelField(page, channel, kind);
    await dismissDevicePanel(page);
    const saved = await reopenAndReadChannel(page, item, kind);
    await dismissDevicePanel(page);
    const ok = saved.toLowerCase() === channel.toLowerCase();
    cfgLog(`  [channel ${kind}] VERIFY reopen "${item.name}" saved="${saved}" -> ${ok}`);
    if (ok) return { ok: true, channel, read: saved };
    if (attempt < 2) {
      cfgLog(`  [channel ${kind}] not persisted — retrying once`);
      await openDeviceForItem(page, item, { preferCoords: true });
    }
  }
  return { ok: false, channel, reason: "channel-not-persisted" };
}
