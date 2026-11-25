import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// 调用方在隔离实例创建一次性账号，同一用户的两个登录验证 WebSocket 撤销。
export async function verifyAccount(browser, base, username, password) {
  assert(username.startsWith("qa-"), "Account rotation requires a disposable qa- user");
  const name = "qa-" + randomUUID();
  const newPassword = randomUUID();
  const first = await browser.newContext({ locale: "zh-CN" }),
    second = await browser.newContext({ locale: "zh-CN" });
  async function login(page, user, secret) {
    await page.goto(base + "/?manage=1");
    await page.locator("input[name=username]").fill(user);
    await page.locator("input[name=password]").fill(secret);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "账号设置" }).waitFor();
  }
  try {
    const a = await first.newPage(),
      b = await second.newPage();
    await Promise.all([login(a, username, password), login(b, username, password)]);
    await a.getByRole("button", { name: "账号设置" }).click();
    const dialog = a.getByRole("dialog");
    const png = await a.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 4;
      const context = canvas.getContext("2d");
      context.fillStyle = "#7654c9";
      context.fillRect(0, 0, 4, 4);
      return canvas.toDataURL().split(",")[1];
    });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "invalid.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg/>"),
    });
    await dialog.getByRole("alert").waitFor();
    assert(await dialog.getByRole("button", { name: "保存头像", exact: true }).isDisabled());
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await dialog.getByRole("button", { name: "保存头像", exact: true }).click();
    await dialog.getByText("头像已保存", { exact: true }).waitFor();
    await b.reload({ waitUntil: "commit" });
    await b.getByRole("button", { name: "账号设置" }).click();
    await b.getByRole("dialog").locator('[data-workspace-avatar="image"] img').waitFor();
    await b.getByRole("button", { name: "恢复默认头像", exact: true }).click();
    await b.getByRole("button", { name: "保存头像", exact: true }).click();
    await b.getByText("头像已保存", { exact: true }).waitFor();
    await b.keyboard.press("Escape");

    await dialog.getByLabel("用户名", { exact: true }).fill(name);
    await dialog.getByLabel("当前密码").fill(randomUUID());
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    if (process.env.SELFHOST_TEST_CONFLICT_USER) {
      await dialog
        .getByLabel("用户名", { exact: true })
        .fill(process.env.SELFHOST_TEST_CONFLICT_USER);
      await dialog.getByLabel("当前密码").fill(password);
      await dialog.getByRole("button", { name: "保存", exact: true }).click();
      await dialog.getByText("该用户名已被使用", { exact: true }).waitFor();
      await dialog.getByLabel("用户名", { exact: true }).fill(name);
    }
    await dialog.getByLabel("当前密码").fill(password);
    await dialog.getByLabel("新密码", { exact: true }).fill(newPassword);
    await dialog.getByLabel("确认新密码").fill(newPassword);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    for (const page of [a, b])
      await page.getByRole("button", { name: "登录", exact: true }).waitFor();
    const old = await first.request.post(base + "/api/auth/login", {
      data: { username, password },
    });
    assert.equal(old.status(), 401);
    await login(a, name, newPassword);
    await a.getByRole("button", { name: "账号设置" }).click();
    assert.equal(
      await a.getByRole("dialog").getByLabel("用户名", { exact: true }).inputValue(),
      name,
    );
    const edit = a.getByRole("dialog");
    await edit.getByLabel("用户名", { exact: true }).fill(username);
    await edit.getByLabel("当前密码").fill(newPassword);
    await edit.getByRole("button", { name: "保存", exact: true }).click();
    await a.getByRole("button", { name: "登录", exact: true }).waitFor();
    await login(a, username, newPassword);
    await a.getByRole("button", { name: "账号设置" }).click();
    await edit.getByLabel("当前密码").fill(newPassword);
    await edit.getByLabel("新密码", { exact: true }).fill(password);
    await edit.getByLabel("确认新密码").fill(password);
    await edit.getByRole("button", { name: "保存", exact: true }).click();
    await a.getByRole("button", { name: "登录", exact: true }).waitFor();
    await login(a, username, password);
    console.log(
      "Account avatar upload, isolated sessions, reload, reset, credential changes and revocation passed",
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}
