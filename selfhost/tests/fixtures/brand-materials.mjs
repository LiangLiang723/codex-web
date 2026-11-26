import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const material = (mode) => `[data-pet-material-option="${mode}"]`;
const canvas = (mode) => `canvas[data-bot-material="${mode}"]`;

export function trackMaterialRequests(page) {
  const materials = new Set();
  page.on("request", (request) => {
    const match = request.url().match(/codex-bot-material-(fluffy|glass)-[a-f0-9]+\.mjs/u);
    if (match) materials.add(match[1]);
  });
  return materials;
}

export async function verifyMaterialOptions(page, studio, preview, activate, requests) {
  await studio.locator(`${material("flat")}[aria-pressed="true"]`).waitFor();
  assert.deepEqual([...requests], [], "Flat does not fetch either WebGL2 material");
  await activate(studio.locator('[data-pet-shape-option="sphere"]'));
  await preview.locator('[data-bot-shape="sphere"] svg').waitFor({ state: "attached" });
  const native = await preview.locator('[data-bot-engine="anatomy"] svg').elementHandle();
  for (const mode of ["fluffy", "glass"]) {
    await activate(studio.locator(material(mode)));
    await preview.locator(canvas(mode)).waitFor();
    assert(await native.evaluate((node) => node.isConnected), "Switching material preserves the Anatomy player");
    const fraction = await preview.locator(canvas(mode)).evaluate((node) => {
      const image = node.getContext("2d").getImageData(0, 0, node.width, node.height);
      let drawn = 0;
      for (let i = 3; i < image.data.length; i += 4) drawn += Number(image.data[i] > 0);
      return drawn / (node.width * node.height);
    });
    assert(fraction > 0.15, `${mode} covers the rounded body`);
    assert.deepEqual([...requests], mode === "fluffy" ? ["fluffy"] : ["fluffy", "glass"]);
    const screenshots = process.env.SELFHOST_BRAND_SCREENSHOTS;
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await studio.screenshot({ path: join(screenshots, `pet-${mode}-${page.viewportSize().width}.png`) });
    }
  }
  await activate(studio.locator(material("flat")));
  await preview.locator(canvas("glass")).waitFor({ state: "detached" });
  await activate(studio.locator(material("glass")));
  await activate(studio.locator('[data-pet-shape-option="cloud"]'));
  await preview.locator('[data-bot-shape="cloud"]').waitFor();
  await preview.locator(canvas("glass")).waitFor();
}

export async function verifySavedMaterial(studio, pet) {
  await studio.locator(`${material("glass")}[aria-pressed="true"]`).waitFor();
  await pet.locator(canvas("glass")).waitFor();
}
