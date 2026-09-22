<template>
  <div class="panel">
    <div class="panel-header">
      <h4>📉 窗口日志量趋势</h4>
      <div v-if="windows.length" class="range-controls">
        <span class="range-label">区间</span>
        <el-select v-model.number="rangeStart" size="small" class="range-select">
          <el-option v-for="i in windows.length" :key="`start-${i - 1}`" :label="`W${i - 1}`" :value="i - 1"/>
        </el-select>
        <span class="range-separator">—</span>
        <el-select v-model.number="rangeEnd" size="small" class="range-select">
          <el-option v-for="i in windows.length" :key="`end-${i - 1}`" :label="`W${i - 1}`" :value="i - 1"/>
        </el-select>
      </div>
    </div>

    <div v-if="status.type === 'insufficient' || status.type === 'chart-warning'" class="notice warning">
      <span>{{ status.type === 'insufficient' ? `当前区间仅 ${selectedPoints.length} 个窗口，少于 ${MIN_SAMPLES} 个，暂不绘制平均值线和异常标记。` : status.message }}</span>
      <el-button size="small" :loading="store.loading" @click="retry">重试</el-button>
    </div>

    <div class="chart-wrap">
      <div ref="chart" class="chart"></div>

      <div v-if="status.type !== 'ok' && status.type !== 'insufficient' && status.type !== 'chart-warning'" class="state-overlay">
        <div class="state-card">
          <p :class="status.type === 'idle' ? 'state-title muted' : 'state-title'">{{ status.title }}</p>
          <p v-if="status.message" class="state-message">{{ status.message }}</p>
          <div class="state-actions">
            <el-button v-if="status.type === 'empty-range'" size="small" @click="resetRange">重置区间</el-button>
            <el-button size="small" type="primary" :loading="store.loading" @click="status.type === 'idle' ? store.generate() : retry()">
              {{ status.type === 'idle' ? '生成日志' : '重试' }}
            </el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { useLogStore } from '../store/log'
import type { TimeWindow } from '../types'

const MIN_SAMPLES = 3
const store = useLogStore()
const chart = ref<HTMLDivElement>()
const rangeStart = ref(0)
const rangeEnd = ref(0)
let inst: echarts.ECharts | null = null
let resizeObserver: ResizeObserver | null = null

interface ViewPoint {
  index: number
  label: string
  count: number
}

interface WindowStats {
  mean: number
  isAnomaly: (count: number) => boolean
}

const windows = computed<TimeWindow[]>(() =>
  Array.isArray(store.result?.windows) ? store.result.windows : []
)

const selectedPoints = computed<ViewPoint[]>(() => {
  if (rangeStart.value > rangeEnd.value) return []
  const start = Math.max(0, rangeStart.value)
  const end = Math.min(windows.value.length - 1, rangeEnd.value)
  const points: ViewPoint[] = []
  for (let i = start; i <= end; i += 1) {
    const window = windows.value[i]
    const rawCount = Number(window?.count)
    points.push({
      index: i,
      label: `W${i}`,
      count: Number.isFinite(rawCount) ? rawCount : 0
    })
  }
  return points
})

const status = computed(() => {
  if (!store.result) {
    if (store.generateError) {
      return { type: 'error', title: '生成失败', message: store.generateError }
    }
    return { type: 'idle', title: '暂无窗口数据', message: '请先生成日志后查看窗口趋势。' }
  }
  if (store.generateError) {
    return {
      type: 'chart-warning',
      title: '生成失败',
      message: `生成失败：${store.generateError}。当前仍展示上一份窗口数据，可重试刷新。`
    }
  }
  if (!windows.value.length) {
    return {
      type: 'empty',
      title: '窗口数据异常',
      message: '接口没有返回可用窗口，或当前日志结果中的窗口为空。'
    }
  }
  if (windows.value.length < MIN_SAMPLES) {
    return {
      type: 'chart-warning',
      title: '窗口样本异常',
      message: `接口仅返回 ${windows.value.length} 个窗口，少于 ${MIN_SAMPLES} 个，暂不绘制平均值线和异常标记。`
    }
  }
  if (!selectedPoints.value.length) {
    return {
      type: 'empty-range',
      title: '当前区间为空',
      message: `W${rangeStart.value} 至 W${rangeEnd.value} 没有可显示的窗口，请调整区间后重试。`
    }
  }
  if (selectedPoints.value.length < MIN_SAMPLES) {
    return { type: 'insufficient', title: '样本不足' }
  }
  return { type: 'ok', title: '' }
})

function quantile(sortedCounts: number[], percentile: number) {
  const position = (sortedCounts.length - 1) * percentile
  const base = Math.floor(position)
  const ratio = position - base
  const next = sortedCounts[base + 1] ?? sortedCounts[base]
  return sortedCounts[base] * (1 - ratio) + next * ratio
}

function calculateStats(points: ViewPoint[]): WindowStats | null {
  if (points.length < MIN_SAMPLES) return null

  const counts = points.map(point => point.count)
  const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length
  const variance = counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / counts.length
  const std = Math.sqrt(variance)
  const sorted = [...counts].sort((a, b) => a - b)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1
  const iqrLow = q1 - 1.5 * iqr
  const iqrHigh = q3 + 1.5 * iqr

  return {
    mean,
    isAnomaly(count: number) {
      const sigmaScore = std > 1e-5 ? Math.abs(count - mean) / std : 0
      const iqrScore = iqr > 1e-5 && (count < iqrLow || count > iqrHigh)
        ? Math.min(10, Math.abs(count - mean) / iqr)
        : 0
      return sigmaScore > 2.5 || iqrScore > 3
    }
  }
}

