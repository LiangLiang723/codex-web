# ZCode · 远程 Codex 工作区

在一台 Linux 服务器部署 Web 服务。电脑和手机登录同一地址，即可在已登记的 SSH 主机上使用该用户自己的 OpenAI Codex CLI。默认端口是 **33723**。

## Docker Compose 部署

首次克隆本仓库时使用 Git 的 `--recurse-submodules` 参数。源码归档已经包含 Gateway 子模块。中心服务器需要能访问目标 SSH 主机。远端需要 Git、Node.js 和已登录的官方 Codex CLI。版本专项覆盖远端 CLI `0.170.0` 与 `0.172.0`，配套协议使用 `codex app-server daemon` 和 `codex app-server proxy`。

```sh
git submodule update --init --recursive
sh selfhost/setup.sh
sh selfhost/update.sh
docker compose ps
```

源码归档部署可略过第一行。如果 Linux 宿主机的 Docker 构建代理只在本机回环地址监听，可在 `.env` 设置 `CODEX_WEB_BUILD_NETWORK=host`，让构建步骤访问该代理。若已有可信的 npm 镜像，可通过 `CODEX_WEB_NPM_REGISTRY` 指定其地址。构建使用仓库的锁文件校验依赖。

部署脚本生成权限为 `0600` 的 `.env` 和随机加密密钥。首次登录前，在服务器的 Bash 终端创建账号，密码由标准输入传入。

```sh
read -rsp 'Web 登录密码 ' web_password
printf '\n'
printf '%s\n' "$web_password" | docker compose exec -T codex-web node scripts/create-user.mjs admin
unset web_password
```

默认监听 `127.0.0.1:33723`。在 `.env` 将 `CODEX_WEB_BIND` 改为 Agents 的局域网地址或 Tailscale 地址，再运行 `docker compose up -d`。电脑与手机访问 `http://<中心服务器地址>:33723`。跨公网部署时，在中心服务前配置 HTTPS 反向代理并转发 `/api/realtime` 的 WebSocket Upgrade。也可从电脑建立 SSH 本地转发。

```sh
ssh -N -L 33723:127.0.0.1:33723 admin@agents.example.net
```

转发目标应与 `CODEX_WEB_BIND` 匹配。仅绑定局域网 IP 时使用那个 IP。Docker 数据库位于 `/data/codex-web.db`。备份整个数据卷、`.env` 里的加密密钥、挂载的身份文件及信任记录。恢复时使用原密钥。`docker compose down` 可保留卷。

## 使用已构建的 Linux 镜像

随交付提供 Linux AMD64 镜像归档时，可在同架构服务器跳过镜像构建。用 `sha256sum -c SHA256SUMS` 核对下载文件，解压源代码后在项目根目录执行以下命令。创建 Web 账号和配置监听地址的操作与上文相同。

```sh
docker load -i /path/to/zcode-web-linux-amd64.tar.gz
sh selfhost/setup.sh
sh selfhost/update.sh --no-build
```

每次用 `selfhost/update.sh` 更新时，Compose 在 `codex-web` 健康后清理 `zcode-selfhost` 仓库下已被替换的镜像，并用 `zcode-selfhost:rollback` 保留上一版健康镜像。通过其他流程切换版本时，验收后可在同一部署目录运行 `sh selfhost/update.sh --cleanup zcode-selfhost:<上一版标签>`。镜像通过 Mac 或其他构建机中转时，发布完成后清除该次构建和上传的临时目录、旧归档，以及构建机上明确已用完的候选镜像。服务端的 SQLite、SSH 配置、数据卷和备份有各自的保留周期。

需要在清理前验收服务时，使用 `sh selfhost/update.sh --stage` 切换到已构建的镜像。更新前的健康镜像按精确 ID 保存在部署目录的记录中，并受标签保护。验证登录、SSH 和桌面及手机会话后，运行 `sh selfhost/update.sh --cleanup`。若验收失败，将 `.env` 的 `CODEX_WEB_IMAGE` 指回原版本，运行 `docker compose up -d --no-build --wait codex-web`。共用 Docker daemon 的独立实例可将 `CODEX_WEB_RELEASE_REPOSITORY` 导出到脚本环境，各自使用独立的镜像仓库。

## 连接和切换主机

在「SSH 工作区」选择「添加主机」，填写 SSH 地址和登录方式。地址支持普通主机名、Tailscale 地址，以及 `user@host`、`ssh://user@host:port` 和 `ssh -p 2222 user@host`。可在保存前按「测试连接」验证认证。指纹、密钥类型和 SOCKS5 代理在「高级选项」。「外观」支持搜索 Font Awesome 图标、设置图标颜色和上传图片。

