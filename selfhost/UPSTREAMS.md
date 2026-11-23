# 双上游维护

产品从 ZCode v4.0.0 的 Git 树分叉，`packages/web` 和 `packages/ui` 由 ZCode 提供。Gateway 作为 `upstream/codex-gateway` 子模块提供服务端基础。每次升级可以通过 Git 追溯两条历史。`selfhost/upstreams.lock.json` 记录两个已集成的完整 SHA，`upstream-history.jsonl` 追加每次变更的组合。分支名和标签用于查找候选版本，构建以 SHA 为准。

```sh
git submodule update --init --recursive
python3 selfhost/upstreams.py status
python3 selfhost/upstreams.py check
```

在干净的维护分支上，一次升级一个组件。`prepare` 下载指定分支或标签，验证历史关系并准备本地三方合并或子模块指针。冲突停在维护分支内，按正常 Git 流程解决；如需取消，先用 `git merge --abort` 终止正在进行的 ZCode 合并，再执行 `python3 selfhost/upstreams.py cancel zcode` 清理准备记录；Gateway 更新可用 `cancel codex-gateway` 恢复子模块指针。准备步骤不更改锁。运行本项目的构建、类型检查和真实 SSH 验收后再用 `record` 写入并暂存新的完整 SHA 和历史条目，然后检查暂存内容并提交。示例中的标签应替换成实际要引入的版本。

```sh
git switch -c codex/update-zcode
python3 selfhost/upstreams.py prepare zcode refs/tags/vX.Y.Z
# 解决冲突，构建并验证工作区
python3 selfhost/upstreams.py record zcode
python3 selfhost/upstreams.py status

# 升级 Gateway 时，使用另一条干净的维护分支
python3 selfhost/upstreams.py prepare codex-gateway refs/heads/main
# 检查服务端补丁、身份校验、协议和持久化兼容性，运行验收
python3 selfhost/upstreams.py record codex-gateway
python3 selfhost/upstreams.py status
```

生产镜像和源码归档应附相同的版本锁。Web 外观变更优先在 ZCode 的现有展示组件内合并。模型、账号、SSH 和 Thread 差异收口在自托管服务接口。上游升级时复查 [功能清单](FEATURE-AUDIT.zh.md)，新出现的商业或云端入口需要明确决定是否进入自托管构建。

聊天状态栏随锁定的 ZCode Web 主线。v4 将早期右上浮栏移到了输入框上方，见 [ZCode 状态栏规格](https://github.com/zai-org/ZCode/blob/v4.0.0/docs/ui/chat-summary-panel.md)。

完成本地提交后，执行 `python3 selfhost/export.py dist/zcode-web-source.tar.gz` 生成包含两个上游和构建依赖锁的源码归档。导出基于 Git 暂存区；私钥、密码和运行数据库不属于源码。
