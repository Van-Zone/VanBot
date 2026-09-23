---
title: 插件社区
---

# 插件社区

VanBotJS 插件社区：浏览、搜索、发布插件，每个插件都附带**安全检测报告**——重点展示它调用了哪些 `callApi`、有没有网络 / 文件 / 危险操作，安装前先看清它到底会做什么。

::: tip 使用方式
社区需要后端服务支持：先在 `docs` 目录运行 `node server.js`，插件数据存储在 `data/plugins.json`，手动编辑该文件即可管理插件。
:::

<ClientOnly>
  <PluginCommunity />
</ClientOnly>

## 更多

- [插件安全检测](./scan)：了解安全报告包含哪些内容、风险等级如何判定