- **SSH Agent** 可通过 `compose.agent.yml` 暴露专用签名套接字。设置 `COMPOSE_FILE=docker-compose.yml:compose.agent.yml` 和 `CODEX_WEB_AGENT_DIR`，其下应有应用进程 uid 1000 可访问的 `agent.sock`。
- **SSH 私钥** 可粘贴到表单，服务端用 AES-GCM 加密持久化。也可将专用密钥置于只读挂载的 `ssh-keys/`，填入相对文件名。`compose.identity.yml` 可将单个密钥挂载为 `default`。密钥口令只写不回显。
- **主机身份** 用远端控制台或可信记录核对 SHA256 指纹，也可挂载可信 OpenSSH `ssh-keys/known_hosts`。身份未知或指纹不匹配时拒绝连接。经 SOCKS5 隧道同样校验最终 SSH 主机。

在项目侧栏顶部点击当前主机名称即可打开「SSH 工作区」。每张卡对应一台主机。「进入工作区」优先打开该主机上次使用的项目，首次连接没有项目时使用远程用户的家目录。已归属的会话随项目展示，无项目的会话保留在任务区。「打开目录」也可以直接输入远程绝对路径。连接中可以取消，失败后可就地重试。通过「编辑」可更改连接、工作区名称和头像，同一登录账号的各台设备共用配置。

在主机列表顶部或工作区左下角菜单打开「账号设置」，输入当前密码后可单独修改用户名或密码，也可同时修改两者。修改成功后各设备重新登录，原有 SSH 主机和项目仍归原账号 ID。

## 会话和操作

- 模型菜单、思考强度、Lexical 输入框、文件引用、会话列表和消息时间线使用 upstream ZCode 组件。模型来自所选 SSH 主机和项目提供商的 `model/list`。已有 Thread 使用其原生提供商。
- Thread 和 Turn 由官方 CLI 创建。历史来自远端 Codex，网页地址保留原生 Thread ID。断开浏览器后，后台任务仍由远端 app-server 处理。支持流式输出、工具调用、Plan Mode、权限审批和重新进入同一会话。
- 会话菜单支持重命名、置顶、标记未读、归档和复制原生 ID。选择「永久删除」后需在确认框再次确认，Codex 在所选 SSH 主机删除对话及其派生的子智能体记录。归档设置也可恢复或永久删除会话。
- 另一端持有写锁或 Thread 的模型提供商不可用时，Web 正常显示历史并提供重新连接。Web 创建的会话在首轮完成后生成短标题，通过 Codex 原生接口保存。
- 宽屏对话有内容时，右上角默认展开当前工作树的 Git 改动、分支以及会话的 Goal、计划、子智能体和来源。较窄窗口通过右上角按钮打开，手机使用抽屉。
- 聊天中的文件卡按原生 Turn ID 展示文件、增删行数和补丁。撤销前先预览。SSH 工作树、补丁和文件内容无法相互印证时，界面会说明具体原因。旧历史显示 Codex 实际保存的文件记录。
- 支持的远端可查看和取消原生排队输入，从已完成的轮次创建分支，以及查看上下文用量和触发压缩。
- 文件浏览与 Git 使用 ZCode 原服务，经校验身份的 SSH 通道在远端执行。终端复用 Gateway 的远程 PTY。展开的远程目录通过 Codex 的 `fs/watch` 更新文件树。
- 插件、Skills 和 MCP 通过选中主机的 Codex 接口读取。输入框使用 `plugin/installed` 加载已安装插件，浏览插件市场时再查询市场目录。支持工作流文件的读取、元数据编辑、移动和删除。ZCode 的动态工作流脚本运行器尚未接入 Codex。自动化界面可保存任务，由中心调度器发起 Codex Thread 和 Turn。
- 私有分享保存选定轮次的用户和助手文本，使用同一中心账号查看、撤销或删除。文本分享省略图片附件和工具输出。

在工作区侧栏打开「扩展」，可查看当前 SSH 主机的插件、应用与技能。已安装的条目优先显示。点「使用」会在对应项目打开可编辑的聊天草稿；在已有对话里，可从输入框的加号选择。插件安装沿用 ZCode 商店，应用授权使用 Codex 返回的官方页面，技能详情可打开远端的 `SKILL.md`。「设置 → Agent 能力」也保留三个管理入口。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

## 远程执行链路

浏览器向中心服务鉴权，中心通过校验主机身份的 SSH 连接远端官方 Codex。Gateway 通过 `codex app-server proxy` 接到那台机器上已运行的 daemon，并使用 WebSocket 与 Codex RPC。网页登录令牌用于中心服务，模型认证、服务商与出站网络由远端 Codex 配置决定。

如果同一台 Mac 上桌面回复很快，Web 却反复显示模型重连，检查 SSH 启动的 Codex daemon 是否继承该主机已有的 `HTTPS_PROXY`。代理环境在进程启动时读取。确认该 daemon 没有运行中的轮次后，从能访问已有代理的环境执行 `codex app-server daemon restart`，再用同模型、同推理强度复测首字和完成耗时。

