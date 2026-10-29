# DSH 本地文件与行号链接修复

让 DeepSeek Harness Desktop 的本地文件链接支持 Windows `/C:/...` 路径和常见行列号后缀，并使用 DSH 原有文件预览器打开。

版本 **1.1.0**，插件包名为 `@local/dsh-code-location-links`。兼容基线为 **DeepSeek Harness Desktop 0.2.1-rc.3 / Cordis 4.0.5**。插件依赖 DSH 内部服务钩子，其他版本需要重新验证。

## 安装

1. 打开本仓库的 [Releases](https://github.com/x-mug/dsh-plugins/releases)，下载 `local-dsh-code-location-links-1.1.0.tgz`。
2. 在 DSH 插件页点击「添加插件」→「安装第三方插件」，输入下载文件在本机的绝对路径。
3. 按插件页提示重启或重载应用，确认插件版本为 1.1.0。
4. 关闭此前打开失败的文件标签，再点击消息里的本地文件链接。

开发时也可以将本仓库目录的绝对路径用于安装。目录方式链接源码，需要保留目录；压缩包方式不依赖源码目录持续存在。

## 更新

修改源码目录不会自动更新通过压缩包安装的副本。更新时先下载新版本 `.tgz`，然后：

1. 在插件页移除旧的 `@local/dsh-code-location-links`；仅停用不会解除“已安装”检查。
2. 按安装步骤添加新压缩包，重启或重载应用，并确认版本。
3. 关闭旧的失败标签，再次点击链接。

## 支持的写法

| 写法 | 处理 |
|---|---|
| `/C:/Project/README.md` | 归一化为 `C:/Project/README.md` |
| `/c%3A/Project/My%20File.md` | 解码后识别盘符，保留文件名中的空格 |
| `C:\Project\My File.md`、编码后的 `%5C` | Windows 反斜杠归一化为 `/` |
| 文件服务收到 `\\server\share\file.md` | 保留 UNC 服务器和共享路径，仅归一化分隔符；聊天 Markdown 本身会过滤 UNC |
| `File.cs:251`、`File.cs:251:8` | 去掉位置后缀，传行号 251 给原预览器 |
| `File.cs(251,8)`、`File.cs(251)` | 支持编译器风格位置后缀 |
| `README:12`、`Dockerfile:12`、`.env:12` | 支持常见无扩展名文件和点文件 |
| `File.cs#L251`、`#L251-L260` | 与 DSH 原生行号导航兼容；文件服务直接传入的 `#L251C8` 也能解析 |

列号从文件名移除，当前预览器按行定位。显式传入的 `params.line` 优先，其余打开参数、会话身份和文件访问范围保持不变。

## 兼容边界

- 只处理 `sidebarRight.openResource` 收到的 `dsh-resource://file/session/<id>/...` 文件地址。
- `/home/...`、正常 UNC 路径、网络地址、无效编码、盘符相对路径 `C:foo` 保留原样。开头恰为 `/盘符:/` 时按 Windows 路径解释；远端 POSIX 上若刻意创建同名 `/C:/` 目录，也会触发这条规则。
- 保留原链接的绝对路径和所属会话，不根据工作目录改成相对路径；同一文件已有相对地址标签时，可能另开一个标签。
- 不重复解码 `%253A`，不把编码的 `%2F` 当目录分隔符，不猜测文件实际存在位置。
- Markdown 中的 `file:///...`、UNC、原始 `?query`、`#L12C3` 被 DSH 在渲染阶段过滤，不会进入文件服务。聊天链接请用 `C:/...` 或 `/C:/...`，行号使用 `#L12` 或 `:12`。回复流式生成期间，本地链接暂为普通文字也是 DSH 的行为。
- 位置后缀限正安全整数。含扩展名或常见文件名的末尾 `:数字`、`(数字)` 解释为位置；若真实文件名本来就带这种后缀，应通过文件浏览器打开。
- 1.1.0 支持的是当前聊天文件服务入口。原文件不存在、文件访问权限不足、所属会话工作目录不正确仍由原预览器报告。
- 使用 Cordis `internal/get` 包装 `sidebarRight`。停用或卸载会移除包装，已缓存的旧包装也会停止改写；升级 DSH 后应重新验证。

## 开发与验证

需要 **Node.js 24**。核心测试和语法检查没有第三方依赖，无需执行 `npm install`：

```sh
npm test
npm run check
```

等价的直接命令为：

```sh
node --test --test-isolation=none test/*.test.cjs
node --check client.js
node --check index.js
```

核心测试通过模拟插件服务，覆盖 Windows/POSIX/UNC、编码/中文/空格、行列号、参数保留及卸载恢复。GitHub Actions 在 Linux 和 Windows 上运行核心测试、语法检查与 `npm pack --dry-run --ignore-scripts` 包清单验证。自动化测试不代表真实 GUI 点击验收。

### 可选本机集成测试

`test/routing.test.cjs` 可使用本机提供的 DSH 地址工具和 Cordis 4.0.5，验证地址构造/解析、服务缓存、卸载及重新启用。本仓库不包含或下载这些第三方运行时源码，默认测试会明确跳过这两项集成测试。

如已有兼容的本机依赖目录，可设置 `DSH_INTEGRATION_VENDOR` 指向以下结构后运行 `npm test`：

```text
<local-dependencies>/
  dsh-util-workspace-path/lib/index.js
  cordis/lib/index.js
  cosmokit/lib/index.js
```

例如在 PowerShell 中：

```powershell
$env:DSH_INTEGRATION_VENDOR = 'C:\path\to\local-dependencies'
npm test
```

目录中的文件应来自你已有的兼容安装，保持在本地，不要提交或打包到仓库中。没有设置环境变量或缺少文件时，测试输出会说明跳过原因；依赖存在但不兼容时，集成测试会失败。路由测试使用通用 Windows 示例路径，无需本机存在对应文件，也不依赖相邻项目目录。

## 本地打包

在仓库目录执行：

```sh
npm pack --ignore-scripts
```

输出 `local-dsh-code-location-links-1.1.0.tgz`。包清单由 `package.json` 的 `files` 字段控制。`private: true` 用于避免误发到 npm，不影响本地打包或通过 GitHub Releases 分发。
