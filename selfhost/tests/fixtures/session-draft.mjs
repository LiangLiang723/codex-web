import assert from "node:assert/strict";

export async function verifyConversationDraftRoundTrip(
  page,
  { activate, showTaskList, mobile, editor, threadId, draftThreadId, submissions },
) {
  await editor.focus();
  await page.keyboard.insertText("管理页往返草稿");
  await showTaskList();
  await activate(page.getByTestId("plugin-store-sidebar-open"));
  const extensions = page.getByTestId("workspace-extensions");
  for (const section of ["plugins", "apps", "skills"]) {
    await activate(extensions.getByTestId(`workspace-extensions-${section}`));
    await extensions
      .getByTestId(`workspace-extensions-${section}`)
      .and(page.locator('[aria-pressed="true"]'))
      .waitFor();
  }
  await activate(extensions.getByRole("button", { name: "返回", exact: true }));
  if (mobile) await activate(page.getByTestId(`task-item-${threadId}`));
  await editor.getByText("管理页往返草稿", { exact: true }).waitFor();
  assert.equal(submissions.length, 2, "extension management must leave the draft unsent");
  for (const [id, draft, otherDraft] of [
    [draftThreadId, "会话二未发送草稿", "管理页往返草稿"],
    [threadId, "管理页往返草稿", "会话二未发送草稿"],
  ]) {
    await showTaskList();
    await activate(page.getByTestId(`task-item-${id}`));
    await page.waitForURL((url) => url.searchParams.get("thread") === id);
    await editor.getByText(draft, { exact: true }).waitFor();
    assert.equal(await editor.getByText(otherDraft).count(), 0, "Drafts stay with their conversation");
  }
  assert.equal(submissions.length, 2, "Switching conversations must keep both drafts unsent");
  await showTaskList();
  await activate(page.getByTestId("task-settings-button"));
  await activate(page.locator('[data-settings-section-nav="hooks"]'));
  await page.getByTestId("selfhost-settings-hooks").waitFor();
  await activate(page.getByTestId("settings-back-button"));
  if (mobile && !(await editor.isVisible())) {
    await activate(page.getByTestId(`task-item-${threadId}`));
  }
  await editor.getByText("管理页往返草稿", { exact: true }).waitFor();
  assert.equal(submissions.length, 2, "Returning from settings must keep the current draft unsent");
}
