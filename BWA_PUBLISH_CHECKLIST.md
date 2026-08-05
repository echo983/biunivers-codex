# Biunivers Workspace Application v1 发布检查表

## 身份与发布

- [ ] 交付物是单个 OCI 镜像，不是 Compose 文件
- [ ] 镜像可匿名拉取；当前版本不提供私有 registry 登录流程
- [ ] 包含 `io.biunivers.workspace-application.protocol=1`
- [ ] title、description、source、version、revision、licenses labels 准确且不含 secret
- [ ] source 指向可供用户检查的源码仓库
- [ ] SemVer tag 与应用版本一致，并能取得不可变 RepoDigest

## 容器契约

- [ ] HTTP 监听 `0.0.0.0:8080`
- [ ] `GET /` 提供完整图形界面
- [ ] `GET /health` 无副作用、无需登录且就绪时返回 `2xx`
- [ ] 支持宿主指定的非 root UID/GID 和只读 root filesystem
- [ ] 主要持久写入只进入 `/workspace`，临时写入进入 `/tmp`
- [ ] 不要求 privileged、capabilities、host network、Docker socket 或 published port
- [ ] PID 1 正确处理或转发 SIGTERM

## UI 与代理

- [ ] 默认和较小 iframe 尺寸下核心功能可用
- [ ] 不访问父页面 DOM、Cookie 或 localStorage
- [ ] 不发送阻止宿主嵌入的 X-Frame-Options/CSP
- [ ] 链接、表单、资源和 WebSocket 不泄漏容器私有地址
- [ ] iframe 刷新、关闭和重新打开不会破坏后台状态
- [ ] bootstrap URL、容器 ID、IP 和 Run ID 没有被持久化

## Workspace 与生命周期

- [ ] `/workspace` 写入经过保存重启后仍存在
- [ ] Fork 后两个 Instance 可以独立修改
- [ ] 应用在宿主提交前完成自身 flush/transaction
- [ ] 正常停止能在终止窗口内完成
- [ ] 异常退出后应用不会假设改动已经发布
- [ ] 应用能接受容器重建且不依赖内存、PID 或 socket 恢复

## 配置、secret 与网络

- [ ] README 列出全部必需/可选环境变量及敏感性
- [ ] 缺少必需变量时给出明确且无泄密的错误
- [ ] secret 不进入日志、页面、健康响应、Workspace 或镜像层
- [ ] 不要求 Biunivers 管理凭据或任意宿主环境变量
- [ ] 外部网络失败有可理解的业务行为
- [ ] 不假设其他容器的地址或服务发现

## 最终验收

- [ ] 用 tag 在 Biunivers 完成安装并确认固定 digest
- [ ] 创建空白 Instance、启动并打开 UI
- [ ] 保存重启、停止、再次启动均通过
- [ ] 从已有 Workspace Fork 后状态独立
- [ ] 更新新 digest 和回退均经过显式用户操作
- [ ] 浏览器控制台和容器日志没有阻断错误或凭据

