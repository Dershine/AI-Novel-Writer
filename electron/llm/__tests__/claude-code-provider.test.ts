import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import { ClaudeCodeProvider } from '../claude-code-provider'
import { LLMFactory } from '../llm-factory'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
const model: ModelProfile = { id: 'claude', name: 'Claude', provider: 'claude-code', protocol: 'openai', modelName: 'default', apiKey: '', baseUrl: '', claudeExecutable: process.execPath, temperature: 0.7, maxTokens: 16384, purposes: ['generation'] }
const opts = { temperature: undefined, maxTokens: 4096 }
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const stop = (reason = 'end_turn') => ({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: reason } } })
const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } })
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers() })

function fakeRun(events: unknown[], exit = 0, onInput?: () => void) {
  let input = '', instructions = '', directory = ''
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined })
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', 1)); return true })
  mocks.spawn.mockImplementation((_exe: string, args: string[], options: { cwd: string }) => {
    directory = options.cwd
    instructions = fs.readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8')
    child.stdin.on('data', chunk => { input += chunk.toString() })
    child.stdin.on('finish', () => {
      const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n'))
      // Split inside every multibyte character and leave the last line unterminated.
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
      onInput?.()
      queueMicrotask(() => child.emit('close', exit))
    })
    return child
  })
  return { child, input: () => input, instructions: () => instructions, directory: () => directory }
}

describe('Claude Code provider', () => {
  it('routes CLI profiles before HTTP protocols', () => {
    expect(LLMFactory.getProvider({ ...model, protocol: 'gemini' })).toBeInstanceOf(ClaudeCodeProvider)
  })

  it('streams only visible text, without duplicating the final result or exposing thinking', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'existing-local-auth')
    vi.stubEnv('NODE_OPTIONS', '--inspect')
    const run = fakeRun([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } } },
      delta('中文'), delta('正文'), { type: 'assistant', message: { content: [{ text: '中文正文' }] } }, stop(), result('中文正文'),
    ])
    const onChunk = vi.fn(), onDone = vi.fn(), onError = vi.fn()
    await new ClaudeCodeProvider().generateStream({ ...model, modelName: 'model; echo injected' }, [
      { role: 'system', content: '写小说' }, { role: 'user', content: '$(Get-Content secret)' },
    ], { ...opts, signal: new AbortController().signal, onChunk, onDone, onError })
    expect(onChunk.mock.calls.flat().join('')).toBe('中文正文')
    expect(onDone).toHaveBeenCalledExactlyOnceWith('中文正文', { promptTokens: 33, completionTokens: 5, totalTokens: 38 }, 'stop')
    expect(onError).not.toHaveBeenCalled()
    const [, args, options] = mocks.spawn.mock.calls[0]
    expect(options).toMatchObject({ shell: false, windowsHide: true })
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe('existing-local-auth')
    expect(options.env.NODE_OPTIONS).toBeUndefined()
    expect(args).toContain('model; echo injected')
    expect(args).not.toContain('$(Get-Content secret)')
    expect(args).toContain('--safe-mode')
    expect(run.input()).toContain('$(Get-Content secret)')
    expect(run.instructions()).toContain('写小说')
    expect(fs.existsSync(run.directory())).toBe(false)
  })

  it.each([
    [[delta('partial')], 0, 'error'],
    [[stop(), result('answer')], 1, 'error'],
    [[result('answer')], 0, 'unknown'],
    [[stop('max_tokens'), result('partial')], 0, 'length'],
    [[stop('tool_use'), result('partial')], 0, 'unknown'],
    [[delta('different'), stop(), result('answer')], 0, 'error'],
    [[stop(), result('')], 0, 'error'],
    [[{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate limited'] }], 0, 'error'],
  ])('does not commit incomplete, failed or inconsistent runs (%#)', async (events, exit, finishReason) => {
    fakeRun(events as unknown[], exit as number)
    expect(await new ClaudeCodeProvider().generate(model, [], opts)).toMatchObject({ success: false, finishReason })
  })

  it('validates requested JSON objects', async () => {
    for (const text of ['[]', 'null', '```json\n{}\n```', 'not JSON']) {
      fakeRun([stop(), result(text)])
      expect((await new ClaudeCodeProvider().generate(model, [], { ...opts, responseFormat: { type: 'json_object' } })).success).toBe(false)
    }
    fakeRun([stop(), result('{"title":"雨夜"}')])
    expect((await new ClaudeCodeProvider().generate(model, [], { ...opts, responseFormat: { type: 'json_object' } })).success).toBe(true)
  })

  it('preserves partial text on failure and redacts authentication diagnostics', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'private-gateway-credential')
    fakeRun([delta('草稿'), { type: 'result', subtype: 'error', is_error: true, errors: ['private-gateway-credential sk-secret'] }])
    const onError = vi.fn(), onDone = vi.fn()
    await new ClaudeCodeProvider().generateStream(model, [], { ...opts, signal: new AbortController().signal, onChunk: vi.fn(), onError, onDone })
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('[redacted]'), '草稿', undefined)
    expect(onError.mock.calls[0][0]).not.toContain('private-gateway-credential')
  })

  it('cancels the child and preserves visible text without completing', async () => {
    const controller = new AbortController()
    const run = fakeRun([delta('草稿'), { type: 'system' }], 0, () => controller.abort())
    const onError = vi.fn(), onDone = vi.fn()
    await new ClaudeCodeProvider().generateStream(model, [], { ...opts, signal: controller.signal, onChunk: vi.fn(), onError, onDone })
    expect(run.child.kill).toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('取消'), '草稿', undefined)
  })

  it('rejects invalid paths, embedding requests and pre-cancelled requests without spawning', async () => {
    expect((await new ClaudeCodeProvider().generate({ ...model, claudeExecutable: 'claude.cmd' }, [], opts)).success).toBe(false)
    expect((await new ClaudeCodeProvider().generate({ ...model, purposes: ['embedding'] }, [], opts)).success).toBe(false)
    const controller = new AbortController(); controller.abort()
    await new ClaudeCodeProvider().generateStream(model, [], { ...opts, signal: controller.signal, onChunk: vi.fn(), onError: vi.fn(), onDone: vi.fn() })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('bounds stalled requests and terminates them on timeout', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined })
    child.kill.mockImplementation(() => { child.emit('close', 1); return true })
    mocks.spawn.mockReturnValue(child)
    const pending = new ClaudeCodeProvider().generate(model, [], opts)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(await pending).toMatchObject({ success: false, finishReason: 'error', error: expect.stringContaining('超时') })
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })
})
