# React Hooks 依赖检查

## 目标与边界

在现有 Oxlint 中启用 `react/exhaustive-deps` 与 `react/rules-of-hooks`。
前者检查依赖遗漏、多余依赖和部分不稳定引用；后者检查 Hook 调用位置和顺序。
不安装第二套 linter，不自动修改业务代码的依赖数组。

配置沿用根 `.oxlintrc.json`。在 override 中启用 React 插件和这两条规则，保留
原有 unicorn、typescript、oxc 插件；不同时引入其他 React 默认规则。
现有 ignorePatterns、各包独立 lint 入口和 nested config 的边界保持不变。
根配置排除的组件目录与 CLI React 源码需要在专项扫描中显式纳入；嵌套配置仍按包独立生效，
不能把根 lint 的 Hooks 诊断称为全库结果。

## 接入策略

- `react/exhaustive-deps` 先设为 `warn`，存量诊断逐项复核后修复。
- 根扫描范围的 `react/rules-of-hooks` 使用 `error`。首轮扫描登记的七个文件清理后统一接受该门禁。
- `pnpm lint` 自动执行这些检查；CI/pre-push 沿用同一入口。
- 不使用 `lint:fix` 批量修复 Hooks。新增依赖可能重建订阅或扩大渲染范围，删除依赖
  可能移除业务上的失效条件，均须结合 owner、调用方与运行时场景判断。

## 解读诊断

诊断数量不等于 bug 数量，也不等于 Hook 数量。同一依赖数组可以产生多条诊断。
尤其是把对象整体传给 helper，或通过 `props.callback()` 调用成员函数时，检查器可能
同时报告缺少对象和成员依赖多余。应先检查 helper 的输入边界及调用接收者语义，不能
直接把所有成员替换成整个对象。

```text
闭包读取值 → 检查依赖是否覆盖 → 人工复核身份与失效语义 → 运行时验证更新范围
```

`[props]` 即使通过检查，也不能证明依赖足够窄。文件预览回调变化传播到无关侧栏的
场景仍需组件提交记录验证，静态规则不替代 React 渲染回归。

## 验收

### 调用顺序与会话路由

- 任务、会话与 Agent 的服务 Hook 在每次渲染执行同一条解析链。未指定工作区时取当前 ServiceProvider；有目标时继续由工作区身份和远端会话 ID 选定 Host。远端未就绪时仍使用断连代理。只有有目标的解析需要 TabStoreProvider。
- 分组任务的拖动副本只渲染展示节点，交互行负责拖放注册、菜单状态和按需加载路径。工作流卡片从旧历史或等待投影切换到已联接状态时保持稳定的 Hook 调用顺序，并打开同一个运行 ID。
- 自托管浏览器验收在桌面与手机之间复用同一场景。创建两个会话并分别写入未发送草稿，在 A → B → A 往返后验证正文和草稿归属，确认恢复历史和草稿的过程中发送次数不增加。桌面用例继续覆盖分组任务拖动与工作流恢复。

### 设置、模型和权益

- 自动化编辑以打开状态、自动化 ID 和已选工作区为输入。界面语言变化只同步默认标题，保留用户已输入的字段。打开历史页仍按当前自动化 ID 获取历史。
- 扩展设置以选定的管理范围及工作区身份接收计数。范围切换后只接受当前范围回报，并保持该范围原有的列表和写入入口。
- 模型配置读取保持 Provider、账户和选区边界。模型草稿只向当前选区请求推荐配置，旧接收者的回包不得改写新选区。权益保持既有的请求去重、会话新鲜度和手动刷新行为。
- 浏览器用例在桌面和窄屏检查应用设置往返、扩展范围以及带引用的草稿恢复。自动化夹具检查选定目录、主机被替换后的暂停以及显式重新绑定。

```text
选定范围 / 自动化 ID / 模型连接 → 设置页现有的 owner → 请求当前 Host 或服务
                                                  └→ 异步结果按原 scope 检查后再应用
```

### 工作区、侧栏和扩展

- 切换工作区或远端连接后，目录列表、能力读数和扩展订阅继续由当前目标的服务负责。同一路径上的不同工作区按身份隔离，切换期间停止接收旧范围的结果。
- 侧栏的任务归属、排序和未读写入保留现有 owner。展开、收起、拖动结束和工作流后继切换依然沿现有事件，标签搜索中的相对时间在打开时重新计算。
- 浏览器回归覆盖桌面和窄屏的会话状态、原会话切回、SSH 设置往返与草稿内容，扩展请求夹具验证本地、远端和断连的服务路由。

