import assert from "node:assert/strict";
import { verifyAnatomyMotion } from "./brand-motion.mjs";

export async function verifyBotStatus(page, pet, emit) {
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
  const workingLine = page.locator("[data-chat-loading-icon]");
  await workingLine.locator('[data-codex-bot="working"]').waitFor();
  if (anatomyEnabled) {
    assert.equal(await workingLine.locator('[data-codex-bot="working"]').getAttribute("viewBox"), "0 0 20 20");
    await verifyAnatomyMotion(workingLine.locator('[data-bot-motion="progress"]'));
    await verifyAnatomyMotion(workingLine.locator('[data-bot-motion="working"]'));
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
    await page.locator('[data-summary-leading-icon][data-bot-motion="curious"]').waitFor();
    emit({ type: "timeline.item.upsert", item: command });
    await pet.locator('[data-bot-engine="anatomy"][data-bot-motion="running"]').waitFor();
    emit({ type: "timeline.item.upsert", item: computer });
    await pet.locator('[data-bot-engine="anatomy"][data-bot-motion="controlling"]').waitFor();
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
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
  }
}
