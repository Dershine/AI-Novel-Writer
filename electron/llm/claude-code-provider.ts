import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LLMFinishReason, ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import type { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'

export function resolveClaudeExecutable(configured?: string): string {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  if (configured?.trim()) {
    const executable = configured.trim()
    if (!path.isAbsolute(executable) || !fs.existsSync(executable) || !fs.statSync(executable).isFile()
      || (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe')) {
      throw new Error('Claude 路径必须是可执行文件绝对路径（Windows 使用 claude.exe）')
    }
    return executable
  }
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), path.join(os.homedir(), '.local', 'bin')]
  for (const dir of dirs) {
    const executable = path.resolve(dir, name)
    if (fs.existsSync(executable) && fs.statSync(executable).isFile()) return executable
  }
  throw new Error('未找到 Claude Code CLI。请先安装并在终端确认 claude -p 可用，或填写 claude.exe 的绝对路径。')
}

export function buildClaudePrompt(messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): string {
  return [
    'Process the following conversation in order. Return only the requested answer. The role labels preserve the supplied conversation history.',
    opts.responseFormat?.type === 'json_object'
      ? 'Return exactly one valid JSON object matching the requested structure, with no Markdown fences.'
      : 'Return the complete requested prose or answer, without commentary about your work.',
    JSON.stringify(messages.filter(message => message.role !== 'system' && message.role !== 'developer')),
  ].join('\n\n')
}

