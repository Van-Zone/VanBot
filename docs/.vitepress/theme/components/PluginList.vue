<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({
  // 社区服务地址（文档部署后可改成线上社区域名）
  api: { type: String, default: 'http://localhost:8080' },
})

const plugins = ref([])
const loading = ref(true)
const error = ref('')

function riskClass(risk) {
  if (risk === '高') return 'high'
  if (risk === '中') return 'mid'
  return 'low'
}

onMounted(async () => {
  try {
    const r = await fetch(props.api + '/api/plugins')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json()
    plugins.value = j.data || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="plugin-list">
    <div v-if="loading" class="state">正在加载社区插件列表…</div>
    <div v-else-if="error" class="state err">
      无法加载插件列表（社区服务未启动？请先运行 <code>node community-web/server.js</code>）。<br>
      <span class="err-detail">{{ error }}</span>
    </div>
    <div v-else-if="!plugins.length" class="state">社区暂无插件，去 <a :href="api + '/submit.html'" target="_blank" rel="noopener">提交一个</a> 吧。</div>
    <div v-else class="grid">
      <a
        v-for="p in plugins"
        :key="p.id"
        :href="api + '/detail.html?id=' + p.id"
        target="_blank"
        rel="noopener"
        class="card"
      >
        <div class="head">
          <strong class="name">{{ p.name }}</strong>
          <span :class="'badge ' + riskClass(p.report?.risk)">{{ p.report?.risk || '低' }}风险</span>
        </div>
        <p class="desc">{{ p.description || '（暂无简介）' }}</p>
        <div class="meta">
          <span>v{{ p.version }}</span>
          <span>{{ p.author }}</span>
          <span>调用 API {{ p.report?.callApi?.length ?? 0 }}</span>
          <span>下载 {{ p.downloads ?? 0 }}</span>
        </div>
      </a>
    </div>
  </div>
</template>

<style scoped>
.plugin-list { margin: 16px 0; }
.state {
  padding: 24px;
  text-align: center;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
}
.state.err { color: var(--vp-c-danger-1); }
.err-detail { font-size: 12px; opacity: 0.7; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, transform 0.15s;
}
.card:hover {
  border-color: #527dec;
  transform: translateY(-2px);
  text-decoration: none;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.name { font-size: 15px; font-weight: 700; }
.desc {
  margin: 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--vp-c-text-3);
  border-top: 1px solid var(--vp-c-divider);
  padding-top: 8px;
}

.badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  padding: 2px 8px;
  flex-shrink: 0;
}
.badge.low { background: rgba(22, 163, 74, 0.12); color: #16a34a; }
.badge.mid { background: rgba(217, 119, 6, 0.12); color: #d97706; }
.badge.high { background: rgba(220, 38, 38, 0.12); color: #dc2626; }
</style>
