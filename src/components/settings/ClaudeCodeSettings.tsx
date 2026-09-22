import type { ModelProfile } from '../../shared/ipc-channels'
import { useLocaleStore } from '../../stores/locale-store'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'

export function ClaudeCodeSettings({ model, onChange }: { model: ModelProfile; onChange: (model: ModelProfile) => void }) {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-text-muted)]">
        {text('使用本机 Claude Code 的认证与服务地址，无需在此填写 API Key。请先在终端确认 claude -p 可用。default 使用 CLI 默认模型，也可填写模型 ID；支持实时输出，不支持向量模型。', 'Uses local Claude Code authentication and endpoint; no API key is needed here. Verify claude -p in your terminal first. Use default or a model ID. Supports streaming, but not embeddings.')}
      </p>
      <Label>{text('Claude 可执行文件（可选）', 'Claude executable (optional)')}</Label>
      <Input value={model.claudeExecutable ?? ''} onChange={e => onChange({ ...model, claudeExecutable: e.target.value })} placeholder={text('留空自动查找；Windows 填写 claude.exe 完整路径', 'Auto-detect, or enter the full path to claude.exe on Windows')} />
      <p className="text-xs text-[var(--color-text-muted)]">
        {text('每次请求独立，禁用工具和个人扩展。温度、输出 Token 上限及项目推理策略不传给 CLI；采用 Claude CLI 的行为。连接与代理由本机 Claude 配置管理。', 'Each request is independent, with tools and personal extensions disabled. Temperature, output token limits and project reasoning settings are not passed to the CLI. Connection and proxy settings come from local Claude configuration.')}
      </p>
    </div>
  )
}
