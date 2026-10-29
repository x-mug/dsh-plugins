# DSH 插件仓库

面向 DeepSeek Harness 的本地插件集合。一个仓库维护多个可独立安装的插件，当前兼容基线为 **DSH Desktop 0.2.1-rc.3 / Cordis 4.0.5**。

| 插件 | 版本 | 功能 | 说明 |
|---|---|---|---|
| `@local/dsh-code-location-links` | 1.1.0 | 修复 Windows `/C:/...` 文件链接、常见行列号后缀 | [使用说明](plugins/dsh-code-location-links/README.md) |
| `@local/dsh-session-find` | 1.1.0 | Worker 查找、历史完整性校验、命中核对、跨会话搜索、Ctrl+F | [使用说明](plugins/dsh-session-find/README.md) · [性能记录](plugins/dsh-session-find/PERFORMANCE.md) |

## 安装

在 DSH 打开 **插件 → 添加插件 → 安装第三方插件**，填一段安装地址，不需要先下载文件。插件管理器接受 npm 包名、绝对本地路径、git 地址和 http(s) 压缩包直链。

本仓库是多插件仓库，一个地址只装一个插件，用 `#path:` 指向子目录：

```text
github:x-mug/dsh-plugins#v1.1.0&path:/plugins/dsh-session-find
github:x-mug/dsh-plugins#v1.1.0&path:/plugins/dsh-code-location-links
```

也可以直接贴 [Releases](https://github.com/x-mug/dsh-plugins/releases) 里的压缩包直链，例如：

```text
https://github.com/x-mug/dsh-plugins/releases/download/v1.1.0/local-dsh-session-find-1.1.0.tgz
```

已经下载了文件，就填它的绝对路径。装好后按提示重启或重载；升级时先移除旧版本再安装。

只写仓库根地址不行：根目录不是插件包，管理器会拒绝并回滚。通过压缩包或 git 安装的副本不会随源码目录变化而更新。

## 仓库结构

```text
plugins/
  dsh-code-location-links/  # 文件与行号链接
  dsh-session-find/         # 当前会话与跨会话查找
scripts/verify.mjs          # 两个插件的构建与独立测试
.github/workflows/ci.yml    # Linux / Windows 验证
```

## 开发和验证

需要 **Node.js 24**，构建和核心测试不需要第三方依赖：

```sh
node scripts/verify.mjs
```

默认不运行依赖本机 DSH 包的四项可选集成测试。要运行这些测试，设置 `DSH_INTEGRATION_VENDOR`（链接插件）和 `DSH_TEST_VENDOR_DIR`（会话查找），分别指向自己本机解包的依赖目录；具体格式见各插件说明。仓库不含第三方运行时源码、用户会话或凭据。

打包前先运行验证，然后创建 `dist` 目录，在每个插件目录运行：

```sh
npm pack --ignore-scripts --pack-destination ../../dist
```

安装包独立保留各自版本；仓库 Release 汇总当次两个插件的安装包与 SHA256。

## 兼容性

- 两个插件使用 DSH 现有客户端服务和文件预览，未修改 DSH 安装文件。
- 链接插件依赖 Cordis `internal/get`，会话查找的消息跳转依赖 rc.3 的 Chat DOM 锚点。升级 DSH 后需要重新验证。
- 会话查找的性能记录来自合成语料的本机测试，不等同于浏览器端到端延迟，也不构成与其他编辑器的性能对标。
- 自动测试、真实 Cordis / 快捷键注册器集成和当前 DSH Web 页面的按键、搜索、高亮与跨会话跳转已验收。验证范围与限制见 [验证记录](docs/VALIDATION.md)。
