import assert from "node:assert/strict";
import { verifyAnatomyMotion } from "./brand-motion.mjs";

async function verifyFullPetActionRound(page, pet) {
  const catalogue = await page.evaluate(async () => {
    const modulePath = document.querySelector('meta[name="codex-bot-anatomy"]').content;
    const { states, stateDurations } = await import(new URL(modulePath, location.origin + "/"));
    return { states: Object.keys(states), durations: stateDurations };
  });
  assert.equal(catalogue.states.length, 53);
  const action = pet.and(page.locator('[data-pet-reaction="spontaneous"]'));
  const played = [];
  // 采样短动作时固定虚拟时间，避免浏览器操作的耗时吃掉状态的完整窗口。
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  try {
    for (const _state of catalogue.states) {
      if ((await action.count()) === 0) await page.clock.fastForward(41_000);
      await page.clock.runFor(80);
      const { motion, drawing, reaction } = await pet.evaluate((node) => {
        const svg = node.querySelector('[data-bot-engine="anatomy"]');
        return {
          motion: svg?.getAttribute("data-bot-motion"),
          drawing: Boolean(svg?.querySelector("svg")),
          reaction: node.getAttribute("data-pet-reaction"),
        };
      });
      assert.equal(reaction, "spontaneous", `Expected autonomous action ${played.length + 1}, saw ${motion}`);
      assert(drawing, `${motion} did not mount the live renderer`);
      assert(!played.includes(motion), `${motion} repeated before the round finished`);
      played.push(motion);
      await page.clock.fastForward(catalogue.durations[motion] + 100);
      await action.waitFor({ state: "detached" });
    }
  } finally {
    await page.clock.resume();
  }
  assert.deepEqual(played.sort(), catalogue.states.sort());
  console.log("PASS all 53 native states in a live pet rotation");
}

export async function verifyBotStatus(page, pet, emit) {
  const fullRound = Boolean(process.env.SELFHOST_ALL_PET_ACTIONS) && page.viewportSize().width === 1236;
  const activityTurnId = "bot-activity-fixture";
  const activityUser = {
    id: "bot-activity-user",
    type: "userMessage",
    content: [{ type: "text", text: "检查 Bot 工作状态" }],
  };
  emit({
    type: "turn.started",
    turn: {
      id: activityTurnId,
      status: "inProgress",
      startedAt: Math.floor(Date.now() / 1000),
      items: [activityUser],
    },
  });
  const workingPet = pet.locator('[data-codex-bot="working"]');
  await workingPet.waitFor();
  const anatomyEnabled = (await page.locator('meta[name="codex-bot-anatomy"]').count()) === 1;
  await pet.locator("[data-bot-mirrored]").waitFor();
  const workingLine = page.locator("[data-chat-loading-icon]");
  await workingLine.locator('[data-codex-bot="working"]').waitFor();
  if (anatomyEnabled) {
    assert.equal(await workingLine.locator('[data-codex-bot="working"]').getAttribute("viewBox"), "0 0 20 20");
    await verifyAnatomyMotion(workingLine.locator('[data-bot-motion="progress"]'));
    await verifyAnatomyMotion(workingLine.locator('[data-bot-motion="working"]'));
    if (fullRound) {
      await verifyFullPetActionRound(page, pet);
      await page.clock.fastForward(41_000);
      await pet.and(page.locator('[data-pet-reaction="spontaneous"]')).waitFor();
    }
    if (process.env.SELFHOST_ANATOMY_CLOCK_TEST && !fullRound) {
      await page.clock.fastForward(27_000);
      await pet.and(page.locator('[data-pet-reaction="spontaneous"]')).waitFor();
      await workingLine.locator('[data-bot-motion="working"]').waitFor();
    }
  }
  await page
    .locator('[data-zcode-chat-loading-animate="true"]')
    .getByText("工作中", { exact: true })
    .waitFor();
  const reasoningItem = {
    id: "bot-activity-reasoning",
    turnId: activityTurnId,
    type: "reasoning",
    summary: ["正在核对当前分支"],
    status: "inProgress",
  };
  emit({ type: "timeline.item.upsert", item: reasoningItem });
  await page.locator('[data-summary-leading-icon][data-codex-bot="thinking"]').waitFor();
  const command = {
    id: "bot-activity-command",
    turnId: activityTurnId,
    type: "commandExecution",
    command: "printf fixture",
    status: "inProgress",
  };
  const computer = {
    id: "bot-activity-computer",
    turnId: activityTurnId,
    type: "mcpToolCall",
    server: "computer-use",
    tool: "mcp__plugin_zcode-cua_computer-use__get_app_state",
    status: "inProgress",
  };
  if (anatomyEnabled) {
    await pet.locator('[data-bot-engine="anatomy"][data-bot-motion="thinking"]').waitFor();
    assert.equal(await pet.and(page.locator('[data-pet-reaction="spontaneous"]')).count(), 0);
    await page.locator('[data-summary-leading-icon][data-bot-motion="curious"]').waitFor();
    emit({ type: "timeline.item.upsert", item: command });
    await pet.locator('[data-bot-engine="anatomy"][data-bot-motion="running"]').waitFor();
    emit({ type: "timeline.item.upsert", item: computer });
    await pet.locator('[data-bot-engine="anatomy"][data-bot-motion="controlling"]').waitFor();
  }
  const animatedDrawing = anatomyEnabled ? await workingPet.locator("svg").elementHandle() : null;
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (animatedDrawing) {
    // 媒体偏好切换后，先等旧播放器卸载，再采样静态绘制。
    await page.waitForFunction((node) => !node.isConnected, animatedDrawing);
  }
  const stayedStill = await workingPet
    .locator('path[fill="currentColor"][fill-rule="evenodd"]')
    .evaluate(async (path) => {
    await new Promise(requestAnimationFrame);
    const before = path.getAttribute("d");
    await new Promise(requestAnimationFrame);
    return path.getAttribute("d") === before;
    });
  assert(stayedStill);
  emit({
    type: "turn.completed",
    turn: {
      id: activityTurnId,
      status: "completed",
      items: [
        activityUser,
        reasoningItem,
        ...(anatomyEnabled
          ? [{ ...command, status: "completed" }, { ...computer, status: "completed" }]
          : []),
      ],
    },
  });
  await pet.locator('[data-codex-bot="idle"]').waitFor();
  if (anatomyEnabled) {
    await pet.locator('[data-bot-engine="anatomy"][data-bot-motion="finished"]').waitFor();
    if (fullRound) {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await verifyAnatomyMotion(pet.locator('[data-bot-engine="anatomy"]'));
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
      try {
        await page.clock.fastForward(90_000);
        await pet.locator('[data-bot-motion="sleeping"]').waitFor();
        await page.clock.fastForward(23_000);
        await pet.locator('[data-bot-motion="waking"]').waitFor();
        await page.clock.fastForward(1_800);
        await page.clock.fastForward(23_000);
        await pet.and(page.locator('[data-pet-reaction="spontaneous"]')).waitFor();
      } finally {
        await page.clock.resume();
      }
      console.log("PASS the full pool resumes after an idle nap");
    }
  }
}

