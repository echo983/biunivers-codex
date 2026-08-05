# Biunivers Workspace Application Protocol v1

状态：V1 已冻结

协议标识：`io.biunivers.workspace-application.protocol=1`

## 1. 目标

本协议定义 OCI 容器应用作为 Biunivers Workspace Application（BWA）运行所需的最小
兼容约定。BWA 在受控容器中运行后台逻辑和 HTTP 图形界面，以一个 Workspace 作为可分叉、
可提交的主要持久状态。

本协议不规定应用所用语言、Web 框架、进程结构或内部数据格式，也不把 Biunivers 变成
Docker Compose 前端。

## 2. 适配声明与身份

镜像必须包含 OCI label：

```text
io.biunivers.workspace-application.protocol=1
```

应用的长期身份是规范化 OCI repository，例如：

```text
ghcr.io/example/project
```

实际安装和运行必须固定到不可变 digest。tag 只用于查找候选版本，不是已安装代码的身份。

应用应提供以下标准 OCI label，供管理界面以纯文本或外部链接呈现：

```text
org.opencontainers.image.title
org.opencontainers.image.description
org.opencontainers.image.source
org.opencontainers.image.version
org.opencontainers.image.revision
org.opencontainers.image.licenses
```

本协议不要求在镜像内复制协议 Markdown 原文，也不要求 Compose 或额外 manifest。

## 3. 容器运行约定

应用必须使用镜像自身的 `Entrypoint` 和 `Cmd` 启动，并满足：

- HTTP 服务监听 `0.0.0.0:8080`；
- `GET /` 提供可用的图形界面；
- `GET /health` 提供无副作用的就绪检查；
- 主要持久文件位于 `/workspace`；
- 临时文件写入 `/tmp`；
- 不要求 root、Linux capabilities、host network、published port 或 Docker socket；
- 能在只读容器 root filesystem 下运行；
- 能以宿主指定的非 root UID/GID 运行。

宿主会提供：

```text
BIUNIVERS_HTTP_PORT=8080
BIUNIVERS_WORKSPACE=/workspace
```

应用不得把容器 IP、Container ID 或 Run ID 当作长期身份。

## 4. 健康检查

`GET /health` 返回任意 `2xx` 即表示 HTTP 界面已经就绪。该请求必须：

- 不创建、删除或迁移用户数据；
- 不要求浏览器 Cookie 或交互式登录；
- 快速结束，不保持长连接；
- 在应用尚未就绪时返回非 `2xx` 或拒绝连接。

健康检查只表示当前 Run 可接收请求，不承诺后台任务已经完成，也不替代应用自己的业务状态。

## 5. iframe 界面

宿主通过独立的稳定 Instance Origin 在 iframe 中打开 `/`。应用必须：

- 随 iframe 视口变化布局；
- 不访问父页面 DOM、Cookie、localStorage 或 JavaScript 对象；
- 不导航或覆盖顶层窗口；
- 不返回会阻止 Biunivers Desktop Origin 嵌入的 `X-Frame-Options` 或 CSP
  `frame-ancestors`；
- 将绝对站内 URL、WebSocket 和表单提交保持在当前 origin；
- 忽略不认识的查询参数和请求头。

如应用使用 `postMessage`，发送方和接收方都必须校验精确 origin、`event.source` 和消息
Schema。V1 不定义任何必需的 `postMessage` 消息。

iframe 被关闭、刷新或重建不等于 Instance 停止。应用不能依赖某个浏览器页面持续存在来保证
后台状态正确。

## 6. HTTP 与 WebSocket

Runtime Proxy 透明转发标准 HTTP 方法、请求和响应流、Range、SSE 及 WebSocket。应用应按
普通反向代理部署处理：

- 使用 `X-Forwarded-Proto`、`X-Forwarded-Host` 和 `X-Forwarded-Prefix` 生成外部 URL；
- 不依赖代理重写 HTML、JavaScript、CSP 或绝对 URL；
- 不假定自己的私有容器地址可被浏览器访问；
- 自行管理应用 Cookie，且不得使用 `__Host-biunivers-` 保留前缀；
- WebSocket 重连、消息格式和业务恢复由应用负责。

V1 不承诺外部公开 ingress、多副本负载均衡或应用间容器网络服务发现。

## 7. Workspace 与持久性

`/workspace` 是当前 Instance 所绑定 Workspace 的运行视图。一次 Run 内可以读写该目录，但
写入只有在宿主成功完成提交后才成为新的 Workspace HEAD。

应用必须接受以下事实：

- Instance 可以保存并重启，新的容器继续看到已提交状态；
- Workspace 可以 Fork，同一应用因而可以拥有多个互不影响的 Instance 状态；
- 异常退出的改动不会自动成为当前 HEAD；
- 用户可以选择提交或丢弃异常 Upper；
- 宿主或机器中断后不会恢复原容器内存、PID、打开的 socket 或浏览器连接。

应用需要一致落盘时，应先完成自身 flush/transaction，再由用户或 Manager 发起保存、停止或
重启。应用不得把“文件写入系统调用已返回”解释为 Workspace HEAD 已提交。

## 8. 配置与 secret

Manager 在创建容器时动态注入配置环境变量和 secret。应用可以声明自己所需的变量，但：

- secret 值不得写入 Workspace、日志、HTTP 页面或诊断输出；
- secret 不能作为应用长期身份的一部分；
- 配置变化通常在下一次启动或保存重启时生效；
- 应用不得要求获得宿主管理凭据、Docker socket 或任意宿主环境变量。

## 9. 网络与权限边界

V1 容器默认可以访问外部网络；这不是对远端服务可用性、隐私或安全性的承诺。入站 HTTP
只能通过 Manager Runtime Proxy 到达固定端口 8080，容器端口不直接发布到宿主或局域网。

宿主可决定 iframe 浏览器权限、环境变量、secret、Workspace 绑定及 Instance 生命周期。
镜像作者提供的 source、description 和许可证信息不构成 Biunivers 的代码审核或安全背书。

## 10. V1 明确不提供

V1 不定义：

- Host API、窗口控制、菜单、主题或 ready 消息；
- 任意宿主文件系统遍历；
- 宿主 shell、Docker API、Compose 参数或 privileged 容器；
- 多容器应用、端口选择、服务发现或通用任务调度；
- 用户身份、OAuth/OIDC、RBAC 或应用间授权协议；
- 自动提交、自动合并异常 Upper 或透明内存恢复。

这些能力如确有必要，应通过独立、版本化且可审查的扩展增加，不修改已冻结的 V1 语义。

