// 自动化页跨项目共享上次选中的标签。自托管跟随账号，桌面保留窗口级偏好。
import { selfHostedBuild } from "@zcode/shared/runtimeEnv";
import { getBrowserLocalStorage, getBrowserSessionStorage } from "@/lib/browserEnvironment.js";
import type { AutomationsPageTab } from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";

const STORAGE_KEY = "zcode-automations-page-tab";

function storage(): Storage | null {
  try {
    return (selfHostedBuild ? getBrowserLocalStorage() : getBrowserSessionStorage()) ?? null;
  } catch {
    return null;
  }
}

export function readAutomationsPageTab(): AutomationsPageTab {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    return value === "workflow" ? "workflow" : "automation";
  } catch {
    return "automation";
  }
}

export function writeAutomationsPageTab(tab: AutomationsPageTab): void {
  try {
    storage()?.setItem(STORAGE_KEY, tab);
  } catch {
    // sessionStorage 不可用（隐私模式 / 配额）就不记；下次打开回到默认标签，不影响功能。
  }
}
