# 版本发布(维护者)

推送 `v*` tag 自动触发 [.github/workflows/release.yml](../.github/workflows/release.yml):
构建多架构镜像(linux/amd64 + arm64)并推送到 ghcr.io。流程:

```bash
# 1) 对齐版本号:app/__init__.py 的 __version__ = "0.3.0"
git commit -am "chore: release v0.3.0"
# 2) 打 tag 并推送,CI 接管
git tag v0.3.0 && git push origin v0.3.0
```

- **tag 必须与 `__version__` 一致**,CI 第一步就校验,不一致直接失败
- 镜像 tag:`v0.3.0` → `0.3.0` / `0.3` / `latest`
- CI 在 GitHub 海外 runner 构建,显式覆盖 Dockerfile 的国内源默认值
  (官方 python 基础镜像 + 官方 PyPI);本地构建行为不变
- Actions 页也可选某个已有 tag 手动 `workflow_dispatch` 补跑;选分支触发则只构建自检、不推送
- 油猴脚本**不走此流程**:随 main 分支发布,bump 脚本头 `@version` 推送 main 即发版
  (详见 [浏览器脚本](userscript.md))
- **首次发布后**:GitHub → 个人页 Packages → gh-mirror → Package settings →
  Change visibility 设为 **public**,否则匿名 `docker pull` 会 401
  (私有期间拉取方需 `docker login ghcr.io` 用 GitHub PAT)
