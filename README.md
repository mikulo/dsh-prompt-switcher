<p align="center"><img src="icon.svg" width="72" alt="dsh-prompt-switcher"></p>

# dsh-prompt-switcher

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web 插件。新建对话时输入 `/`，可以从本地目录里的 `.md` 提示词模板中选一个。模板的约束力等同于 `AGENTS.md`，对这个对话之后的每一轮都有效。

- **兼容版本**：DSH `>=0.1.7-alpha.1`，即 0.1.7 系列的 alpha 版及之后的正式版；Node `>=22.19`
- **插件形式**：标准 DSH bundle。`package.json` 里声明了 `dsh.bundle.patch` 和 `dsh.client`，Host 半和 Browser 半都是纯 ESM，没有运行时依赖，安装时不需要构建
- 收录在 [mikulo/dsh-plugins](https://github.com/mikulo/dsh-plugins) 插件清单中

## 功能

| | |
|---|---|
| **设置页** | 设置 → **提示词模板**：选择模板目录（弹出系统文件夹对话框，也可以直接填路径），读取目录第一层的全部 `.md` 文件（不读子目录），每个模板有激活开关和「编辑」按钮，另有「刷新」按钮 |
| **`/` 菜单** | 已激活的模板按文件名显示在 `/` 菜单里，默认排在 Harness 自带指令之前（可以关闭） |
| **约束整个对话** | 选中模板并发送第一条消息后，模板以 AGENTS.md 同样的方式写入会话，之后每一轮都生效。上下文压缩、恢复会话、分叉会话后都会保留 |
| **只对新对话生效** | 已经进行过对话的会话里使用模板会被拒绝：模板不生效，消息也不发出，草稿保留 |
| **模板编辑** | 整页编辑视图：大号等宽编辑框，Ctrl+S 保存，显示未保存状态，检测保存冲突，并自动同步在外部编辑器里所做的修改。「用其他程序打开…」会弹出系统的“打开方式”对话框，由你自己选择编辑器 |

## 安装

### 通过 dsh-plugins 清单（推荐）

```sh
git clone https://github.com/mikulo/dsh-plugins.git
cd dsh-plugins
node install.mjs --profile web --only dsh-prompt-switcher
```

### 直接安装

```sh
dsh plugin --profile web add github:mikulo/dsh-prompt-switcher
```

安装后**重启 `dsh web` 并刷新页面**。

- 更新：`dsh plugin --profile web update @mikulo/dsh-prompt-switcher`，然后重启 `dsh web`
- 卸载：`dsh plugin --profile web remove @mikulo/dsh-prompt-switcher`

> 插件的 Browser 半会随页面热更新，Host 半必须重启 `dsh web` 才会加载新代码。两边版本不一致时，设置页顶部会提示“请重启 dsh web”。

## 使用

1. 打开 **设置 → 提示词模板**，点击「选择文件夹」，选中存放模板的目录。
   - 只读取该目录第一层的 `*.md` 文件，扩展名不区分大小写。列表按文件名显示。
   - 新目录中的模板默认全部关闭，打开开关才会激活。
   - 目录里的文件增删改之后，点击「刷新」。
2. 新建对话，在输入框输入 `/`，已激活的模板（例如 `代码审查`）会出现在菜单里。继续输入文字可以过滤。
3. 选中模板后，输入框变为 `/代码审查 `，接着输入第一条消息并发送。之后这个对话的每一轮都会遵守该模板。

仓库里的 [`examples/`](examples) 有两个示例模板，可以把它设为模板目录来体验。

### 编辑模板

在列表中点「编辑」进入编辑视图：

- 「保存」或 Ctrl+S 保存，「放弃修改」回到上次保存的内容，标题旁显示“已保存 / 未保存”，Tab 键插入两个空格。
- **用其他程序打开…**：Windows 上弹出“你要如何打开这个文件？”对话框，macOS 上弹出“选取应用程序”对话框，Linux 上用默认程序打开。在外部编辑器保存后，编辑视图约 2 秒内自动同步。如果这里也有未保存的修改，会让你选择「载入磁盘版本」或「保留我的修改」。
- 文件在打开后被其他程序改过时，保存会被拒绝，并提供「载入磁盘版本 / 仍然覆盖保存」。
- 关闭设置对话框时，未保存的草稿会保留到页面刷新前。
- 保存时保留文件原有的 BOM 和 CRLF 换行。
- 修改模板只影响**之后新建**的对话。已经开始的对话使用的是第一次发送时的模板快照。

## 工作原理

| 需求 | 实现 |
|---|---|
| 设置页面 | Browser 半向 `settings.section` 槽位注册页面 |
| 文件夹对话框 | 优先使用 Host 的 `directoryPicker` 服务（原生对话框）。该服务不可用时，Windows 上用 PowerShell 的 `FolderBrowserDialog`，其他平台提示手动输入 |
| 设置与模板读写 | Host 路由 `/api/dsh-prompt-switcher/*`，只接受本机回环地址的请求。只接受当前目录扫描结果里的文件名，访问不到目录以外的路径。配置保存在 `$DSH_HOME/dsh-prompt-switcher.json`（默认 `~/.dsh`） |
| `/` 菜单显示中文名 | Host 命令名只能用 ASCII，所以 Browser 半注册了自己的 `/` 输入触发源。选中后提交 Host 命令 `/prompt-template <模板id> <消息>`。置顶就是调整触发源的 `order` |
| 绑定模板 | Handler 先确认这是新对话，然后 `agent.inject(模板消息)`，再 `agent.steer(用户消息)`，与官方 `/plan` 的做法相同 |
| 约束力等同于 AGENTS.md | 模板以带来源 `{kind:'prompt-switcher', form:'instructions'}` 的 `<system-reminder>` user 消息写入会话日志，措辞与 `dsh-agent-instructions` 一致，即不高于 system、developer 或用户的直接指令 |
| 持续生效 | 会话投影从完整日志中折叠出已绑定的模板快照，所以恢复和分叉会话都能还原。`agent/pre-step` 钩子在模板被上下文压缩掉后，重新注入同一份快照 |

注意：

- 子代理（subagent）的会话不继承模板。
- 单个模板上限为 1 MiB。模板中的 `</system-reminder>` 会被转义。
- 设置接口只接受本机访问。通过局域网打开的 Web 页面不能修改本插件的设置。

## 开发

```sh
npm run build   # src/ → lib/：写入版本号，校验 Host/Client 协议号与模块 id，并做语法检查
npm test        # 确认 lib/ 与 src/ 一致，然后用伪造的 Harness 服务跑 Host 与 Client 冒烟测试
```

- 修改 `src/` 后运行 `npm run build`，并把 `lib/` 一起提交。插件通过 `github:` 安装时直接使用仓库里的 `lib/`，没有安装时构建脚本。
- 修改 Host 与 Client 之间的接口时，同时递增 `src/index.js` 和 `src/client.js` 中的 `HOST_PROTOCOL`。

本地联调可以用 link 安装：`dsh plugin --profile web add link:<本仓库绝对路径>`。改代码后重新构建，再重启 `dsh web`。

## 许可证

[MIT](LICENSE)
