# MWI 迷宫模拟器：GitHub Pages 发布包

当前版本：v0.40。访问：https://kubona.github.io/migong/

怪物首次技能冷却采用计算器1.5.13的固定半冷却规则（先修正技能急速）。这是兼容口径，尚非经官方验证的机制。支持学习式搜索、独立统计验证和本机断点恢复；旧冷却规则的学习证据和断点不能直接用于本版。

这个压缩包已经是可直接发布的纯静态网站，不需要 Node.js、数据库、Cloudflare、服务器或构建命令。

## 发布步骤

1. 在 GitHub 新建一个 **Public** 仓库。
2. 解压本压缩包，把解压后根目录中的全部文件上传到仓库 `main` 分支根目录。必须让 `index.html` 直接位于仓库根目录，不要再套一层同名文件夹。
3. 打开仓库 **Settings → Pages**。
4. 在 **Build and deployment** 中把 **Source** 设为 **Deploy from a branch**，分支选择 `main`，目录选择 `/(root)`，保存。
5. 等待 GitHub 完成部署。项目站点通常是 `https://你的用户名.github.io/仓库名/`。

GitHub 官方说明：<https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site>

## 使用方式

- 网页版不会自动连接 Windows 本机启动器，请在页面中手动选择 `init_character_data.json` 和 `init_client_data_v*.json`。
- 随包提供的 `MWI数据桥接.user.js` 可在游戏页捕获并下载这两份文件；自动推送只对 Windows 本机版有效。
- 模拟完全在访问者浏览器和 CPU 中运行。站点没有后端、登录、数据库、遥测或文件上传接口。

## 不要上传的内容

不要上传开发项目目录、真实角色 JSON、测试夹具、`.git`、`.openai`、`.env*`、`node_modules`、构建缓存、研究日志或 Windows 构建工作目录。只上传本压缩包内的文件。

## 更新

更新时，用新发布包中的 `index.html`、`styles.css`、`assets`、`data`、`engine`、`js` 覆盖仓库中的旧版本；保留 `.nojekyll`。游戏更新后，使用者仍应自行加载与角色数据同版本的客户端 JSON。
