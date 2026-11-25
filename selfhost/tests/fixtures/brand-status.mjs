import assert from "node:assert/strict";

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
  const workingLine = page.locator("[data-chat-loading-icon]");
  await workingLine.locator('[data-codex-bot="working"]').waitFor();
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stayedStill = await workingPet.locator("path").evaluate(async (path) => {
    await new Promise(requestAnimationFrame);
    const before = path.getAttribute("d");
    await new Promise(requestAnimationFrame);
    return path.getAttribute("d") === before;
  });
  assert(stayedStill);
  emit({
    type: "turn.completed",
    turn: { id: activityTurnId, status: "completed", items: [activityUser, reasoningItem] },
  });
  await pet.locator('[data-codex-bot="idle"]').waitFor();
}
