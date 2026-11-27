import assert from "node:assert/strict";
import { verifyAnatomyMotion } from "./brand-motion.mjs";
import { verifyPaintedBots } from "./brand-materials.mjs";
import { browserStateFixture } from "./browser-state.mjs";

export async function prepareStatusBrowserPage(page) {
  const allActions = Boolean(process.env.SELFHOST_ALL_PET_ACTIONS);
  const styled = Boolean(process.env.SELFHOST_BOT_MATERIALS_TEST);
  // 在页面安装桌宠计时器前统一时钟，保证进入工作状态时能取消之前的空闲计时器。
  if (process.env.SELFHOST_ANATOMY_CLOCK_TEST || (allActions && page.viewportSize().width === 1236)) {
    await page.clock.install();
  }
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "status-test-fixture");
  });
  return browserStateFixture({
    "zcode-locale-preference": "zh-CN",
    "codex-web:conversation-pet-preferences": JSON.stringify({
      allActions,
      ...(styled ? { material: "fluffy", color: "#c74ef3" } : {}),
    }),
  });
}

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
  const styled = anatomyEnabled && process.env.SELFHOST_BOT_MATERIALS_TEST;
  await pet.locator("[data-bot-mirrored]").waitFor();
  const workingLine = page.locator("[data-chat-loading-icon]");
  await workingLine.locator('[data-codex-bot="working"]').waitFor();
  if (anatomyEnabled) {
    assert.equal(await workingLine.locator('[data-codex-bot="working"]').getAttribute("viewBox"), "0 0 20 20");
    await verifyAnatomyMotion(workingLine.locator('[data-bot-motion="progress"]'));
    await verifyAnatomyMotion(workingLine.locator('[data-bot-motion="working"]'));
    if (styled) {
      await verifyPaintedBots(workingLine, "fluffy", 1, "#c74ef3");
      await verifyPaintedBots(pet, "fluffy", 1, "#c74ef3");
    }
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
    summary: [],
    startedAtMs: 1000,
    status: "inProgress",
  };
  emit({ type: "timeline.item.upsert", item: reasoningItem });
  const nativeCaption = "Checking App Server watch APIs";
  emit({
    type: "timeline.item.delta",
    turnId: activityTurnId,
    itemId: reasoningItem.id,
    channel: "reasoningSummary",
    summaryIndex: 0,
    delta: "**" + nativeCaption + "**",
  });
  const thinking = page.locator('[data-summary-leading-icon][data-codex-bot="thinking"]');
  await thinking.waitFor();
  await page.getByText(nativeCaption, { exact: true }).waitFor();
  if (anatomyEnabled) await verifyAnatomyMotion(thinking);
  if (styled) await verifyPaintedBots(thinking, "fluffy", 1, "#c74ef3");
  const command = {
    id: "bot-activity-command",
    turnId: activityTurnId,
    type: "commandExecution",
    command: "printf fixture",
    status: "inProgress",
    startedAtMs: 6000,
    commandActions: ["status-panel.mjs", "status-panel.mjs", "brand-status.mjs", "BotActivity.tsx"].map(
      (name) => ({ type: "read", name, path: "/fixture/" + name, command: "cat " + name }),
    ),
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
  }
  const completedReasoning = {
    ...reasoningItem,
    summary: ["**" + nativeCaption + "**"],
    completedAtMs: 5800,
    status: "completed",
  };
  emit({ type: "timeline.item.upsert", item: completedReasoning });
  await page.getByText(/持续了.*5.*秒/).waitFor();
  await page.getByText("正在思考", { exact: true }).waitFor({ state: "hidden" });
  emit({ type: "timeline.item.upsert", item: {
    ...completedReasoning,
    id: "bot-activity-reasoning-next",
    summary: ["Checking gallery card selection"],
  } });
  const group = page.locator("[data-consecutive-summary-group]").filter({
    hasText: "Checking gallery card selection",
  });
  const groupTrigger = group.locator("[data-summary-group-trigger]");
  await groupTrigger.locator('[data-codex-bot="thinking"]').waitFor();
  await groupTrigger.click();
  await groupTrigger.locator('[data-codex-bot="thinking"]').waitFor();
  assert.equal(await groupTrigger.locator(".lucide-brain").count(), 0);
  emit({ type: "timeline.item.upsert", item: command });
  const reads = group.locator("[data-native-command-action]");
  await reads.last().waitFor();
  assert.deepEqual(await reads.allTextContents(), [
    "正在读取 status-panel.mjs",
    "正在读取 status-panel.mjs",
    "正在读取 brand-status.mjs",
    "正在读取 BotActivity.tsx",
  ]);
  if (anatomyEnabled) {
    await pet.locator('[data-bot-engine="anatomy"][data-bot-motion="running"]').waitFor();
  }
  const completedCommand = { ...command, status: "completed", completedAtMs: 8000, aggregatedOutput: "fixture command stdout" };
  emit({ type: "timeline.item.upsert", item: completedCommand });
  await group.locator("[data-native-command-duration]").getByText("2 秒", { exact: true }).waitFor();
  await reads.filter({ hasText: "已读取 BotActivity.tsx" }).waitFor();
  await group.getByTestId(`tool-summary-trigger-${command.id}`).click();
  await group.getByTestId("execute-detail").getByText("fixture command stdout", { exact: true }).waitFor();
  if (anatomyEnabled) {
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
    .locator('path[fill-rule="evenodd"][d]:not([d=""])').first()
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
        completedReasoning,
        completedCommand,
        ...(anatomyEnabled ? [{ ...computer, status: "completed" }] : []),
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
  let anatomy;
  try {
    await page.goto(origin, { waitUntil: "commit" });
    const splash = page.locator(".zcode-boot-loading");
    await splash.waitFor();
    anatomy = (await page.locator('meta[name="codex-bot-anatomy"]').count()) === 1;
    if (anatomy) {
      const mark = splash.locator('[data-bot-engine="anatomy"]');
      await mark.waitFor();
      assert.equal(await mark.getAttribute("data-bot-motion"), "idle");
      await mark.locator("svg path[d]").first().waitFor({ state: "attached" });
    }
    const frames = await splash.evaluate(async (element, reduced) => {
      const read = () => {
        const paths = Array.from(element.querySelectorAll("svg path[d]"));
        return paths.length
          ? JSON.stringify(paths.map((path) => path.getAttribute("d")))
          : getComputedStyle(element.querySelector(".zcode-boot-loading__logo")).transform;
      };
      const samples = new Set();
      const start = performance.now();
      // 原生 idle 有停顿，软件渲染的浏览器还要等第一次材质上传。
      while (performance.now() - start < (reduced ? 500 : 3_000)) {
        await new Promise(requestAnimationFrame);
        samples.add(read());
        if (!reduced && samples.size > 1) break;
      }
      return samples.size;
    }, reducedMotion === "reduce");
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
