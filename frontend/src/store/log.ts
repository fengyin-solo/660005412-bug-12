import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'
import type { AnalysisResult, AlertRule } from '@/types'
export const useLogStore = defineStore('log', () => {
  const result = ref<AnalysisResult | null>(null)
  const loading = ref(false)
  const error = ref('')
  const searchQuery = ref('')
  const logType = ref('nginx')
  const rules = ref<AlertRule[]>([
    { id:1, name:'高频ERROR', type:'level', threshold:5, enabled:true },
    { id:2, name:'异常流量', type:'count', threshold:200, enabled:false },
    { id:3, name:'关键词命中', type:'keyword', threshold:0, enabled:true }
  ])

  async function generate() {
    loading.value=true
    error.value=''
    try {
      const {data} = await axios.post('/api/generate',{type:logType.value,count:1000})
      result.value=data
    } catch (e: any) {
      // Keep the previous result visible; surface the failure so panels can retry.
      error.value = e?.response?.data?.detail || e?.message || '日志生成失败，请检查后端服务后重试'
    } finally { loading.value=false }
  }

  async function detect() {
    if (!result.value) return
    loading.value=true
    error.value=''
    try {
      const {data} = await axios.post('/api/detect',{logs:result.value.logs,rules:rules.value.filter(r=>r.enabled),query:searchQuery.value})
      result.value=data
    } catch (e: any) {
      error.value = e?.response?.data?.detail || e?.message || '异常检测失败，请重试'
    } finally { loading.value=false }
  }

  return { result, loading, error, searchQuery, logType, rules, generate, detect }
})
