<template>
  <div class="panel trend-panel">
    <div class="trend-head">
      <h4>📉 窗口日志量趋势</h4>
      <el-select v-model="rangeKey" size="small" class="trend-range" :disabled="hasFatal">
        <el-option v-for="r in RANGE_OPTIONS" :key="r.key" :label="r.label" :value="r.key"/>
      </el-select>
    </div>

    <div v-if="warning" class="trend-note trend-note-warn">
      <span class="trend-note-text">ℹ️ {{ warning }}</span>
      <el-button v-if="warnRetry" size="small" type="warning" plain @click="reload" :loading="store.loading">重试</el-button>
    </div>

    <div class="chart-wrap">
      <!-- 始终挂载，保证 ECharts 实例与 DOM 绑定不丢失 -->
      <div ref="chart" class="chart"></div>

      <div v-if="store.loading" class="trend-mask">
        <span>⏳ 正在加载窗口数据…</span>
      </div>

      <div v-else-if="!store.result" class="trend-mask trend-mask-fatal">
        <span>暂无窗口数据，请先生成日志</span>
        <el-button size="small" type="primary" @click="reload" :loading="store.loading">生成日志</el-button>
      </div>

      <div v-else-if="fatalMsg" class="trend-mask trend-mask-fatal">
        <span>⚠️ {{ fatalMsg }}</span>
        <el-button size="small" type="primary" @click="reload" :loading="store.loading">重试</el-button>
      </div>
    </div>

    <div v-if="!hasFatal && total > 0" class="trend-legend">
      <span><i class="dot" style="background:#38bdf8"></i>正常</span>
      <span v-if="enough"><i class="dot" style="background:#f87171"></i>异常窗口</span>
      <span v-if="enough"><i class="dash"></i>区间均值</span>
      <span class="trend-count">显示 {{ visible.items.length }}/{{ total }} 个窗口</span>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import { useLogStore } from '../store/log'

const store = useLogStore()
const chart = ref<HTMLDivElement>()
let inst: echarts.ECharts | null = null

/** 均值线与异常标记所需的最少窗口数：样本不足时不做统计推断 */
const MIN_SAMPLES = 3

const RANGE_OPTIONS = [
  { key: 'all', label: '全部窗口' },
  { key: 'first20', label: '前 20 个窗口' },
  { key: 'middle10', label: '中间 10 个窗口' },
  { key: 'last20', label: '后 20 个窗口' }
] as const
const rangeKey = ref<(typeof RANGE_OPTIONS)[number]['key']>('all')

/** 面板内所有图形只认这一份窗口数据 */
const windows = computed(() => {
  const ws = store.result?.windows
  return Array.isArray(ws) ? ws : []
})
const total = computed(() => windows.value.length)

/** 异常判定结果按 windowIndex 建索引，与柱子一一对齐，杜绝错位 */
const anomalyMap = computed(() => {
  const m = new Map<number, { isAnomaly: boolean }>()
  for (const a of store.result?.anomalies ?? []) m.set(a.windowIndex, { isAnomaly: !!a.isAnomaly })
  return m
})

/** 选中区间 [start, end) —— 柱子、均值线、异常标色、高亮全部使用这个切片 */
const visible = computed(() => {
  const n = windows.value.length
  if (!n) return { start: 0, end: 0, items: [] as typeof windows.value }
  let start = 0
  let end = n
  if (rangeKey.value === 'first20') { start = 0; end = Math.min(20, n) }
  else if (rangeKey.value === 'last20') { start = Math.max(0, n - 20); end = n }
  else if (rangeKey.value === 'middle10') {
    const len = Math.min(10, n)
    start = Math.floor((n - len) / 2)
    end = start + len
  }
  return { start, end, items: windows.value.slice(start, end) }
})

const enough = computed(() => visible.value.items.length >= MIN_SAMPLES)
/** 均值线必须与柱子同源：直接用选中区间的 count 计算 */
const average = computed(() => {
  const counts = visible.value.items.map(w => Number(w?.count) || 0)
  if (!counts.length) return 0
  return counts.reduce((a, b) => a + b, 0) / counts.length
})

const hasFatal = computed(() => !store.loading && (!store.result || total.value === 0 || !!store.error))
const fatalMsg = computed(() => {
  if (store.error) return `窗口数据加载失败：${store.error}`
  if (store.result && total.value === 0) return '接口返回的窗口数据为空（样本数为 0），无法绘制趋势与统计量'
  return ''
})

