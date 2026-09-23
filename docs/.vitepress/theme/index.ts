import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './style.css'
import PluginCommunity from './components/PluginCommunity.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('PluginCommunity', PluginCommunity)
  },
} satisfies Theme
