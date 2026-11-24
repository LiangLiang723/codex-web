import assert from "node:assert/strict";

// 仅响应明确指定的测试 Thread 和测试服务。不能自动处理用户会话中的请求。
export async function verifyElicitation(
  page,
  { base, hostId, cwd, thread, action, mode = "form" },
) {
  assert(["accept", "decline", "cancel"].includes(action));
  const sent = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      const value = JSON.parse(frame.payload);
      if (value.type === "serverRequest.respond") sent.push(value);
    }),
  );
  await page.goto(base + "/?" + new URLSearchParams({ host: String(hostId), cwd, thread }));
  const form = page.getByTestId("codex-mcp-elicitation");
  await form.getByText("ZCode approval check", { exact: true }).waitFor({ timeout: 60000 });
  // 首次展示后重开同一 Thread，必须仍然由该原生请求受理决定。
  await page.reload();
  await form.getByText("ZCode approval check", {exact:true}).waitFor({timeout:45000});
  if (mode === "url")
    assert.equal(await form.getByRole("link").getAttribute("href"), "https://example.org/");
  else if (action === "accept") await form.getByLabel("Count").fill("7");
  await form
    .getByRole("button", {
      name: { accept: "确认", decline: "拒绝", cancel: "取消" }[action],
      exact: true,
    })
    .click();
  await form.waitFor({ state: "hidden", timeout: 45000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, thread);
  assert.equal(sent[0].result.action, action);
  assert.deepEqual(
    sent[0].result.content,
    action === "accept" && mode !== "url" ? { count: 7 } : null,
  );
}
