import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function verifyAnatomyMotion(avatar) {
  const drawing = avatar.locator("svg");
  await avatar.scrollIntoViewIfNeeded();
  await drawing.waitFor({ state: "attached" });
  await drawing.evaluate((node) => new Promise((resolve, reject) => {
    const initial = node.innerHTML;
    const stop = () => {
      observer.disconnect();
      clearTimeout(expiry);
    };
    const observer = new MutationObserver(() => {
      if (node.innerHTML === initial) return;
      stop();
      resolve();
    });
    const expiry = setTimeout(() => {
      stop();
      reject(new Error(
        `Anatomy did not draw a new frame (${node.closest("[data-bot-motion]")?.getAttribute("data-bot-motion")}, ${document.visibilityState})`,
      ));
    }, 12_000);
    observer.observe(node, { attributes: true, childList: true, subtree: true });
  }));
}

export async function verifyMotionPreview(page, activate) {
  const studio = page.getByTestId("conversation-pet-studio");
  const preview = studio.getByTestId("bot-studio-avatar");
  const picks = studio.locator("[data-pet-shape-option]");
  await picks.first().waitFor();
  assert.equal(await picks.count(), 25);
  await picks.last().locator('svg svg[viewBox="0 0 32 32"]').waitFor({ state: "attached" });
  await activate(studio.locator('[data-pet-shape-option="cloud"]'));
  await studio.getByTestId("bot-studio-custom-color").fill("#c74ef3");
  assert.equal(await preview.locator("[data-codex-bot]").evaluate((node) => getComputedStyle(node).color), "rgb(199, 78, 243)");
  await activate(studio.locator('[data-pet-color-option="#3289ff"]'));
  await activate(studio.locator('[data-pet-size-option="large"]'));
  await activate(page.getByTestId("bot-studio-followPointer"));
  await preview.locator('[data-bot-shape="cloud"]').waitFor();
  assert.equal(await preview.locator("[data-codex-bot]").evaluate((node) => getComputedStyle(node).color), "rgb(50, 137, 255)");
  const screenshots = process.env.SELFHOST_BRAND_SCREENSHOTS;
  const width = page.viewportSize().width;
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await studio.screenshot({ path: join(screenshots, `pet-appearance-${width}.png`) });
  }
  await activate(studio.getByTestId("bot-studio-gallery-tab"));
  const cards = studio.locator("[data-bot-state-card]");
  assert.equal(await cards.count(), 53);
  await activate(studio.locator('[data-bot-group="Morphs"]'));
  assert.equal(await cards.count(), 13);
  await verifyAnatomyMotion(cards.locator('[data-bot-motion="radar"]'));
  await activate(studio.locator('[data-bot-state-card="radar"]'));
  await studio.getByTestId("bot-studio-trigger").getByText(/搜索/u).waitFor();
  await verifyAnatomyMotion(preview.locator('[data-bot-motion="radar"]'));
  await activate(studio.getByTestId("bot-studio-poke"));
  await activate(studio.getByTestId("bot-studio-replay"));
  if (screenshots) await studio.screenshot({ path: join(screenshots, `pet-gallery-${width}.png`) });
  await activate(studio.getByTestId("bot-studio-appearance-tab"));
}

export async function verifySavedAppearance(page) {
  const studio = page.getByTestId("conversation-pet-studio");
  await studio.locator('[data-pet-shape-option="cloud"][aria-pressed="true"]').waitFor();
  await studio.locator('[data-pet-color-option="#3289ff"][aria-pressed="true"]').waitFor();
  await studio.locator('[data-pet-size-option="large"][aria-pressed="true"]').waitFor();
  assert.equal(await page.getByTestId("bot-studio-followPointer").getAttribute("aria-checked"), "false");
}

