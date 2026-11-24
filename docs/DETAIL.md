# 画布提示词桥

把提示词从 DeepSeek Harness 直接送进局域网里的 Infinite Canvas。

## 它解决什么

画布的节点数据在浏览器页面里，DSH 运行在 Node 侧，两者不能直接互访。这个插件把「发到哪台机器」保存成插件自己的配置：你只要让 DSH 发提示词，不需要记 IP、端口或接口格式。

链路：

```
DSH 工具 canvas_prompt
  → POST http://<画布主机>:8799/prompt
    → 画布里的「提示词桥」插件轮询取走
      → 写入你在画布上选中的那个节点
        → 你点生成
```

## 工具

| 工具 | 作用 |
|---|---|
| `canvas_prompt` | 把一段提示词放进队列。参数：`prompt`（必填）、`target`（可选，节点标题或 id）、`bridge`（可选，本次临时覆盖地址） |
| `canvas_prompt_bridge` | `status` 查看队列长度，`clear` 清空队列 |
| `canvas_prompt_config` | `get` 查看当前地址与来源，`set` 保存新地址，`clear` 清除 |

## 改地址

地址不写死，优先级为：

1. 单次调用传的 `bridge`
2. 保存的配置 `config.json` 里的 `bridgeUrl`
3. 环境变量 `CANVAS_BRIDGE_URL`
4. 内置默认 `http://192.168.3.200:8799`

改保存的地址：调用 `canvas_prompt_config`，`action: "set"`，`bridge: "http://192.168.3.201:8799"`。设置写进 profile 的 `cordis.patch.yml`（`canvas-prompt` 条目的 `config.bridgeUrl`），是 volatile 字段，改完立即生效、重启后保留。

本插件不带浏览器端设置页：DSH 只渲染插件自己注册的页面，而工作区链接形式的 bundle 无法可靠提供该页面，因此地址通过工具或 profile 配置修改。

## 使用前提

1. 画布主机上运行着提示词桥服务（`prompt-bridge.mjs`，监听 8799）。
2. 画布页面里放了一张「提示词桥」卡片，并在卡片面板里选好了接收提示词的节点。
3. 画布页面开着（关闭时提示词会留在队列里，下次打开补写）。

## 限制

- 桥只监听局域网，没有鉴权；只在可信内网使用，不要映射到公网。
- 插件只负责写入提示词，不触发生成。
