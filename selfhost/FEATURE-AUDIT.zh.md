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


## 真实环境验收

桌面和手机宽度都通过了主机添加及认证方式切换、编辑、取消删除、目录路径校验、模型菜单和输入框加号的浏览器回归。输入框从所选主机的 Codex 读取已安装插件和本地技能。桌面、手机回归均检查每个市场的已启用插件可见，并断言打开输入框不向远程市场查询插件详情。原生项目目录在远端读取并解析符号链接，已验证有会话、无会话以及目录别名三类分区。实际验证还包括远端 Git 修改、终端、原生 Thread 恢复、跨客户端一次性只读命令审批、已保存工作流目录以及私有分享撤销。聊天状态栏采用锁定的 ZCode v4 组件，位置随上游。

## 旧 Codex ACP

公开主线首次导出业务源码的提交为 872ad960de7ec172591f7e1952f7849229f94521。该提交的服务端和 UI 已存在 nonCliAcpRetirement 测试。UI 测试明确枚举 codex，服务端测试保护退役 ID、已有转录和会话不存在时的真实错误。主线以及公开 feat/ui-plugin 分支均未找到可接入的旧 Codex ACP 传输实现。协议 SDK 的依赖条目无法充当运行适配器。[服务端退役测试](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/services/test/nonCliAcpRetirement.test.ts#L99) · [UI 提供方清理测试](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/ui/test/nonCliAcpRetirement.test.ts#L28)

自托管回归继承其中的身份约束。它先通过一个已认证的连接读取真实原生 Thread，再从第二个连接打开不存在的 ID，验证服务端拒绝请求，并按原始 ID 再次读取已完成的 Turn。执行引擎仍是官方 app-server。
