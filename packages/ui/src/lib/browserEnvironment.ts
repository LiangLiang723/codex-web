export interface BrowserReadableStorageLike {
  getItem(key: string): string | null;
}

export interface BrowserStorageLike extends BrowserReadableStorageLike {
  setItem(key: string, value: string): void;
}

function getLocalStorageCandidate(): unknown {
  try {
    return typeof window !== "undefined"
      ? window.localStorage
      : typeof localStorage !== "undefined"
        ? localStorage
        : undefined;
  } catch {
    return undefined;
  }
}

function isBrowserReadableStorageLike(
  storage: unknown,
): storage is BrowserReadableStorageLike {
  return (
    Boolean(storage) &&
    typeof (storage as Partial<BrowserReadableStorageLike>).getItem === "function"
  );
}

function isBrowserStorageLike(storage: unknown): storage is BrowserStorageLike {
  return (
    isBrowserReadableStorageLike(storage) &&
    typeof (storage as Partial<BrowserStorageLike>).setItem === "function"
  );
}

export function getSafeReadableLocalStorage(): BrowserReadableStorageLike | null {
  const storage = getLocalStorageCandidate();

  if (!isBrowserReadableStorageLike(storage)) {
    return null;
  }

  return storage;
}

export function getSafeLocalStorage(): BrowserStorageLike | null {
  const storage = getLocalStorageCandidate();

  if (!isBrowserStorageLike(storage)) {
    return null;
  }

  return storage;
}

export function readSafeLocalStorage(key: string): string | null {
  try {
    return getSafeReadableLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeSafeLocalStorage(key: string, value: string): void {
  try {
    getSafeLocalStorage()?.setItem(key, value);
  } catch {
    // SSR/测试环境或隐私模式下 localStorage 可能存在但不可写。
    // 写入失败不应阻断 UI 渲染，真实偏好下次仍可从 settingService 或默认值恢复。
  }
}

export function readNavigatorLanguage(): string | null {
  if (typeof navigator === "undefined" || typeof navigator.language !== "string") {
    return null;
  }

  return navigator.language;
}

export async function writeBrowserClipboardText(text: string): Promise<void> {
  if (!text) throw new Error("No text to copy");

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }

  // 局域网 HTTP 不提供异步 Clipboard API。在原用户激活中处理同步 copy 事件，可保留当前焦点和选区。
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    throw new Error("Text clipboard is unavailable");
  }

  let suppliedText = false;
  const handleCopy = (event: ClipboardEvent) => {
    if (!event.isTrusted || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    event.stopImmediatePropagation();
    suppliedText = true;
  };
  document.addEventListener("copy", handleCopy, { capture: true, once: true });
  try {
    // WebKit 的命令返回值反映选区是否可复制，自定义文本由受信 copy 事件提交。
    document.execCommand("copy");
    if (!suppliedText) {
      throw new Error("Browser did not copy the text");
    }
  } finally {
    document.removeEventListener("copy", handleCopy, true);
  }
}