async function verifyStartup(page, origin, reducedMotion) {
  await page.emulateMedia({ reducedMotion });
  const app = Promise.withResolvers();
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    await app.promise;
    await route.continue();
  });
  try {
    await page.goto(origin, { waitUntil: "commit" });
    const splash = page.locator(".zcode-boot-loading");
    await splash.waitFor();
    const anatomy = (await page.locator('meta[name="codex-bot-anatomy"]').count()) === 1;
    if (anatomy) {
      const mark = splash.locator('[data-bot-engine="anatomy"]');
      await mark.waitFor();
      assert.equal(await mark.getAttribute("data-bot-motion"), "idle");
      await mark.locator("svg path[d]").first().waitFor({ state: "attached" });
    }
    const frames = await splash.evaluate(async (element) => {
      const read = () => {
        const paths = Array.from(element.querySelectorAll("svg path[d]"));
        return paths.length
          ? JSON.stringify(paths.map((path) => path.getAttribute("d")))
          : getComputedStyle(element.querySelector(".zcode-boot-loading__logo")).transform;
      };
      const samples = new Set();
      const start = performance.now();
      while (performance.now() - start < 450) {
        await new Promise(requestAnimationFrame);
        samples.add(read());
      }
      return samples.size;
    });
    assert.equal(frames > 1, reducedMotion === "no-preference", "The initial splash follows motion preferences");
  } finally {
    app.resolve();
  }
  await page.locator(".zcode-boot-loading").waitFor({ state: "detached" });
}

export async function verifyBrowserStartup(browser, origin) {
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    try {
      await verifyStartup(page, origin, reducedMotion);
      console.log(`PASS idle startup splash (${reducedMotion})`);
    } finally {
      await page.close();
    }
  }
}

export async function verifyCompactPet(pane) {
  const pet = pane.locator('[data-codex-pet][data-pet-placement="composer"]');
  await pet.waitFor();
  const anchor = pane.locator('[data-codex-pet-anchor="composer"]');
  const dock = pane.locator("[data-v4-composer-dock-content]");
  const transition = pane.getByTestId("conversation-bottom-dock-transition");
  const [slot, dockBox, transitionBox] = await Promise.all(
    [anchor, dock, transition].map((element) => element.boundingBox()),
  );
  assert.equal(await anchor.evaluate((element) => getComputedStyle(element).position), "static");
  assert(slot.height > 0 && Math.abs(dockBox.height - transitionBox.height - slot.height) <= 1);
  assert(Math.abs(slot.y + slot.height - transitionBox.y) <= 1, "The compact pet has its own row above the dock");
  assert(slot.x + slot.width <= dockBox.x + dockBox.width, "The pet is at the upper right of the dock");
}

export async function verifyReadOnlyPet(pane, placement) {
  await pane.getByText("另一会话内容", { exact: true }).waitFor();
  const notice = pane.getByTestId("v4-workspace-readonly-notice");
  await notice.getByText(/此会话由另一端持有/).waitFor();
  assert.equal(await pane.getByTestId("v4-composer-input").count(), 0);
  assert(await notice.getByRole("button", { name: "重新连接", exact: true }).isEnabled());
  if (placement === "composer") await verifyCompactPet(pane);
  else await pane.locator('[data-codex-pet][data-pet-placement="rail"]').waitFor();
  assert.equal(await pane.locator("[data-codex-pet]").count(), 1);
}
