"""Gitea API 客户端:token 校验、仓库清单、migrate 建镜像、手动触发同步。"""

from __future__ import annotations

import httpx


class GiteaError(RuntimeError):
    pass


class GiteaClient:
    def __init__(self, base_url: str, token: str):
        self._client = httpx.AsyncClient(
            base_url=f"{base_url}/api/v1",
            headers={"Authorization": f"token {token}"},
            timeout=httpx.Timeout(30.0, connect=10.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        json: dict | None = None,
        params: dict | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        resp = await self._client.request(
            method, path, json=json, params=params,
            timeout=httpx.Timeout(timeout) if timeout else None,
        )
        if resp.status_code == 401:
            raise GiteaError("Gitea token 无效或已过期 (401)")
        return resp

    async def me(self) -> dict:
        resp = await self._request("GET", "/user")
        if resp.status_code != 200:
            raise GiteaError(f"获取 Gitea 用户失败: HTTP {resp.status_code} {resp.text[:200]}")
        return resp.json()

    # ---------------- 组织管理 ----------------

    async def get_org(self, name: str) -> dict | None:
        resp = await self._request("GET", f"/orgs/{name}")
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 404:
            return None
        raise GiteaError(f"查询组织 {name} 失败: HTTP {resp.status_code} {resp.text[:200]}")

    async def create_org(self, name: str, description: str = "") -> tuple[bool, str]:
        payload = {
            "username": name,
            "description": description,
            "visibility": "private",   # 备份用途默认私有组织
        }
        resp = await self._request("POST", "/orgs", payload)
        if resp.status_code == 201:
            return True, "已创建"
        detail = ""
        try:
            detail = resp.json().get("message", "") or resp.text[:200]
        except Exception:
            detail = resp.text[:200]
        return False, f"HTTP {resp.status_code}: {detail}"

    async def delete_org(self, name: str) -> tuple[bool, str]:
        resp = await self._request("DELETE", f"/orgs/{name}")
        if resp.status_code in (204, 200):
            return True, "已删除"
        detail = ""
        try:
            detail = resp.json().get("message", "") or resp.text[:200]
        except Exception:
            detail = resp.text[:200]
        return False, f"HTTP {resp.status_code}: {detail}"

    async def update_org_desc(self, name: str, description: str) -> tuple[bool, str]:
        """更新组织描述;缺省字段 Gitea 视为不变,只传 description 即可。"""
        resp = await self._request("PATCH", f"/orgs/{name}", {"description": description})
        if resp.status_code == 200:
            return True, "已更新"
        detail = ""
        try:
            detail = resp.json().get("message", "") or resp.text[:200]
        except Exception:
            detail = resp.text[:200]
        return False, f"HTTP {resp.status_code}: {detail}"

    async def list_org_repos(self, org: str) -> dict[str, dict]:
        """列某组织的全部仓库,key 为 owner/name 小写;组织不存在返回空。"""
        repos: dict[str, dict] = {}
        page = 1
        while page <= 50:
            resp = await self._request(
                "GET", f"/orgs/{org}/repos", None, {"limit": 50, "page": page},
            )
            if resp.status_code == 404:
                return {}
            if resp.status_code != 200:
                raise GiteaError(f"列出组织 {org} 仓库失败: HTTP {resp.status_code} {resp.text[:200]}")
            data = resp.json()
            if not isinstance(data, list) or not data:
                break
            for r in data:
                repos[f"{r['owner']['login']}/{r['name']}".lower()] = r
            if len(data) < 50:
                break
            page += 1
        return repos

    async def list_my_orgs(self) -> list[str]:
        """token 用户所属的全部 Gitea 组织名(孤儿扫描用,含面板未管理的)。"""
        names: list[str] = []
        page = 1
        while page <= 20:
            resp = await self._request("GET", "/user/orgs", None, {"limit": 50, "page": page})
            if resp.status_code != 200:
                raise GiteaError(f"列出我的组织失败: HTTP {resp.status_code} {resp.text[:200]}")
            data = resp.json()
            if not isinstance(data, list) or not data:
                break
            names.extend(o.get("username") or o.get("full_name") or "" for o in data)
            if len(data) < 50:
                break
            page += 1
        return [n for n in names if n]

    async def list_my_repos(self) -> dict[str, dict]:
        """列出 token 用户可见的仓库,key 为 owner/name 小写。"""
        repos: dict[str, dict] = {}
        page = 1
        while page <= 50:
            resp = await self._request(
                "GET", "/user/repos", None, {"limit": 50, "page": page},
            )
            if resp.status_code != 200:
                raise GiteaError(f"列出 Gitea 仓库失败: HTTP {resp.status_code} {resp.text[:200]}")
            data = resp.json()
            if not isinstance(data, list) or not data:
                break
            for r in data:
                repos[f"{r['owner']['login']}/{r['name']}".lower()] = r
            if len(data) < 50:
                break
            page += 1
        return repos

    async def get_repo(self, owner: str, name: str) -> dict | None:
        resp = await self._request("GET", f"/repos/{owner}/{name}")
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 404:
            return None
        raise GiteaError(f"查询 {owner}/{name} 失败: HTTP {resp.status_code} {resp.text[:200]}")

    async def migrate_mirror(
        self,
        *,
        clone_addr: str,
        repo_name: str,
        repo_owner: str,
        mirror_interval: str,
        private: bool,
        service: str = "github",
        github_token: str = "",
    ) -> tuple[bool, str]:
        """创建拉取镜像;返回 (是否成功, 说明)。201=新建 409=已存在。
        service=github 时迁移 issues/PR/releases/wiki 并携带 token;其他(git 等)仅镜像 git 数据。"""
        payload = {
            "clone_addr": clone_addr,
            "repo_name": repo_name,
            "repo_owner": repo_owner,
            "mirror": True,
            "mirror_interval": mirror_interval,
            "service": service,
            "private": private,
            "wiki": True,
            "releases": True,
            "issues": True,
            "pull_requests": True,
            "lfs": True,
        }
        if service == "github" and github_token:
            payload["auth_token"] = github_token
        # 大仓库 clone 耗时,migrate 是同步接口,给足超时
        resp = await self._request("POST", "/repos/migrate", payload, timeout=900.0)
        if resp.status_code == 201:
            return True, "已创建"
        if resp.status_code == 409:
            return True, "已存在(409)"
        detail = ""
        try:
            body = resp.json()
            detail = body.get("message") or str(body)[:200]
        except Exception:
            detail = resp.text[:200]
        return False, f"HTTP {resp.status_code}: {detail}"

    async def mirror_sync(self, owner: str, name: str) -> tuple[bool, str]:
        """手动触发一次镜像拉取(Gitea 的 Synchronize Now)。"""
        resp = await self._request("POST", f"/repos/{owner}/{name}/mirror-sync", timeout=300.0)
        if resp.status_code == 200:
            return True, "已触发同步"
        return False, f"HTTP {resp.status_code}: {resp.text[:200]}"

    async def delete_repo(self, owner: str, name: str) -> tuple[bool, str]:
        """删除镜像仓库本体(破坏性,调用方负责确认)。"""
        resp = await self._request("DELETE", f"/repos/{owner}/{name}")
        if resp.status_code in (204, 200):
            return True, "已删除"
        detail = ""
        try:
            detail = resp.json().get("message", "") or resp.text[:200]
        except Exception:
            detail = resp.text[:200]
        return False, f"HTTP {resp.status_code}: {detail}"

    async def transfer_repo(self, owner: str, name: str, new_owner: str) -> tuple[bool, str]:
        """把仓库转移到另一命名空间(组织);镜像属性随仓库保留。"""
        resp = await self._request(
            "POST", f"/repos/{owner}/{name}/transfer",
            {"new_owner": new_owner}, timeout=120.0,
        )
        if resp.status_code == 202:
            return True, "已转移"
        detail = ""
        try:
            detail = resp.json().get("message", "") or resp.text[:200]
        except Exception:
            detail = resp.text[:200]
        return False, f"HTTP {resp.status_code}: {detail}"
