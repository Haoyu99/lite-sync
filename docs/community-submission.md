# Obsidian 社区目录提交

Obsidian 读取 GitHub 默认分支根目录的 manifest，并从匹配的 Release 标签下载安装附件。

## 本地准备

- 根目录 `README.md`、`LICENSE`、`manifest.json` 和 `versions.json` 已提供。
- 根目录与 `packages/plugin` 的 manifest 和版本映射需要一致。
- README 披露自行部署要求、网络目标、加密范围、运行元数据、本地凭据存储和其他插件代码及配置同步。
- `THIRD_PARTY_NOTICES.md` 保留 node-diff3 的许可证，构建时嵌入 `main.js`。
- 执行 `npm ci`、`npm run lint:plugin`、`npm test`、`npm run check`、`npm run build`。
- 本地 ESLint 检查覆盖插件与共用核心；服务端、网页后台、测试和构建脚本不作为 Obsidian 运行时代码检查。官方扫描器可能扫描单仓库内更多文件，以官方报告为准。
- `isDesktopOnly: false` 声明移动端支持，但真实 Windows、macOS、iOS 和 Android 客户端的完整验收尚未完成；不能把模拟测试描述为实机验证。

发布时在 GitHub 创建与 manifest 一致、不带 `v` 的标签，并为 Release 上传独立的 `main.js`、`manifest.json`、`styles.css`。安装 ZIP 的根目录也应直接包含这三个文件。不要移动或覆盖已发布的旧标签。

## 0.2.5 本地验证记录

- 83 项自动化测试通过，涵盖同步、加密、配对和登录，以及空目录清理时并发创建文件的回归场景。
- 类型检查：通过；Svelte 为 0 错误、0 警告。
- 项目构建：通过，插件产物包含 `main.js`、`manifest.json`、`styles.css`。
- 官方推荐 ESLint 0.6.0：0 错误、18 条警告。警告包括共用核心的 `globalThis`、配置目录默认值、可在 Node 测试中运行的定时器、主文档事件监听，以及保留最低 Obsidian 1.8.7 支持时使用的设置 API。没有为了取得零警告而全局关闭这些规则。
- 官方自动审核完成，无阻塞错误，构建通过逐字节验证。`0.2.6` 把英文使用说明和数据披露移到根目录 README，并升级审核标记的 Hono 服务端依赖。新版本的在线结果以社区后台为准。

## 在官方目录提交

1. 打开 <https://community.obsidian.md>，使用 Obsidian 账号登录。
2. 在个人资料关联拥有仓库的 GitHub 账号。
3. 进入 **Plugins → New plugin**，填写 `https://github.com/Haoyu99/lite-sync`，Owner 选择自己。
4. 阅读开发者政策和维护承诺，再确认并提交。
5. 查看自动审核结果；如有错误，修正并发布递增版本。编辑条目说明，按页面要求完成 **Publish**。
6. 确认公开条目可见，并在 Obsidian 的社区插件浏览器确认可安装后，才更新 README 宣布收录。

可用于条目的英文短说明（也可保留当前 manifest 的说明）：

> Sync notes through your own server with end-to-end encryption, version history, and conflict recovery.

需要重点核对插件同步行为：只同步用户自己服务器中的其他插件，不更新 Lite Sync 自身；新插件不自动启用，已有插件可能在同步后重新加载。官方政策禁止插件自行安装或更新自身及其依赖，不能将该规则解读成无条件允许所有代码同步。若审核对此提出问题，应按实际行为解释或调整功能，不隐瞒该能力。

## 官方资料

- [提交指南](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [账号关联与添加插件](https://docs.obsidian.md/community-directory/set-up-and-claim)
- [开发者政策](https://docs.obsidian.md/community-directory/developer-policies)
- [插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [审核 FAQ 与本地检查](https://docs.obsidian.md/community-directory/faq)
