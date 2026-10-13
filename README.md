# gh-mirror — GitHub → Gitea 镜像备份面板

[![License](https://img.shields.io/github/license/RavenHogWarts/gh-mirror?logo=gnu)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fravenhogwarts%2Fgh--mirror-2496ED?logo=docker&logoColor=white)](https://github.com/RavenHogWarts/gh-mirror/pkgs/container/gh-mirror)

本地部署的 Python(FastAPI)+ Web UI 服务:把你的 GitHub 仓库(自己、组织、Star,
含 fork、私有仓库)列进**目录**,按需**启用同步**到自托管 Gitea 的**拉取镜像
(pull mirror)**,Gitea 随后按 `mirror_interval` 周期自动拉取,实现"建一次、持续同步"的备份。

```
GitHub ──枚举(自己/组织/Star)──▶ 目录(默认不同步) ──启用(指派组织)──▶ Gitea(Docker)
手动清单 ─────────────────────────┘                                       │
                                              Web UI :13655 ◀──状态/日志/手动同步─┘
```

## 模型:目录 + 显式启用

- **目录**:GitHub 枚举(自己 + 配置的组织 + Star)与手动清单只入目录,**默认不自动同步、不分配归属**
- **启用 = 指派组织**(表格下拉 / 批量栏 / 行内「启用」按钮)。默认目标规则:
  自己的仓库 → 同名组织(= GitHub 登录名,如 `RavenHogwarts`);GitHub 组织仓库 →
  `org_routes` 映射或同名组织(如 `Raven-Pensieve`);Star / 手动 → `default_org`(可选,
  未配置则显式选择)。目标组织不存在会**自动创建**
- **停止同步**(已镜像仓库):镜像**保留**在 Gitea 并继续自行按间隔拉取;面板不再管理、
  不再重建,位置记入 `known_mirrors`(行内显示"未启用 · 有镜像",可单独删除或重新启用)。
  注意 Gitea 的拉取镜像是 Gitea 自己周期执行的,API 无法暂停——要彻底停拉取需在 Gitea
  网页转普通仓库,或删除镜像
- **设为未分配**(仅未镜像仓库):取消启用计划,无任何副作用;已镜像的仓库不允许设为未分配
- **手动同步**:已镜像行「同步」触发拉取;待补/失败行「立即同步」= 建拉一体(没有镜像先创建,
  创建即完成首次拉取);批量同步同样建拉一体

## 功能

- **组织中心**:仓库一律镜像进 Gitea 组织(个人空间不放仓库),组织即分类;
  启用同步时目标组织不存在会自动创建;Gitea 里直接建的组织显示为「未管理」,一键导入纳管
- **目录 + 显式启用**:状态筛选(已镜像/待补/失败/未启用)+ 来源筛选(自己/组织/Star/手动)独立分类浏览
- **Star 列表**:把自己 Star 的仓库拉进目录(仅展示、默认不同步,10 分钟缓存省配额;
  设置里可关);与自己的/组织仓库重名时以自己/组织为准
- **批量操作**:勾选后底部浮出操作栏 —— 启用(默认规则)/ 移到指定组织 / 同步(建拉一体)/
  设为未分配(未镜像)/ 停止同步(已镜像,保留镜像)/ 删除镜像;孤儿表同样支持多选批量删除
- **自动对账**:定时(默认 60 分钟)只为**已启用**的仓库补建缺失镜像;幂等;未启用条目不参与
- **孤儿检测**:Gitea 里不属于任何目录条目(含已停止仓库的已知镜像位置)的仓库单独列出,
  可一键删除
- **Web 面板** `http://localhost:13655`:状态卡片、组织管理(卡片 + 菜单)、仓库表
  (搜索 / 状态与来源筛选 / 排序 / 行内启用与移动)、实时日志、手动"立即对账 / 立即同步 /
  删除镜像 / 立即备份";对账/批量同步进行时状态卡片显示进度条,日志逐仓输出
  `[i/n] 迁移 …`、在途心跳(每 60s)与完成耗时;亮 / 暗双主题(右上角切换,跟随系统偏好,记忆选择);
  新建组织、添加仓库均为按钮 + 弹窗
- **元数据**:建镜像时一并迁移 issues / PR / releases / wiki / LFS(Gitea 原生行为:
  元数据迁移一次,此后周期同步的是 git 数据)
- 纯 API 实现,无 git/docker CLI 依赖;未配置 token 时优雅降级,面板给出提示;
  GitHub/Gitea 启动时连接失败(如网络抖动)会在后续刷新中自动重试恢复,无需重启或重存配置

> ⚠ **删除 ≠ 停止同步**:删除镜像只影响 Gitea 侧;仍在启用清单(有指派)里的仓库,
> 下次对账会自动重建。想长期不要:停止同步(镜像保留)或设为未分配(未镜像),再按需删除镜像。

## 浏览器脚本(油猴)

在 GitHub 仓库页一键「加入目录 / 启用同步 / 立即拉取」,状态实时显示:

[![安装油猴脚本](https://img.shields.io/badge/%E5%AE%89%E8%A3%85%E6%B2%B9%E7%8C%B4%E8%84%9A%E6%9C%AC-GitHub%20Raw-181717?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/RavenHogWarts/gh-mirror/main/userscript/gh-mirror.user.js)
[![备用源](https://img.shields.io/badge/%E5%A4%87%E7%94%A8%E6%BA%90-jsDelivr-E84D3D?style=for-the-badge&logo=jsdelivr&logoColor=white)](https://fastly.jsdelivr.net/gh/RavenHogWarts/gh-mirror@main/userscript/gh-mirror.user.js)

安装即自动更新;面板地址与 `@connect` 说明见 **[docs/userscript.md](docs/userscript.md)**。

## 快速开始(Docker,推荐)

```bash
cp .env.example .env          # 可以先不填,只留文件
docker compose up -d --build  # Gitea :13654 + 面板 :13655 一起启动
```

> 懒得本地构建:发布 tag 后 CI 会自动把镜像推到
> `ghcr.io/ravenhogwarts/gh-mirror`(见 [docs/release.md](docs/release.md)),可直接:
>
> ```bash
> docker compose pull mirror && docker compose up -d
> ```
>
> ghcr.io 国内可能拉不动,失败就回到上面 `up -d --build` 的本地构建
> (Dockerfile 默认国内源)。

然后给 Gitea 建管理员、生成 token,再到面板 `http://localhost:13655` → 右上角「⚙ 设置」
粘贴两个 token 保存即可:

```bash
# scope 必须含 read:user(面板启动时调 GET /user 验证 token),漏掉会 403
docker compose exec -u git gitea gitea admin user create \
    --admin --username <你的用户名> --email you@local.com --password '强密码'
docker compose exec -u git gitea gitea admin user generate-access-token \
    --username <你的用户名> --token-name mirror \
    --scopes write:repository,write:organization,read:user
```

详细说明(网页配置、数据卷、本机直跑)见 **[docs/configuration.md](docs/configuration.md)**;
token 报错排查见 **[docs/operations.md](docs/operations.md)**。

<details>
<summary>本机直接跑(不进 Docker)</summary>

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env         # 填好 token(GITEA_URL 指向你的 Gitea)
python -m app                  # http://localhost:13655
```
</details>

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/userscript.md](docs/userscript.md) | 油猴脚本:安装、面板地址与 `@connect`、自动更新机制 |
| [docs/configuration.md](docs/configuration.md) | 网页配置项一览、`.env` 首次播种、数据卷存放 |
| [docs/deploy-public.md](docs/deploy-public.md) | **公网部署方案**:反向代理 / HTTPS / 认证 / 迁移 / 加固清单 |
| [docs/api.md](docs/api.md) | REST API 摘要(自动文档见 `/api/docs`) |
| [docs/operations.md](docs/operations.md) | 整站备份(`gitea dump`)与常见问题排查 |
| [docs/release.md](docs/release.md) | 版本发布流程(维护者) |

## 项目结构

```
app/
├── main.py          # FastAPI:路由 + 生命周期(定时对账)
├── service.py       # 对账/状态/日志核心
├── github_api.py    # GitHub REST(分页、限速余量)
├── gitea_api.py     # Gitea API(migrate/mirror-sync/清单)
├── config.py        # 环境变量 + .env 加载
└── web/static/      # 零构建前端(原生 JS)
Dockerfile / docker-compose.yml / .env.example
userscript/gh-mirror.user.js   # GitHub 页一键同步油猴脚本
.github/workflows/release.yml  # 打 v* tag 自动发镜像到 ghcr
```

## 许可证

[GPL-3.0](LICENSE)