export async function verifyPetPresence(page, pet, editor, activate) {
  const pose = (motion) => pet.locator(`[data-bot-engine="anatomy"][data-bot-motion="${motion}"]`);
  if (process.env.SELFHOST_ANATOMY_CLOCK_TEST && page.viewportSize().width > 600) {
    await page.clock.fastForward(12_300);
    await pose("showcase").waitFor();
    await page.clock.fastForward(56_300);
    await pose("sleeping").waitFor();
    await pet.getByRole("button").hover();
    await pose("waking").waitFor();
    await page.clock.fastForward(1_800);
  }
  await activate(pet.getByRole("button"));
  await pose("curious").waitFor();
  await activate(pet.getByRole("button"));
  await pose("playful").waitFor();
  await editor.focus();
  await Promise.all([pose("listening").waitFor(), page.keyboard.insertText("桌宠倾听")]);
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
}

export async function verifyAnatomyCatalogue(page) {
  const result = await page.evaluate(async () => {
    const source = document.querySelector('meta[name="codex-bot-anatomy"]').content;
    const { createBot, clips, lifecycleGroups, shapes } = await import(new URL(source, location.origin + "/"));
    const host = document.createElement("div");
    // SVG 的实体区域查询依赖布局。测试画布挂到屏幕外，避免干扰真实的设置页。
    host.style.cssText = "position:fixed;left:-10000px;top:0;pointer-events:none";
    host.setAttribute("aria-hidden", "true");
    document.body.append(host);
    const options = { size: 80, firstPhase: 0, frozenAt: 0, reducedMotion: false };
    const unplayed = [];
    for (const name of clips) {
      const player = createBot(host, { ...options, state: `clip:${name}` });
      await player.ready;
      const frame = player.el?.outerHTML;
      const loadedClip = player.clip;
      const step = Math.max(1, Math.floor(player.debugFrame()?.duration * 6 || 1));
      let changed = false;
      for (let sample = 0; sample < 10 && !changed; sample++) {
        player.step(step);
        changed = player.el?.outerHTML !== frame;
      }
      if (loadedClip !== name || !frame || !changed) unplayed.push(name);
      player.destroy();
    }
    const missing = [];
    for (const name of lifecycleGroups.flatMap((group) => group.states)) {
      const player = createBot(host, { ...options, state: name });
      await player.ready;
      if (player.state !== name || !player.el?.querySelector("g path[d]:not([d=''])")) {
        missing.push(name);
      }
      player.destroy();
    }
    const playlist = createBot(host, { ...options, state: "all" });
    await playlist.ready;
    const played = new Set();
    for (let sample = 0; sample < 250 && playlist.state === "all"; sample++) {
      played.add(playlist.clip);
      playlist.step(48);
    }
    playlist.destroy();
    const outlines = new Set();
    const cutoutErrors = [];
    const cutouts = (avatar) => {
      const body = avatar.el.querySelector("g path[mask]");
      if (!body) return [];
      const eyePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      return (avatar.el.querySelector("mask path").getAttribute("d")?.match(/M[^M]+/g) ?? []).map((d) => {
        eyePath.setAttribute("d", d);
        const length = eyePath.getTotalLength();
        return length > 0 && Array.from({ length: 36 }, (_, sample) =>
          body.isPointInFill(eyePath.getPointAtLength(length * sample / 36)),
        ).every(Boolean);
      });
    };
    for (const shape of shapes) {
      const player = createBot(host, { size: 32, state: "idle", shape, frontFacing: true, staticMode: true });
      await player.ready;
      const body = player.el?.querySelector('g path[fill-rule="evenodd"][d]:not([d=""])');
      if (body) outlines.add(body.getAttribute("d"));
      const eyes = shape === "sphere" ? body?.getAttribute("d").split("M").slice(2).map(Boolean) : cutouts(player);
      if (eyes?.length !== 2 || !eyes.every(Boolean)) cutoutErrors.push(`${shape}: frontal`);
      player.destroy();
    }
    for (const shape of ["cloud", "sparkle", "wedge", "crystal", "arch"]) {
      for (const state of ["working", "coding", "turntable"]) {
        const player = createBot(host, { ...options, state, shape });
        await player.ready;
        for (let sample = 0; sample < 30; sample++) {
          if (cutouts(player).includes(false)) {
            cutoutErrors.push(`${shape}: ${state}, frame ${sample * 12}`);
            break;
          }
          player.step(12);
        }
        player.destroy();
      }
    }
    host.remove();
    return { unplayed, missing, skipped: clips.filter((name) => !played.has(name)), shapes: outlines.size, cutoutErrors };
  });
  assert.deepEqual(result, { unplayed: [], missing: [], skipped: [], shapes: 25, cutoutErrors: [] });
}

