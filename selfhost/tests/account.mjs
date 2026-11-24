import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// 调用方在隔离实例创建一次性账号，同一用户的两个登录验证 WebSocket 撤销。
export async function verifyAccount(browser, base, username, password) {
  assert(username.startsWith("qa-"), "Account rotation requires a disposable qa- user");
  const name = "qa-" + randomUUID();
  const newPassword = randomUUID();
  const first = await browser.newContext(),
    second = await browser.newContext();
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
    await dialog.getByLabel("用户名", { exact: true }).fill(name);
    await dialog.getByLabel("当前密码").fill(randomUUID());
    await dialog.getByRole("button", { name: "保存" }).click();
    await dialog.getByRole("alert").waitFor();
    if (process.env.SELFHOST_TEST_CONFLICT_USER) {
      await dialog
        .getByLabel("用户名", { exact: true })
        .fill(process.env.SELFHOST_TEST_CONFLICT_USER);
      await dialog.getByLabel("当前密码").fill(password);
      await dialog.getByRole("button", { name: "保存" }).click();
      await dialog.getByText("该用户名已被使用", { exact: true }).waitFor();
      await dialog.getByLabel("用户名", { exact: true }).fill(name);
    }
    await dialog.getByLabel("当前密码").fill(password);
    await dialog.getByLabel("新密码", { exact: true }).fill(newPassword);
    await dialog.getByLabel("确认新密码").fill(newPassword);
    await dialog.getByRole("button", { name: "保存" }).click();
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
    await edit.getByRole("button", { name: "保存" }).click();
    await a.getByRole("button", { name: "登录", exact: true }).waitFor();
    await login(a, username, newPassword);
    await a.getByRole("button", { name: "账号设置" }).click();
    await edit.getByLabel("当前密码").fill(newPassword);
    await edit.getByLabel("新密码", { exact: true }).fill(password);
    await edit.getByLabel("确认新密码").fill(password);
    await edit.getByRole("button", { name: "保存" }).click();
    await a.getByRole("button", { name: "登录", exact: true }).waitFor();
    await login(a, username, password);
    console.log(
      "Account rename, password change, combined change, collision and revocation passed",
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}
