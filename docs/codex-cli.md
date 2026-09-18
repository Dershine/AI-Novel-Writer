# 使用本机 Codex CLI

在“设置 → 模型”新增生成模型，服务商选择 **Codex CLI**。先在本机安装官方 `@openai/codex` 并运行 `codex login` 登录。无需填写 API Key 或 API 地址。

- 模型名称 `default` 使用 CLI 内置默认模型，也可填写账号允许的模型 ID。
- 自动查找 PATH 中的原生程序及 Windows npm 全局安装的 Codex。找不到时填写原生可执行文件的绝对路径（Windows 为 `codex.exe`，不是 `.cmd` 或 `.ps1`）。
- 支持正文、设定、审稿、摘要以及 JSON 对象输出；不支持 embedding。
- 结果生成完成后一次显示，不提供逐字流式输出。取消会终止本次 CLI 进程树。
- 温度、输出 Token 上限与项目推理策略不映射为 CLI 参数；界面中的上下文预算不是 CLI 输出长度保证。
- 每个请求建立独立临时工作目录与会话，不加载个人 Codex 配置、历史会话、项目说明或记忆。复用本机认证，不读取或复制登录令牌。通过专用文本生成指令代替默认编码指令。
- 提示词使用 stdin，进程以参数数组启动且不开 shell。关闭 shell、Code Mode、搜索与多代理功能，使用只读沙箱。小说保存仍由本软件完成。
- 仅在 CLI 正常退出、收到 `turn.completed` 且最终结果通过校验后报告成功。结构化任务额外校验结果为 JSON 对象；临时结果和指令在结束后清理。
- 单次请求超时为30分钟；额度、登录过期或模型不可用会作为生成失败显示。不自动重试，以免重复消耗额度。

当前已在 Windows、Codex CLI 0.145.0 上验证。真实连接测试会消耗账号的 Codex 额度。官方参考：[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[认证](https://learn.chatgpt.com/docs/auth)。
