# 配置管理

## 运行时配置(网页设置)

运行时配置的唯一事实源是 `mirror_data` 卷里的 `/app/data/config.json`,
在面板「⚙ 设置」中修改,保存后:校验 → 落盘 → 重建 API 客户端 → 后台重新
自检连接 → 调度器按新周期运行,**全程无需重启容器**。

- 优先级:`config.json` > 首次播种(env/.env)> 代码默认值
- token 字段**只写不回显**:界面只显示"已设置(尾号)",留空提交=保持不变
- 例外:面板自身端口(`APP_PORT`,容器内固定 8000)启动前就要确定,不走网页;
  宿主机端口在 compose 的 `ports` 映射里改
- 安全提示:token 明文存于卷内 config.json(与 .env 同级风险);面板无鉴权,
  只在本机/内网用(公网部署见 [公网部署方案](deploy-public.md));
  `GET /api/config` 永远只返回脱敏值

## 配置项(均可网页修改)

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | — | GitHub PAT(repo + read:org) |
| `GITHUB_ORGS` | 空 | 额外纳入目录的组织,逗号分隔 |
| `INCLUDE_FORKS` | 1 | 是否包含 fork |
| `INCLUDE_STARS` | 1 | 是否把 Star 列表拉进目录(仅展示,不同步) |
| `GITEA_URL` | http://gitea:3000 | Gitea API 地址(容器内;本机直跑填 http://localhost:13654) |
| `GITEA_PUBLIC_URL` | 同上 | 浏览器可达地址(面板跳转链接用) |
| `GITEA_TOKEN` | — | Gitea token(repository + organization + **user 读权限**;CLI 加 `read:user`) |
| `GITEA_OWNER` | 登录名 | 镜像统一放进哪个命名空间 |
| `MIRROR_INTERVAL` | 8h0m0s | Gitea 拉取周期;下限受 Gitea `MIN_INTERVAL`(默认 10m)约束 |
| `RECONCILE_EVERY_MIN` | 60 | 面板自动对账周期(分钟);0=仅手动 |
| `BACKUP_CMD` | 空 | "立即备份"按钮执行的命令 |
| `APP_PORT` | 8000 | 面板端口(**唯一不走网页的项**,env/compose 层面改) |

> 兼容旧方式:`.env` / 环境变量仍可作首次播种——数据卷里还没有配置文件时
> 读取一次初始化;之后一切以网页设置为准。若走这条路,改完 `.env` 后要用
> `docker compose up -d`(重建容器)而不是 `restart`(环境变量只在容器创建时注入)。

## 数据存放

- 默认 Gitea 数据(数据库/仓库/LFS)在 named volume `gitea_data` 里:`down`、重建容器
  都不会丢,只有 `docker compose down -v` 才删除。实际位置:
  `docker volume inspect gh-mirror_gitea-data`(Docker Desktop WSL2 后端在
  `\\wsl.localhost\docker-desktop-data\...\volumes\` 下)。
- 想让数据目录直接可见(挂到 `E:\WorkSpace\Python\gh-mirror\gitea-data`):
  compose 里有注释好的备选 bind mount 写法。**Windows 下绑定挂载走 9p/gRPC-FUSE,
  IO 慢且 SQLite 有锁风险,仓库多时不建议**;Linux 宿主机则可以放心用。
- 无论哪种存放方式,真正的备份都应定期跑 `gitea dump`(见
  [运维与常见问题](operations.md))导出 zip 并同步到异地,而不是依赖运行目录本身。
