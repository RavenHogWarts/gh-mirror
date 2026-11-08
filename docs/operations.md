# 运维:备份与常见问题

## 关于"立即备份"与整站备份

Gitea 整站备份用官方 `gitea dump`。两种接法:

1. **推荐**:`BACKUP_CMD` 留空,备份仍按老办法跑(计划任务 + `docker exec … gitea dump`,
   或配套的 `backup-gitea.sh`),面板只管镜像对账。
2. 容器内执行:给 mirror 容器挂 `/var/run/docker.sock` 并让 `BACKUP_CMD` 调
   `docker exec … gitea dump`。方便但等于给面板容器宿主机 docker 权限,仅本地单机可接受。

恢复流程、升级注意事项见官方 [Backup and Restore](https://docs.gitea.com/administration/backup-and-restore)。

公网服务器部署时,备份还必须有一份**异地副本**(cron + rclone/rsync 推离机),
完整方案见 [公网部署方案 §4.8](deploy-public.md)。

## 常见问题

- **URL 型手动镜像报 "Authentication failed / could not read Username"**:目标
  仓库不公开或地址不可达(被拦截的域名也会这样)。URL 源仅支持**可匿名克隆的公开仓库**;
  要镜像本机/内网 git 地址,compose 已在 `ALLOWED_HOST_LIST` 放行 `private,loopback`,
  但注意**私有组织内的仓库匿名不可克隆**(Gitea 行为),跨实例镜像私有仓库需带凭据(P3)。
- **建镜像 HTTP 422 "You can not import from disallowed hosts" / 同步报
  "migration/cloning from 'github.com' is not allowed"**:Gitea 28 新出网策略所致。
  本机走 fake-ip 代理时,容器内 github.com 解析成 198.18.x,属受限网段,
  必须在 `GITEA__migrations__ALLOWED_HOST_LIST` 显式放行(compose 已含
  `198.18.0.0/15,private,loopback`);代理改了 fake-ip 段,这里要跟着改。
  旧键 `ALLOW_LOCALNETWORKS` 已废弃,单独使用只会放行内网,等于把 github.com 拒掉。
- **镜像从 GitHub 删了/转私有**:Gitea 侧同步开始报错但数据保留;停止无谓重试去
  Gitea 网页 Convert to Regular Repository,或面板里删除镜像+排除。
- **删除的镜像又回来了**:预期之内的设计——仍在 GitHub 清单/手动清单里的仓库,
  每次对账都会补建;不想让它回来请移出手动清单或改指派(排除功能在 P2)。
- **仓库显示"未分组织"**:还没创建组织或没设默认组织;面板「组织」区创建并设默认后
  点"立即对账"即可。
- **同名冲突 409**:不同来源同名仓库进了同一组织;改用单仓指派换组织或手动清单里
  指定目标名。
- **Gitea 403 "token does not have required scope(s) required=[read:user]"**:
  token 少了 `read:user`。重新生成一条带上(见 README「快速开始」),网页设置里换新值;
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
- 面板无鉴权,只适合本机/内网;要公网访问请按 [公网部署方案](deploy-public.md)
  走反向代理 + 认证,不要裸开放端口。
