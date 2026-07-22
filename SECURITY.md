# Security policy

## Supported versions

Codex ChatCut 目前是 pre-release source MVP，没有稳定 release branch 或二进制发行版。安全修复只针对本仓库最新 `main`、`UPSTREAM.json` 中的精确 OpenChatCut revision，以及其中列出的 Host Patch；其他 commit、浮动 upstream `main`、第三方构建和独立 Electron 包不在支持范围内。

## Private reporting

请不要在公开 Issue、discussion、日志或截图中披露可利用细节、bearer、browser capability、workspace 私有路径或媒体内容。

优先使用 GitHub 仓库 Security 页中的 **Report a vulnerability** 私下提交报告。如果该入口尚未启用，请只创建一个不含技术细节的公开 Issue，请求维护者提供私密沟通渠道；不要把 PoC 放进该 Issue。

报告尽量包含：

- Codex ChatCut commit、`UPSTREAM.json` revision 与 patch digest；
- 操作系统、Codex 版本、Node 24 精确版本；
- 受影响路由/进程边界和最小复现步骤；
- 期望结果、实际结果与影响；
- 已脱敏的日志，以及是否需要立即轮换或清除本地数据。

这是志愿维护项目，目前不承诺固定响应 SLA。维护者会先确认接收，在修复、回归测试和披露时间线达成一致前请保持私密。

## Threat model

重点保护以下边界：

- 非本插件进程对 loopback HTTP MCP 的未授权调用；
- 恶意网页或普通 loopback 客户端未授权读写 embedded server 的静态资源、项目/设置 API、媒体、上传、导出、生成或 key-injecting provider proxy；
- 跨站请求、DNS rebinding、错误 Host/Origin 或伪造非顶层导航绕过 browser capability；
- MCP bearer、browser capability、宿主环境秘密或代理注入凭据经 URL、tool result、stdout/stderr、请求转发、响应 cookie、异常或 Codex task 泄漏；
- 模型参数或 settings 导致 workspace/data root 逃逸、任意文件读取、SSRF 或任意 URL 代理；
- SVG active content、未知动态路由回退 SPA 或可控 `MEDIA_DIR` 扩大了 Host Mode 权限；
- sidecar 脱离 stdio owner 后继续运行；
- `host=codex` 意外挂载 ChatPanel、provider UI、Codex preload/bridge 或未声明浏览器权限；
- upstream pin 漂移、补丁部分应用或准备目录被篡改。

项目的安全不变量是：

1. sidecar 仅绑定 `127.0.0.1:0`，所有 HTTP 请求都先验证精确 loopback socket 与 Host；
2. MCP 与 Browser 使用不同的每进程随机能力，编辑 URL 不含任何凭据；只有通过 Fetch Metadata 与 Host 检查的真实顶层编辑器导航可获得按 sidecar 端口隔离的初始 `HttpOnly; SameSite=Strict; Path=/` capability cookie，已鉴权 bootstrap 只能对它续期；
3. HTTP MCP 和 control-only tool discovery 要求独立 bearer，bootstrap 要求已有 browser capability。静态资源、项目/设置 API、媒体与 Range、上传、导出、生成和 provider proxy 等整个 browser-loaded surface 都要求 browser capability；
4. Browser `GET`/`HEAD` 只接受 same-origin/none fetch site，并在 Origin 存在时要求精确同源；mutation 还要求精确 Origin 和 same-origin。未知动态路由 fail closed 为 404，响应禁止 framing、referrer 泄漏和 content sniffing；
5. sidecar 只继承明确 allowlist 中的 locale、进程查找、临时目录、proxy 与 trust-store 环境，不继承任意 API key 或 `NODE_OPTIONS`。出站 proxy 剔除 browser authorization/cookie/origin/referer/fetch-metadata，上游响应的 `Set-Cookie`、`Set-Cookie2` 和 `Clear-Site-Data` 不会返回 Browser；
6. Codex Host Mode 固定使用 workspace 内媒体目录，不允许 `MEDIA_DIR` 改到任意路径，并禁用远程 URL import 和 SVG 上传；
7. stdout 专供 MCP 协议，子进程诊断只写 stderr 且对能力值脱敏；
8. workspace 从 Codex `tools/call` 注入的 `codex/sandbox-state-meta.sandboxCwd` 解析并在首次启动时固定；模型工具不能提供替代 storage root，跨 workspace 调用 fail closed；
9. 状态目录逐层拒绝 symlink 并验证 canonical containment；启动取消、超时、正常退出、信号处理和 MCP 退出都会有界终止并回收 sidecar；
10. prepared tree 必须匹配固定 SHA、patch digest、patched source digest 和 Node major；每次 rebuild 从 canonical submodule 重建，submodule 必须干净；
11. Codex Host Mode 不挂载第二套 chat，也不加载 OpenChatCut preload、Codex bridge 或未声明的 Browser 特权。

## Trust assumptions and limits

`127.0.0.1` 不是完整的安全沙箱。以同一用户运行且能读取进程环境、附加调试器、修改 plugin checkout/准备目录或控制 Codex 启动环境的恶意本地程序，已位于本 MVP 的信任边界内。能力校验主要防止偶然暴露、跨站请求和普通未授权 loopback 客户端，不能抵抗已控制本地账户的攻击者。

OpenChatCut、npm dependencies、Remotion 和上游素材仍属于 supply-chain 边界。固定 SHA 和 patch digest 提供可审查性，不等同于上游代码已通过全面安全审计。不要在不信任的 workspace 中运行本插件，也不要分发 `.runtime` 或包含未审计素材的构建。

## Safe research rules

- 只在你拥有或明确获准的本机 checkout、workspace 和 sidecar 上测试。
- 不要扫描公共 IP、他人的 Codex 实例或生产服务。
- 使用无敏感内容的临时 workspace 和媒体；完成后停止 MCP/sidecar 并清理测试数据。
- PoC 应证明最小影响，不要建立持久化、横向移动或导出不相关数据。
- 任何调试输出都必须先移除 token、cookie、绝对私有路径和用户媒体。

## Not a security guarantee

CI、negative tests 和 loopback hardening 只能证明已覆盖的行为。本政策不声明源码或真实 Codex Desktop 流程不存在漏洞，也不取代使用者自己的风险、许可证和部署审查。
