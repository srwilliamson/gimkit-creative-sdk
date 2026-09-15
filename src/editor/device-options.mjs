/**
 * Generic device options: find a sidebar label ("Trigger Delay", "Visible In-Game",
 * "Button Message", ...) and drive the control right below it — ant-select, switch,
 * checkbox, input or textarea — with real keyboard/mouse events, then reopen the
 * device and read the value back. Labels are matched case-insensitively by regex
 * so the same code serves the dedicated `hidden` / `delay N` syntax and the escape
 * hatch `option "Device" "Label" = value`.
 */
import { dismissDevicePanel } from "./editor-actions.mjs";
import { cfgLog } from "./configure-log.mjs";
import { openDeviceForItem, openDeviceAt, clickAllOptionsTab, pickDropdownOption, SIDEBAR_MIN_LEFT } from "./device-editor.mjs";

const TRUE_WORDS = ["Yes", "True", "On", "Enabled", "Show", "Visible"];
const FALSE_WORDS = ["No", "False", "Off", "Disabled", "Hide", "Hidden"];

/**
 * In-page: locate the label and the nearest control below/beside it; tag the control.
 * Returns geometry + the control kind + current value, or { ok:false, reason, labels }.
 */
async function locateOptionField(page, labelPattern) {
  return page.evaluate(
    ({ minLeft, pattern }) => {
      const re = new RegExp(pattern, "i");
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
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

      const labels = [];
      let header = null;
      for (const el of sb.querySelectorAll("div, span, p, label, h1, h2, h3, h4, strong, b")) {
        const t = norm(el.textContent);
        if (!t || t.length > 80) continue;
        if (el.children.length > 2) continue;
        if (labels.length < 60 && !labels.includes(t)) labels.push(t);
        if (!header && re.test(t)) header = el;
      }
      if (!header) return { ok: false, reason: "label-not-found", labels };
      const ht = header.getBoundingClientRect();

      const selector = ".ant-select, .ant-switch, button[role='switch'], .ant-checkbox, input[type='checkbox'], .ant-radio-group, .ant-segmented, input:not([type='hidden']):not([type='color']):not([type='range']), textarea";
      let best = null;
      let bestScore = Infinity;
      for (const c of sb.querySelectorAll(selector)) {
        if (header.contains(c)) continue;
        const r = c.getBoundingClientRect();
        if (r.width < 14 || r.height < 10) continue;
        const dy = r.top - ht.bottom;
        const sameRow = r.top < ht.bottom && r.bottom > ht.top;
        const score = sameRow ? Math.abs(r.left - ht.right) / 10 : dy;
        if (!sameRow && (dy < -6 || dy > 160)) continue;
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) return { ok: false, reason: "no-control-below-label", labels };

      sb.querySelectorAll("[data-gkc-option-field]").forEach((e) => e.removeAttribute("data-gkc-option-field"));
      best.setAttribute("data-gkc-option-field", "1");

      let kind = "input";
      let current = "";
      if (best.classList.contains("ant-select") || best.querySelector?.(".ant-select")) {
        kind = "select";
        current = norm(best.querySelector(".ant-select-selection-item")?.textContent || "");
      } else if (best.classList.contains("ant-switch") || best.getAttribute("role") === "switch") {
        kind = "switch";
        current = best.classList.contains("ant-switch-checked") || best.getAttribute("aria-checked") === "true" ? "true" : "false";
      } else if (best.classList.contains("ant-checkbox") || (best.tagName === "INPUT" && best.type === "checkbox")) {
        kind = "checkbox";
        const inp = best.tagName === "INPUT" ? best : best.querySelector("input");
        current = inp && inp.checked ? "true" : "false";
      } else if (best.classList.contains("ant-radio-group") || best.classList.contains("ant-segmented")) {
        kind = "radio";
        current = norm(best.querySelector(".ant-radio-button-wrapper-checked, .ant-radio-wrapper-checked, .ant-segmented-item-selected")?.textContent || "");
      } else if (best.tagName === "TEXTAREA") {
        kind = "textarea";
        current = best.value ?? "";
      } else {
        current = best.value ?? "";
      }
      const clickEl = kind === "select" ? best.querySelector(".ant-select-selector") || best : best;
      const r = clickEl.getBoundingClientRect();
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, kind, current, label: norm(header.textContent).slice(0, 60) };
    },
    { minLeft: SIDEBAR_MIN_LEFT, pattern: labelPattern },
  );
}

function wantWords(value) {
  if (value === true) return TRUE_WORDS;
  if (value === false) return FALSE_WORDS;
  return [String(value)];
}

/** Compare a read-back value with the requested one (booleans accept Yes/No etc.). */
export function optionValueMatches(want, got) {
  const g = String(got ?? "").trim().toLowerCase();
  if (want === true) return TRUE_WORDS.some((w) => w.toLowerCase() === g) || g === "true" || g === "1";
  if (want === false) return FALSE_WORDS.some((w) => w.toLowerCase() === g) || g === "false" || g === "0";
  if (typeof want === "number") return Number(g) === want;
  return String(want).trim().toLowerCase() === g;
}

