"""python -m app 启动服务。"""

import uvicorn

from .config import load_settings

if __name__ == "__main__":
    s = load_settings()
    # access_log 关闭:面板每几秒轮询 5 个接口,访问日志只会刷屏 docker logs
    uvicorn.run("app.main:app", host="0.0.0.0", port=s.app_port, access_log=False)
