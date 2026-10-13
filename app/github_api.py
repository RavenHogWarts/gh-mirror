"""GitHub REST API 客户端:分页枚举用户/组织仓库,顺带记录限速余量。"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

_PER_PAGE = 100
_MAX_PAGES = 50  # 100*50=5000 个仓库,足够个人账号


class GitHubError(RuntimeError):
    pass


@dataclass
class GHRepo:
    full_name: str
    name: str
    owner: str
    private: bool
    fork: bool
    html_url: str
    updated_at: str


class GitHubClient:
    def __init__(self, token: str):
        self._token = token
        self.rate_remaining: int | None = None
        self._client = httpx.AsyncClient(
            base_url="https://api.github.com",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=httpx.Timeout(30.0, connect=10.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, params: dict | None = None) -> httpx.Response:
        resp = await self._client.get(path, params=params)
        if remaining := resp.headers.get("x-ratelimit-remaining"):
            try:
                self.rate_remaining = int(remaining)
            except ValueError:
                pass
        if resp.status_code == 401:
            raise GitHubError("GitHub token 无效或已过期 (401)")
        if resp.status_code == 403:
            raise GitHubError(f"GitHub 拒绝访问 (403),可能触发限速:{resp.text[:300]}")
        resp.raise_for_status()
        return resp

    async def get_login(self) -> str:
        resp = await self._get("/user")
        return resp.json()["login"]

    async def list_own_repos(self, include_forks: bool) -> list[GHRepo]:
        """用户本人(affiliation=owner)名下全部仓库。"""
        repos: list[GHRepo] = []
        for page in range(1, _MAX_PAGES + 1):
            data = (await self._get(
                "/user/repos",
                {"affiliation": "owner", "per_page": _PER_PAGE, "page": page, "sort": "full_name"},
            )).json()
            if not data:
                break
            repos.extend(self._parse(r) for r in data)
            if len(data) < _PER_PAGE:
                break
        if not include_forks:
            repos = [r for r in repos if not r.fork]
        return repos

    async def list_org_repos(self, org: str, include_forks: bool) -> list[GHRepo]:
        repos: list[GHRepo] = []
        for page in range(1, _MAX_PAGES + 1):
            data = (await self._get(
                f"/orgs/{org}/repos",
                {"per_page": _PER_PAGE, "page": page, "sort": "full_name"},
            )).json()
            if not data:
                break
            repos.extend(self._parse(r) for r in data)
            if len(data) < _PER_PAGE:
                break
        if not include_forks:
            repos = [r for r in repos if not r.fork]
        return repos

    async def list_starred(self, include_forks: bool) -> list[GHRepo]:
        """当前账号 Star 的仓库(仅入目录,默认不同步)。"""
        repos: list[GHRepo] = []
        for page in range(1, _MAX_PAGES + 1):
            data = (await self._get(
                "/user/starred",
                {"per_page": _PER_PAGE, "page": page},
            )).json()
            if not data:
                break
            repos.extend(self._parse(r) for r in data)
            if len(data) < _PER_PAGE:
                break
        if not include_forks:
            repos = [r for r in repos if not r.fork]
        return repos

    @staticmethod
    def _parse(r: dict) -> GHRepo:
        return GHRepo(
            full_name=r["full_name"],
            name=r["name"],
            owner=r["owner"]["login"],
            private=r.get("private", False),
            fork=r.get("fork", False),
            html_url=r.get("html_url", ""),
            updated_at=r.get("updated_at", ""),
        )
