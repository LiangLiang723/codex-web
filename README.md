# ZCode · 远程 Codex 工作区

在一台 Linux 服务器部署 Web 服务。电脑和手机登录同一地址，即可在已登记的 SSH 主机上使用该用户自己的 OpenAI Codex CLI。默认端口是 **33723**。

## Docker Compose 部署

首次克隆本仓库时使用 Git 的 `--recurse-submodules` 参数。源码归档已经包含 Gateway 子模块。中心服务器需要能访问目标 SSH 主机。远端需要 Git、Node.js 和已登录的官方 Codex CLI。已实测的远端 CLI 为 `0.171.0`，配套协议使用 `codex app-server daemon` 和 `codex app-server proxy`。

```sh
git submodule update --init --recursive
sh selfhost/setup.sh
docker compose up -d --build
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
docker compose up -d --no-build
```

## 连接和切换主机

在「SSH 工作区」选择「添加主机」，输入 SSH 地址、端口、用户与认证方式。可使用 Tailscale IP、普通 SSH 主机名或中心服务器能访问的 SSH 隧道端点。

- **SSH Agent** 可通过 `compose.agent.yml` 暴露专用签名套接字。设置 `COMPOSE_FILE=docker-compose.yml:compose.agent.yml` 和 `CODEX_WEB_AGENT_DIR`，其下应有应用进程 uid 1000 可访问的 `agent.sock`。
- **SSH 私钥** 可粘贴到表单，服务端用 AES-GCM 加密持久化。也可将专用密钥置于只读挂载的 `ssh-keys/`，填入相对文件名。`compose.identity.yml` 可将单个密钥挂载为 `default`。密钥口令只写不回显。
- **主机身份** 用远端控制台或可信记录核对 SHA256 指纹，也可挂载可信 OpenSSH `ssh-keys/known_hosts`。身份未知或指纹不匹配时拒绝连接。经 SOCKS5 隧道同样校验最终 SSH 主机。

「同步项目」从这台主机读取 Codex 登记的工作区、可信项目和原生 Thread 工作目录，在中心按账号缓存项目分区。支持含空格、中文和符号链接的路径。「打开目录」会验证远程路径并保存项目。只有一台主机时自动同步，多个主机可分别同步。选定目录后进入 ZCode 工作区，侧栏底部可返回 SSH 主机管理。

## 会话和操作

- 模型菜单、思考强度、Lexical 输入框、文件引用、会话列表和消息时间线使用 upstream ZCode 组件。模型来自选中主机的 `model/list`。
- Thread 和 Turn 由官方 CLI 创建。历史来自远端 Codex，网页地址保留原生 Thread ID。断开浏览器后，后台任务仍由远端 app-server 处理。支持流式输出、工具调用、Plan Mode、权限审批和重新进入同一会话。
- 桌面和手机沿用 ZCode v4 的输入框状态栏。Git 更改、目标、计划进度和后台活动按真实数据出现，点开相应胶囊可查看详情。
- 文件浏览与 Git 使用 ZCode 原服务，经校验身份的 SSH 通道在远端执行。终端复用 Gateway 的远程 PTY。展开的远程目录通过 Codex 的 `fs/watch` 更新文件树。
- 插件、Skills 和 MCP 通过选中主机的 Codex 接口读取。输入框使用 `plugin/installed` 加载已安装插件，浏览插件市场时再查询市场目录。支持工作流文件的读取、元数据编辑、移动和删除。ZCode 的动态工作流脚本运行器尚未接入 Codex。自动化界面可保存任务，由中心调度器发起 Codex Thread 和 Turn。
- 私有分享保存选定轮次的用户和助手文本，使用同一中心账号查看、撤销或删除。文本分享省略图片附件和工具输出。

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
```

桌面与手机回归脚本为 `selfhost/tests/browser.mjs`。设置 `SELFHOST_TEST_URL`、`SELFHOST_TEST_USER`、`SELFHOST_TEST_PASSWORD_FILE`、`SELFHOST_TEST_HOST`、`SELFHOST_TEST_CWD` 和 `SELFHOST_TEST_THREAD`，选择至少有一轮已完成对话的测试 Thread，在已安装 Chrome 的开发机执行 `node selfhost/tests/browser.mjs`。`SELFHOST_TEST_PANEL=1` 验证有 Git 更改的测试项目的 v4 状态栏。`SELFHOST_TEST_FILE_WATCH=1` 会在指定的测试项目创建并清理临时文件，验证文件树随远端变动刷新。`SELFHOST_TEST_MUTATE=1` 会创建、编辑并删除仅属于本次测试的临时主机。

后续升级、完整 SHA 和取舍清单见 [上游同步说明](selfhost/UPSTREAMS.md)、[上游版本锁](selfhost/upstreams.lock.json) 和 [功能盘点](selfhost/FEATURE-AUDIT.zh.md)。源码遵循上游许可。[ZCode](LICENSE) · [Codex Gateway](upstream/codex-gateway/LICENSE) · [第三方许可](THIRD-PARTY-NOTICES.md)
