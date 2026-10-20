# Sloan云盈客服助手

把拼多多、天猫、抖店、京东、有赞等店铺的**商家客服网页**放进一个桌面软件里：所有店铺的买家消息汇总到一个收件箱，AI 按知识库和大模型自动回复，答不了的用平台自带的转接功能交给人工子账号，目标是每条消息 20 秒内有回应。

- 不需要平台开放接口：直接内嵌各平台官方的商家客服网页，在网页内读消息、发回复、做转接。
- **任意模型驱动**：通义千问、DeepSeek、智谱 GLM、Kimi、豆包、OpenAI、Claude、本地模型（Ollama，免费、不用 Key），以及任何 OpenAI 兼容接口。可以配置多个，按顺序互为备用。**一个模型都不配也能用**：知识库能答的照常自动回复，其余转人工或发保底话术。
- 收件箱右侧看买家订单，一键发送订单、商品卡片或商品链接；买家问到商品时自动带链接。
- 三种模式：AI 托管 / 人工（AI 只在后台影子学习）/ 人工离线时 AI 接管。
- 双机部署：AI 席位和人工席位各一台电脑，通过同步服务共享知识库、待办和在线状态。

## 安装（普通用户）

到本仓库的 [Releases](../../releases) 页面下载对应文件：

| 系统 | 文件 | 安装方法 |
| --- | --- | --- |
| Mac（Apple 芯片：M1/M2/M3/M4） | `SloanYunying-版本号-mac-arm64.dmg` | 双击打开，把图标拖进「应用程序」 |
| Mac（Intel 芯片） | `SloanYunying-版本号-mac-x64.dmg` | 同上 |
| Windows 10/11 | `SloanYunying-版本号-win-x64-setup.exe` | 双击安装（推荐） |
| Windows 10/11（免安装） | `SloanYunying-版本号-win-x64.zip` | 解压到任意文件夹，双击 `Sloan云盈客服助手.exe` |

**第一次打开时的系统提示**（软件没有购买苹果/微软的开发者签名，属正常现象）：

- Mac 提示「无法验证开发者」：在「应用程序」里**右键点软件 → 打开 → 打开**，只需一次。如果提示「已损坏」，打开「终端」执行：`xattr -cr "/Applications/Sloan云盈客服助手.app"`
- Windows 提示「Windows 已保护你的电脑」：点「更多信息 → 仍要运行」。

不知道自己的 Mac 是哪种芯片：左上角苹果菜单 → 关于本机，「芯片」写着 Apple M 开头的选 arm64，写 Intel 的选 x64。

## 开始使用

