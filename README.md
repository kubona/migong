# MWI 迷宫模拟器：GitHub Pages 发布包

当前版本：v0.42。访问：https://kubona.github.io/migong/

v0.42 完整合法配装及主动顺序参与竞争。模型从正常战斗结果边模拟边学习，只安排测试先后，不截断候选。每套先测试当前最高已确认等级，通过后增加5级，失败后二分；同等级保留胜率与胜场平均耗时两张榜单。

怪物首次技能冷却继续采用计算器1.5.13的固定半冷却规则（先修正技能急速）。这是兼容口径，尚非经官方验证的机制。搜索采用胜率随等级不升高的假设；95%统计保证覆盖本任务全部候选/等级及反复查看，但不保证游戏模型本身正确，也不另外认证同级前三排序。

首次默认100场、每批追加300场，每个配装等级本轮最多5000场。仍未确定时保留候选，可恢复任务追加新样本，不将其判为失败或宣布最优。完整候选分页保存在本机，内存工作窗口不是搜索范围上限。旧版断点不能跨计算版本恢复；兼容学习档案可引导排序，不直接充当新任务认证证据。

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
