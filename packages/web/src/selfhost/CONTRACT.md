# Web 自托管工作区

浏览器向同源中心服务登录，选择账号拥有的 SSH 主机和远程绝对目录，再由 openWorkspace 装配 ZCode 的 RemoteServiceAccess。模型和历史以选中主机的 Codex app-server 为准。真实 Thread ID 同时用于浏览器地址和会话操作。关闭浏览器只注销订阅。添加、编辑主机及项目由服务端持久化，响应不包含 SSH 私钥和口令。

Web 入口是 index.ts。协议类型位于 contract.ts，运行模块位于本目录。公共界面继续由 ZCode Root 提供。
