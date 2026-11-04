# DSH 插件仓库

面向 DeepSeek Harness 的插件合集。各插件由独立仓库维护，当前兼容基线为 **DSH Desktop 0.2.1-rc.3 / Cordis 4.0.5**。

| 插件 | 版本 | 功能 | 说明 |
|---|---|---|---|
| `@x-mug/dsh-auto-review-cache-identity` | 1.1.1 | 给内置 Auto 审查补稳定缓存身份，可固定审查模型 | [源码仓库](https://github.com/x-mug/dsh-auto-review-cache-identity) · [使用说明](plugins/dsh-auto-review-cache-identity/README.md) |
| `@x-mug/dsh-code-location-links` | 1.1.0 | 修复 Windows `/C:/...` 文件链接、常见行列号后缀 | [源码仓库](https://github.com/x-mug/dsh-code-location-links) · [使用说明](plugins/dsh-code-location-links/README.md) |
| `@x-mug/dsh-session-find` | 1.1.0 | Worker 查找、历史完整性校验、命中核对、跨会话搜索、Ctrl+F | [源码仓库](https://github.com/x-mug/dsh-session-find) · [使用说明](plugins/dsh-session-find/README.md) · [性能记录](plugins/dsh-session-find/PERFORMANCE.md) |
| `dsh-session-header` | 0.4.3 | 给 LLM 请求补会话标识头，原生发送时让位 | [源码仓库](https://github.com/x-mug/dsh-session-header) · [使用说明](plugins/dsh-session-header/README.md) |

本仓库是合集索引：每个插件有自己的源码仓库，这里用 submodule 挂载，统一校验。**本仓库不能当作插件安装**，装的是各插件自己的仓库根地址。

## 安装

在 DSH 打开 **插件 → 添加插件 → 安装第三方插件**，填插件仓库的安装地址，例如：

```text
github:x-mug/dsh-session-find
github:x-mug/dsh-session-header
```

插件管理器接受 npm 包名、绝对本地路径、git 地址和 http(s) 压缩包直链。每个插件仓库的根目录就是插件包，所以不再需要 `#path:` 子目录写法。

如插件仓库提供 Release，也可以贴其中的压缩包直链。

已经下载了文件，就填它的绝对路径。装好后按提示重启或重载；升级时先移除旧版本再安装。

只写本合集仓库的根地址不行：根目录不是插件包，管理器会拒绝并回滚。通过压缩包或 git 安装的副本不会随源码目录变化而更新。

## 仓库结构

```text
plugins/
  dsh-auto-review-cache-identity/  # submodule → x-mug/dsh-auto-review-cache-identity
  dsh-code-location-links/         # submodule → x-mug/dsh-code-location-links
  dsh-session-find/                # submodule → x-mug/dsh-session-find
  dsh-session-header/              # submodule → x-mug/dsh-session-header
scripts/verify.mjs                 # 逐个插件跑语法与独立测试
docs/PLUGIN-DEVELOPMENT.md         # DSH 插件开发经验
.github/workflows/ci.yml           # Linux / Windows 验证（递归 checkout）
.github/workflows/sync-submodules.yml # 每天把 submodule 指到插件仓库最新提交
```

克隆时带上 `--recursive`，否则 `plugins/` 下是空目录：

```sh
git clone --recursive https://github.com/x-mug/dsh-plugins.git
```

已经普通克隆过的补一次：

```sh
git submodule update --init --recursive
```

## 开发和验证

需要 **Node.js 24** 和 **pnpm 11**。先安装 session-header 的锁定依赖，再运行四个插件的验证：

```sh
pnpm --dir plugins/dsh-session-header install --frozen-lockfile --ignore-scripts
node scripts/verify.mjs
```

默认不运行依赖本机 DSH 包的四项可选集成测试。要运行这些测试，设置 `DSH_INTEGRATION_VENDOR`（链接插件）和 `DSH_TEST_VENDOR_DIR`（会话查找），分别指向自己本机解包的依赖目录；具体格式见各插件说明。仓库不含第三方运行时源码、用户会话或凭据。

插件形态、bundle patch、配置读取、`llm/stream` 拦截、设置分区等通用注意事项见 [DSH 插件开发经验](docs/PLUGIN-DEVELOPMENT.md)。

打包前先运行验证，然后创建 `dist` 目录，在每个插件目录运行：

```sh
npm pack --ignore-scripts --pack-destination ../../dist
```

安装包独立保留各自版本；上述命令生成本地压缩包。

## 兼容性

- 插件都使用 DSH 现有客户端服务和既有能力，未修改 DSH 安装文件。
- 链接插件依赖 Cordis `internal/get`，会话查找的消息跳转依赖 rc.3 的 Chat DOM 锚点，审查身份插件依赖 rc.3 的 `llm/stream` waterfall、`agents.currentInitiator()` 与设置页槽位。升级 DSH 后需要重新验证。
- 会话查找的性能记录来自合成语料的本机测试，不等同于浏览器端到端延迟，也不构成与其他编辑器的性能对标。
- 自动测试、真实 Cordis / 快捷键注册器集成和当前 DSH Web 页面的按键、搜索、高亮与跨会话跳转已验收；审查身份插件另有离线自动化验证（23 项）；设置分区、模型下拉、保存与热切换已在真实 DSH 桌面端验收：连续切换 `magpie-responses/codex/gpt-6.1-terra`、清空、`magpie/group/fasttranslate` 后，profile 补丁值与 trace 记录的实际改写路由逐一一致，切换在秒级生效且无需重启。链接插件与会话查找的验证范围见 [验证记录](docs/VALIDATION.md)，本次新增插件的验证范围见其[使用说明](plugins/dsh-auto-review-cache-identity/README.md)。
