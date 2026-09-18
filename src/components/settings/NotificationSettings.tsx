import { useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { Switch } from '../ui/Switch'
import { Button } from '../ui/Button'

export default function NotificationSettings() {
  const { text, locale } = useLocaleStore()
  const [enabled, setEnabled] = useState(true)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!ipc.isElectron) return
    let active = true
    void ipc.invoke('config:get').then(config => {
      if (!active) return
      setEnabled(config.taskNotificationsEnabled !== false)
      setReady(true)
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [])

  const save = async (checked: boolean) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await ipc.invoke('config:set', { taskNotificationsEnabled: checked })
      if (!result.success) throw new Error(result.error)
      setEnabled(checked)
    } catch (cause) {
      setError(text('通知设置保存失败：', 'Could not save notification settings: ') + String(cause))
    } finally { setBusy(false) }
  }

  const test = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await ipc.invoke('notification:test', locale)
      if (!result.success) throw new Error(result.error)
      setMessage(text('测试通知已提交给系统。如果没有看到横幅，请检查 Windows 通知设置和勿扰模式。', 'Test notification submitted. If no banner appears, check system notification settings and Do Not Disturb.'))
    } catch (cause) {
      setError(text('发送测试通知失败：', 'Could not send the test notification: ') + String(cause))
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3 rounded-xl p-4" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>{text('任务完成时发送系统通知', 'System notifications for completed tasks')}</p>
          <p className="text-[0.68rem] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {text('应用在后台或最小化时，生成、审稿、定稿等任务完成后提醒；点击通知查看任务。应用需保持运行。', 'Notify when generation, review, finalization, or other tasks finish while the app is in the background. Click to view the task. Keep the app running.')}
          </p>
        </div>
        <Switch checked={enabled} disabled={!ready || busy} onCheckedChange={checked => void save(checked)} aria-label={text('任务完成时发送系统通知', 'System notifications for completed tasks')} />
      </div>
      <Button variant="outline" size="sm" disabled={!ipc.isElectron || busy} onClick={() => void test()}>{text('发送测试通知', 'Send test notification')}</Button>
      {message && <p role="status" className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{message}</p>}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--color-error-text)' }}>{error}</p>}
    </div>
  )
}
