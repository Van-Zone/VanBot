---
title: 配置文件
description: config.json 结构与热重载
---

# 配置文件

`config.json` 顶层有三个字段：`bots`（机器人数组）、`plugins`（插件开关）、`hotReload`（插件热加载开关，默认 true）。

## bots（机器人实例）

| 字段 | 说明 |
| --- | --- |
| `botId` | 框架内唯一标识 |
| `type` | 适配器类型：`onebot11 \| milky \| satori \| wechat \| bilibili_live \| qq \| telegram \| kook \| discord \| weixin_oc \| icqq \| douyin` |
| `enable` | 是否启用（默认 true；`false` 跳过启动，热重载生效） |
| `mode` | 连接模式（onebot11/milky/satori 用 `ws_client / ws_reverse / http`；qq 用 `websocket / websockets / webhook`） |
| `port / path` | 反向 WS / HTTP 的监听端口与路径 |
| `url` | 正向 WS 连接地址 |
| `token` | 鉴权 token（各平台密钥） |
| `ignoreSelf` | 忽略机器人自己产生的消息（默认 true，防死循环/刷屏） |
| `…` | 各适配器专有字段（appId/appSecret/intents/roomId/…），见[平台](/platform/qq) |

## plugins（插件配置）

```json
"plugins": {
  "example_demo": true,                   // 布尔开关
  "example_demo": {
    "enable": true,                   // 对象形式：开关 + 代理 API 白名单
    "apis": ["plugin.list"]           // 允许该插件调用的代理 API（可再收窄）
  }
}
```

插件 API 权限为**两道闸门取交集**：插件 `definePlugin` 里声明的 `apis` ∩ 本处 `apis` 白名单。未写 `apis` 视为不额外限制（跟随插件声明）；空数组 `[]` 表示全部禁用。

## 热重载

- `bots` 变化 → 新增自动启动、删除自动断开、变更自动重建重连；
- `plugins` 变化 → 自动启用 / 禁用对应插件（含动态加载此前未加载的）；
- JSON 格式错误 → 保持原配置继续运行并打印错误。

::: warning
修改 `hotReload` 本身不影响已运行的监听。微信服务号等依赖回调 URL 的平台，配置变更重建适配器时会同步更新回调路由。
:::
