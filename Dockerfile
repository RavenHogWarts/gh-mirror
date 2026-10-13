# 纯 Python(API 调用,无需 git/docker 客户端),镜像极简
# 网络不通 docker.io 时可覆盖基础镜像源,例如:
#   docker compose build --build-arg BASE_IMAGE=public.ecr.aws/docker/library/python:3.12-slim
#   可用镜像源:docker.m.daocloud.io / public.ecr.aws/docker/library / docker.1ms.run
ARG BASE_IMAGE=docker.m.daocloud.io/library/python:3.12-slim
FROM ${BASE_IMAGE}

WORKDIR /app

# 国内网络 pypi 不稳时用清华源;网络正常可 build-arg 传空串恢复官方源
ARG PIP_INDEX_URL=https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    ${PIP_INDEX_URL:+-i ${PIP_INDEX_URL}}

COPY app ./app

# 配置持久化目录(config.json 由网页设置写入;named volume 首挂时继承此属主)
RUN useradd --create-home appuser && mkdir -p /app/data && chown -R appuser /app
USER appuser

EXPOSE 8000
CMD ["python", "-m", "app"]
