---
title: 待测试
description: 当前版本已实现但仍需人工验证的变更项
---

# 待测试

- 图片节点的“Codex 生图”：不会创建新画布或重复的空生图节点；空图片节点无参考图时按提示词从零生成并填入该节点；已有图片时以原图迭代并新建连接结果，保留原图。
- Fork 的 Docker 发布：合并到 `main` 后确认 GitHub Actions 构建多架构镜像并推送 `ghcr.io/tyreamon/infinite-canvas:latest`；VPS 更新后验证拉取和启动。
