# gh-mirror — GitHub → Gitea 镜像备份面板

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
- **目录 + 显式启用**:见上文模型节;状态筛选(已镜像/待补/失败/未启用)+
  来源筛选(自己/组织/Star/手动)独立分类浏览
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

## 快速开始(Docker,推荐)

可以一条命令先把整套栈拉起来,token 之后补——面板没 token 也能跑(只提示"未配置"):

```bash
cp .env.example .env          # 可以先不填,只留文件
docker compose up -d --build  # Gitea :13654 + 面板 :13655 一起启动
```

> 懒得本地构建:发布 tag 后 CI 会自动把镜像推到
> `ghcr.io/ravenhogwarts/gh-mirror`(见文末「版本发布」),可直接:
>
> ```bash
> docker compose pull mirror && docker compose up -d
> ```
>
> ghcr.io 国内可能拉不动,失败就回到上面 `up -d --build` 的本地构建
> (Dockerfile 默认国内源)。

然后给 Gitea 建管理员、生成 token(用户名换成你自己的,后面 `.env` 的
`GITEA_OWNER` 留空即默认用这个登录名):

```bash
docker compose exec -u git gitea gitea admin user create \
    --admin --username <你的用户名> --email you@local.com --password '强密码'

# scope 必须含 read:user(面板启动时调 GET /user 验证 token),漏掉会 403
docker compose exec -u git gitea gitea admin user generate-access-token \
    --username <你的用户名> --token-name mirror \
    --scopes write:repository,write:organization,read:user
```

token 只显示一次,立即复制。若报 `access token name has already been used`,
说明同名 token 已存在:换一个 `--token-name`(如 mirror2),或到 Gitea 网页
Settings → Applications 删掉旧的再生成。

**推荐填法:打开面板 `http://localhost:13655` → 右上角「⚙ 设置」→ 粘贴两个
token(GitHub PAT 在 https://github.com/settings/tokens 生成,勾 `repo`,镜像组织
仓库再加 `read:org`)→ 保存,即时生效,无需重启或改任何文件。**

> 兼容旧方式:`.env` / 环境变量仍可作首次播种——数据卷里还没有配置文件时
> 读取一次初始化;之后一切以网页设置为准。若走这条路,改完 `.env` 后要用
> `docker compose up -d`(重建容器)而不是 `restart`(环境变量只在容器创建时注入)。

## 浏览器脚本(油猴):GitHub 页面一键同步

`userscript/gh-mirror.user.js` —— 在任意 GitHub 仓库页的头部操作区
(Notifications / Fork / Star 旁)注入一个 gh-mirror 按钮,免开面板即可操作:

- **按状态显示并行动**:未收录 →「加入 gh-mirror」、未启用 →「启用同步」——两者都会弹
  **选择面板**(与面板「添加仓库」一致):默认规则 / 指定组织 / 仅入目录 + 可选目标名;
  待补/失败 →「立即同步」(建拉一体);已镜像 →「立即同步」(拉取)
- 按钮悬停可看镜像位置 / 失败原因;操作结果以 Toast 提示
- 启用时若面板没配默认组织,会列出面板组织让你现场选一个

安装:浏览器打开下面的安装链接,Tampermonkey 弹出确认页装完即自动更新——
脚本随 main 分支发布,`@version` 推上 main 就是发版,已安装用户由 Tampermonkey
例行检查后自动升级:

- 官方源:<https://raw.githubusercontent.com/RavenHogWarts/gh-mirror/main/userscript/gh-mirror.user.js>
- 国内 raw 打不开时用 jsDelivr 镜像(缓存最长约 12h,新版到账略延迟):
  <https://fastly.jsdelivr.net/gh/RavenHogWarts/gh-mirror@main/userscript/gh-mirror.user.js>

默认面板地址 `http://localhost:13655`,用油猴菜单「gh-mirror:设置面板地址」修改
(面板不在本机时需在脚本头部 `@connect` 追加对应域名)。
旧版手动粘贴安装的:删掉旧脚本,从上面链接重装一次,即纳入自动更新。

