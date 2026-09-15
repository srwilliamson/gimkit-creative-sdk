/**
 * Detailed configure-phase logging — share build-output/configure.log when debugging.
 */
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.mjs";

const LOG_PATH = path.join(CONFIG.outputDir, "configure.log");
const CFG_VERBOSE = process.env.GKC_CFG_VERBOSE === "1";

/** Detailed line → configure.log; terminal only if GKC_CFG_VERBOSE=1 or forceConsole. */
export function cfgLog(msg, { console: forceConsole = false } = {}) {
  const line = `[${new Date().toISOString()}] [CFG] ${msg}`;
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  if (CFG_VERBOSE || forceConsole) console.log(line);
}

/** Always print one-line progress to terminal + log file. */
export function cfgLogSummary(msg) {
  const line = `[${new Date().toISOString()}] [CFG] ${msg}`;
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  console.log(line);
}

export function cfgLogPanel(label, panel) {
  if (!panel?.ok) {
    cfgLog(`${label}: panel NOT FOUND`);
    return;
  }
  cfgLog(
    `${label}: type="${panel.type || "?"}" name="${panel.name || ""}" val="${panel.value ?? ""}" scope="${panel.scope || ""}"`,
  );
}

/** Snapshot sidebar DOM — helps debug label/dropdown mismatches. */
export async function probeConfigureUi(page) {
  return page.evaluate(() => {
    const vpW = innerWidth;
    let root = null;
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
        root = el;
      }
    }

    const dropdownOptions = [];
    for (const dd of document.querySelectorAll(
      ".ant-select-dropdown, [class*='dropdown'], [role='listbox'], [role='menu']",
    )) {
      if (dd.classList?.contains("ant-select-dropdown-hidden")) continue;
      const r = dd.getBoundingClientRect();
      if (r.height < 5) continue;
      for (const item of dd.querySelectorAll(".ant-select-item-option, [role='option'], [role='menuitem']")) {
        const t = (item.textContent || "").replace(/\s+/g, " ").trim();
        if (t) dropdownOptions.push(t);
      }
    }

    if (!root) {
      return { panelFound: false, dropdownOptions, labelRows: [], inputs: [] };
    }

    const rr = root.getBoundingClientRect();
    const labelRows = [];
    for (const block of root.querySelectorAll("div, section, label")) {
      const txt = (block.innerText || "").trim();
      if (!txt || txt.length > 100) continue;
      const lines = txt.split("\n").map((s) => s.trim());
      const first = lines[0] || "";
      if (!lines.some((l) => /property|default value|channel|broadcast/i.test(l))) continue;
      labelRows.push({
        firstLine: first.slice(0, 40),
        hasSelect: !!block.querySelector(".ant-select"),
        plainInputs: [...block.querySelectorAll("input:not([type='hidden']):not([type='checkbox']), textarea")].filter(
          (i) => !i.closest(".ant-select") && i.getBoundingClientRect().width > 40,
        ).length,
      });
    }

    const inputs = [...root.querySelectorAll("input:not([type='hidden']):not([type='checkbox']), textarea")].map(
      (input) => ({
        value: (input.value || "").slice(0, 30),
        placeholder: (input.placeholder || "").slice(0, 30),
        inAntSelect: !!input.closest(".ant-select"),
        w: Math.round(input.getBoundingClientRect().width),
      }),
    );

    const selects = [...root.querySelectorAll(".ant-select-selection-item")].map((s) =>
      (s.textContent || "").trim(),
    );

    return {
      panelFound: true,
      panelBox: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
      dropdownOptions,
      labelRows: labelRows.slice(0, 12),
      inputs: inputs.slice(0, 8),
      selectItems: selects,
    };
  });
}

export function cfgLogProbe(tag, probe) {
  if (!probe.panelFound) {
    cfgLog(`${tag} PROBE: no Property sidebar in DOM`);
    cfgLog(`${tag} open dropdowns: [${(probe.dropdownOptions || []).join(", ")}]`);
    return;
  }
  const b = probe.panelBox;
  cfgLog(`${tag} PROBE: sidebar at (${b.x},${b.y}) ${b.w}x${b.h}`);
  cfgLog(`${tag} select chips: [${(probe.selectItems || []).join(" | ")}]`);
  cfgLog(`${tag} inputs: ${JSON.stringify(probe.inputs || [])}`);
  cfgLog(`${tag} label rows: ${JSON.stringify(probe.labelRows || [])}`);
  if (probe.dropdownOptions?.length) {
    cfgLog(`${tag} dropdown open: [${probe.dropdownOptions.join(", ")}]`);
  }
}

export function resetConfigureLog() {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  fs.writeFileSync(
    LOG_PATH,
    `# Configure debug log — paste this file when asking for help\n# Generated ${new Date().toISOString()}\n\n`,
    "utf8",
  );
}