async function pickRadioOption(page, words) {
  return page.evaluate((ws) => {
    const root = document.querySelector("[data-gkc-option-field='1']");
    if (!root) return false;
    const items = [...root.querySelectorAll("label, .ant-segmented-item, [role='radio']")];
    for (const w of ws) {
      const hit = items.find((i) => (i.textContent || "").trim().toLowerCase() === w.toLowerCase());
      if (hit) {
        const r = hit.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return false;
  }, words);
}

/** Drive the tagged control to `value`. Returns the value read straight after. */
async function driveOptionField(page, field, value) {
  const words = wantWords(value);
  if (field.kind === "select") {
    if (words.some((w) => w.toLowerCase() === String(field.current).toLowerCase())) return field.current;
    await page.mouse.click(field.x, field.y);
    await page.waitForTimeout(450);
    let picked = false;
    for (const w of words) {
      if (await pickDropdownOption(page, w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) {
        picked = true;
        break;
      }
    }
    if (!picked) {
      // Searchable select: type the value and confirm.
      await page.keyboard.type(String(words[0]), { delay: 40 });
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter").catch(() => {});
    }
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape").catch(() => {});
  } else if (field.kind === "switch" || field.kind === "checkbox") {
    const wantOn = value === true || /^(yes|true|on|1)$/i.test(String(value));
    const isOn = field.current === "true";
    if (wantOn !== isOn) {
      await page.mouse.click(field.x, field.y);
      await page.waitForTimeout(300);
    }
  } else if (field.kind === "radio") {
    const pt = await pickRadioOption(page, words);
    if (pt) {
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(300);
    }
  } else {
    if (String(field.current).trim() !== String(value).trim()) {
      await page.mouse.click(field.x, field.y);
      await page.waitForTimeout(150);
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await page.waitForTimeout(60);
      await page.keyboard.type(String(value), { delay: 30 });
      await page.waitForTimeout(120);
      await page.keyboard.press("Tab").catch(() => {}); // real blur = Gimkit saves
      await page.waitForTimeout(300);
    }
  }
  return page.evaluate(() => {
    const el = document.querySelector("[data-gkc-option-field='1']");
    if (!el) return "";
    const chip = el.querySelector?.(".ant-select-selection-item");
    if (chip) return (chip.textContent || "").trim();
    if (el.classList.contains("ant-switch") || el.getAttribute("role") === "switch") return el.classList.contains("ant-switch-checked") || el.getAttribute("aria-checked") === "true" ? "true" : "false";
    const cb = el.tagName === "INPUT" && el.type === "checkbox" ? el : el.querySelector?.("input[type='checkbox']");
    if (cb) return cb.checked ? "true" : "false";
    const checked = el.querySelector?.(".ant-radio-button-wrapper-checked, .ant-radio-wrapper-checked, .ant-segmented-item-selected");
    if (checked) return (checked.textContent || "").trim();
    return (el.value ?? "").toString().trim();
  });
}

/**
 * Set one option on the device at item.configureAt. `labelPattern` is a regex source
 * (case-insensitive). Reopens the device to verify persistence. Never throws.
 */
export async function setDeviceOption(page, item, { label, labelPattern, value }) {
  const pattern = labelPattern || String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  cfgLog(`========== Option "${item.name}" [${label || pattern}] = ${JSON.stringify(value)} ==========`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const opened = await openDeviceForItem(page, item, { preferLabel: false, preferCoords: true });
    if (!opened.ok) return { ok: false, reason: `open-failed:${opened.method}` };
    await clickAllOptionsTab(page);
    await page.waitForTimeout(300);
    const field = await locateOptionField(page, pattern);
    if (!field.ok) {
      await dismissDevicePanel(page);
      return { ok: false, reason: field.reason, labels: field.labels };
    }
    cfgLog(`  [option] label="${field.label}" kind=${field.kind} current="${field.current}"`);
    const immediate = await driveOptionField(page, field, value);
    await dismissDevicePanel(page);

    const at = item.configureAt || item.placeAt || { x: 400, y: 400 };
    let read = "";
    if (await openDeviceAt(page, at.x, at.y, { anyDevice: true })) {
      await clickAllOptionsTab(page);
      await page.waitForTimeout(250);
      const again = await locateOptionField(page, pattern);
      read = again.ok ? again.current : "";
    }
    await dismissDevicePanel(page);
    const ok = optionValueMatches(value, read);
    cfgLog(`  [option] want=${JSON.stringify(value)} immediate="${immediate}" readBack="${read}" ok=${ok} attempt=${attempt}`);
    if (ok) return { ok: true, read, label: field.label, kind: field.kind };
    if (attempt === 2) return { ok: false, reason: "option-not-persisted", read, label: field.label, kind: field.kind };
  }
  return { ok: false, reason: "option-not-persisted" };
}

/** Read all short labels of the open device panel (for `gkc probe`). */
export async function readPanelLabels(page) {
  return page.evaluate((minLeft) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
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
    if (!sb) return [];
    const out = [];
    for (const el of sb.querySelectorAll("div, span, p, label, h1, h2, h3, h4, strong, b")) {
      const t = norm(el.textContent);
      if (!t || t.length > 80 || el.children.length > 2) continue;
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }, SIDEBAR_MIN_LEFT);
}
