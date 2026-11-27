import { createError, type H3Event } from "h3";
import { requireAuthenticatedUser } from "./gateway/auth/context";
import { decryptJson, encryptJson, hashToken } from "./gateway/storage/crypto";
import { gatewayDatabase, withGatewayDatabaseTransaction } from "./gateway/storage/database";
import { settingsFor, updateSettings } from "./selfhost-settings";

const localeKey = "zcode-locale-preference";
const locales = new Set(["zh-CN", "en-US", "ja-JP", "ko-KR", "ru-RU"]);
const loginScopedKeys = new Set(["zcode-v4-client-id:v1", "zcode-v4-pending-commands:v1"]);

export function isBrowserStateKey(key: string) {
  return /^(?:zcode[-.:]|codex-web:|react-resizable-panels:)/u.test(key);
}

function table() {
  const db = gatewayDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS zcode_browser_state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      session_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE,
      key TEXT NOT NULL,
      encrypted_value TEXT,
      PRIMARY KEY (user_id, namespace, key)
    )
  `);
  return db;
}

export function browserStateFor(event: H3Event) {
  const { id } = requireAuthenticatedUser(event);
  const hash = hashToken(event.context.auth!.token);
  const rows = table().prepare(
    "SELECT key, encrypted_value FROM zcode_browser_state WHERE user_id=? AND namespace IN ('', ?) AND encrypted_value IS NOT NULL",
  ).all(id, hash);
  const state = Object.fromEntries(
    rows.map(({ key, encrypted_value }) => [String(key), decryptJson(String(encrypted_value))]),
  );
  const settings = settingsFor(event);
  // 语言只有一个持久化写入方，浏览器启动快照只投影现有账号设置。
  const locale = settings.localePreference ?? settings.locale;
  if (typeof locale === "string" && (locale === "system" || locales.has(locale))) {
    state[localeKey] = locale;
    if (typeof settings.locale === "string" && locales.has(settings.locale))
      state["zcode-locale"] = settings.locale;
  }
  return state;
}

export function writeBrowserState(
  event: H3Event,
  changes: Array<[string, string | null]>,
  importLegacy: boolean,
) {
  const { id } = requireAuthenticatedUser(event);
  const hash = hashToken(event.context.auth!.token);
  table();
  withGatewayDatabaseTransaction((db) => {
    // 请求体读取期间可能发生退出或密码变更，写入时复检原会话。
    if (!db.prepare(
      "SELECT 1 FROM sessions WHERE user_id=? AND token_hash=? AND expires_at>?",
    ).get(id, hash, new Date().toISOString())) {
      throw createError({ statusCode: 401, message: "登录已失效" });
    }
    const put = db.prepare(
      "INSERT INTO zcode_browser_state(user_id,namespace,session_hash,key,encrypted_value) VALUES(?,?,?,?,?) " +
      (importLegacy
        ? "ON CONFLICT(user_id,namespace,key) DO NOTHING"
        : "ON CONFLICT(user_id,namespace,key) DO UPDATE SET encrypted_value=excluded.encrypted_value"),
    );
    for (const [key, value] of changes) {
      if (key === localeKey || key === "zcode-locale") continue;
      const session = loginScopedKeys.has(key) ? hash : null;
      put.run(id, session ?? "", session, key, value === null ? null : encryptJson(value));
    }
  });
  if (importLegacy) {
    const legacy = new Map(changes);
    const preference = legacy.get(localeKey);
    if (preference && (preference === "system" || locales.has(preference))) {
      const resolved = legacy.get("zcode-locale");
      updateSettings(
        event,
        {
          localePreference: preference,
          locale: preference === "system"
            ? resolved && locales.has(resolved) ? resolved : "zh-CN"
            : preference,
        },
        ["localePreference", "locale"],
      );
    }
    return browserStateFor(event);
  }
  return {};
}