普通输入会裁去首尾空白，作为原生 `text` 输入发送。模型、推理强度、推理摘要、权限和 Plan 模式走独立协议字段，Web 的协作模式设置传入 `developer_instructions: null`。用户主动选择的代码批注、网页元素等上下文按 ZCode 输入框规则序列化，图片作为原生图片输入发送。普通文件上传后，其远端路径写入用户输入。选中的应用和插件按原生 `mention` 提交，技能按 `skill` 提交并保留远端文件路径。Codex 自带的模式指令和项目指令由远端 CLI 加载。

## 直接在 Linux 运行

准备 Node.js 24.22 或更高版本、Corepack、Git、Python 3 和 OpenSSL。在仓库根目录执行以下命令。

```sh
sh selfhost/setup.sh
sh selfhost/build.sh
read -rsp 'Web 登录密码 ' web_password
printf '%s\n' "$web_password" | CODEX_GATEWAY_DB_PATH="$PWD/.data/codex-web.db" node selfhost/create-user.mjs admin
unset web_password
sh selfhost/serve.sh
```

`.selfhost/current` 指向已构建的版本。`.data` 是持久数据目录。设置 `CODEX_GATEWAY_DB_PATH` 可以移动数据库。组信息存放在数据库旁，配置和私有分享按账号隔离。

## 源码和维护

仓库根目录继承 ZCode 的 Git 历史，Gateway 是独立的 Git 子模块。Gateway 提供后端。自托管适配在 `packages/web/src/selfhost` 和 `selfhost/gateway`。凭据、数据库、密码文件均位于 Git 与 Docker 构建上下文之外。

```sh
python3 selfhost/upstreams.py status
python3 selfhost/upstreams.py check
python3 -m unittest discover -s selfhost/tests
node selfhost/tests/session-resync.mjs
```

流式恢复验收使用本机 Chrome，在两种 Web 窗口宽度下模拟帧装配故障。

使用临时测试账号时，`SELFHOST_TEST_ROTATE_ACCOUNT=1` 验证改名、改密及旧会话撤销。`SELFHOST_TEST_IDENTITY=1` 在专用 QA 主机上验证多浏览器头像和名称同步。`SELFHOST_TEST_COMPAT_HOST` 可指定另一台已有原生会话的主机，验证不同 Codex 版本的项目发现。MCP 浏览器验收可用 `SELFHOST_TEST_MCP_THREAD` 指定已收到 `selfhost/tests/fixtures/mcp-confirmation.mjs` 请求的独立测试 Thread。

桌面与手机回归脚本为 `selfhost/tests/browser.mjs`。设置 `SELFHOST_TEST_URL`、`SELFHOST_TEST_USER`、`SELFHOST_TEST_PASSWORD_FILE`、`SELFHOST_TEST_HOST`、`SELFHOST_TEST_CWD` 和 `SELFHOST_TEST_THREAD`，选择至少有一轮已完成对话的测试 Thread，在已安装 Chrome 的开发机执行 `node selfhost/tests/browser.mjs`。`SELFHOST_TEST_PANEL=1` 验证有 Git 更改的测试项目的右上角状态栏。`SELFHOST_TEST_FILE_WATCH=1` 会在指定的测试项目创建并清理临时文件，验证文件树随远端变动刷新。`SELFHOST_TEST_MUTATE=1` 会创建、编辑并删除仅属于本次测试的临时主机。

`SELFHOST_TEST_SESSION_FOCUS=1` 可单独运行会话验收。`SELFHOST_TEST_WRITER_THREAD` 指定由另一端持有且已有历史的测试会话。`SELFHOST_TEST_AUTO_TITLE=1` 在指定测试目录创建一条合成会话，验证原生项目归属和标题后归档该会话。

在独立 QA 工作区，`node selfhost/tests/ssh-web-acceptance.mjs` 可用相同登录变量记录网页提交、原生接纳、首字和完成时间。该脚本默认发送一条短消息。设置 `SELFHOST_TEST_SCENARIO=patch` 可验证同一原生轮次的文件卡、补丁、右上面板及手机抽屉。文件撤销验收仅在自己的临时工作区运行；脚本先核对预览中唯一的合成路径。

后续升级、完整 SHA 和取舍清单见 [上游同步说明](selfhost/UPSTREAMS.md)、[上游版本锁](selfhost/upstreams.lock.json) 和 [功能盘点](selfhost/FEATURE-AUDIT.zh.md)。源码遵循上游许可。[ZCode](LICENSE) · [Codex Gateway](upstream/codex-gateway/LICENSE) · [第三方许可](THIRD-PARTY-NOTICES.md)
