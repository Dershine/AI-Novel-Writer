import { BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron'
import type { GlobalConfig } from '../../src/shared/ipc-channels'
import { DEFAULT_GLOBAL_CONFIG, GLOBAL_CONFIG_PATH, readJsonFile } from '../utils/config-utils'

export function registerNotificationController() {
  // Keep native objects alive until Windows dismisses them; deduplicate per renderer.
  const live = new Set<Notification>()
  const delivered = new WeakMap<Electron.WebContents, Set<string>>()

  function show(event: IpcMainInvokeEvent, title: string, body: string, runId?: string) {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      return { success: false, error: 'Invalid notification sender' }
    }
    try {
      if (runId) {
        const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
        if (config.taskNotificationsEnabled === false || (win.isFocused() && !win.isMinimized())) {
          return { success: true }
        }
        if (delivered.get(event.sender)?.has(runId)) return { success: true }
      }
      if (!Notification.isSupported()) return { success: false, error: 'System notifications are unavailable' }
      const notification = new Notification({ title, body })
      if (runId) {
        const ids = delivered.get(event.sender) ?? new Set<string>()
        ids.add(runId)
        if (ids.size > 500) ids.delete(ids.values().next().value!)
        delivered.set(event.sender, ids)
      }
      live.add(notification)
      notification.on('close', () => live.delete(notification))
      notification.on('click', () => {
        live.delete(notification)
        if (win.isDestroyed() || event.sender.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        if (runId) event.sender.send('notification:clicked', { runId })
      })
      return new Promise<{ success: boolean; error?: string }>(resolve => {
        const timer = setTimeout(() => {
          resolve({ success: false, error: 'Notification delivery was not confirmed by the system' })
        }, 5000)
        notification.once('show', () => {
          clearTimeout(timer)
          resolve({ success: true })
        })
        notification.once('failed', (_event, error) => {
          clearTimeout(timer)
          live.delete(notification)
          if (runId) delivered.get(event.sender)?.delete(runId)
          console.warn('[Notifications]', error)
          resolve({ success: false, error })
        })
        try { notification.show() } catch (error) {
          clearTimeout(timer)
          live.delete(notification)
          if (runId) delivered.get(event.sender)?.delete(runId)
          resolve({ success: false, error: String(error) })
        }
      })
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  ipcMain.handle('notification:show', (event, request: unknown) => {
    if (!request || typeof request !== 'object') return { success: false, error: 'Invalid notification' }
    const { title, body, runId } = request as Record<string, unknown>
    if (typeof title !== 'string' || typeof body !== 'string' || typeof runId !== 'string'
      || !runId || runId.length > 200 || title.length > 200 || body.length > 1000) {
      return { success: false, error: 'Invalid notification' }
    }
    return show(event, title, body, runId)
  })
  ipcMain.handle('notification:test', (event, locale: unknown) => show(event,
    locale === 'en-US' ? 'AI Novel Writer · Test notification' : 'AI小说作家 · 测试通知',
    locale === 'en-US' ? 'You will be notified when a background task completes.' : '后台任务完成时，你会在这里收到提醒。',
  ))
}
