---
title: Linux 安装
description: 在 Linux 服务器上部署 VanBotJS
---

# Linux 安装

## 前置要求

- **Node.js ≥ 18**（含 npm）

## 安装 Node.js

```bash
# Ubuntu / Debian（用 nvm 更省心）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 或用 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
```

## 克隆项目并安装依赖

```bash
git clone <你的仓库地址> VanBotJS
cd VanBotJS
npm install
```

> `skia-canvas` 等原生依赖编译失败会被自动忽略（降级为文本输出），不影响运行。

## 配置与启动

```bash
cp config.example.json config.json   # 按需编辑 config.json（接入机器人、开启插件）
van run                              # 推荐（等价于 npm run dev）
```

## 常驻守护（后台运行）

**pm2：**

```bash
npm i -g pm2
pm2 start "van run" --name vanbot
pm2 save && pm2 startup            # 开机自启
pm2 logs vanbot                    # 查看日志
```

**systemd（Ubuntu/Debian）：**

```ini
# /etc/systemd/system/vanbot.service
[Unit]
Description=VanBotJS Bot
After=network.target

[Service]
WorkingDirectory=/opt/VanBotJS
ExecStart=/usr/bin/van run
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now vanbot
```

## 注意事项

- 微信服务号 / webhook 等需要**公网可达回调**的平台，服务器需有公网 IP 或配内网穿透；
- `douyin` 适配器需要 Edge/Chrome 浏览器，无桌面环境（纯 CLI 服务器）时请设 `enable: false`；
- 程序内置单实例锁，同一目录不会重复启动。
