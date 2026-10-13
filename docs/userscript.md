# 浏览器脚本(油猴):GitHub 页面一键同步

[![安装油猴脚本](https://img.shields.io/badge/%E5%AE%89%E8%A3%85%E6%B2%B9%E7%8C%B4%E8%84%9A%E6%9C%AC-GitHub%20Raw-181717?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/RavenHogWarts/gh-mirror/main/userscript/gh-mirror.user.js)
[![备用源](https://img.shields.io/badge/%E5%A4%87%E7%94%A8%E6%BA%90-jsDelivr-E84D3D?style=for-the-badge&logo=jsdelivr&logoColor=white)](https://fastly.jsdelivr.net/gh/RavenHogWarts/gh-mirror@main/userscript/gh-mirror.user.js)

`userscript/gh-mirror.user.js` —— 在任意 GitHub 仓库页的头部操作区
(Notifications / Fork / Star 旁)注入一个 gh-mirror 按钮,免开面板即可操作:

- **按状态显示并行动**:未收录 →「加入 gh-mirror」、未启用 →「启用同步」——两者都会弹
  **选择面板**(与面板「添加仓库」一致):默认规则 / 指定组织 / 仅入目录 + 可选目标名;
  待补/失败 →「立即同步」(建拉一体);已镜像 →「立即同步」(拉取)
- 按钮悬停可看镜像位置 / 失败原因;操作结果以 Toast 提示
- 启用时若面板没配默认组织,会列出面板组织让你现场选一个

## 安装与更新

浏览器打开上面的安装链接,Tampermonkey 弹出确认页装完即自动更新——
脚本随 main 分支发布,`@version` 推上 main 就是发版,已安装用户由 Tampermonkey
例行检查后自动升级:

- 官方源:<https://raw.githubusercontent.com/RavenHogWarts/gh-mirror/main/userscript/gh-mirror.user.js>
- 国内 raw 打不开时用 jsDelivr 镜像(缓存最长约 12h,新版到账略延迟):
  <https://fastly.jsdelivr.net/gh/RavenHogWarts/gh-mirror@main/userscript/gh-mirror.user.js>

旧版手动粘贴安装的:删掉旧脚本,从上面链接重装一次,即纳入自动更新。

## 面板地址

默认面板地址 `http://localhost:13655`,用油猴菜单「gh-mirror:设置面板地址」修改。
面板不在本机时,需在脚本头部 `@connect` 追加对应域名:

| 面板位置 | 面板地址 | `@connect` 追加 |
| --- | --- | --- |
| 本机 | `http://localhost:13655` | 已内置,无需改 |
| 局域网 | `http://192.168.x.x:13655` | 已内置 `192.168.*`,无需改 |
| 公网域名 | `https://mirror.example.com` | `@connect mirror.example.com` |
| Tailscale / WireGuard | `http://100.x.y.z:13655` | `@connect 100.*`(WG 自建网段用 `10.*`) |

公网部署(认证、HTTPS、面板地址规划)见 [公网部署方案](deploy-public.md)。

## 设计取舍:为什么是油猴脚本而不是浏览器扩展

单文件零构建,`GM_xmlhttpRequest` 在扩展上下文发请求,天然绕过 CORS / 私网访问
限制,面板零改动;需要右键菜单 / 弹出窗时再升级扩展,逻辑可原样移植。

## 发布(维护者)

不走 CI:改好脚本头部 `@version`,推送 main 即发版(不写 `@updateURL/@downloadURL`,
Tampermonkey 以安装源 URL 检查更新,`@version` 变大自然升级)。
