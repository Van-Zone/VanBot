import { defineConfig } from 'vitepress'

// 站点多语言：中文（样式复刻 keli.viki.moe：蓝色品牌色 + 深色代码块；
// 侧边栏参考 Zhin.js：全局统一侧边栏，三大板块 开始 / 平台 / 开发）
export default defineConfig({
  lang: 'zh-CN',
  title: 'VanBotJS',
  titleTemplate: 'Just run の Bot',
  description: 'Just run の Bot — 一套插件，全平台机器人',

  // 站点头部：favicon 与 SEO
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }],
    ['meta', { name: 'theme-color', content: '#527dec' }],
  ],

  // 本地搜索
  search: {
    provider: 'local',
  },

  // 代码块统一深色高亮（keli 同款黑底 #292d3e 由 style.css 覆盖）
  markdown: {
    theme: {
      light: 'github-dark',
      dark: 'github-dark',
    },
  },

  // 开发模式：把 /api 代理到本地后端服务（node server.js）
  vite: {
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  },

  themeConfig: {
    // 站点标识与 logo
    logo: '/logo.png',
    siteTitle: 'VanBotJS',

    // 顶部导航
    nav: [
      { text: '首页', link: '/' },
      { text: '简介', link: '/guide/quickstart', activeMatch: '/guide/' },
      { text: '安装', link: '/install/linux', activeMatch: '/install/' },
      { text: '平台', link: '/platform/qq', activeMatch: '/platform/' },
      { text: '开发', link: '/develop/plugin', activeMatch: '/develop/' },
      { text: '社区', link: '/community/', activeMatch: '/community/' },
    ],

    // 全局侧边栏（参考 Zhin.js：所有页面统一展示三大板块）
    sidebar: [
      {
        text: '开始',
        collapsed: false,
        items: [
          {
            text: '简介',
            items: [
              { text: '快速上手', link: '/guide/quickstart' },
              { text: '架构总览', link: '/guide/architecture' },
              { text: '目录结构', link: '/guide/directory' },
              { text: '配置文件', link: '/guide/configuration' },
              { text: '事件模型', link: '/guide/event' },
              { text: '消息段', link: '/guide/segment' },
              { text: '能力体系', link: '/guide/capabilities' },
              { text: '事件 / 发送流水线', link: '/guide/pipeline' },
            ],
          },
          {
            text: '安装',
            items: [
              { text: 'Linux', link: '/install/linux' },
              { text: 'Windows', link: '/install/windows' },
              { text: 'Android（Termux）', link: '/install/android-termux' },
              { text: '其他平台与常见问题', link: '/install/other' },
            ],
          },
        ],
      },
      {
        text: '平台',
        collapsed: false,
        items: [
          { text: '能力总览', link: '/platform/abilities' },
          { text: 'QQ 官方机器人', link: '/platform/qq' },
          { text: 'QQ API 参考（bot.callApi）', link: '/platform/qq-api' },
          { text: 'QQ（OneBot11 / NapCat）', link: '/platform/onebot11' },
          { text: 'Satori', link: '/platform/satori' },
          { text: 'Milky', link: '/platform/milky' },
          { text: 'Telegram', link: '/platform/telegram' },
          { text: '微信公众号 / 服务号', link: '/platform/wechat' },
          { text: '个人微信（wechat_db）', link: '/platform/wechat_db' },
          { text: '个人微信（weixin_oc）', link: '/platform/weixin-oc' },
          { text: 'KOOK', link: '/platform/kook' },
          { text: 'Discord', link: '/platform/discord' },
          { text: 'QQ 个人号（icqq）', link: '/platform/icqq' },
          { text: 'B站直播间', link: '/platform/bilibili-live' },
          { text: '抖音', link: '/platform/douyin' },
          { text: 'Minecraft', link: '/platform/minecraft' },
          { text: 'Sandbox（模拟环境）', link: '/platform/sandbox' },
        ],
      },
      {
        text: '开发',
        collapsed: false,
        items: [
          { text: '插件开发（definePlugin）', link: '/develop/plugin' },
          { text: 'Skill 技能', link: '/develop/skill' },
          { text: '代理 API（ctx.api）', link: '/develop/api' },
          { text: '单元测试（MockAdapter）', link: '/develop/testing' },
          { text: '内核能力', link: '/develop/core' },
        ],
      },
      {
        text: '社区',
        collapsed: false,
        items: [
          { text: '插件社区', link: '/community/' },
          { text: '插件安全检测', link: '/community/scan' },
        ],
      },
    ],

    // 页面大纲
    outline: { level: [2, 3], label: '本页目录' },

    // 文档页脚
    docFooter: { prev: '上一页', next: '下一页' },

    footer: {
      message: 'Just run の Bot · 一套插件，全平台机器人',
      copyright: 'VanBotJS · 基于 GPLv3 开源协议',
    },

    // 深色模式切换按钮文案
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '回到顶部',
    langMenuLabel: '语言',
  },
})
