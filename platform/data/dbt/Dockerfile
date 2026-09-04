# syntax=docker/dockerfile:1.7
FROM python:3.12.11-slim

ARG DBT_CLICKHOUSE_VERSION=1.10.1
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url "${PIP_INDEX_URL}" "dbt-clickhouse==${DBT_CLICKHOUSE_VERSION}"

WORKDIR /app
RUN groupadd --gid 10001 dbt \
    && useradd --uid 10001 --gid 10001 --create-home dbt \
    && chown dbt:dbt /app
COPY --chown=dbt:dbt dbt_project.yml profiles.yml ./
COPY --chown=dbt:dbt macros ./macros
COPY --chown=dbt:dbt models ./models
COPY --chown=dbt:dbt tests ./tests

USER 10001:10001

ENTRYPOINT ["dbt"]
CMD ["build", "--project-dir", "/app", "--profiles-dir", "/app", "--target", "local"]