const warning = computed(() => {
  if (hasFatal.value || store.loading) return ''
  if (visible.value.items.length === 0) return '当前选中区间内没有窗口，请切换到其他区间。'
  if (total.value < MIN_SAMPLES) {
    return `样本不足：接口仅返回 ${total.value} 个窗口，至少需要 ${MIN_SAMPLES} 个窗口才能计算均值线与异常标记，已隐藏相关统计内容。`
  }
  if (visible.value.items.length < MIN_SAMPLES) {
    return `当前区间样本不足（仅 ${visible.value.items.length} 个窗口，至少需要 ${MIN_SAMPLES} 个），已隐藏均值线与异常标记，请切换区间或扩大范围。`
  }
  return ''
})
/** 只有"接口返回条数过少"这类数据问题提供重试；纯区间选择问题引导用户切换区间 */
const warnRetry = computed(() => !hasFatal.value && total.value > 0 && total.value < MIN_SAMPLES)

function reload() { store.generate() }

function render() {
  if (!inst) return
  const ws = windows.value
  const n = ws.length

  // 致命状态下图形无意义，清空实例避免残留上一次的均值线/柱子
  if (hasFatal.value) {
    inst.clear()
    return
  }

  const categories = ws.map((_, i) => 'W' + i)
  const { start, end } = visible.value
  const isFullRange = start === 0 && end === n

  // 柱子取值与颜色：在同一窗口数组上计算，区间外压暗、区间内按异常标红
  const barData = ws.map((w, i) => {
    const inRange = i >= start && i < end
    let color = '#334155' // 区间外
    if (inRange) {
      const anomalous = enough.value && !!anomalyMap.value.get(i)?.isAnomaly
      color = anomalous ? '#f87171' : '#38bdf8'
    }
    return { value: Number(w?.count) || 0, itemStyle: { color } }
  })

  const markLine: any = enough.value
    ? {
        silent: true,
        symbol: 'none',
        lineStyle: { color: '#f97316', type: 'dashed' },
        label: { color: '#f97316', fontSize: 10, formatter: `均值 ${average.value.toFixed(1)}` },
        data: [{ yAxis: Number(average.value.toFixed(4)) }]
      }
    : undefined

  // 高亮坐标取自同一份 category 数组，刻度与高亮区间天然对齐
  const markArea: any = !isFullRange && n > 0
    ? {
        silent: true,
        itemStyle: { color: 'rgba(56,189,248,0.10)' },
        data: [[{ xAxis: categories[start] }, { xAxis: categories[end - 1] }]]
      }
    : undefined

  inst.setOption({
    backgroundColor: 'transparent',
    grid: { left: 40, right: 15, top: 10, bottom: 25 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        const i = p?.dataIndex
        if (i == null || !ws[i]) return ''
        const inRange = i >= start && i < end
        const status = !inRange ? '区间外'
          : enough.value && anomalyMap.value.get(i)?.isAnomaly ? '⚠ 异常'
          : enough.value ? '正常'
          : '样本不足，未判定'
        return `${categories[i]}<br/>日志量：<b>${ws[i].count}</b><br/>状态：${status}`
      }
    },
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { color: '#94a3b8', fontSize: 9 }
    },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#94a3b8' } },
    series: [{
      type: 'bar',
      data: barData,
      // 零值窗口仍保留可见柱位，避免"柱子消失但均值线还在"
      barMaxWidth: 26,
      showBackground: true,
      backgroundStyle: { color: 'rgba(148,163,184,0.10)' },
      markLine,
      markArea
    }],
    animation: false
  } as any, true)
}

onMounted(() => {
  if (chart.value) {
    inst = echarts.init(chart.value)
    render()
  }
})
// 刷新（重新生成）、切换区间、错误状态变化都基于同一份窗口数据整体重算
watch([() => store.result, rangeKey, () => store.error, () => store.loading], render)
onUnmounted(() => { inst?.dispose(); inst = null })
</script>
<style scoped>
.trend-panel{background:#1e293b;border-radius:8px;padding:12px;border:1px solid #334155}
.trend-panel h4{color:#38bdf8;font-size:13px;margin-bottom:4px}
.trend-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.trend-range{width:140px}
.chart-wrap{position:relative;width:100%;height:200px}
.chart{width:100%;height:200px}
.trend-mask{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;color:#94a3b8;font-size:12px;background:rgba(30,41,59,.82);border-radius:6px;text-align:center;padding:0 16px}
.trend-mask-fatal{color:#fbbf24}
.trend-note{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;padding:5px 8px;border-radius:4px;background:#78350f33;border:1px solid #b4530955;font-size:11px;color:#fbbf24}
.trend-note-text{line-height:1.4}
.trend-legend{display:flex;align-items:center;gap:12px;margin-top:2px;font-size:10px;color:#94a3b8}
.trend-legend .dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.trend-legend .dash{display:inline-block;width:12px;border-top:2px dashed #f97316;margin-right:4px;vertical-align:3px}
.trend-count{margin-left:auto;color:#64748b}
</style>
