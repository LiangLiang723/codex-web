import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const material = (mode) => `[data-pet-material-option="${mode}"]`;
const painted = (mode, color = "#3289ff") =>
  `svg[data-bot-material="${mode}"][data-bot-color="${color}"]`;

export async function verifyPaintedBots(scope, mode, count, color) {
  await scope.locator(painted(mode, color)).nth(count - 1).waitFor({ state: "attached" });
  assert.equal(await scope.locator(painted(mode, color)).count(), count,
    "Every Anatomy instance on this surface uses the current material and color");
}

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
  const eyes = studio.locator('[data-pet-shape-option="sphere"] [data-bot-material-eye]');
  const textures = [];
  for (const mode of ["fluffy", "glass"]) {
    await activate(studio.locator(material(mode)));
    await verifyPaintedBots(preview, mode, 1);
    await verifyPaintedBots(studio.locator("fieldset").first(), mode, 25);
    const live = preview.locator(`canvas[data-bot-live-material="${mode}"]`);
    await live.waitFor({ state: "attached" });
    assert.equal(await studio.locator("fieldset canvas[data-bot-live-material]").count(), 0,
      "Small shape picks use the shared palette");
    const opacity = await live.evaluate((node) => {
      const { data } = node.getContext("2d").getImageData(0, 0, node.width, node.height);
      let visible = 0, translucent = 0;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) visible++;
        if (data[index] > 0 && data[index] < 250) translucent++;
      }
      return { visible, translucent };
    });
    assert(opacity.visible > 100 && opacity.translucent > 20,
      `${mode} preserves the upstream transparent edges`);
    assert(await native.evaluate((node) => node.isConnected), "Switching material preserves the Anatomy player");
    assert.equal(await eyes.count(), 2, "The front-facing sphere keeps two eyes");
    const eye = await eyes.first().evaluate(async (node) => {
      const paint = node.getAttribute("fill").match(/url\(#(.*?)\)/u)[1];
      const image = new Image();
      image.src = document.getElementById(paint).querySelector("image").getAttribute("href");
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const levels = new Set();
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] > 200) levels.add(data[index] + data[index + 1] + data[index + 2]);
      }
      return { palette: levels.size, raster: image.src, path: node.getAttribute("d") };
    });
    assert(eye.path && eye.palette > 8, `${mode} shades the native eye contour`);
    textures.push(eye);
    await page.waitForFunction(() => {
      const icon = document.querySelector("link[data-codex-bot-favicon]");
      return icon.href.startsWith("data:image/svg+xml") &&
        decodeURIComponent(icon.href).includes("data:image/png");
    });
    assert.deepEqual([...requests], mode === "fluffy" ? ["fluffy"] : ["fluffy", "glass"]);
    const screenshots = process.env.SELFHOST_BRAND_SCREENSHOTS;
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await studio.screenshot({ path: join(screenshots, `pet-${mode}-${page.viewportSize().width}.png`) });
    }
  }
  assert.equal(textures[0].path, textures[1].path, "Both materials use the same Anatomy eye outline");
  assert.notEqual(textures[0].raster, textures[1].raster, "Eye pixels differ between fluffy and glass");
  await studio.getByTestId("bot-studio-custom-color").fill("#c74ef3");
  await verifyPaintedBots(preview, "glass", 1, "#c74ef3");
  await verifyPaintedBots(studio.locator("fieldset").first(), "glass", 25, "#c74ef3");
  await activate(studio.locator('[data-pet-color-option="#3289ff"]'));
  await activate(studio.locator(material("flat")));
  await preview.locator(painted("glass")).waitFor({ state: "detached" });
  await activate(studio.locator(material("glass")));
  await activate(studio.locator('[data-pet-shape-option="cloud"]'));
  await preview.locator('[data-bot-shape="cloud"]').waitFor();
  await verifyPaintedBots(preview, "glass", 1);
}

export async function verifySavedMaterial(studio, pet) {
  await studio.locator(`${material("glass")}[aria-pressed="true"]`).waitFor();
  await verifyPaintedBots(pet, "glass", 1);
}