/** Uses the user's existing CLI authentication, including its configured gateway. */
export class ClaudeCodeProvider implements ILLMProvider {
  generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    return this.run(model, messages, opts)
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    const result = await this.run(model, messages, opts, opts)
    if (result.finishReason === 'error' || result.finishReason === 'cancelled') {
      opts.onError(result.error || 'Claude 生成失败', result.content || undefined, result.usage)
    } else {
      opts.onDone(result.content, result.usage, result.finishReason)
    }
  }

  private async run(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions, stream?: LLMStreamOptions): Promise<LLMResponse> {
    let workdir: string | undefined
    let content = ''
    let usage: TokenUsage | undefined
    const terminal: { reason: LLMFinishReason } = { reason: 'unknown' }
    const signal = stream?.signal
    try {
      if (signal?.aborted) throw new Error('已取消 Claude 生成')
      if (model.purposes.includes('embedding')) throw new Error('Claude Code CLI 不支持向量模型')
      const executable = resolveClaudeExecutable(model.claudeExecutable)
      workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-claude-'))
      const instructions = path.join(workdir, 'instructions.txt')
      fs.writeFileSync(instructions, [
        'You are the text-generation backend of a novel-writing application. Follow the writing instructions and return only the requested text. Do not use tools.',
        ...messages.filter(message => message.role === 'system' || message.role === 'developer').map(message => message.content),
      ].join('\n\n'), 'utf8')
      const args = ['-p', '--safe-mode', '--disallowedTools', '*', '--strict-mcp-config',
        '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--system-prompt-file', instructions]
      if (model.modelName.trim() && model.modelName !== 'default') args.push('--model', model.modelName.trim())
      const env = { ...process.env }
      delete env.NODE_OPTIONS
      delete env.ELECTRON_RUN_AS_NODE
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, { cwd: workdir, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
        let pending = '', stderr = '', failure = ''
        let completed = false, settled = false
        let shutdownTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          clearTimeout(shutdownTimer)
          signal?.removeEventListener('abort', abort)
          if (error) reject(error)
          else resolve()
        }
        const stop = (message: string) => {
          if (failure || settled) return
          failure = message
          shutdownTimer = setTimeout(() => finish(new Error(failure)), 5000)
          if (process.platform === 'win32' && child.pid) {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
            killer.on('error', () => child.kill())
            killer.on('close', code => { if (code !== 0) child.kill() })
          } else child.kill('SIGKILL')
        }
        const abort = () => stop('已取消 Claude 生成')
        const timer = setTimeout(() => stop('Claude 生成超时（30 分钟），请缩小任务后重试'), 30 * 60 * 1000)
        const emitText = (text: string) => {
          if (!text) return
          if (content.length + text.length > 16 * 1024 * 1024) throw new Error('Claude 正文超过处理上限')
          content += text
          stream?.onChunk(text)
        }
        const eventLine = (line: string) => {
          if (!line.trim() || failure || settled) return
          try {
            const event = JSON.parse(line)
            if (event.parent_tool_use_id) return
            if (completed && (event.type === 'result' || event.type === 'stream_event')) throw new Error('Claude 在结束后返回了额外事件')
            if (event.type === 'stream_event') {
              const delta = event.event?.delta
              if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') emitText(delta.text)
              if (event.event?.type === 'message_delta') {
                terminal.reason = delta?.stop_reason === 'end_turn' || delta?.stop_reason === 'stop_sequence' ? 'stop'
                  : delta?.stop_reason === 'max_tokens' ? 'length' : 'unknown'
              }
            }
            if (event.type === 'result') {
              const u = event.usage
              if (u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens)) {
                const promptTokens = u.input_tokens + (Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0)
                  + (Number.isFinite(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0)
                usage = { promptTokens, completionTokens: u.output_tokens, totalTokens: promptTokens + u.output_tokens }
              }
              if (event.is_error !== false || event.subtype !== 'success') {
                throw new Error(`Claude 请求失败：${event.subtype || 'unknown'}。${Array.isArray(event.errors) ? event.errors.join('; ') : ''}`)
              }
              if (typeof event.result !== 'string') throw new Error('Claude 未返回有效正文')
              if (!event.result.startsWith(content)) throw new Error('Claude 最终结果与流式正文不一致')
              emitText(event.result.slice(content.length))
              completed = true
            }
          } catch (error) { stop(String(error)) }
        }
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          if (settled || failure) return
          pending += chunk
          let newline: number
          while ((newline = pending.indexOf('\n')) >= 0) {
            eventLine(pending.slice(0, newline))
            pending = pending.slice(newline + 1)
          }
          if (pending.length > 16 * 1024 * 1024) stop('Claude 事件超过处理上限')
        })
        child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
        child.on('error', error => finish(new Error(`无法启动 Claude：${error.message}`)))
        child.on('close', code => {
          if (pending.trim()) eventLine(pending)
          if (failure || code !== 0 || !completed) finish(new Error(failure || `Claude 未正常完成（退出码 ${code}）。${stderr.slice(-1500)}`))
          else finish()
        })
        child.stdin.on('error', () => { /* Process close reports EPIPE and early exits. */ })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        else child.stdin.end(buildClaudePrompt(messages, opts), 'utf8')
      })
      if (signal?.aborted) throw new Error('已取消 Claude 生成')
      if (!content.trim()) throw new Error('Claude 返回了空正文')
      if (terminal.reason !== 'stop') return { success: false, content, usage, finishReason: terminal.reason, error: `Claude 未完整结束：${terminal.reason}` }
      if (opts.responseFormat?.type === 'json_object') {
        const parsed: unknown = JSON.parse(content)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude 未返回所需的 JSON 对象')
      }
      return { success: true, content, usage, finishReason: 'stop' }
    } catch (error) {
      // Credentials can also appear in CLI diagnostics; never expose them to the renderer.
      let message = String(error).replace(/sk-[\w-]+/g, '[redacted]')
      for (const [key, value] of Object.entries(process.env)) {
        if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key) && value && value.length >= 8) message = message.split(value).join('[redacted]')
      }
      return { success: false, content, usage, finishReason: signal?.aborted ? 'cancelled' : 'error', error: message }
    } finally {
      if (workdir) {
        try { fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
        catch { console.warn('[Claude] Unable to remove temporary generation directory') }
      }
    }
  }
}
