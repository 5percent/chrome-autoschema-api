# AutoSchema API Collector (Chrome Extension)

自动抓取浏览网站过程中的 API 请求与响应，推断出 schema 结构，并按域名分组导出 JSON，便于喂给 AI 做网站操作学习（例如结合 Chrome MCP 工具）。

## 特性

- 自动监听页面网络请求（XHR / fetch / 其他 HTTP 请求）
- 采集入参（query、body）和出参（response body）
- 自动推断 JSON schema 并做增量合并
- 按域名分组管理 API schema
- 支持导出当前域名组和全部分组
- 支持导出 Chrome MCP 可直接消费的结构化格式
- 支持采集开关、仅 XHR/fetch、静态资源过滤、域名黑白名单

## 使用步骤

1. 打开 `chrome://extensions/`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”，选择本项目目录
4. 正常浏览目标网站，插件会自动采集 API
5. 点击插件图标，进入导出面板
6. 选择域名组并导出 JSON

## 采集策略

在导出面板可以配置：

- 启用/暂停采集
- 仅采集 XHR / fetch
- 过滤静态资源请求
- 域名白名单（仅采集匹配域名）
- 域名黑名单（排除匹配域名）

提示：白名单与黑名单都支持子域名匹配，例如配置 `example.com` 会匹配 `api.example.com`。

## MCP 导出

点击“导出 MCP 格式”会生成：

- `format: chrome-mcp-site-schema`
- `sites[]`：按域名分组
- `operations[]`：每个 API 的 method/pathTemplate/requestSchema/responseSchema/样例

该结构可直接提供给 AI Agent，用于通过 Chrome MCP 执行网站自动化操作与参数生成。

## 导出结构说明

导出 JSON 顶层为 `domains`，每个域名包含多个 API 项，每个 API 项包含：

- `method`
- `path`
- `pathTemplate`
- `requestSchema`
- `responseSchema`
- `sampleRequests`
- `sampleResponses`
- `count`
- `lastSeen`

## 注意事项

- 由于 Chrome 权限模型限制，响应体抓取依赖 `chrome.debugger` 协议。
- 对于二进制响应、跨进程限制或特殊协议响应，可能无法拿到 body。
- 本插件将数据保存在 `chrome.storage.local`（本地）。
