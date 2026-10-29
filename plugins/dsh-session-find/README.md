# 会话内查找（@local/dsh-session-find）

DSH Desktop 0.2.1-rc.3 的会话内查找插件。选中会话内按 `Ctrl+F`（Web 端 `Ctrl+Alt+F`）打开右侧查找面板，检索 **完整会话历史**，逐个跳转命中处。

## 为什么需要它

DSH 0.2.1-rc.3 没有独立的“当前会话内查找”：

- 浏览器自带查找只能覆盖已经挂载的消息。旧历史仍分页存放，未加载的消息搜不到。
- 侧栏搜索是跨会话的会话级搜索；内置 SQLite 后端在当前 Desktop 配置里 `openAt: never`，且用 `unicode61` 分词，中文和代码标识符的内部子串无法命中。
- 官方“会话搜索”插件只给 Agent 注册工具，不改变侧栏，也不提供 Ctrl+F。
- 消息跳转没有公开 API；`conversation.openView('chat', focus)` 写入的 `viewRequest` 官方 Chat 并未消费。

本插件不改变内置包：独立通过 `remote.session.page` 分页读取当前会话历史，在 Worker 中建索引，命中后调用公开的 `loadThrough(seq)` 加载对应窗口，再用当前版本的 Chat DOM 锚点（`data-chat-node-key` / `data-chat-anchor-key` / `data-chat-group-part`）定位与高亮。

## 功能

- 后台 Worker 索引，主线程不扫文本。
- 区分大小写、中文等无大小写字符的字面量搜索走原生 `indexOf`；忽略大小写时，ASCII 缓存内走折叠加 `indexOf`，其余走转义后的 `giu` 正则以保留 UTF-16 偏移。
- 选项：区分大小写、全字匹配（Unicode 字母/数字/下划线边界）、正则、包括思考文字。
- 计数、上一个/下一个（`Enter` / `Shift+Enter`）、结果分页（每页 50 条）。
- 新输入立即取消过期查询（latest-wins）；正则查询超过 1.5 秒会重建 Worker，不会挂死界面。
- 搜索范围：已完成的用户输入与助手文字；思考可选。工具、附件、注入上下文、compaction 摘要不在范围内。被 compaction 从模型上下文移除、但当前会话仍可见的原始消息仍会被搜到。

## 安装

1. 从本仓库的 [Releases](https://github.com/x-mug/dsh-plugins/releases) 下载 `local-dsh-session-find-1.0.0.tgz`。
2. 打开 Desktop 的 **插件 → 添加插件 → 安装第三方插件**，选择该 `.tgz`。
3. 重启 / 重载应用，打开任意会话按 `Ctrl+F`，或点会话标题栏的搜索按钮。

升级时先移除旧版本再安装新包；修改源码目录不会影响已安装副本。

> 安装后是否加载成功以 Desktop 插件页显示的状态为准；本仓库的测试不代替运行中的应用验证。

## 使用与边界

| 场景 | 行为 |
|---|---|
| 旧历史尚未加载 | 插件独立分页读取并索引，不会一次性把全文挂进聊天正文 |
| 点击命中 | 调用 `loadThrough` 加载目标窗口，展开折叠过程，滚动并高亮 |
| Markdown 显示与原文略有差异 | 仍然定位到对应消息；面板会提示精确高亮不可用 |
| 正在流式生成的回复 | 完成入库后自动纳入索引 |
| 历史超预算 | 默认 128 MiB 文本；超出后停止扩展并明确报告“仅部分历史” |
| 会话切换 | 关闭旧会话的索引与 Worker 引用，结果不会串会话 |

## 已知限制

- 点击命中前需处于会话的聊天视图。跳转依赖 rc.3 的 Chat DOM 锚点。DSH 升级后若锚点变化，会明确报“聊天锚点不兼容”，而不是跳到错误位置。
- `loadThrough` 在已有普通分页进行中时可能提前返回；插件会先等待空闲再加载并校验结果。跳转旧消息会让 DSH 挂载目标到当前窗口之间的历史，这是内置 Chat 的行为，搜索本身不会触发这项成本。
- 默认最多 100,000 个文本块、100,000 处命中；文本超限或读取失败会保留明确的“部分历史”提示。索引仅在内存，关闭查找或切换会话后释放，再次打开需要重读。
- 正则使用 JavaScript `g`/`gi` 语义，不支持用户指定额外 flags；查询以单个原始文本块为边界，跨块或跨消息的匹配不计入结果。
- Web 端不支持普通 `Ctrl+F`（快捷键策略拒绝），改用 `Ctrl+Alt+F` 或按钮。
- 冷启动需要读取历史；首次搜索的延迟取决于会话长度，见 [PERFORMANCE.md](./PERFORMANCE.md)。

## 开发

```powershell
node build.mjs                                    # 生成 client.js 与 test/worker-built.js
node --test --test-isolation=none test/*.test.mjs # 全量测试
node test/benchmark.mjs                           # 性能测量
```

`build.mjs` 把 `src/engine.js` 与 `src/worker.js` 合并成嵌入 Client 的 Worker 文本，并把其余源码组装为 `client.js`；测试前必须先构建。沙箱环境下请使用 `--test-isolation=none`，避免子进程管道被拒绝。

默认跳过一项可选的运行时集成测试：设置 `DSH_TEST_VENDOR_DIR` 指向已解包的 `cordis/`、`cosmokit/` 目录后，会额外验证生成的 Client 在 Cordis 4.0.5 中加载与卸载。仓库不含任何第三方运行时源码。

打包后可用 `node test/package-check.mjs <tgz>` 逐文件比对归档与工作区内容并输出 SHA256。
