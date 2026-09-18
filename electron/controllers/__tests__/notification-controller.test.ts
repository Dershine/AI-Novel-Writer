import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: ReturnType<typeof sender>, request: unknown) => unknown>(),
  notifications: [] as (EventEmitter & { options: unknown })[],
  config: {} as { taskNotificationsEnabled?: boolean },
  supported: true,
  fail: false,
  win: {
    isDestroyed: vi.fn(() => false), isFocused: vi.fn(() => false),
    isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: ReturnType<typeof sender>, request: unknown) => unknown) => state.handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: () => state.win },
  Notification: class extends EventEmitter {
    static isSupported() { return state.supported }
    constructor(public options: unknown) { super(); state.notifications.push(this) }
    show() { if (state.fail) this.emit('failed', {}, 'delivery failed'); else this.emit('show') }
  },
}))
vi.mock('../../utils/config-utils', () => ({
  GLOBAL_CONFIG_PATH: 'config.json', DEFAULT_GLOBAL_CONFIG: {}, readJsonFile: () => state.config,
}))

import { registerNotificationController } from '../notification-controller'

function sender() {
  const frame = {}
  return { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false, send: vi.fn() } }
}
const request = { title: 'Task completed', body: 'Chapter 12 reviewed', runId: 'run-12' }
const invoke = (event = sender()) => state.handlers.get('notification:show')!(event, request)

beforeEach(() => {
  vi.clearAllMocks()
  state.handlers.clear()
  state.notifications.length = 0
  state.config = {}
  state.supported = true
  state.fail = false
  state.win.isDestroyed.mockReturnValue(false)
  state.win.isFocused.mockReturnValue(false)
  state.win.isMinimized.mockReturnValue(false)
  registerNotificationController()
})

describe('system task notifications', () => {
  it('enables old configurations by default and deduplicates completed runs', async () => {
    const event = sender()
    expect(await invoke(event)).toEqual({ success: true })
    await invoke(event)
    expect(state.notifications).toHaveLength(1)
    expect(state.notifications[0].options).toEqual({ title: request.title, body: request.body })
  })
  it('suppresses foreground notifications and respects the persisted switch', async () => {
    state.win.isFocused.mockReturnValue(true)
    await invoke()
    state.win.isFocused.mockReturnValue(false)
    state.config.taskNotificationsEnabled = false
    await invoke()
    expect(state.notifications).toHaveLength(0)
  })
  it('test notifications bypass the switch and foreground suppression', async () => {
    state.win.isFocused.mockReturnValue(true)
    state.config.taskNotificationsEnabled = false
    expect(await state.handlers.get('notification:test')!(sender(), 'zh-CN')).toEqual({ success: true })
    expect(state.notifications).toHaveLength(1)
  })
  it('restores the sending window and routes clicks to the exact run', async () => {
    const event = sender()
    state.win.isMinimized.mockReturnValue(true)
    await invoke(event)
    state.notifications[0].emit('click')
    expect(state.win.restore).toHaveBeenCalledOnce()
    expect(state.win.focus).toHaveBeenCalledOnce()
    expect(event.sender.send).toHaveBeenCalledWith('notification:clicked', { runId: 'run-12' })
  })
  it('ignores clicks after the window closes', async () => {
    const event = sender()
    await invoke(event)
    state.win.isDestroyed.mockReturnValue(true)
    state.notifications[0].emit('click')
    expect(event.sender.send).not.toHaveBeenCalled()
  })
  it('returns native failures without throwing and allows retry', async () => {
    const event = sender()
    state.fail = true
    expect(await invoke(event)).toEqual({ success: false, error: 'delivery failed' })
    state.fail = false
    expect(await invoke(event)).toEqual({ success: true })
    state.supported = false
    expect(await invoke()).toMatchObject({ success: false })
  })
  it('rejects malformed payloads and subframe senders', async () => {
    expect(await state.handlers.get('notification:show')!(sender(), { ...request, runId: '' })).toMatchObject({ success: false })
    expect(await invoke({ ...sender(), senderFrame: {} })).toMatchObject({ success: false })
    expect(state.notifications).toHaveLength(0)
  })
})
