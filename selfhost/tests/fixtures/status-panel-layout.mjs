import assert from "node:assert/strict";

export const statusTrigger = (page) =>
  page.getByTestId("workspace-header").getByRole("button", { name: "打开会话状态", exact: true });

export async function verifyHeaderStatusTrigger(page, expectedTitle) {
  const header = page.getByTestId("workspace-header");
  const title = header.getByTestId("workspace-title");
  await statusTrigger(page).waitFor();
  assert.equal(await title.getAttribute("title"), expectedTitle);
  const { width } = await header.boundingBox();
  assert((await title.boundingBox()).width >= Math.min(410, width * 0.54), "Long titles use the available header width");
  const button = await statusTrigger(page).boundingBox();
  const side = await header.getByTestId("side-pane-toggle").boundingBox();
  const terminal = header.getByTestId("terminal-toggle");
  const next = (await terminal.isVisible()) ? await terminal.boundingBox() : side;
  assert(button.x + button.width <= next.x, "The status button precedes the terminal or side pane action");
  assert(Math.abs(button.y + button.height / 2 - next.y - next.height / 2) <= 1);
}

export async function verifyTableInset(page, statusLeft) {
  const selector = "[data-markdown-table-virtual-scroll-track]";
  const track = page.locator(selector);
  const expand = page.getByRole("button", { name: "展开表格滚动区域", exact: true });
  await expand.waitFor();
  const before = await track.boundingBox();
  await expand.click();
  await page.waitForFunction(
    ({ selector, before }) => {
      const track = document.querySelector(selector);
      return (
        track &&
        track.getBoundingClientRect().width > before &&
        track.parentElement.getAnimations().every((animation) => animation.playState !== "running")
      );
    },
    { selector, before: before.width },
  );
  const box = await track.boundingBox();
  assert(
    box.x + box.width <= statusLeft,
    "The expanded table track must stop before the status panel",
  );
  await page.getByRole("button", { name: "收回表格滚动区域", exact: true }).click();
}