1. 打开软件，左侧有一个「模拟店铺(测试)」可以先熟悉流程：在「店铺后台」底部黄色栏模拟买家发消息，到「收件箱」看 AI 怎么处理。
2. 「设置 → 模型」：选一个平台，点「获取 Key」去申请 API Key，填入后点「测试」。不想花钱、也不想联网用模型，可以装 [Ollama](https://ollama.com/download) 跑本地模型。
3. 「知识库 → 导入 Excel」：模板见 `samples/QA知识库模板.xlsx`，第一行表头：问题、答案、相似问法（用 | 分隔）、关键词（用 | 分隔，`+` 表示都要出现）、分类、品牌。知识库匹配完全在本机完成，**不需要模型**。
4. 左下角「添加店铺」→ 在「店铺后台」登录 → 点「校准」告诉软件消息、输入框、订单栏在哪 → 录转接步骤（图文教程见使用说明「校准（详细图解）」）。
5. 「商品库 → 导入 Excel」（模板 `samples/商品库模板.xlsx`）：收件箱右侧可一键发商品链接，买家问到商品时 AI 自动带链接。

完整使用说明见 [docs/使用说明.md](docs/使用说明.md)。

## 模型配置参考

| 平台 | 接口地址（默认已填） | 默认型号 | 是否要 Key |
| --- | --- | --- | --- |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | qwen-plus | 是 |
| DeepSeek | `https://api.deepseek.com` | deepseek-flash | 是 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | glm-4.7-flash（免费档） | 是 |
| Kimi（月之暗面） | `https://api.moonshot.cn/v1` | kimi-k2.6 | 是 |
| 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` | doubao-seed-1-8-251228 | 是 |
| OpenAI | `https://api.openai.com/v1` | gpt-4.1-mini | 是 |
| Claude | `https://api.anthropic.com` | claude-haiku-5-5 | 是 |
| 本地模型（Ollama） | `http://127.0.0.1:11434/v1` | qwen3:8b | 否 |
| 自定义 | 任何 OpenAI 兼容接口 | 自填 | 视接口而定 |

各家型号名更新很快：填好 Key 后点「获取型号」，会列出当前账号能用的型号供选择。

## 两台电脑（AI 席位 + 人工席位）

1. 在其中一台电脑（或云服务器）运行同步服务：`SYNC_TOKEN=自设密码 node sync/server.js`（Windows 可双击 `启动同步服务.bat`），默认端口 8787。需要先安装 [Node.js](https://nodejs.org)。
2. 两台电脑的「设置 → 双机同步」都填 `http://那台电脑的局域网IP:8787` 和同一个密码。
3. AI 电脑「席位类型」选 AI 席位、登录各店 AI 客服账号；人工电脑选人工席位、登录各店人工子账号。

## 从源码运行 / 调试（开发者）

需要 [Node.js](https://nodejs.org) 20 或更高版本。

```bash
git clone <本仓库地址>
cd sloan-yunying-kefu
npm install          # 国内网络已在 .npmrc 配置 npmmirror 镜像
npm start            # 启动软件
npm test             # 引擎、模型路由、双机同步测试
```

也可以直接双击 `启动云盈客服助手.command`（Mac）或 `启动云盈客服助手.bat`（Windows），首次运行会自动安装依赖。

浏览器端测试（模拟商家客服页 + 真实 Chromium）：

```bash
npm i -D playwright && npx playwright install chromium
npm run test:browser
```

打包安装程序（在 Mac 上可同时打出 Mac 和 Windows 版）：

```bash
npm run dist         # 产物在 dist/：两个 .dmg 和一个 Windows .zip
```

或双击 `打包安装程序.command`。

### 发布新版本

仓库已配置 GitHub Actions（`.github/workflows/release.yml`）：改好 `package.json` 里的 `version`，提交后推送一个同名标签，GitHub 会自动跑测试、在 Mac 和 Windows 机器上打包，并把安装包发布到 Releases。

```bash
git tag v1.0.2
git push origin v1.0.2
```

### 代码结构

```
main.js                 主进程：窗口、每个店铺一个独立登录环境的内嵌网页、模式判断、与界面通信
preload-platform.js     注入到店铺网页的桥
adapters/dom-core.js    页面内：读消息、自动打开未读会话、填写发送、执行转接、校准点选
adapters/platforms.json 各平台客服网页入口和选择器
engine/qa.js            知识库：Excel/CSV 导入、关键词/相似问法匹配
engine/products.js      商品库：导入、按商品名/关键词匹配
engine/llm.js           模型路由：任意平台、按顺序备用、超时控制、获取型号列表
engine/router.js        应答决策：人工专属类 → 知识库 → 模型 → 转接/保底/待办，时限控制
engine/learner.js       影子学习、候选问答、各类吻合率
engine/sync.js          双机同步客户端；sync/server.js 同步服务（零依赖）
ui/                     界面
mock/platform.html      模拟商家客服页（测试和演示用）
test/                   测试
```

### 数据存在哪

店铺登录状态、知识库、设置都保存在本机，不会上传：

- Mac：`~/Library/Application Support/Sloan云盈客服助手/`
- Windows：`%APPDATA%\Sloan云盈客服助手\`

API Key 只保存在这里，不在代码仓库里。

## 已知限制

- 每个平台的选择器需要在真实页面上「校准」一次；平台改版后重新校准对应项即可。
- 天猫/淘宝如果只能用千牛客户端接待（没有网页接待入口），当前版本不支持。
- 个人微信没有官方接口，不建议自动化；企业微信、有赞开放接口的接入在后续版本。
- 自动化操作商家后台存在平台风控风险，建议先用一家店小流量验证。
