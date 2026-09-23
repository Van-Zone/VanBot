---
title: Windows 安装
description: 在 Windows 上部署 VanBotJS
---

# Windows 安装

## 1. 安装 Node.js

- 到 [nodejs.org](https://nodejs.org/) 下载 **LTS 版** `.msi` 安装包，一路下一步；
- 装完打开 PowerShell（或 CMD）验证：

```powershell
node -v
npm -v
```

## 2. 获取项目并安装依赖

```powershell
cd C:\Users\<你>\Desktop
git clone <你的仓库地址> VanBotJS
cd VanBotJS
npm install
```

> 若 `skia-canvas` 原生编译报错，忽略即可——加载失败会自动降级为文本输出。

## 3. 配置与启动

```powershell
# 编辑 config.json（接入机器人、开启插件）
van run              # 推荐（等价于 npm run dev）
```

## 4. 后台常驻

- **简单方式**：PowerShell 窗口挂着，或
- **开机自启**：任务计划程序 / NSSM 注册为服务：

```powershell
nssm install VanBotJS "C:\Program Files\nodejs\npx.cmd" "tsx src/index.ts"
nssm set VanBotJS AppDirectory "C:\Users\<你>\Desktop\VanBotJS"
nssm start VanBotJS
```

## 注意事项

- 微信服务号回调需公网地址（http 80 / https 443），本地测试可用内网穿透；
- 抖音适配器默认用系统 Edge，Windows 直接可用；
- 程序内置单实例锁，同一目录不会重复启动。
