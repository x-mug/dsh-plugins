# DSH 插件仓库

面向 DeepSeek Harness 的本地插件集合。一个仓库维护多个可独立安装的插件，当前兼容基线为 **DSH Desktop 0.2.1-rc.3 / Cordis 4.0.5**。

| 插件 | 版本 | 功能 | 说明 |
|---|---|---|---|
| `@local/dsh-code-location-links` | 1.1.0 | 修复 Windows `/C:/...` 文件链接、常见行列号后缀 | [使用说明](plugins/dsh-code-location-links/README.md) |
| `@local/dsh-session-find` | 1.1.0 | Worker 查找、历史完整性校验、命中核对、跨会话搜索、Ctrl+F | [使用说明](plugins/dsh-session-find/README.md) · [性能记录](plugins/dsh-session-find/PERFORMANCE.md) |

## 安装

1. 打开 [Releases](https://github.com/x-mug/dsh-plugins/releases)，下载需要的插件 `.tgz`，无需同时安装两个。
2. 在 DSH 打开 **插件 → 添加插件 → 安装第三方插件**，输入下载文件的本机绝对路径。
3. 按应用提示重启或重载。升级时先移除旧插件再安装新版。

不要把仓库根目录当作一个插件安装。开发时可安装 `plugins/` 下具体插件的目录；通过压缩包安装的副本不会随源码目录变化而更新。

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
