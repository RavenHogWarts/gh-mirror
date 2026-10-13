# REST API

自动文档(Swagger UI)见面板的 `/api/docs`。

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

> 面板无鉴权,这些接口只应在本机/内网可达;公网部署时由反向代理层统一加认证,
> 见 [公网部署方案](deploy-public.md)。