> 选择油猴脚本而非浏览器扩展:单文件零构建,`GM_xmlhttpRequest` 在扩展上下文发请求,
> 天然绕过 CORS / 私网访问限制,面板零改动;需要右键菜单 / 弹出窗时再升级扩展,
> 逻辑可原样移植。

## 配置管理(网页设置)

运行时配置的唯一事实源是 `mirror_data` 卷里的 `/app/data/config.json`,
在面板「⚙ 设置」中修改,保存后:校验 → 落盘 → 重建 API 客户端 → 后台重新
自检连接 → 调度器按新周期运行,**全程无需重启容器**。

- 优先级:`config.json` > 首次播种(env/.env)> 代码默认值
- token 字段**只写不回显**:界面只显示"已设置(尾号)",留空提交=保持不变
- 例外:面板自身端口(`APP_PORT`,容器内固定 8000)启动前就要确定,不走网页;
  宿主机端口在 compose 的 `ports` 映射里改
- 安全提示:token 明文存于卷内 config.json(与 .env 同级风险);面板无鉴权,
  只在本机/内网用;`GET /api/config` 永远只返回脱敏值

## 数据存放

- 默认 Gitea 数据(数据库/仓库/LFS)在 named volume `gitea_data` 里:`down`、重建容器
  都不会丢,只有 `docker compose down -v` 才删除。实际位置:
  `docker volume inspect gh-mirror_gitea-data`(Docker Desktop WSL2 后端在
  `\\wsl.localhost\docker-desktop-data\...\volumes\` 下)。
- 想让数据目录直接可见(挂到 `E:\WorkSpace\Python\gh-mirror\gitea-data`):
  compose 里有注释好的备选 bind mount 写法。**Windows 下绑定挂载走 9p/gRPC-FUSE,
  IO 慢且 SQLite 有锁风险,仓库多时不建议**;Linux 宿主机则可以放心用。
- 无论哪种存放方式,真正的备份都应定期跑 `gitea dump`(见"关于立即备份")导出 zip
  并同步到异地,而不是依赖运行目录本身。

## 本机直接跑(不进 Docker)

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env         # 填好 token(GITEA_URL 指向你的 Gitea)
python -m app                  # http://localhost:13655
```

## 配置项(均可网页修改,见上节)

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

## REST API(自动文档见 `/api/docs`)

- 状态:`GET /api/status`(含按来源计数)、`GET /api/repos`(含 origin/status/default_target)、
  `GET /api/orphans`、`GET /api/logs`(支持 `?after=seq` 增量;响应 `{seq, logs, reset}`)
- 列表接口带数据版本 ETag:内容未变回 304,轮询不再重复传输/序列化大列表
- 组织:`GET/POST /api/orgs`、`PATCH/DELETE /api/orgs/{name}`(删仅限空组织且无引用)、
  `POST /api/orgs/{name}/rename {new_name}`
- 启用/停止:`POST /api/repos/enable {repos[], org?}`(org 空=默认规则,同名/映射/默认组织,
  缺组织自动建)、`POST /api/repos/stop-bulk {repos[]}`(已镜像→停止同步保留镜像;
  未镜像→设为未分配,按仓库状态自动区分)
- 仓库:`POST /api/assign {full, org}`(指派/移动,所有来源生效)、
  `POST /api/repos/assign-bulk {repos[], org}`、
  `POST /api/repos/{owner}/{repo}/sync`(**建拉一体**:无镜像先创建)、
  `POST /api/repos/sync-bulk {targets[]}`、`DELETE /api/mirror/{org}/{repo}`、
  `POST /api/mirror/delete-bulk {targets[]}`
- 手动目录:`POST /api/extra {source, org?, name?}`(org 可空=仅入目录;source 可为 URL)、
  `DELETE /api/extra/{source}`(path 形式,自动支持 URL)
- 对账/备份:`POST /api/reconcile`、`POST /api/backup`
- 配置:`GET/POST /api/config`(POST 热生效;含 include_stars、known_mirrors)

## 关于"立即备份"与整站备份

Gitea 整站备份用官方 `gitea dump`。两种接法:

1. **推荐**:`BACKUP_CMD` 留空,备份仍按老办法跑(计划任务 + `docker exec … gitea dump`,
   或配套的 `backup-gitea.sh`),面板只管镜像对账。
2. 容器内执行:给 mirror 容器挂 `/var/run/docker.sock` 并让 `BACKUP_CMD` 调
   `docker exec … gitea dump`。方便但等于给面板容器宿主机 docker 权限,仅本地单机可接受。

恢复流程、升级注意事项见官方 [Backup and Restore](https://docs.gitea.com/administration/backup-and-restore)。

## 常见问题

- **URL 型手动镜像报 "Authentication failed / could not read Username"**:目标
  仓库不公开或地址不可达(被拦截的域名也会这样)。URL 源仅支持**可匿名克隆的公开仓库**;
  要镜像本机/内网 git 地址,compose 已开 `GITEA__migrations__ALLOW_LOCALNETWORKS=true`,
  但注意**私有组织内的仓库匿名不可克隆**(Gitea 行为),跨实例镜像私有仓库需带凭据(P3)。
- **镜像从 GitHub 删了/转私有**:Gitea 侧同步开始报错但数据保留;停止无谓重试去
  Gitea 网页 Convert to Regular Repository,或面板里删除镜像+排除。
- **删除的镜像又回来了**:预期之内的设计——仍在 GitHub 清单/手动清单里的仓库,
  每次对账都会补建;不想让它回来请移出手动清单或改指派(排除功能在 P2)。
- **仓库显示"未分组织"**:还没创建组织或没设默认组织;面板「组织」区创建并设默认后
  点"立即对账"即可。
- **同名冲突 409**:不同来源同名仓库进了同一组织;改用单仓指派换组织或手动清单里
  指定目标名。
- **Gitea 403 "token does not have required scope(s) required=[read:user]"**:
  token 少了 `read:user`。重新生成一条带上(见上文快速开始),网页设置里换新值;
  旧 token 可在 Gitea 网页 Settings → Applications 删除。
- **token 名字重复**(`access token name has already been used`):换
  `--token-name`,或先在网页删旧 token。
- **管理员建错了想重来**:
  `docker compose exec -u git gitea gitea admin user delete --username <名字>`
  (名下有仓库时会拒绝,先删仓库或用管理 API `DELETE /api/v1/admin/users/<名字>` + `{"purge":true}`);
  整体清零则 `docker compose down -v`(会删卷,慎用)。
- **`docker compose build` 拉不到 python 基础镜像**(auth.docker.io 连不通):
  Dockerfile 已默认走国内源(`docker.m.daocloud.io`)+ 清华 pip 源,一般无需处理;
  需要切换时:`docker compose build --build-arg BASE_IMAGE=public.ecr.aws/docker/library/python:3.12-slim`,
  网络正常想回官方源则 `--build-arg PIP_INDEX_URL=` 传空。
- **GitHub token 过期**:私有仓库同步开始 403 → 换新 token,除了更新 `.env`,
  已建镜像还要逐个 `PATCH /api/v1/repos/{owner}/{repo}` 更新 `mirror.auth_token`。
- **面板仓库列表为空**:看日志区是否 401/403;两个 token 都有效才能拉取,
  在「⚙ 设置」里修正保存即可。
- **同步间隔不生效**:Gitea 侧 `MIN_INTERVAL` 下限默认 10 分钟,`MIRROR_INTERVAL`
  不能小于它(可在 Gitea 的 app.ini `[mirror]` 调整)。
- 面板无鉴权,只适合本机/内网,不要暴露公网。

## 版本发布(维护者)

推送 `v*` tag 自动触发 [.github/workflows/release.yml](.github/workflows/release.yml):
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
  (安装链接见上文「浏览器脚本」一节)
- **首次发布后**:GitHub → 个人页 Packages → gh-mirror → Package settings →
  Change visibility 设为 **public**,否则匿名 `docker pull` 会 401
  (私有期间拉取方需 `docker login ghcr.io` 用 GitHub PAT)

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
.github/workflows/release.yml  # 打 v* tag 自动发镜像到 ghcr
```

## 许可证

[GPL-3.0](LICENSE)
