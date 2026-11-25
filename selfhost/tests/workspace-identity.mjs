import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function verifyWorkspaceIdentity({ page, browser, base, hostId, cwd, login, api }) {
  const host = (await api(page, "/api/hosts")).find((row) => row.id === hostId);
  assert(host.name.startsWith("QA "), "Use a disposable QA host for appearance changes");
  const remote = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const name = "QA " + randomUUID().slice(0, 8);
  const card = (label) =>
    page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: label, exact: true }) });
  try {
    const other = await remote.newPage();
    await login(other);
    await other.goto(base + "/?" + new URLSearchParams({ host: String(hostId), cwd }));
    const footer = other.getByTestId("login-trigger").filter({ visible: true }).first();
    await footer.waitFor();
    assert.equal(await footer.getAttribute("aria-label"), "账号设置");
    await card(host.name).getByRole("button", { name: "进入工作区", exact: true }).click();
    await page.getByTestId("login-trigger").filter({ visible: true }).first().waitFor();
    await page.goto(base + "/?manage=1");
    await card(host.name).getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("input[name=name]").fill(name);
    await dialog.getByRole("button", { name: "高级选项" }).click();
    await dialog.getByRole("radio", { name: "终端", exact: true }).locator("..").click();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await other
      .getByTestId("selfhost-workspaces-open")
      .locator('[data-workspace-avatar="terminal"]')
      .waitFor();
    await card(name).getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.getByRole("button", { name: "高级选项" }).click();
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 4;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#227799";
      ctx.fillRect(0, 0, 4, 4);
      return c.toDataURL().split(",")[1];
    });
    await dialog.locator("input[type=file]").setInputFiles({
      name: "test.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await dialog.locator('[data-workspace-avatar="image"]').waitFor();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    const workspaces = other.getByTestId("selfhost-workspaces-open");
    await workspaces.locator('[data-workspace-avatar="image"] img').waitFor();
    await other.reload();
    await workspaces.locator('[data-workspace-avatar="image"] img').waitFor();
    await workspaces.click();
    await other
      .getByTestId("selfhost-ssh-catalog")
      .getByRole("button", { name: "编辑" })
      .first()
      .click();
    const edit = other.getByTestId("selfhost-ssh-host-form");
    assert.equal(await edit.locator("input[name=name]").inputValue(), name);
    await edit.getByRole("button", { name: "取消" }).click();
    await other.keyboard.press("Escape");
    await footer.click();
    await other.getByRole("menuitem", { name: "账号设置" }).click();
    await other.getByRole("dialog").getByLabel("当前密码").waitFor();
  } finally {
    const original = Object.fromEntries(
      [
        "name",
        "sshHost",
        "username",
        "port",
        "authMode",
        "hostKeyType",
        "hostKeyFingerprint",
        "privateKeyPath",
        "proxyUrl",
      ]
        .filter((k) => k in host)
        .map((k) => [k, host[k]]),
    );
    await page.evaluate(
      async ({ id, data }) => {
        const response = await fetch("/api/hosts/" + id, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + localStorage.getItem("selfhost.auth"),
          },
          body: JSON.stringify(data),
        });
        if (!response.ok) throw Error("Failed to restore QA appearance");
      },
      { id: hostId, data: { ...original, avatar: host.avatar ?? "server" } },
    );
    await remote.close();
  }
}
