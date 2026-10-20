## Sloan云盈客服助手

多平台多店铺电商客服整合 IM：内嵌拼多多、天猫、抖店、京东、有赞等商家客服网页，知识库关键词秒回、任意大模型驱动 AI 自动应答，平台转接人工、人工离线 AI 接管。

### 下载哪个

| 系统 | 文件 |
| --- | --- |
| Mac（Apple 芯片 M1/M2/M3/M4） | `SloanYunying-版本号-mac-arm64.dmg` |
| Mac（Intel 芯片） | `SloanYunying-版本号-mac-x64.dmg` |
| Windows 10/11（64 位，安装版，推荐） | `SloanYunying-版本号-win-x64-setup.exe` |
| Windows 10/11（64 位，免安装） | `SloanYunying-版本号-win-x64.zip`，解压后双击 `Sloan云盈客服助手.exe` |
| 使用说明（离线网页） | `user-guide-zh.html` |
| 知识库模板 | `qa-template.xlsx` |

不知道 Mac 是哪种芯片：左上角苹果菜单 → 关于本机，「芯片」写 Apple M 开头的选 arm64，写 Intel 的选 x64。

### 第一次打开

- Mac 提示「无法验证开发者」：在「应用程序」里右键点软件 → 打开 → 打开。提示「已损坏」：终端执行 `xattr -cr "/Applications/Sloan云盈客服助手.app"`
- Windows 提示「Windows 已保护你的电脑」：点「更多信息 → 仍要运行」

### 本版更新（v1.0.1）

- 知识库匹配新增「关键词」：买家的话里出现关键词就直接用答案回复，`+` 表示几个词都要出现（如 `多久+发`）；买家一长句里包含标准问法也能命中。全部在本机完成，不需要模型。
- 试答和收件箱会显示命中原因（关键词 / 包含问法 / 相似问法）。

### 模型

通义千问、DeepSeek、智谱 GLM、Kimi、豆包、OpenAI、Claude、本地 Ollama（免费、不用 Key）及任意 OpenAI 兼容接口，在「设置 → 模型」里配置。不配模型也能用：知识库能答的自动回复，其余转人工。
