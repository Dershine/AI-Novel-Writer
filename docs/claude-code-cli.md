# 使用 Claude Code CLI 生成小说

本机需要安装原生 Claude Code，并且能在终端通过 `claude -p` 完成请求。应用调用本机 CLI，复用其认证、默认模型和服务地址，无需经过 Gemini 协议转换。

1. 在模型设置中新增生成模型，服务商选择 **Claude Code CLI**。
2. 模型名称使用 `default`，或手动填写当前账号可用的模型 ID。
3. 可执行文件路径留空会从 PATH 和 `~/.local/bin` 查找。在 Windows 上也可以填写 `claude.exe` 的完整路径，不支持 `.cmd` 或 `.ps1` 包装脚本。
4. 点击“测试连接”，保存后将它设为默认模型，或在生成流程中选择该模型。

此入口不保存 API Key 或 HTTP 地址。若认证依赖 PowerShell 中临时设置的环境变量，请从同一环境启动应用，或使用 Claude Code 自身的持久认证配置。应用的 HTTP 代理设置不替代 Claude Code 的连接配置。

支持正文流式输出、普通生成、JSON 对象校验、取消和超时处理。每次请求使用独立临时目录，不续用其他小说的会话；工具及个人扩展通过 CLI 的 safe mode 和工具限制关闭。需要支持 `--safe-mode`、`--include-partial-messages` 等参数的 CLI 版本，本次实测版本为 2.1.278。

只有 CLI 明确报告正常完成，且最终正文与流式输出一致，结果才会被标记为完整。失败、取消或截断后的可见正文保留为未完成内容。JSON 对象输出不符合要求时返回失败，不自动将无效内容当作大纲使用。

温度、输出 Token 上限、项目推理策略目前不传递给 CLI，采用 Claude Code 自身行为。此入口不支持 embedding；向量模型需要单独配置。用量及额度取决于本机 Claude Code 实际使用的认证方式。
