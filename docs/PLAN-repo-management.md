# gh-mirror 仓库管理增强方案 v2(组织中心模型)

> 状态:**P1 + P2 均已实施并上线(2026-10-13)**。P2 落地:排除清单(单/批量)、
> 批量指派、组织改名(建新→转移→改引用→删旧,实测转移保留镜像属性)、
> 任意 git URL 源(service=git,仅公开可匿名克隆;内网需 ALLOW_LOCALNETWORKS,
> 已在 compose 开启)。实测坑:私有组织内仓库匿名不可克隆;gitea.com 在用户网络被拦;
> migrate 失败(422)可能残留空仓库记录,删除重试即可。
> 未做(P3 候选):带凭据的私有 URL 源、孤儿忽略清单、指派规则批量编辑器。

## 核心决策

- **组织是一等公民**:面板创建/管理 Gitea 组织;组织即分类(如 personal / work / third-party)
- **个人空间不放镜像仓库**:登录用户仅用于 token 与建组织;migrate 一律 `repo_owner=组织`
- **每个仓库可指定归属组织**,支持随时改(转移所有权,秒级,不重新下载)
- 现有 17 个个人空间镜像**自动迁移**:对账时发现目标位置缺失但个人空间已有同名镜像 →
  直接 transfer,而不是重复建镜像(自愈式迁移,无需向导)

## 数据模型(config.json 新增键)

```jsonc
{
  "orgs": [
    {"name": "personal", "description": "自己的项目"},
    {"name": "third-party", "description": "他人/开源仓库"}
  ],
  "default_org": "personal",        // 自己 GitHub 仓库的默认归属
  "repo_assignments": {             // 单仓覆盖(可选,优先于 default_org)
    "RavenHogWarts/legado": "third-party"
  },
  "org_routes": {                   // GitHub 组织 → Gitea 组织;缺省 = 同名自动建
    "myorg": "work-myorg"
  },
  "extra_repos": [
    {"source": "torvalds/linux", "org": "third-party", "name": ""}
  ],
  "excluded": []                    // P2:排除自己账号的仓库
}
```

兼容:旧 config.json 无新键 → 默认空;首次升级对账即触发自愈迁移。

## 路由与命名规则

| 来源 | 归属组织 | Gitea 仓库名 |
| --- | --- | --- |
| 自己 GitHub 仓库 | `repo_assignments[full]` 或 `default_org` | 原名 |
| GitHub 组织仓库 | `org_routes[gh_org]` 或同名组织(自动创建) | 原名 |
| 手动添加(额外) | 添加时选择的组织(必选,不再默认个人空间) | 原名,可选自定义名 |

同名冲突(不同来源同名进同组织):Gitea 409 → 行状态"失败"+提示换组织或改目标名。
旧的 `owner--repo` 前缀规则废除——分类由组织承担。

## 后端改动

### GiteaClient 新增

| 方法 | 端点 |
| --- | --- |
| `list_org_repos(org)` | `GET /orgs/{org}/repos`(替代按用户列仓库;孤儿扫描与对账都用它) |
| `create_org(name, desc)` / `get_org` / `patch_org` | 组织管理 |
| `transfer_repo(owner, name, new_owner)` | `POST /repos/{owner}/{repo}/transfer` |
| `delete_repo(owner, name)` | 删除镜像 |

### MirrorService 改动

- `_collect_github()` 不变;`refresh_view()` 重写预期集合:
  - 预期 = {自己仓库→路由组织} ∪ {GitHub 组织仓库→路由组织} ∪ {extra→其组织}
  - Gitea 侧实际 = Σ 各受管组织 `list_org_repos` + 个人空间一次扫描(仅为发现待迁移项)
  - 孤儿 = 受管组织里有、预期集合没有;个人空间里的镜像显示为"待迁移"(下一轮对账自动 transfer)
- `_ensure_org(name)`:查→无则建(token 用户即 Owner,migrate/transfer 都有权限)
- `_ensure_placement(gitea_full, org)`:目标缺失且个人空间同名存在 → transfer;
  都不存在 → migrate;已有 → 跳过
- `reconcile()` 用 `_ensure_placement` 收敛所有预期仓库的位置

### REST API

| 端点 | 说明 |
| --- | --- |
| `GET /api/orgs` / `POST /api/orgs` / `PATCH /api/orgs/{name}` / `DELETE /api/orgs/{name}` | 组织管理(删仅限空组织) |
| `POST /api/repos/{full}/assign` `{org}` | 改归属:落配置 + 立即 transfer |
| `POST /api/extra` `{source, org, name?}` / `DELETE /api/extra/{source}` | 手动清单增删 |
| `DELETE /api/mirror/{org}/{repo}` | 删除镜像本体(确认;github 来源提示改用 assign 到"归档"组织或排除) |
| `GET /api/orphans` | 孤儿 + 待迁移两类分开返回 |
| `GET /api/repos` | 行增加 `org`、`origin`、`placement`(ok/pending-transfer/missing/failed) |

## UI 改动

- **组织管理区**(新):组织列表(名称/仓库数/描述),创建/编辑/删除(空)
- **仓库表加"组织"列**:每行下拉选择(改动即 assign+transfer);多选批量指派(P2)
- **添加额外仓库**(新):source 输入 + 组织下拉(必选)+ 可选目标名
- **孤儿/待迁移区**(新,折叠+角标):孤儿=打开/删除;待迁移=提示下轮对账自动搬运,
  附"立即对账"按钮
- **设置弹窗**:`default_org` 下拉(受管组织中选)、`org_routes` 简易编辑
- 首次升级横幅:"检测到 17 个个人空间镜像,对账后将自动迁入 default_org"

## 边界与风险

| 风险 | 处置 |
| --- | --- |
| 组织名与现有用户/组织撞名 | create_org 失败 → 明确报错,可换名 |
| transfer 后 mirror 是否继续按周期同步 | 设计上镜像属性随仓库保留;**实施时用 1 个仓库实测验证**,异常则退化为"删除重建"(重新 clone)并告知代价 |
| 删组织时含仓库 | Gitea 会拒绝;面板预检非空则提示先移走/删仓库 |
| 他人私有仓库 | 无法镜像(无授权),失败信息原样展示 |
| 大仓库首迁耗时 | migrate 超时 900s;transfer 不受影响(仅元数据) |
| 镜像转普通仓库无 API | 孤儿区给 Gitea 网页直达链接 |
| `default_org` 被删 | 校验:default_org 必须 ∈ orgs;删除时联动提示 |

## 分期

**P1(一次实施)**:组织 CRUD + 路由(default_org / repo_assignments / org_routes)+
额外仓库(带组织)+ transfer 自愈迁移 + 孤儿/待迁移区 + 仓库表组织列。

**P2**:排除清单、多选批量指派、组织改名联动、任意 git URL 源。

## 验证计划(运行实例)

1. 建 `personal` 组织 → 设 default_org → 对账 → 17 个镜像全部 transfer 迁入,
   个人空间清空,镜像同步仍正常(验证 transfer 保留 mirror)
2. 建 `third-party` → 添加 `octocat/Hello-World` → 落位 `third-party/Hello-World`
3. 行内改组织 → 秒级转移成功
4. 删空组织成功;含仓库组织被拒并提示
5. 手动在 Gitea 网页删一个 GitHub 上的仓库来源 → 下轮对账出现在"孤儿"
6. 回归:78 仓库枚举与 GitHub 连接不受影响