```text
工作区身份 / attachment → TabStore 与连接注册表 → 当前服务 → 可见的目录和扩展列表
侧栏交互 / 工作流进度   → 原面板 owner           → 标签更新 → 对话保持原绑定
```

工程回归：`node --test scripts/test/react-hooks-lint.test.mjs scripts/test/source-size-policy.test.mjs`。
该回归也纳入现有 `test:architecture` 入口。验证缺失/多余依赖可见、非法 Hook 调用阻断、
包内运行继承配置，以及原有插件规则不丢失。
正确的精确依赖和完整对象依赖均保持规则原有语义，不把静态检查包装成性能证明。

专项扫描使用独立的临时配置，只启用两条 Hooks 规则。Oxlint 1.60.0 的 `--no-ignore`
不会清除配置里的 `ignorePatterns`，仅在根配置上添加该参数仍会漏掉被忽略的源码。
显式列出源码目录，不对生成文件、依赖目录和语法测试 fixture 做全目录扫描：

```sh
audit_dir=$(mktemp -d)
cat > "$audit_dir/hooks.json" <<'JSON'
{
  "plugins": ["react"],
  "categories": { "correctness": "off" },
  "rules": {
    "react/exhaustive-deps": "warn",
    "react/rules-of-hooks": "warn"
  }
}
JSON
pnpm exec oxlint -c "$audit_dir/hooks.json" \
  --no-ignore --disable-nested-config --format json \
  packages/ui/src packages/desktop/src packages/web/src packages/web-share/src \
  packages/stream-animate/src packages/e2e-report/src apps/dev-docs/src \
  apps/zcode-cli/packages/tui/src apps/zcode-cli/packages/debug/src \
  apps/zcode-cli/packages/office-runtime/ui \
  apps/zcode-cli/packages/zcode-site-plugin/src/ui > "$audit_dir/result.json"
```

保留原始 JSON；按规则、类别、文件和行号汇总。缺失、多余、不稳定引用、复杂表达式、
cleanup ref 和调用顺序问题分开计数；人工复核结论单列，未验证项不得标为已修复。

## 首轮扫描记录

2026-11-04，基于 `01100ad2c9`，Oxlint 1.60.0。上面的专项扫描覆盖 2,662 个源码目录下的
文件，发现 141 个文件中的 446 条 deps 诊断，另有 18 条 Hook 调用规则诊断。根 lint 的
Hooks 检查不覆盖 CLI React 源码与基础组件目录，但包含辅助脚本与测试，得到 425 条 deps、
20 条调用规则诊断。启用前后同范围比较，原有非 Hooks 诊断没有新增或减少。

| deps 类别                    | 诊断数 |
| ---------------------------- | -----: |
| 缺少依赖                     |    174 |
| 多余依赖                     |    218 |
| 引用每次 render 都变化       |     24 |
| cleanup 读取可变 ref.current |     21 |
| 依赖数组含复杂表达式         |      9 |

优先复核的源码位置与边界：

- `ToolCallBlocks.tsx` 的 `childToolList` 读取 `onOpenWorkflowRun`、
  `disableSummaryContentAnimation`、`animateDiffCountOnMount`，但 deps 未列入这三个输入。
- `plugin-ui/adapters/usePluginUiSidePaneModel.tsx` 的 `feedScope` 读取 `tab.remoteSessionId`，
  deps 未覆盖该字段；需要验证其在同一组件生命周期内变化的场景。
- `hooks/useAppPanels.ts` 的 `handleOpenBrowserUrl` 未读取 `workspaceAbsPath`，但把它列入 deps；
  两个关闭回调还保留了已不使用的 `currentSidePaneScope`、`setIsSidePaneCollapsed`。
- `v4/WorkflowNotificationToolRow.tsx` 在 `onOpenRun` 存在时，每次 render 重建 JSX 值
  `openRunLink`，导致依赖它的 `renderContent` 回调每次更新。
- `v4/SessionPane.tsx` 的 `composerDraftGeneration` 是重读外部草稿的失效信号；虽被标为多余，
  不能直接删除。`app-shell/SidePaneTabOverview.tsx` 的 `currentTime` 同样需要保留相对时间刷新语义。
- `SidePaneTabOverview`、`useGitAutoRefresh` 中对象与成员的成对诊断先检查 helper 边界，
  不机械改成整个对象依赖。
- `resume-workflow-run.tsx` 和 `project-sidebar/grouped/task-row.tsx` 在部分 Hook 之前提前返回，
  分别有 3 条和 8 条调用规则诊断；运行时风险取决于分支在同一组件实例内是否切换。

本轮只接入检查和登记问题，未修改业务依赖，未把静态诊断认定为已经复现的产品 bug。
