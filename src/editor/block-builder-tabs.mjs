/** Blocks tab opener — shared by block-builder and stack runner. */
import { dismissDevicePanel, reactFindClick } from "./editor-actions.mjs";

export async function openBlocksTab(page) {
  const hit =
    (await reactFindClick(page, (t) => /^blocks$/i.test(t))) ||
    (await page
      .getByRole("tab", { name: /^blocks$/i })
      .first()
      .click({ force: true, timeout: 2000 })
      .then(() => true)
      .catch(() => false));
  await page.waitForTimeout(600);
  return hit;
}

export { dismissDevicePanel };
