import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import { CodexProvider, buildCodexPrompt, decodeCodexResult } from '../codex-provider'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

const mocks=vi.hoisted(()=>({spawn:vi.fn()}))
vi.mock('node:child_process',()=>({spawn:mocks.spawn}))
const model:ModelProfile={id:'test',name:'Codex',provider:'codex',protocol:'openai',modelName:'default',apiKey:'',baseUrl:'',codexExecutable:process.execPath,temperature:0.7,maxTokens:16384,purposes:['generation']}
const opts={temperature:undefined,maxTokens:4096}
afterEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs()})

function fakeRun(events:unknown[],answer:string,exit=0) {
  let input='';let directory=''
  mocks.spawn.mockImplementation((_exe:string,args:string[],options:{cwd:string})=>{
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(),pid:undefined})
    directory=options.cwd
    child.stdin.on('data',chunk=>{input+=chunk.toString()})
    child.stdin.on('finish',()=>{
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1],answer)
      // Deliberately split a UTF-8 event across writes.
      const bytes=Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')
      child.stdout.write(bytes.subarray(0,11));child.stdout.write(bytes.subarray(11))
      queueMicrotask(()=>child.emit('close',exit))
    })
    return child
  })
  return {input:()=>input,directory:()=>directory}
}

describe('Codex CLI provider',()=>{
  it('preserves roles and sends shell-looking content only through stdin',async()=>{
    vi.stubEnv('OPENAI_API_KEY','must-not-inherit')
    const run=fakeRun([{type:'item.completed',item:{type:'reasoning',text:'private'}},{type:'turn.completed',usage:{input_tokens:12,output_tokens:5}}],JSON.stringify({result:'中文正文'}))
    const result=await new CodexProvider().generate({...model,modelName:'model; echo injected'},[{role:'system',content:'写小说'},{role:'user',content:'$(Get-Content secret) & echo test'}],opts)
    expect(result).toMatchObject({success:true,content:'中文正文',finishReason:'stop',usage:{totalTokens:17}})
    expect(run.input()).toContain('$(Get-Content secret)')
    const [,args,options]=mocks.spawn.mock.calls[0]
    expect(args).toContain('model; echo injected')
    expect(args).not.toContain('$(Get-Content secret)')
    expect(options.shell).toBe(false)
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
    expect(fs.existsSync(run.directory())).toBe(false)
  })
  it('rejects output without a successful turn even when exit is zero',async()=>{
    fakeRun([{type:'item.completed'}],JSON.stringify({result:'incomplete'}))
    expect((await new CodexProvider().generate(model,[],opts)).success).toBe(false)
  })
  it('rejects failed turns and nonzero process exits despite an answer file',async()=>{
    fakeRun([{type:'turn.failed',error:{message:'rate limit'}}],JSON.stringify({result:'partial'}))
    expect(await new CodexProvider().generate(model,[],opts)).toMatchObject({success:false,content:'',error:expect.stringContaining('rate limit')})
    fakeRun([{type:'turn.completed'}],JSON.stringify({result:'partial'}),1)
    expect((await new CodexProvider().generate(model,[],opts)).success).toBe(false)
  })
  it('validates JSON objects without accepting fences or arrays',()=>{
    expect(decodeCodexResult(JSON.stringify({result:'{"ok":true}'}),true)).toBe('{"ok":true}')
    for(const result of ['[]','null','```json\n{}\n```','not JSON','']) expect(()=>decodeCodexResult(JSON.stringify({result}),true)).toThrow()
    expect(buildCodexPrompt([], {...opts,responseFormat:{type:'json_object'}})).toContain('one valid JSON object')
  })
  it('delivers only the final answer to the stream callbacks',async()=>{
    fakeRun([{type:'item.completed',item:{type:'agent_message',text:'commentary'}},{type:'turn.completed'}],JSON.stringify({result:'最终正文'}))
    const onChunk=vi.fn(),onDone=vi.fn(),onError=vi.fn()
    await new CodexProvider().generateStream(model,[],{...opts,signal:new AbortController().signal,onChunk,onDone,onError})
    expect(onChunk).toHaveBeenCalledExactlyOnceWith('最终正文')
    expect(onDone).toHaveBeenCalledWith('最终正文',undefined,'stop')
    expect(onError).not.toHaveBeenCalled()
  })
  it('does not start a cancelled request or an embedding request',async()=>{
    const controller=new AbortController();controller.abort()
    const onError=vi.fn()
    await new CodexProvider().generateStream(model,[],{...opts,signal:controller.signal,onChunk:vi.fn(),onDone:vi.fn(),onError})
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('取消'),undefined,undefined)
    expect((await new CodexProvider().generate({...model,purposes:['embedding']},[],opts)).success).toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('kills a running request on cancellation and never reports success',async()=>{
    const controller=new AbortController()
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:undefined,kill:vi.fn()})
    child.kill.mockImplementation(()=>queueMicrotask(()=>child.emit('close',1)))
    mocks.spawn.mockReturnValue(child)
    child.stdin.on('finish',()=>controller.abort())
    const onDone=vi.fn(),onError=vi.fn()
    await new CodexProvider().generateStream(model,[],{...opts,signal:controller.signal,onChunk:vi.fn(),onDone,onError})
    expect(child.kill).toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('取消'),undefined,undefined)
  })
})
