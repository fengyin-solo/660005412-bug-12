import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'
import type { AnalysisResult, AlertRule } from '@/types'
export const useLogStore = defineStore('log', () => {
  const result = ref<AnalysisResult | null>(null)
  const loading = ref(false)
  const generateError = ref('')
  const detectError = ref('')
  const searchQuery = ref('')
  const logType = ref('nginx')
  const rules = ref<AlertRule[]>([
    { id: 1, name: '高频ERROR', type: 'level', threshold: 5, enabled: true },
    { id: 2, name: '异常流量', type: 'count', threshold: 200, enabled: false },
    { id: 3, name: '关键词命中', type: 'keyword', threshold: 0, enabled: true }
  ])
  let requestSerial = 0

  function formatError(err: unknown) {
    if (axios.isAxiosError(err)) return err.message || '接口请求失败，请稍后重试。'
    if (err instanceof Error) return err.message
    return '数据处理失败，请稍后重试。'
  }

  async function generate() {
    const serial = ++requestSerial
    loading.value = true
    generateError.value = ''
    try {
      const { data } = await axios.post('/api/generate', { type: logType.value, count: 1000 })
      if (serial === requestSerial) result.value = data
    } catch (err) {
      if (serial === requestSerial) generateError.value = formatError(err)
    } finally {
      if (serial === requestSerial) loading.value = false
    }
  }

  async function detect() {
    if (!result.value) return
    const serial = ++requestSerial
    loading.value = true
    detectError.value = ''
    try {
      const { data } = await axios.post('/api/detect', { logs: result.value.logs, rules: rules.value.filter(r => r.enabled), query: searchQuery.value })
      if (serial === requestSerial) result.value = data
    } catch (err) {
      if (serial === requestSerial) detectError.value = formatError(err)
    } finally {
      if (serial === requestSerial) loading.value = false
    }
  }

  return { result, loading, generateError, detectError, searchQuery, logType, rules, generate, detect }
})
