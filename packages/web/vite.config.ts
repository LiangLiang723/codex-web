import { createHash } from "node:crypto";
import { build as bundleGatewayProtocol } from "esbuild";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { parse as parseYaml } from "yaml";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
import { resolveRemoteFrontendVersion } from "./vite/remoteFrontendVersion.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version, zcodeCompatibility } = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
) as { version: string; zcodeCompatibility?: { minCompatibleVersion?: string } };
const minCompatibleVersion = zcodeCompatibility?.minCompatibleVersion ?? version;
const resolveDependency = createRequire(import.meta.url).resolve;
const fontAwesomePrefixes = { solid: "fas", regular: "far", brands: "fab" } as const;

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export default defineConfig(({ mode, command }) => {
  // `.env*` 只提供链接常量；当前产品环境由启动脚本或 CI 注入 ZCODE_ENV。
  // 启动脚本通过 process.env 显式选择 test/production；它必须优先于 .env 文件，
  // 否则 share:test 可能被 mode 的旧配置误解析到错误 endpoint。
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);

  return {
    plugins: [
      ...[
        {
          name: "selfhost-web-entry",
          resolveId(id: string) {
            if (id === "virtual:selfhost-locale-messages") return "\0selfhost-locale-messages.js";
            if (id === "virtual:zcode-projection-state") return "\0zcode-projection-state.js";
            if (id === "virtual:gateway-terminal-stream") return "\0gateway-terminal-stream.js";
            if (id === "virtual:selfhost-workspace-icons") return "\0selfhost-workspace-icons.js";
          },
          async load(id: string) {
            if (id === "\0selfhost-locale-messages.js") return "export const LOCALE_MESSAGES = {};";
            if (id === "\0selfhost-workspace-icons.js") {
              const metadata = parseYaml(
                await readFile(
                  resolveDependency("@fortawesome/fontawesome-free/metadata/icons.yml"),
                  "utf8",
                ),
              ) as Record<
                string,
                {
                  label: string;
                  styles: (keyof typeof fontAwesomePrefixes)[];
                  search: { terms: string[] };
                }
              >;
              // Tabby 也按 Font Awesome 的样式生成类名，浏览器只需要类名与搜索字段。
              const icons = Object.entries(metadata).flatMap(([name, icon]) =>
                icon.styles.map((style) => [
                  `${fontAwesomePrefixes[style]} fa-${name}`,
                  icon.label,
                  icon.search.terms.join(" "),
                ]),
              );
              return `export default ${JSON.stringify(icons)};`;
            }
            if (id === "\0zcode-projection-state.js") {
              const path = resolve(
                REPO_ROOT,
                "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-state.ts",
              );
              const module = await bundleGatewayProtocol({
                entryPoints: [path],
                tsconfigRaw: {},
                bundle: true,
                platform: "browser",
                format: "esm",
                write: false,
              });
              return module.outputFiles[0].text;
            }
            if (id !== "\0gateway-terminal-stream.js") return;
            const dir = resolve(__dirname, "../../upstream/codex-gateway");
            const built = await bundleGatewayProtocol({
              stdin: {
                contents:
                  'export * from "./shared/runtime/terminal-stream"; export {applyCanonicalEventToHistory} from "./shared/thread-history/canonical-events"; export {timelinePageToTurns} from "./shared/thread-history/app-server-timeline"; export {mergeThreadTurns} from "./shared/thread-history/turns";',
                resolveDir: dir,
              },
              alias: { "~~": dir },
              tsconfigRaw: {},
              platform: "browser",
              format: "esm",
              bundle: true,
              write: false,
            });
            return built.outputFiles[0].text;
          },
          transformIndexHtml: {
            order: "pre" as const,
            handler: (html: string) => {
              if (command !== "build") return html;
              const scripts = Array.from(
                html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
                (match) =>
                  "'sha256-" + createHash("sha256").update(match[1]).digest("base64") + "'",
              );
              const policy = [
                "default-src 'self'",
                "connect-src 'self'",
                "script-src 'self' 'wasm-unsafe-eval' " + scripts.join(" "),
                "worker-src 'self' blob:",
                "style-src 'self' 'unsafe-inline'",
                "font-src 'self' data:",
                "img-src 'self' data: blob: https:",
                "media-src 'self' blob: data:",
                "frame-src 'self' blob:",
                "object-src 'none'",
                "base-uri 'self'",
                "form-action 'self'",
              ].join("; ");
              return html.replace(
                "<head>",
                '<head><meta http-equiv="Content-Security-Policy" content="' +
                  policy +
                  '"><meta name="referrer" content="same-origin">',
              );
            },
          },
        },
      ],
      pdfJsCMapsPlugin(),
      react(),
      tailwindcss(),
      thirdPartyNoticesVitePlugin(),
    ],
    resolve: {
      alias: [
        // 自托管入口让 IntlProvider 从空表按需装配词典，其他构建沿用同步文案表。
        {
          find: /^@\/i18n\/localeMessages\.js$/,
          replacement: "virtual:selfhost-locale-messages",
        },
        // 修复 UI 组件库中的 @ 别名解析失败。
        // 问题原因：packages/ui 的源码直接被 web 应用交给 Vite 打包，但 web 自己没声明 @ -> packages/ui/src，
        // 所以像 "@/components/lib/utils" 这类导入会在运行时构建阶段报找不到模块。
        // 这里把别名补到消费方 Vite 配置里，保持现有组件源码不动，影响面最小。
        { find: "@", replacement: resolve(__dirname, "../ui/src") },
        // Recharts 依赖 d3-shape@3.x，后者需要 d3-path 的 Path 导出。
        // hoisted node_modules 可能把 d3-shape 旁边的旧 d3-path@1.x 暴露给 Vite 预构建，
        // 导致桌面/Web dev 都在依赖优化阶段失败；显式指向根部 3.x 入口以固定解析边界。
        {
          find: "d3-path",
          replacement: resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
        },
        // Bugfix：pdf.js 默认构建在主线程和 Worker 里直接调用 URL.parse（Chrome 126）与
        // Promise.withResolvers（Chrome 119）。Chrome/Edge 111–125 打开字符串 URL 的 PDF 时，
        // getUrlProp() 抛 TypeError，会话区域崩溃；Worker 是独立全局，main.tsx 的 polyfill 进不去。
        // 只在 Web 换成同版本 legacy 构建，它的主线程与 Worker 文件各自带 core-js polyfill。
        // 必须用正则精确匹配：字符串键按前缀匹配，会把 worker 子路径也改写错。
        { find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" },
        {
          find: /^pdfjs-dist\/build\/pdf\.worker\.min\.mjs(?=$|\?)/,
          replacement: "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
        },
      ],
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: env.SELFHOST_GATEWAY_ORIGIN || "http://127.0.0.1:33724",
          ws: true,
          changeOrigin: true,
        },
      },
    },
    optimizeDeps: {
      // 修复：在依赖预构建阶段显式加入 react 相关入口，避免 rolldown 解析 `react/jsx-runtime`
      // / `react/jsx-dev-runtime` 时返回无后缀路径导致的加载失败（UNLOADABLE_DEPENDENCY）。
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
      // pdfjs-dist 是纯 ESM，不需要预构建。上面的 alias 让 dev 依赖扫描把带 ?url 的 worker
      // 当成依赖预构建并崩溃，pdf-viewer 动态导入随之 504；排除后直接按源文件提供。
      exclude: ["pdfjs-dist"],
    },
    worker: {
      rollupOptions: {
        // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听。
        // 它的 package sideEffects 漏声明会让生产 worker 子构建被摇成 0B；
        // 只关闭 worker 构建的摇树，避免影响主包。
        treeshake: false,
      },
    },
    define: {
      __ZCODE_SELFHOST__: "true",
      __ZCODE_VERSION__: JSON.stringify(
        resolveRemoteFrontendVersion(version, process.env.WEB_REMOTE_FRONTEND_VERSION),
      ),
      __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(minCompatibleVersion),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    },
    build: {
      // 生产不在浏览器产物暴露 sourceMappingURL，避免客户端侧还原业务源码。
      sourcemap: false,
    },
  };
});
