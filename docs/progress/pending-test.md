---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

- 图片节点的“Codex 迭代”：确认提示词和上游图片素材作为参考、当前图片作为主要编辑对象；生成结果上传后创建新图片节点并连接来源，原节点保留。
- Fork 的 Docker 发布：合并到 `main` 后确认 GitHub Actions 构建多架构镜像并推送 `ghcr.io/tyreamon/infinite-canvas:latest`；VPS 更新后验证拉取和启动。
