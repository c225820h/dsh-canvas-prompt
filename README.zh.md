# 画布提示词桥（中文说明）

在 DeepSeek Harness 里写提示词，直接落到局域网里 Infinite Canvas 的某个节点上，可选写入后立即开始生成。

这个仓库装的是**两半**，缺一半链路就不通：

```
DSH 侧插件（本仓库根目录 index.js）
  内置邮筒 :8799        ◀──每 1.5 秒轮询──   画布侧「提示词桥」卡片（canvas-plugin/prompt-bridge.js）
        ▲                                          │
        └──── DSH 工具 canvas_prompt 投递           └── 写进你指定的节点，可选触发 run_generation
```

- **DSH 侧**：`index.js`。它的 `apply()` 在 DSH 进程里起一个 HTTP 邮筒，监听 `0.0.0.0:8799`，并提供 `canvas_prompt` / `canvas_prompt_bridge` / `canvas_prompt_config` 三个工具。**不需要另起进程，不用改网关或启动器。**
- **画布侧**：`canvas-plugin/prompt-bridge.js`。一个画布插件，轮询邮筒、写提示词、按需触发生成。

两半是**两套独立安装**，互不代劳：DSH 侧装一次全局通用；画布侧是静态文件，**哪个画布实例要用，就单独往那份目录放一份**。

> ⚠️ 版本前提：内置邮筒是 **1.3.0** 才有的。1.2.x 只有客户端、没有 8799 服务端，装上去会出现「画布卡片一直未连接」。装之前先确认版本号。

---

## 一、DSH 侧安装

包装进的是 DSH 的 profile，装一次所有会话都能用。

### 方式 A：DSH 界面里装（推荐）

DSH → Plugins（插件）→ Add plugin（添加插件）→ 粘贴本仓库地址：

```
https://github.com/c225820h/dsh-canvas-prompt
```

→ 安装 → 立即启用。

### 方式 B：命令行装

```bash
dsh plugin --profile <你的 profile> add https://github.com/c225820h/dsh-canvas-prompt
```

### 方式 C：本地目录装

把这个仓库目录拷到目标机器，然后在 DSH 里「Plugins → Add plugin → 选本地目录」；或者软链进 profile 的 `node_modules`，并在 profile 的 `package.json` 里登记：

```json
{
  "dependencies": { "@local/dsh-canvas-prompt": "github:c225820h/dsh-canvas-prompt" },
  "dsh": { "profile": { "bundles": ["@local/dsh-canvas-prompt"] } }
}
```

本地目录安装需要先在包目录里 `npm install`（依赖 `@deepseek-ai/schemastery`）；走 Git 地址安装会自带依赖。

### 装完验证

1. **重启 DSH**（邮筒是在插件 `apply()` 里 `listen` 的，不重启不生效）。
2. 确认端口在听：

```bash
curl http://127.0.0.1:8799/health
# {"ok":true,"pending":0}
```

3. 确认工具出现：`canvas_prompt`、`canvas_prompt_bridge`、`canvas_prompt_config`。

### 卸载

从 profile 的 `package.json` 里同时删掉 `dependencies` 里那一行和 `dsh.profile.bundles` 里那一项，再删掉 `node_modules/@local/dsh-canvas-prompt` 目录，然后重启 DSH。**只删一处不行**：只删依赖，加载器还会去加载；只删 bundles，安装记录还留着。

---

## 二、画布侧安装

画布插件是静态文件，没有包管理器，靠目录扫描自动发现。

### 放两个文件

```
<画布项目>/infinite-canvas/web/dist/plugins/prompt-bridge.js      ← 运行时真正托管的是这份
<画布项目>/infinite-canvas/web/public/plugins/prompt-bridge.js    ← 重建 front-end 时不被冲掉用这份
```

`dist/` 是**必需**的；`public/` 是为了下次 `npm run build` 时不丢，两份都放最省心。

### 改两处 index.json

`dist/plugins/index.json` 与 `public/plugins/index.json` 各加一条：

```json
"/plugins/prompt-bridge.js"
```

### 刷新画布

插件声明了 `defaultEnabled: true`，刷新页面就会自动启用，不需要手动开开关。

### 落到哪一份画布上

画布可能同时存在多份，**各读各自的 `plugins/` 目录，互不相通**：

| 画布实例 | 放文件的目录 |
|---|---|
| 工作台直连（如 `http://<画布主机>:3000`） | `<画布项目>/infinite-canvas/web/dist/plugins/` |
| DSH 侧边栏内嵌画布（8294） | `<DSH profile>/node_modules/dsh-wujie-canvas/web/plugins/` |

两份都对 `index.json` 做同样的登记。别指望装一处两边都有——连画布项目数据（localStorage）都是按 origin 隔离的。

---

## 三、使用

1. 在画布里新建一个 **提示词桥** 节点（在节点插件列表里，图标 BRG）。
2. 点开它的面板：
   - **邮筒地址**：填 **DSH 那台机器**的地址，例如 `http://192.168.3.150:8799`。
     ⚠️ 卡片默认值是「页面自己的主机名 + 8799」。当画布在 200、DSH 在 150 时，这个默认值必然填错，必须手改成 DSH 那台的 IP。
   - **写入目标**：下拉选接收提示词的节点。
   - **写入后自动生成**：勾上则写入后立即 `run_generation`；不勾只写提示词，你自己点生成。
   - **测试邮筒**：连通性自检；**清空队列**：丢弃积压。
3. 在 DSH 里让 agent 发提示词，或直接调工具：

```
canvas_prompt { prompt: "雨夜街口红裙女子，逆光，镜头浅景深" }
```

4. 卡片每 1.5 秒取一次件。页面关着时提示词留在 DSH 队列里，重开页面会补写。

---

## 四、工具

| 工具 | 作用 |
|---|---|
| `canvas_prompt` | 投递一条提示词。`prompt` 必填；`target` 可选（节点标题或 id），留空则用卡片里选的目标 |
| `canvas_prompt_bridge` | `status` 看待处理条数，`clear` 清空队列 |
| `canvas_prompt_config` | 读取邮筒端口，以及该填进画布卡片的地址 |

## 五、邮筒接口

如果只想自己写个客户端，直接用这几个路由：

| 路由 | 说明 |
|---|---|
| `GET /health` | `{ok, pending}` |
| `GET /queue` | `{ok, items[], nextId}`，**不删除**，取件靠 ack |
| `POST /prompt` | `{text, target?}` → `{ok, item, pending}` |
| `POST /ack` | `{ids:[...]}` 确认已写入，从队列删除 |
| `POST /clear` | 清空队列 |

## 六、配置

`bridgePort`（默认 `8799`）是易变配置项，改 profile patch 后不用重启 DSH：

```yaml
- id: canvas-prompt
  name: "@local/dsh-canvas-prompt"
  config:
    bridgePort: 8799
```

改端口后，画布卡片里的地址也要跟着改。

## 七、限制

- 邮筒绑 `0.0.0.0` 且**没有鉴权**。只在可信内网使用，不要映射到公网。
- 队列在内存里，最多 50 条，**DSH 重启即清空**。
- 画布侧写的是 `metadata.prompt`（文本节点写 `metadata.content`）；只有 image / video / audio / text 四类节点会触发 `run_generation`。
- 卡片地址存在**画布项目**里（节点 metadata），换项目要重填；邮筒端口存在 **DSH profile** 里，两边是分开的。

## 许可

MIT