export async function verifyBrandSettings(page, { activate, showTaskList, origin, threadId, anatomyEnabled }) {
  const mobile = page.viewportSize().width === 390;
  const pet = page.locator("[data-codex-pet]");
  const canvas = pet.locator("[data-codex-bot]");
  const dockedPet = pet.and(page.locator(`[data-pet-placement="${mobile ? "composer" : "rail"}"]`));
  const favicon = page.locator('link[rel="icon"]');
  const editor = page.getByTestId("v4-composer-input");
  await showTaskList();
  await activate(page.getByTestId("task-settings-button"));
  await activate(page.getByTestId("settings-search-open"));
  await page.getByTestId("settings-search-input").fill("桌宠");
  await activate(page.locator('[data-settings-search-result="settings.conversationPet"]'));
  await page.locator('[data-settings-search-id="settings.conversationPet"][data-settings-search-highlighted]').waitFor();
  const petToggle = page.getByRole("switch", { name: "桌宠", exact: true });
  assert.equal(await petToggle.getAttribute("aria-checked"), "true");
  if (anatomyEnabled) {
    await verifyMotionPreview(page, activate);
  }
  await activate(petToggle);
  assert.equal(await petToggle.getAttribute("aria-checked"), "false");
  await activate(page.locator('[data-settings-section-nav="appearance"]'));
  const themeSelect = page.locator('[data-settings-search-id="settings.themeMode"]').getByRole("combobox");
  await activate(themeSelect);
  await activate(page.getByRole("option", { name: "浅色", exact: true }));
  await page.waitForFunction(() =>
    document.querySelector('link[rel="icon"]')?.getAttribute("href")?.endsWith("codex-bot-light.svg?v=3"),
  );
  const lightIcon = await favicon.getAttribute("href");
  const lightSvg = await (await page.request.get(new URL(lightIcon, origin).href)).text();
  assert.match(lightSvg, /fill="#161616"/);
  if (anatomyEnabled) {
    assert.match(lightSvg, /viewBox="10 10 44 44"/);
    assert.equal(lightSvg.match(/M[\d.]+ /g)?.length, 3, "The tab icon shows two complete eye cutouts");
  }
  await page.reload({ waitUntil: "commit" });
  await editor.waitFor();
  assert.equal(await pet.count(), 0);
  await showTaskList();
  await activate(page.getByTestId("task-settings-button"));
  await activate(page.locator('[data-settings-section-nav="conversationPet"]'));
  if (anatomyEnabled) await verifySavedAppearance(page);
  assert.equal(await petToggle.getAttribute("aria-checked"), "false");
  await activate(petToggle);
  assert.equal(await petToggle.getAttribute("aria-checked"), "true");
  await activate(page.getByTestId("settings-back-button"));
  if (mobile) {
    const targetTask = page.getByTestId(`task-item-${threadId}`);
    await activate(targetTask);
  }
  await dockedPet.waitFor();
  assert.equal(await canvas.evaluate((node) => getComputedStyle(node).color), anatomyEnabled ? "rgb(50, 137, 255)" : "rgb(22, 22, 22)");
  if (anatomyEnabled) assert.equal(await canvas.getAttribute("data-bot-shape"), "cloud");
}
