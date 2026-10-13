# 公网部署方案(gh-mirror + Gitea)

> 面向想把 gh-mirror 从本机搬到公网服务器(或有远程访问需求)的用户。
> **结论先说:面板本身无鉴权,绝不能直接把 13655 端口暴露到公网。**
> 正确姿势是:服务只留在容器内网(不发布端口),由反向代理统一负责 HTTPS 与认证。
> 本文给出三条路线与可直接复制的完整配置。

## 目录

- [1. 风险面盘点(为什么不能直接开放端口)](#1-风险面盘点为什么不能直接开放端口)
- [2. 路线选型](#2-路线选型)
- [3. 路线 A:私网穿透,零公网端口](#3-路线-a私网穿透零公网端口)
- [4. 路线 B:VPS + Caddy 反代(推荐)](#4-路线-bvps--caddy-反代推荐)
- [5. 路线 C:Cloudflare Tunnel](#5-路线-ccloudflare-tunnel)
- [6. 从本机迁移到公网服务器](#6-从本机迁移到公网服务器)
- [7. 上线检查清单](#7-上线检查清单)

---

## 1. 风险面盘点(为什么不能直接开放端口)

先看清现状,再谈方案:

| 组件 | 现状 | 直接暴露公网的后果 |
| --- | --- | --- |
| 面板 :13655 | **无鉴权、无 CSRF 防护、无限流** | 任何拿到地址的人都能:改配置(`POST /api/config`)、批量删除全部镜像、触发同步;把 `GITEA_URL` 改指向攻击者的服务器后,面板会把 **GITEA_TOKEN 主动发过去**(token 外泄) |
| 面板读接口 | `GET /api/config` 只回脱敏值(token 不回显) | 但 `/api/logs`、`/api/repos`、`/api/status` 仍会泄露仓库清单与同步状态 |
| 配置文件 | token 明文存于 `mirror_data` 卷的 `config.json` | 服务器被攻破 = GitHub PAT + Gitea token 一起泄露 |
| Gitea :13654 | 自带账号体系,compose 已关注册(`INSTALL_LOCK`、`DISABLE_REGISTRATION`) | 相对安全,但仍需:HTTPS、强管理员密码、限流 / fail2ban、SSH 加固 |
| compose 默认端口 | `13654:3000`、`13655:8000` 绑定 **0.0.0.0** | 公网 VPS 上 `docker compose up -d` 的**瞬间**两个端口就对全网开放——迁移时最容易踩的坑 |

另外两个容易忽视的点:

- **Docker 发布的端口会绕过 ufw/iptables 的 INPUT 规则**(走 `DOCKER` 链)。所以"用防火墙挡住 13655"不可靠,必须靠端口绑定(`127.0.0.1:` 前缀)或干脆不发布端口。
- 面板前端与 API 全部使用绝对路径(`/api/...`、`/static/...`),**不支持挂在子路径**(如 `example.com/mirror/`)。公网入口请用独立子域名。

由此得出公网部署的固定架构(路线 B):

```
                 ┌──────────────── VPS(境外推荐)────────────────┐
浏览器 ──HTTPS──▶ Caddy :80/:443 ─┬─ git.example.com    ──▶ gitea:3000  (不发布端口)
油猴脚本 ────────────────────────┤
git SSH ──▶ :2222 ───────────────┼────────────────────▶ gitea:22      │
                                 └─ mirror.example.com ──▶ mirror:8000 (不发布端口,带认证)
                                                                  │
              gitea / mirror ──出站 HTTPS──▶ github.com ◀─────────┘
```

## 2. 路线选型

| 路线 | 公网端口 | 难度 | 适合 | 油猴脚本 |
| --- | --- | --- | --- | --- |
| [A. 私网穿透](#3-路线-a私网穿透零公网端口)(Tailscale / WireGuard) | 0 | ★ | 个人自用,追求最小攻击面 | ✓(`@connect` 加 VPN 网段) |
| [B. VPS + Caddy + 认证](#4-路线-bvps--caddy-反代推荐)(本文主线) | 80/443(+2222) | ★★★ | 想要正规域名、随时访问 | ✓(见 §4.4) |
| [C. Cloudflare Tunnel](#5-路线-ccloudflare-tunnel) + Access | 0 | ★★ | 服务器无公网 IP / 在 NAT 后 | 需先在浏览器登录过 Access |

服务器地域建议:

- **境外 VPS(香港/新加坡/日本/美国)**:出站直连 GitHub,镜像拉取无障碍;域名无需 ICP 备案。境内访问速度看线路,香港通常最好。
- **国内 VPS**:境内访问快,但域名走 80/443 必须 ICP 备案,且 gitea / mirror 容器出站访问 GitHub 需要配代理(见 §4.7)。

个人自用且不追求域名,优先路线 A,五分钟搞定且新增攻击面为零;想要"随时随地点开就能用"的正式站点,走路线 B。

## 3. 路线 A:私网穿透,零公网端口

不开放任何公网端口,用 VPN 组网把面板"带到身边"。面板继续无鉴权也不怕——只有你自己的设备可达。

以 Tailscale 为例(VPS 和自己的电脑/手机都装,登录同一账号):

```bash
# VPS 上
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
tailscale ip -4        # 记下 VPS 的 100.x.y.z
```

然后修改 `docker-compose.yml`,把两个端口**绑定到 Tailscale IP**(而不是默认的全接口):

```yaml
  gitea:
    ports:
      - "100.x.y.z:13654:3000"    # ← 换成你的 tailscale IP
  mirror:
    ports:
      - "100.x.y.z:13655:8000"
```

`docker compose up -d` 重建容器后,这两个端口只在 VPN 网内可达,公网扫描不到。

油猴脚本:

1. Tampermonkey 菜单「gh-mirror:设置面板地址」→ `http://100.x.y.z:13655`
2. 编辑已安装脚本,头部 `@connect` 区追加一行 `@connect 100.*`,保存

自建 WireGuard 同理(网段通常是 `10.8.0.0/24`,对应 `@connect 10.*`)。

> 注意:加入同一 VPN 的**所有设备**都能访问面板。家庭网络够用;如果 tailnet 里有不受控设备,回到路线 B 加认证。

## 4. 路线 B:VPS + Caddy 反代(推荐)

### 4.0 前置条件

- 一台 VPS(建议 2C4G 起步;磁盘按 GitHub 镜像总量 ×2 预留,git 对象 + Gitea 数据库 + 备份),已装 Docker
- 一个域名,在 DNS 服务商加两条 A 记录指向 VPS 公网 IP:
  - `git.example.com` → Gitea
  - `mirror.example.com` → 面板
- 等解析生效(Caddy 签发 Let's Encrypt 证书要求域名已能解析到本机)

以下所有 `example.com` 都换成你自己的域名。

### 4.1 docker-compose.yml(公网版)

与仓库默认版的差异:**gitea / mirror 不再发布 Web 端口**(流量全走 Caddy)、gitea SSH 单独映射 2222、新增 caddy 服务:

```yaml
services:
  gitea:
    image: docker.gitea.com/gitea:28.1.0
    container_name: gitea
    restart: unless-stopped
    environment:
      - USER_UID=1000
      - USER_GID=1000
      - GITEA__security__INSTALL_LOCK=true
      - GITEA__service__DISABLE_REGISTRATION=true
      # —— 公网地址(替换成你的域名)——
      - GITEA__server__DOMAIN=git.example.com
      - GITEA__server__ROOT_URL=https://git.example.com/
      - GITEA__server__SSH_DOMAIN=git.example.com
      - GITEA__server__SSH_PORT=2222          # 克隆地址里展示的 SSH 端口
      - GITEA__server__LFS_START_SERVER=true
      - GITEA__migrations__ALLOW_LOCALNETWORKS=true
    volumes:
      - gitea_data:/data
    ports:
      - "2222:22"          # git SSH;不需要 SSH 克隆可整段删除(只走 HTTPS 克隆)
    # 调试时可临时放开(仅本机可达):"127.0.0.1:13654:3000"

  mirror:
    image: ghcr.io/ravenhogwarts/gh-mirror:latest
    build: .
    container_name: mirror
    restart: unless-stopped
    environment:
      - GITEA_URL=http://gitea:3000               # 容器内网地址,保持不变
      - GITEA_PUBLIC_URL=https://git.example.com  # 面板跳转链接用的公网地址
      # 其余首次播种项按需保留;运行时配置统一在网页「⚙ 设置」里改
    volumes:
      - mirror_data:/app/data
    depends_on:
      - gitea
    # 不发布端口,仅经 Caddy;调试可临时放开 "127.0.0.1:13655:8000"
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"     # HTTP/3
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data      # 证书存这里,必须持久化
      - caddy_config:/config
    depends_on:
      - gitea
      - mirror

volumes:
  gitea_data:
  mirror_data:
  caddy_data:
  caddy_config:
```

> 镜像拉不动 ghcr.io 就删掉 `image:` 行用本地构建(`docker compose up -d --build`,Dockerfile 默认国内源),见主 README「快速开始」。

### 4.2 Caddyfile

与 compose 文件同目录建 `Caddyfile`(域名替换成自己的):

```caddyfile
git.example.com {
	encode zstd gzip
	request_body {
		max_size 4GB          # LFS 对象 / 大推送;按需调整
	}
	reverse_proxy gitea:3000
}

mirror.example.com {
	basic_auth {
		# 密码哈希生成:docker run --rm caddy:2 caddy hash-password --bcrypt
		alice $2a$14$REPLACE_WITH_YOUR_BCRYPT_HASH
	}
	reverse_proxy mirror:8000
}
```

- Caddy 自动申请/续期 Let's Encrypt 证书并强制 HTTP→HTTPS,无需 certbot。
- `basic_auth` 内是 `用户名 + bcrypt 哈希`,明文密码只在本机生成哈希时出现。
- Caddy 对请求体默认无大小限制,`request_body` 是为 LFS 明确兜底(若换 nginx,记得 `client_max_body_size 0`,否则大对象推送 413)。

### 4.3 启动与验证

```bash
docker compose up -d --build
docker compose logs -f caddy       # 看到 certificate obtained 即签发成功
```

逐项验证:

1. `https://git.example.com` → Gitea 登录页,证书有效
2. `https://mirror.example.com` → 弹出 Basic Auth,通过后面板正常轮询、日志滚动
3. 面板「⚙ 设置」确认 `GITEA_PUBLIC_URL` 为 `https://git.example.com`(compose 已播种;网页设置为准)
4. 首次初始化照旧:建 Gitea 管理员、生成 token、面板里粘贴两个 token(见主 README「快速开始」)
5. `git clone ssh://git@git.example.com:2222/org/repo.git` 或 HTTPS 克隆均可

油猴脚本:

1. Tampermonkey 菜单「gh-mirror:设置面板地址」→ `https://mirror.example.com`
2. 编辑已安装脚本,头部 `@connect` 区追加一行 `@connect mirror.example.com`,保存

### 4.4 面板认证方式与油猴脚本的兼容性

面板自己没有账号体系,认证全部加在 Caddy 层。三档按需选:

| 方式 | 配置量 | 说明 |
| --- | --- | --- |
| **Basic Auth**(上文默认) | 最低 | 浏览器记住密码后无感;配合强密码 + fail2ban(§4.6)足够个人使用 |
| **IP 白名单** | 低 | 家/公司固定出口 IP 时最干净,免密;可与 Basic Auth 叠加 |
| **forward-auth**(Authelia / oauth2-proxy,OIDC 登录) | 中 | 多用户、会话管理、2FA;cookie 会话对油猴脚本最友好 |

IP 白名单写法(替换 `mirror.example.com` 站点块):

```caddyfile
mirror.example.com {
	@allowed remote_ip 203.0.113.10 198.51.100.0/24
	handle @allowed {
		reverse_proxy mirror:8000
	}
	respond 403
}
```

**油猴脚本兼容性**(关键认知,别跳过):

- Tampermonkey 的 `GM_xmlhttpRequest` 默认携带目标域的 Cookie(未开 `anonymous` 标志)。因此**基于 Cookie 的会话认证(forward-auth / OAuth / Cloudflare Access)只要在浏览器里登录过一次,油猴按钮即可正常工作**。
- Basic Auth 没有 Cookie:扩展发起的请求是否复用浏览器缓存的凭据,因浏览器而异(Chrome 通常可以)。遇到按钮报 401,先在标签页打开一次面板完成认证再回 GitHub 页;重度依赖脚本的话,建议升级到 forward-auth。

> Gitea 子域(`git.example.com`)不加 Caddy 层认证——它有自己的登录体系,且 git/油猴之外的工具(clone、IDE)要直连。它的安全靠 HTTPS + 强密码 + 已关闭注册 + fail2ban。

### 4.5 Gitea 侧加固

- 公网地址(`ROOT_URL` / `SSH_DOMAIN` / `SSH_PORT`)已在 §4.1 的 compose 里配置;改这些必须 `docker compose up -d` 重建容器生效。
- Caddy 与 Gitea 同处容器内网(私网地址),Gitea 默认信任私网反代,日志里能记录真实客户端 IP,fail2ban 可用。
- 管理员强密码;普通按需开(注册已关,只能管理员手工建号)。
- SSH:容器默认仅允许密钥登录;不需要 SSH 协议就删掉 `2222:22` 映射,统一 HTTPS 克隆,少一个暴露面。
- 可选:Gitea 网页登录失败次数限流,交给 fail2ban(§4.6)。

### 4.6 系统层加固

```bash
# 基础防火墙(主要保护宿主机自身服务;容器发布端口走 DOCKER 链,不归 ufw 管,
# 而本文方案里发布的只有 caddy 80/443 和 gitea 2222,正是要开放的)
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80,443/tcp && ufw allow 2222/tcp
ufw enable

# SSH:key-only(/etc/ssh/sshd_config:PasswordAuthentication no)+ fail2ban
apt install fail2ban -y && systemctl enable --now fail2ban

# 自动安全更新
apt install unattended-upgrades -y && dpkg-reconfigure -f noninteractive unattended-upgrades
```

日志轮转已在 compose 里给 mirror 配了(`logging` 段);gitea / caddy 可照抄,防止 `docker_logs` 撑爆磁盘。

### 4.7 出站代理(仅国内 VPS 需要)

gitea 拉取镜像、面板调 GitHub API 都要出站访问 github.com。国内 VPS 给这两个服务加代理环境变量(替换成你自己的代理地址):

```yaml
  gitea:
    environment:
      - HTTPS_PROXY=http://192.168.x.x:7890
      - NO_PROXY=gitea,mirror,localhost,127.0.0.1
  mirror:
    environment:
      - HTTPS_PROXY=http://192.168.x.x:7890
      - NO_PROXY=gitea,mirror,localhost,127.0.0.1
```

`NO_PROXY` 必须包含容器互访的服务名,否则面板 → Gitea 的内网调用也被送进代理。

### 4.8 备份(必须异地)

公网机器被入侵 / 被删库 / 商家跑路,概率不高但后果是全灭。在[备份说明](operations.md)基础上,补一条"离开这台机器"的异地副本:

```bash
# 每日 04:00:gitea dump 到卷内 + 同步 mirror 配置 → /srv/offsite(再由 rclone/rsync 推向对象存储或另一台机器)
0 4 * * * docker exec -u git gitea sh -c 'mkdir -p /data/backups && gitea dump -c /data/gitea/conf/app.ini -t /tmp -f /data/backups/gitea-$(date +\%F).zip'
3 4 * * * docker run --rm -v gh-mirror_gitea-data:/g -v gh-mirror_mirror-data:/m -v /srv/offsite:/o alpine sh -c 'cp /g/backups/gitea-*.zip /o/ && cp /m/config.json /o/mirror-config.json && find /o -name "gitea-*.zip" -mtime +14 -delete'
```

> 卷名默认是 `<compose 项目目录名>_gitea-data`(项目目录叫 `gh-mirror` 即如上);
> 用 `docker volume ls` 确认实际名字。

注意 `mirror-config.json` 含**明文 token**:异地存放位置要加密(`age`/`openssl enc`)或保证存储侧访问控制。恢复流程见 Gitea 官方 [Backup and Restore](https://docs.gitea.com/administration/backup-and-restore)。

### 4.9 升级

```bash
docker compose pull && docker compose up -d
```

升级 gh-mirror 前先跑一次 §4.8 的备份;Gitea 大版本升级同样先 dump。不建议 watchtower 之类的自动更新——这套栈是"备份本体",求稳。

### 4.10 监控

- 磁盘是第一杀手(镜像只增不减 + 备份堆积 + SQLite 怕磁盘满):`docker system df` 定期看,或上个 uptime-kuma 顺带盯磁盘告警。
- `docker compose logs -f mirror gitea caddy` 三处日志,出错先看这里。

## 5. 路线 C:Cloudflare Tunnel

服务器不开任何入站端口(连 80/443 都不用),由 cloudflared 主动向 Cloudflare 建立隧道;认证用 Cloudflare Access(邮箱 OTP / OIDC)。适合服务器在 NAT 后、或不想维护证书与防火墙的场景。

1. Cloudflare Zero Trust 控制台建 Tunnel,拿到 token
2. compose 加一个服务:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token <你的TUNNEL_TOKEN>
```

3. 控制台里把 `git.example.com` → `http://gitea:3000`、`mirror.example.com` → `http://mirror:8000`(compose 内网名即可);gitea / mirror 照 §4.1 不发布端口,`ROOT_URL` 同样指到公网域名
4. Zero Trust → Access → Applications 给两个子域配策略(如邮箱白名单)

**代价与注意**:

- 国内直连 Cloudflare 边缘质量一般,大仓库 clone/push 速度可能明显劣于路线 B;大流量也不符合 CF 免费条款精神,镜像站慎用。
- 油猴脚本:Access 是 Cookie 会话——先在浏览器里打开过一次面板完成登录,`GM_xmlhttpRequest` 携带该 Cookie 即可通过(见 §4.4)。
- git SSH 无法直接走 Tunnel(需客户端 `cloudflared access ssh` 辅助),统一用 HTTPS 克隆即可。

## 6. 从本机迁移到公网服务器

两种方式,按"旧数据要不要保留"选:

### 方式一:全新部署,让对账重建(推荐)

这套工具的数据本来就是 GitHub 的镜像,天然适合重建:

1. 公网服务器按 §4 全新 `up -d`,建管理员、生成 token
2. 把旧机 `mirror_data` 卷里的 `config.json` 拷到新机同卷(组织、指派、手动清单全套迁移;token 也在里面,注意传输安全),或干脆在网页设置里手工重填
3. 面板里启用仓库 → 立即对账,镜像逐个重建(issues/PR/releases 元数据会随 migrate 重新迁移一次)

### 方式二:原样搬迁数据卷

适合 Gitea 里有大量手工数据、不想重新拉取(流量/时间)的场景:

```bash
# 旧机:停栈、打包两个卷
docker compose stop
docker run --rm -v gh-mirror_gitea-data:/data alpine tar czf - -C /data . | ssh vps 'cat > /tmp/gitea-data.tgz'
docker run --rm -v gh-mirror_mirror-data:/data alpine tar czf - -C /data . | ssh vps 'cat > /tmp/mirror-data.tgz'

# 新机:按 §4.1 的公网版 compose 先 up -d 再 down(创建出卷),或手工 docker volume create
# (卷名 = <项目目录名>_<卷名>,如 gh-mirror_gitea-data,以 docker volume ls 为准)
docker compose down
docker run --rm -i -v gh-mirror_gitea-data:/data alpine tar xzf - -C /data < /tmp/gitea-data.tgz
docker run --rm -i -v gh-mirror_mirror-data:/data alpine tar xzf - -C /data < /tmp/mirror-data.tgz
docker compose up -d
```

### 迁移后必改清单

| 项 | 在哪改 | 值 |
| --- | --- | --- |
| Gitea `ROOT_URL` / `DOMAIN` / `SSH_DOMAIN` / `SSH_PORT` | compose 环境变量,`up -d` 生效 | `https://git.example.com` 等 |
| `GITEA_PUBLIC_URL` | 面板「⚙ 设置」 | `https://git.example.com` |
| `GITEA_URL` | 不改 | `http://gitea:3000`(容器内网) |
| token | 不改 | 随 config.json 迁移或重填 |
| 油猴面板地址 + `@connect` | Tampermonkey | `https://mirror.example.com` |
| DNS | 域名服务商 | 两条记录指向新 VPS |

## 7. 上线检查清单

全部打勾再认为"公网部署完成":

- [ ] `docker compose ps` 里 gitea / mirror **没有**发布到 `0.0.0.0` 的端口(只剩 caddy 80/443、可选 gitea 2222)
- [ ] `https://git.example.com` 与 `https://mirror.example.com` 证书有效,HTTP 自动跳 HTTPS
- [ ] 面板域名**未认证直接访问被拒**(Basic Auth 弹窗 / forward-auth 跳登录 / 403)
- [ ] 面板能列出 GitHub 目录、能触发一次同步且 Gitea 侧成功收到镜像(出站连通)
- [ ] Gitea 注册入口关闭(`DISABLE_REGISTRATION`),管理员强密码
- [ ] 面板「⚙ 设置」里 `GITEA_PUBLIC_URL` 是公网地址
- [ ] 油猴脚本:面板地址已改、`@connect` 已加域名、GitHub 页按钮四态 + 操作正常
- [ ] ufw 只放行 22/80/443(+2222);sshd 仅密钥登录;fail2ban 运行中
- [ ] 备份 cron 生效,异地副本落盘,**恢复流程演练过一次**
- [ ] 磁盘告警已设;三个容器日志轮转已配
- [ ] (国内 VPS)gitea / mirror 出站代理生效,GitHub API 与镜像拉取正常
