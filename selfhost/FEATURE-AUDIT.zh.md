# ZCode 自托管功能盘点

用户已确认保留通用插件、分享、工作流和自动化，移除智谱云依赖。托管分享与内部会话链接分别处理，自动化和工作流不按厂商品牌整体裁撤。

本清单依据 ZCode `a4b4445141eb7d3b3e99eada9292775383bfc44e` 与 Codex Gateway `76200537c19f0c4075153c1458667a07e804db6c` 的源码。下表是自托管构建的功能决策，和各项实际验收状态分开记录。上游版权、Apache NOTICE 和第三方许可随分发保留。

| 功能 | 源码依据 | 自托管处理 |
| --- | --- | --- |
| 智谱账号、登录回调和团队身份 | `packages/web/src/auth/webZaiOAuthConfig.ts`、`packages/services/src/oauth`、`packages/ui/src/root/useRootOAuthEffects.ts` | 换成中心服务器账号，远端 OpenAI 登录使用该远端用户的 Codex CLI。 |
| BigModel/Z.ai 套餐、个人和团队购买、额度重置、余额及升级弹窗 | `packages/services/src/bigmodel`、`packages/services/src/coding-plan-subscription`、`packages/ui/src/settings/CodingPlanUpgradeDialog.tsx` | 从产品菜单、路由、构建依赖和运行请求移除。上下文窗口用量读取远端 Codex 的真实数据。 |
| 奖励中心和营销触达 | `packages/ui/src/rewards`、`packages/services/src/marketing-touch`、`packages/ui/src/marketing-touch-contract` | 移除奖励、活动素材请求、推广提示和转化上报。 |
| 智谱专属模型加速与套餐任务 | `packages/ui/src/highspeed`、`packages/ui/src/v4/OffPeakNewTaskEntry.tsx`、`packages/ui/src/settings/OffPeakEditView.tsx` | 移除套餐专用入口和倒计时。模型菜单继续使用 ZCode 控件，数据来自远端官方 CLI。 |
| 官方云内容推荐、托管分享、设备配对中继 | `packages/services/src/cloud-content`、`packages/services/src/conversation-share`、`packages/web/src/share`、`packages/web/src/web-remote-control` | 自托管浏览器直连同一个服务，手机复用 ZCode 手机界面。会话链接受本地账号认证。 |
| 产品遥测、营销归因和日志上传 | `packages/services/src/telemetry`、`packages/services/src/conversation-telemetry`、`packages/services/src/feedback/feedbackHttpClient.ts` | 从自托管请求链移除；本地运维日志继续提供连接与协议错误。 |
| 智谱代理进程、官方 MCP 凭据签发、多供应商云端配置下发 | `packages/services/src/zcode-agent`、`packages/services/src/official-mcp`、`packages/provider-node/src/zcode-builtin-remote-synchronizer.ts` | 执行端换成 SSH 目标上的官方 Codex app-server。MCP、Skills 是否可用由远端 Codex 配置和协议能力决定。 |
| 模型搜索与推理强度、Lexical 编辑器、输入引用、计划与授权交互 | `packages/ui/src/ModelConfigSelect.tsx`、`chat-input-toolbar/ComposerModelMenu.tsx`、`prompt-editor/ChatPromptEditor.tsx`、`LexicalChatInput.tsx`、`PermissionDialog.tsx` | 保留 ZCode 展示和交互，适配 Codex 模型、输入和审批。 |
| 项目与任务树、手机主页、文件、差异、终端、语言和主题 | `packages/ui/src/project-sidebar`、`WebRemoteControlMobileShell.tsx`、`WorkspaceFileTree.tsx`、`terminal`、`styles.css` | 保留通用工作区设计，接入认证后的账号、SSH 主机、目录和原生 Thread。 |
| 插件机制、MCP、Skills、hooks、自动化、工作流、语音、Office/图片预览 | `packages/ui/src/settings`、`packages/ui/src/plugin-ui`、`packages/services/src/skills` | 其中包含通用功能，不能按品牌整体删掉。面向真实 Codex 能力逐项启用；暂缺运行时的入口不得伪装成可用功能。 |
| Electron 自动更新、原生系统框、桌面 CUA | `packages/desktop`、`packages/zcode-cua` | 属于平台范围，Linux Web 镜像无需打包。 |

