/**
 * `gkc probe` — collect the unknowns of a live editor session into
 * build-output/probe.json so the block vocabulary / option labels / block-code
 * flow can be corrected from data instead of guesses:
 *
 *   - Blockly registry: every block type with its inputs, fields, dropdown options and text
 *   - the Blocks tab sidebar texts (block-code list, create button, event names)
 *   - the device panel's option labels ("All Options")
 *   - the map's page text sample
 */
import fs from "fs";
import path from "path";
import { CONFIG, log } from "./editor/config.mjs";
import { dismissDevicePanel } from "./editor/editor-actions.mjs";
import { openDeviceAt, clickAllOptionsTab } from "./editor/device-editor.mjs";
import { readPanelLabels } from "./editor/device-options.mjs";
import { ensureBlockWorkspace, dumpBlockRegistry, readSidebarTexts, hasBlocklyWorkspace, openBlocksTab } from "./editor/block-code.mjs";

/**
 * @param {import('playwright').Page} page
 * @param {import('./layout.mjs').Layout} layout   used to resolve `at` / `name`
 * @param {object} [opts]
 * @param {string} [opts.at]      position spec ("r0c0", "400,300", or a device name)
 * @param {string} [opts.name]    device name known to the layout
 * @param {object} [opts.event]   block-code event to open ({kind:"channel",channel} | {kind:"triggered"})
 * @param {string} [opts.out]     output file (default build-output/probe.json)
 */
export async function probeEditor(page, layout, { at, name, event = null, out } = {}) {
  if (!page) throw new Error("gkc probe needs a live editor session (not --dry-run)");
  const file = out || path.join(CONFIG.outputDir, "probe.json");
  const result = { at: new Date().toISOString(), url: page.url(), device: null, panelLabels: [], blocksSidebar: [], workspace: null, registry: null, pageText: "" };

  let pos = null;
  if (at) pos = layout.resolve(at);
  if (!pos && name) pos = layout.resolve(name);
  if (!pos) {
    const first = [...layout.named.entries()][0];
    if (first) pos = { x: first[1].x, y: first[1].y, name: first[0] };
  }
  result.pageText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 3000)).catch(() => "");

  if (pos) {
    await dismissDevicePanel(page);
    const opened = await openDeviceAt(page, pos.x, pos.y, { anyDevice: true });
    result.device = { x: pos.x, y: pos.y, name: pos.name || name || at || null, opened };
    if (opened) {
      await clickAllOptionsTab(page);
      await page.waitForTimeout(300);
      result.panelLabels = await readPanelLabels(page);
      if (await openBlocksTab(page)) {
        await page.waitForTimeout(400);
        result.blocksSidebar = await readSidebarTexts(page);
        const ws = await ensureBlockWorkspace(page, { event, deviceName: pos.name });
        result.workspace = ws;
        if (ws.ok && (await hasBlocklyWorkspace(page))) {
          result.registry = await dumpBlockRegistry(page);
          result.blocksSidebarAfter = await readSidebarTexts(page);
        }
      } else {
        result.blocksSidebar = await readSidebarTexts(page);
      }
      await dismissDevicePanel(page);
    }
  } else {
    result.note = "no device position known — pass --at r0c0 / --at x,y or place a device first";
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  const types = result.registry?.blocks ? Object.keys(result.registry.blocks).length : 0;
  log(`probe: ${types} block types, ${result.panelLabels.length} panel labels, ${result.blocksSidebar.length} Blocks-tab texts → ${file}`);
  return { file, blockTypes: types, panelLabels: result.panelLabels.length, blocksSidebar: result.blocksSidebar, workspace: result.workspace, device: result.device };
}
