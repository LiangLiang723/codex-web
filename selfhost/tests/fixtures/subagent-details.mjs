import assert from "node:assert/strict";

const sessionPane = (page, id) =>
  page.locator(`[data-v4-conversation-drop-target][data-session-id="${id}"]`);
const faceColor = (locator) =>
  locator
    .locator("[data-subagent-avatar]")
    .evaluate((face) => face.style.getPropertyValue("--wf-face-body"));

export async function verifyChildDetails(page, child) {
  const childPane = sessionPane(page, child.id);
  await childPane.getByText("子智能体的原生结果", { exact: true }).waitFor();
  const metadata = childPane.getByTestId("selfhost-subagent-model");
  await metadata.getByText(child.model, { exact: true }).waitFor();
  await metadata.getByText("推理强度 高", { exact: true }).waitFor();
  assert.equal(await childPane.locator('[contenteditable="true"]').count(), 0);
  const laterTurn = childPane.locator('section[data-turn-id="child-followup-turn"]');
  assert.ok(
    await laterTurn.evaluate((turn) => parseFloat(getComputedStyle(turn).paddingTop) <= 20),
  );
}

export async function verifySubagentDirectory({
  page,
  status,
  timeline,
  child,
  archive,
  screenshotPath,
}) {
  const statusRow = status.getByRole("button", { name: /项目审阅/ });
  const childColor = await faceColor(statusRow);
  archive.release();
  await timeline.hover({ position: { x: 56, y: 100 } });
  await page.mouse.wheel(0, -20_000);
  await page
    .getByText(archive.text, { exact: true })
    .waitFor()
    .catch((cause) => {
      throw Error(`Older timeline response sent: ${archive.delivered()}`, { cause });
    });
  const directoryTab = page.locator("[data-side-pane-tab-id]").filter({ hasText: "子智能体目录" });
  await status.getByRole("button", { name: "子智能体目录", exact: true }).click();
  const directory = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^已结束/ }) });
  const loadMore = directory.getByRole("button", { name: "再显示 20 个", exact: true });
  await loadMore.waitFor();
  const count = directory.getByRole("heading", {
    name: `已结束 · ${archive.children.length + 1}`,
    exact: true,
  });
  await count.waitFor();
  const directoryRow = directory.getByRole("button", { name: /^项目审阅/ });
  assert.equal(await faceColor(directoryRow), childColor);
  assert.notEqual(
    await faceColor(directory.getByRole("button", { name: /^历史子智能体 22/ })),
    childColor,
  );
  await loadMore.click();
  await loadMore.waitFor({ state: "hidden" });
  assert.equal(
    await directory.locator("[data-subagent-avatar]").count(),
    archive.children.length + 1,
  );
  await count.waitFor();
  await directoryRow.click();
  await verifyChildDetails(page, child);
  assert.equal(
    await faceColor(page.locator("[data-side-pane-tab-id]").filter({ hasText: "项目审阅" })),
    childColor,
  );
  if (screenshotPath)
    await page.screenshot({
      path: screenshotPath,
      animations: "disabled",
    });

  await directoryTab.click();
  const oldChild = archive.children.at(-1);
  await directory.getByRole("button", { name: new RegExp(`^${oldChild.name}`) }).click();
  const oldMetadata = sessionPane(page, oldChild.id).getByTestId("selfhost-subagent-model");
  await oldMetadata.getByText("未知模型", { exact: true }).waitFor();
  await oldMetadata.getByText("推理档位暂不可用", { exact: true }).waitFor();
}