更新两个上游时要复查新增入口、依赖及浏览器实际发出的网络请求。表中的目录说明依赖来源，不能据此整目录盲删共享实现。例如 `web-remote-control` 既有厂商中继，也有手机界面所需的数据类型。

本分支已删除原 Web 入口的厂商设备中继启动、智谱 OAuth 回调页面和 14 份独立商业运营文档。保留 Git 上游历史，可用锁定的 SHA 查阅原文。

## 会话与设置入口核对

| 入口 | 公共 App Server 或工作区能力 | 自托管处理 |
| --- | --- | --- |
| 会话重命名、归档、恢复、消息分支 | `thread/name/set`、`thread/archive`、`thread/unarchive`、`thread/fork` | 保留原生操作，置顶会话优先展示远端标题。 |
| 会话置顶、手动未读、分组 | 中心账号的导航状态，支持 Codex 0.170 | 置顶、未读和分组都由中心账号持有，清除未读时比对客户端实际看到的标记。 |
| 永久删除 | `thread/delete`、`thread/deleted` | 右键和归档设置经确认后执行，清理该会话的网关缓存与组织元数据。 |
| 复制与桌面专属会话工具 | `thread/read` 的 `path`、Web 剪贴板、SSH 文件树 | 保留可获取的路径和会话 ID。移除本机文件管理器、ZCode 日志、调用轨迹、反馈和重启入口。 |
| 项目操作 | SSH 目录登记及浏览。较新 Codex 有项目协议，当前最低版本提供 Thread 目录信息。 | 保留目录登记、目录浏览、会话创建和网页排序。隐去对旧桌面与原生项目无法写回的控件。 |
| MCP 和钩子 | `mcpServerStatus/list`、`hooks/list` | 提供当前主机状态、钩子目录和刷新。OAuth 需要远端回调链路，写入由远端原生配置负责。 |
| 一般设置及 Agent 行为 | 网页界面、通知、终端字体与消息展示由 Web 消费 | 隐去终端启动配置、代理、数据目录、引导、ZCode Agent 特有参数及其搜索结果。 |
| 数据与扩展 | App、插件、技能、归档和私有分享已有服务。Codex 从 SSH 用户目录加载个性化指令。 | 私有分享管理使用中心登录态。个性化读取和保存原生指令文件。ZCode 的自动归档、模型供应商、记忆模板、浏览器控制和桌面设置入口退场。 |

会话、应用与状态的协议依据是 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 和 [Codex 0.170 原生方法定义](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts)。验收场景见[会话操作与设置兼容性](../specs/selfhost-codex/README.md#会话操作与设置兼容性)。


## 真实环境验收

桌面和手机宽度都通过了主机添加及认证方式切换、编辑、取消删除、目录路径校验、模型菜单和输入框加号的浏览器回归。输入框从所选主机的 Codex 读取已安装插件和本地技能。桌面、手机回归均检查每个市场的已启用插件可见，并断言打开输入框不向远程市场查询插件详情。原生项目目录在远端读取并解析符号链接，已验证有会话、无会话以及目录别名三类分区。实际验证还包括远端 Git 修改、终端、原生 Thread 恢复、跨客户端一次性只读命令审批、已保存工作流目录以及私有分享撤销。SSH 网页复用 ZCode v4 状态组件，在右上角展示当前工作树与会话。每轮的文件卡单独读取该 Turn 的改动。

## 旧 Codex ACP

公开主线首次导出业务源码的提交为 872ad960de7ec172591f7e1952f7849229f94521。该提交的服务端和 UI 已存在 nonCliAcpRetirement 测试。UI 测试明确枚举 codex，服务端测试保护退役 ID、已有转录和会话不存在时的真实错误。主线以及公开 feat/ui-plugin 分支均未找到可接入的旧 Codex ACP 传输实现。协议 SDK 的依赖条目无法充当运行适配器。[服务端退役测试](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/test/nonCliAcpRetirement.test.ts#L99) · [UI 提供方清理测试](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/ui/test/nonCliAcpRetirement.test.ts#L28)

自托管回归继承其中的身份约束。它先通过一个已认证的连接读取真实原生 Thread，再从第二个连接打开不存在的 ID，验证服务端拒绝请求，并按原始 ID 再次读取已完成的 Turn。执行引擎仍是官方 app-server。
