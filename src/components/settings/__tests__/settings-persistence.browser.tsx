import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import SettingsModal from '../SettingsModal'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>

async function renderSection(section: 'proxy' | 'editor') {
  useLayoutStore.setState({ settingsSection: section })
  await act(async () => root.render(<SettingsModal open onClose={() => {}} />))
}

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'config:get') return { autoOpenNextChapterAfterFinalize: false }
    if (channel === 'config:set') return { success: true }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: { invoke },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
})

describe('settings persistence truthfulness', () => {
  it('keeps notifications enabled when saving the preference fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'config:get') return {}
      if (channel === 'config:set') return { success: false, error: 'read only' }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    await renderSection('editor')
    const toggle = page.getByRole('switch', { name: '任务完成时发送系统通知' })
    await expect.element(toggle).toBeChecked()
    await act(async () => toggle.click())
    await expect.element(toggle).toBeChecked()
    await expect.element(page.getByText(/通知设置保存失败/)).toBeVisible()
  })

  it('persists the notification switch and sends an explicit test even when disabled', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'config:get') return {}
      return { success: true }
    })
    await renderSection('editor')
    const toggle = page.getByRole('switch', { name: '任务完成时发送系统通知' })
    await act(async () => toggle.click())
    await expect.element(toggle).not.toBeChecked()
    expect(invoke).toHaveBeenCalledWith('config:set', { taskNotificationsEnabled: false })
    await act(async () => page.getByRole('button', { name: '发送测试通知' }).click())
    expect(invoke).toHaveBeenCalledWith('notification:test', 'zh-CN')
    await expect.element(page.getByRole('status')).toBeVisible()
  })
  it.each([
    ['business failure', () => Promise.resolve({ success: false, error: 'disk full' })],
    ['transport rejection', () => Promise.reject(new Error('IPC unavailable'))],
  ] as const)('does not report proxy settings as saved after a %s', async (_label, failure) => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'config:get') return { proxy: { enabled: false, type: 'http', host: '', port: 7890 } }
      if (channel === 'config:set') return failure()
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    await renderSection('proxy')

    await act(async () => page.getByRole('button', { name: '保存代理配置' }).click())

    await expect.element(page.getByText(/代理配置保存失败/)).toBeVisible()
    await expect.element(page.getByText('已保存')).not.toBeInTheDocument()
  })

  it('rolls back the auto-open-next setting when persistence fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'config:get') return { autoOpenNextChapterAfterFinalize: false }
      if (channel === 'config:set') return { success: false, error: 'read only' }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    await renderSection('editor')
    const toggle = page.getByRole('switch', { name: '定稿后打开下一章' })
    await expect.element(toggle).not.toBeChecked()

    await act(async () => toggle.click())

    await expect.element(toggle).not.toBeChecked()
    await expect.element(page.getByText(/自动打开下一章设置保存失败/)).toBeVisible()
  })
})