function renderChart() {
  if (!inst) return

  if (status.value.type !== 'ok' && status.value.type !== 'insufficient' && status.value.type !== 'chart-warning') {
    inst.clear()
    return
  }

  const points = selectedPoints.value
  const labels = windows.value.map((_, index) => `W${index}`)
  const stats = calculateStats(points)
  const selectedIndexes = new Set(points.map(point => point.index))
  const anomalyIndexes = new Set(
    stats ? points.filter(point => stats.isAnomaly(point.count)).map(point => point.index) : []
  )
  const zeroPoints = points
    .filter(point => point.count === 0)
    .map(point => ({ value: [point.label, 0] }))
  const maxCount = Math.max(...windows.value.map(window => Number(window.count) || 0), 0)

  inst.setOption({
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 40, right: 15, top: 18, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter(params: unknown) {
        const list = Array.isArray(params) ? params : [params]
        const first = list[0] as { name?: string } | undefined
        const label = first?.name
        if (!label) return ''
        const point = points.find(item => item.label === label)
        if (!point) return `${label}<br/>不在当前区间`
        const isAnomaly = anomalyIndexes.has(point.index)
        return `${point.label}<br/>日志量：${point.count}${isAnomaly ? '<br/><span style="color:#f87171">统计异常</span>' : ''}`
      }
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: '#94a3b8', fontSize: 9 },
      axisTick: { alignWithLabel: true }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: maxCount === 0 ? 2 : undefined,
      minInterval: 1,
      axisLabel: { color: '#94a3b8' }
    },
    series: [
      {
        type: 'bar',
        data: windows.value.map((window, index) => {
          const count = Number(window.count) || 0
          const selected = selectedIndexes.has(index)
          const anomaly = anomalyIndexes.has(index)
          return {
            value: count,
            itemStyle: {
              color: anomaly ? '#ef4444' : selected ? '#38bdf8' : 'rgba(56, 189, 248, 0.16)'
            },
            label: {
              show: true,
              position: 'top',
              fontSize: 9,
              color: anomaly ? '#f87171' : '#94a3b8',
              formatter: count === 0 ? '' : String(count)
            }
          }
        }),
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(56, 189, 248, 0.08)' },
          data: [[
            { xAxis: points[0]?.label ?? labels[0] },
            { xAxis: points[points.length - 1]?.label ?? labels[0] }
          ]]
        },
        markLine: stats ? {
          symbol: 'none',
          silent: true,
          animation: false,
          lineStyle: { color: '#f97316', type: 'dashed', width: 1.5 },
          label: {
            color: '#f97316',
            fontSize: 10,
            position: 'insideEndTop',
            formatter: `平均 ${stats.mean.toFixed(1)}`
          },
          data: [{ yAxis: stats.mean }]
        } : undefined
      },
      {
        type: 'scatter',
        data: zeroPoints,
        symbol: 'path://M -5 0 L 5 0 L 0 -8 Z',
        symbolSize: [10, 8],
        itemStyle: { color: '#fbbf24' },
        label: {
          show: true,
          formatter: '0',
          position: 'top',
          fontSize: 9,
          color: '#fbbf24'
        },
        z: 5
      }
    ]
  } as echarts.EChartsOption, true)
}

function resetRange() {
  rangeStart.value = 0
  rangeEnd.value = Math.max(windows.value.length - 1, 0)
}

async function retry() {
  await store.generate()
}

watch(
  () => windows.value.length,
  (length, oldLength) => {
    if (!oldLength && length) resetRange()
    else if (length) {
      rangeStart.value = Math.min(rangeStart.value, length - 1)
      rangeEnd.value = Math.min(rangeEnd.value, length - 1)
    }
  }
)
watch(
  [windows, rangeStart, rangeEnd, () => store.generateError],
  renderChart,
  { deep: true }
)

onMounted(() => {
  if (!chart.value) return
  inst = echarts.init(chart.value)
  if (windows.value.length) resetRange()
  renderChart()
  resizeObserver = new ResizeObserver(() => inst?.resize())
  resizeObserver.observe(chart.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  inst?.dispose()
  inst = null
})
</script>

<style scoped>
.panel{background:#1e293b;border-radius:8px;padding:12px;border:1px solid #334155}
.panel-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.panel h4{color:#38bdf8;font-size:13px}
.range-controls{display:flex;align-items:center;gap:5px}
.range-label{color:#94a3b8;font-size:10px}
.range-select{width:64px}
.range-separator{color:#64748b;font-size:10px}
.notice{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding:6px 8px;border-radius:4px;font-size:11px;line-height:1.4}
.notice.warning{background:#78350f33;color:#fbbf24;border:1px solid #b4530955}
.chart-wrap{position:relative;width:100%;height:200px}
.chart{width:100%;height:100%}
.state-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.82);border-radius:6px}
.state-card{max-width:88%;padding:10px 12px;text-align:center;background:#1e293b;border:1px solid #334155;border-radius:6px}
.state-title{color:#f87171;font-size:12px;font-weight:700;margin-bottom:4px}
.state-title.muted{color:#38bdf8}
.state-message{color:#94a3b8;font-size:11px;line-height:1.5;margin-bottom:8px}
.state-actions{display:flex;justify-content:center;gap:6px}
</style>
