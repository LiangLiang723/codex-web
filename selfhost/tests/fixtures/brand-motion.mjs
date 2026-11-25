import assert from "node:assert/strict";

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
  const preview = page.getByTestId("bot-motion-preview");
  const summary = preview.locator("summary");
  await activate(summary);
  const motion = preview.getByTestId("bot-motion-select");
  const avatar = preview.locator("[data-codex-bot]");
  assert.equal(await motion.locator('option[value^="clip:"]').count(), 28);
  assert.equal(await motion.locator('option[value^="state:"]').count(), 53);
  await motion.selectOption("clip:Rotation_B");
  await verifyAnatomyMotion(avatar.and(page.locator('[data-bot-motion="clip:Rotation_B"]')));
  await motion.selectOption("all");
  await verifyAnatomyMotion(avatar.and(page.locator('[data-bot-motion="all"]')));
  await activate(summary);
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
    const { createBot, clips, lifecycleGroups } = await import(new URL(source, location.origin + "/"));
    const host = document.createElement("div");
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
    return { unplayed, missing, skipped: clips.filter((name) => !played.has(name)) };
  });
  assert.deepEqual(result, { unplayed: [], missing: [], skipped: [] });
}
