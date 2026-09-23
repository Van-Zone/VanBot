---
title: 目录结构
description: VanBotJS 项目结构说明
---

# 目录结构

```
VanBotJS/
├── src/
│   ├── index.ts                 # 启动入口：读 config.json，创建适配器，加载插件
│   ├── assets/                  # 框架静态资源（如 WebUI logo）
│   ├── core/                    # 内核
│   │   ├── config.ts            # 配置类型定义（适配器类型可外置扩展）
│   │   ├── capabilities.ts      # 会话能力体系（CAP / Capabilities / hasCapabilities）
│   │   ├── sendPipeline.ts      # 发送降级（applySendFallback）
│   │   ├── eventPipeline.ts     # 接收归一化（traceId / ID 字符串 / 未知段占位）
│   │   ├── middleware.ts        # 中间件 + 快照记录
│   │   ├── pluginContext.ts     # definePlugin + ctx（副作用追踪 / Skill / 代理 API）
│   │   ├── pluginManager.ts     # 插件加载 / 热插拔 / 热重载
│   │   ├── pluginApi.ts         # 代理 API（受控能力层，权限两道闸门）
│   │   ├── skillRegistry.ts     # 中立 Skill 注册表（命令桥 / 函数调用描述）
│   │   ├── botRegistry.ts       # 机器人注册表
│   │   ├── eventBus.ts          # 全局事件总线
│   │   └── models/              # BotEvent / MessageSegment
│   ├── adapter/                 # 适配器（按需安装；每个子目录自带 package.json 声明依赖）
│   │   └── <name>/              # client.ts / converter.ts / types.ts / package.json
│   └── testing/mockAdapter.ts   # 纯内存 Mock 适配器（插件单元测试）
├── test/                        # 内核单元测试（node:test，npm test）
├── plugin/                      # ★ 插件目录（热插拔，每个 .ts 是一个插件）
│   ├── example_demo.ts          # definePlugin 示例插件
│   └── lib/                     # 插件共享依赖（子目录不当作插件加载）
├── bin/van.mjs                  # van 命令行（运行框架、安装/移除适配器与插件）
├── docs/                        # 文档站（VitePress 源目录）
├── config.example.json          # 配置模板（真实 config.json 含密钥，不入库）
├── config.json                  # 框架配置（支持热重载，.gitignore 忽略）
├── LICENSE
└── package.json                 # 主包只含最小运行依赖，平台 SDK 随适配器安装
```

::: tip 插件规则
- `plugin/` 下每个 `.ts` 文件是一个插件（`_` 开头跳过）；
- `lib/` 子目录放共享依赖，不会被当作插件加载；
- 新增 / 删除文件自动感知（热插拔），改动自动 reload（热重载）。
:::

::: tip 适配器依赖
每个适配器目录里的 `package.json` 用 `dependencies` 声明该平台所需的外部包，`van adapter install` 会自动安装；内核主包不内置这些平台 SDK。
:::
