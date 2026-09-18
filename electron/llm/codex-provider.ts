import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'
import type { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'

/** Resolve the native CLI, never interpolate prompts or model names into a shell. */
export function resolveCodexExecutable(configured?: string): string {
  if (configured?.trim()) {
    const executable = configured.trim()
    if (!path.isAbsolute(executable) || !fs.existsSync(executable)
      || (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe')) {
      throw new Error('Codex 路径必须是已存在的可执行文件绝对路径（Windows 使用 codex.exe，不使用 .cmd/.ps1）')
    }
    return executable
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  if (process.platform === 'win32') {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    for (const dir of dirs) {
      const root = path.join(dir, 'node_modules', '@openai', 'codex')
      const candidates = [path.join(dir, 'codex.exe'),
        path.join(root, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', target, 'bin', 'codex.exe'),
        path.join(root, 'vendor', target, 'bin', 'codex.exe')]
      for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
    }
  } else {
    for (const dir of dirs) {
      const candidate = path.join(dir, 'codex')
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error('未找到 Codex CLI。请先安装 @openai/codex 并运行 codex login，或填写 codex.exe 的绝对路径。')
}

export function buildCodexPrompt(messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): string {
  return [
    'You are the text-generation backend of a novel-writing application. Do not use tools, inspect files, run commands, or modify any files.',
    'Process the supplied conversation in order. System/developer messages define writing instructions; user messages contain the task and reference material. Return only the requested answer in the result field of the output schema, without commentary about your work.',
    opts.responseFormat?.type === 'json_object'
      ? 'The result string MUST contain one valid JSON object, without Markdown fences. Follow the JSON structure requested in the conversation.'
      : 'The result string must contain the complete requested prose or answer.',
    'Conversation (JSON encoded, preserving roles and content):', JSON.stringify(messages),
  ].join('\n\n')
}

export function decodeCodexResult(raw: string, jsonObject: boolean): string {
  const envelope = JSON.parse(raw) as { result?: unknown }
  if (typeof envelope.result !== 'string' || !envelope.result.trim()) throw new Error('Codex 未返回有效正文')
  if (jsonObject) {
    const parsed: unknown = JSON.parse(envelope.result)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Codex 未返回所需的 JSON 对象')
  }
  return envelope.result
}

export class CodexProvider implements ILLMProvider {
  async generate(model: ModelProfile, messages: Array<{role: string; content: string}>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    return this.run(model, messages, opts)
  }

  async generateStream(model: ModelProfile, messages: Array<{role: string; content: string}>, opts: LLMStreamOptions): Promise<void> {
    const result = await this.run(model, messages, opts, opts.signal)
    if (result.success) {
      // exec emits completed items, not a stable token-delta protocol. Never stream reasoning/logs.
      opts.onChunk(result.content)
      opts.onDone(result.content, result.usage, 'stop')
    } else opts.onError(result.error || 'Codex 生成失败', undefined, result.usage)
  }

  private async run(model: ModelProfile, messages: Array<{role: string; content: string}>, opts: LLMGenerateOptions, signal?: AbortSignal): Promise<LLMResponse> {
    let workdir: string | undefined
    try {
      if (signal?.aborted) throw new Error('已取消 Codex 生成')
      if (model.purposes.includes('embedding')) throw new Error('Codex CLI 不支持向量模型')
      const executable = resolveCodexExecutable(model.codexExecutable)
      workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-codex-'))
      const schemaPath = path.join(workdir, 'schema.json')
      const outputPath = path.join(workdir, 'answer.json')
      const instructionsPath = path.join(workdir, 'instructions.txt')
      fs.writeFileSync(instructionsPath, [
        'You are a text-generation assistant embedded in a novel-writing application. Produce the requested text, not coding assistance. Do not use tools, read files or modify the workspace. Put only the final requested answer in the result field.',
        ...messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content),
      ].join('\n\n'), 'utf8')
      fs.writeFileSync(schemaPath, JSON.stringify({type:'object',properties:{result:{type:'string'}},required:['result'],additionalProperties:false}))
      const args = ['exec','--json','--ephemeral','--ignore-user-config','--skip-git-repo-check',
        '--sandbox','read-only','--color','never','--output-schema',schemaPath,'--output-last-message',outputPath,
        '-c','approval_policy="never"','-c','web_search="disabled"',
        '-c','features.shell_tool=false','-c','features.unified_exec=false','-c','features.multi_agent=false',
        '-c','features.code_mode=false','-c','features.code_mode_host=false',
        '-c','features.skill_search=false','-c','features.skip_host_skill_discovery=true',
        '-c','memories.use_memories=false','-c','project_doc_max_bytes=0',
        '-c',`model_instructions_file=${JSON.stringify(instructionsPath)}`]
      if (model.modelName.trim() && model.modelName !== 'default') args.push('--model',model.modelName.trim())
      args.push('-')
      const env = {...process.env}
      // Use saved ChatGPT login, not an API credential inherited from the desktop host.
      for (const key of ['OPENAI_API_KEY','CODEX_API_KEY','NODE_OPTIONS','ELECTRON_RUN_AS_NODE']) delete env[key]
      const result = await new Promise<{usage?: TokenUsage}>((resolve,reject)=>{
        const child = spawn(executable,args,{cwd:workdir,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']})
        let pending='', stderr='', failed='', completed=false, settled=false
        let usage: TokenUsage | undefined
        const stop = () => {
          if (process.platform === 'win32' && child.pid) {
            const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'})
            killer.on('error',()=>child.kill())
          } else child.kill('SIGKILL')
        }
        const abort=()=>{ failed='已取消 Codex 生成'; stop() }
        const timer=setTimeout(()=>{failed='Codex 生成超时（30分钟），请缩小任务后重试';stop()},30*60*1000)
        const finish=(error?: Error)=>{
          if(settled)return
          settled=true; clearTimeout(timer);signal?.removeEventListener('abort',abort)
          if(error)reject(error);else resolve({usage})
        }
        const eventLine=(line:string)=>{
          if(!line.trim())return
          try {
            const e=JSON.parse(line)
            if(e.type==='turn.completed') {
              completed=true
              const u=e.usage
              if(u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens)) usage={promptTokens:u.input_tokens,completionTokens:u.output_tokens,totalTokens:u.input_tokens+u.output_tokens}
            }
            if(e.type==='turn.failed') failed=String(e.error?.message || 'Codex 请求失败')
            // Retried transport errors are not terminal; turn.failed/exit status decide the outcome.
          } catch { failed='Codex 事件格式无效';stop() }
        }
        child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
        child.stdout.on('data',(chunk:string)=>{
          pending+=chunk
          let newline:number
          while((newline=pending.indexOf('\n'))>=0){eventLine(pending.slice(0,newline));pending=pending.slice(newline+1)}
          if(pending.length>16*1024*1024){failed='Codex 输出超过处理上限';stop()}
        })
        child.stderr.on('data',(chunk:string)=>{stderr=(stderr+chunk).slice(-4000)})
        child.on('error',error=>finish(new Error(`无法启动 Codex：${error.message}`)))
        child.on('close',code=>{
          if(pending.trim())eventLine(pending)
          if(failed || code!==0 || !completed) finish(new Error(failed || `Codex 未正常完成（退出码 ${code}）。${stderr.replace(/sk-[\w-]+/g,'[redacted]').slice(-1500)}`))
          else finish()
        })
        child.stdin.on('error',()=>{ /* EPIPE is reported by the process close/error handler. */ })
        signal?.addEventListener('abort',abort,{once:true})
        if(signal?.aborted)abort();else child.stdin.end(buildCodexPrompt(messages,opts),'utf8')
      })
      if(signal?.aborted)throw new Error('已取消 Codex 生成')
      const content=decodeCodexResult(fs.readFileSync(outputPath,'utf8'),opts.responseFormat?.type==='json_object')
      return {success:true,content,finishReason:'stop',usage:result.usage}
    } catch(error) {
      return {success:false,content:'',finishReason:'error',error:String(error)}
    } finally {
      if(workdir) {
        try { fs.rmSync(workdir,{recursive:true,force:true,maxRetries:3,retryDelay:100}) }
        catch { console.warn('[Codex] Unable to remove the temporary generation directory') }
      }
    }
  }
}
