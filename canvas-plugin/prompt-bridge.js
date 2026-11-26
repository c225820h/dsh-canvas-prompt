// 提示词桥（画布侧）：轮询 DSH 插件内置的邮筒，写入「连线指向」的节点，可选写入后自动生成。
// 目标只用连线：把这张卡连到目标节点即可，不再有下拉框。
export default function (runtime) {
    const { React, antd } = runtime;
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    const { Button } = antd || {};

    const NODE_TYPE = "prompt-bridge:card";
    const VERSION = "2.5.4";
    /** 必须与 DSH 侧的 CONTRACT 一致；不一致就拒绝写入并提示。 */
    const CONTRACT = 1;
    const POLL_MS = 1500;
    // 克隆新卡时剔掉的字段：上一轮的运行结果与任务状态。
    // 留着会让新卡顶着旧图、旧任务 ID 和旧错误，看起来像没生效。
    const RESULT_KEYS = [
        "status",
        "errorDetails",
        "images",
        "primaryImageId",
        "storageKey",
        "mimeType",
        "bytes",
        "durationMs",
        "previewUrl",
        "previewMime",
        "previewStep",
        "previewTotal",
        "stepProgress",
        "generationStartedAt",
        "generationDurationMs",
        "videoTaskId",
        "videoTaskProvider",
        "captionStatus",
        "captionError",
        "promptOptimizeStatus",
        "promptOptimizeError",
        "model3d",
        "stage3d",
    ];
    /** 默认邮筒：跑 DSH 插件的那台机器。面板里填地址可以覆盖。 */
    const DEFAULT_BASE = "http://192.168.3.150:8799";

    const OK = "#16a34a";
    const BAD = "#dc2626";
    const ACCENT = "#2563eb";
    const WARN = "#d97706";

    const FALLBACK_THEME = {
        node: {
            panel: "#fbfaf7",
            fill: "#e7e5df",
            stroke: "#d6d3ca",
            text: "#292524",
            muted: "#78716c",
            faint: "#a8a29e",
            label: "#57534e",
            placeholder: "#8a8479",
        },
    };

    const TYPE_LABEL = {
        text: "文本",
        image: "图片",
        video: "视频",
        audio: "音频",
        "free-card": "自由卡片",
        automation: "自动化",
        "short-drama": "短剧",
    };
    const SKIP_TYPES = new Set(["group", "config"]);
    const GENERATION_MODES = new Set(["image", "video", "audio", "text"]);

    const paletteOf = (theme) => (theme && theme.node ? theme : FALLBACK_THEME);
    const isDarkPalette = (palette) => {
        const hex = String(palette.node.fill || "#e7e5df").replace("#", "");
        if (hex.length < 6) return false;
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    };

    function tint(palette, kind) {
        const dark = isDarkPalette(palette);
        const map = {
            block: dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.035)",
            okSoft: dark ? "rgba(22,163,74,.18)" : "rgba(22,163,74,.12)",
            badSoft: dark ? "rgba(220,38,38,.18)" : "rgba(220,38,38,.12)",
            accSoft: dark ? "rgba(37,99,235,.22)" : "rgba(37,99,235,.10)",
            warnSoft: dark ? "rgba(217,119,6,.20)" : "rgba(217,119,6,.12)",
        };
        return map[kind] || map.block;
    }

    function typeLabel(type) {
        if (TYPE_LABEL[type]) return TYPE_LABEL[type];
        const raw = String(type || "?");
        return raw.includes(":") ? raw.split(":").pop() : raw;
    }

    function baseOf(node) {
        const raw = String((node?.metadata || {}).bridgeBase || "").trim();
        return (raw || DEFAULT_BASE).replace(/\/+$/, "");
    }

    function promptOf(node) {
        const meta = node?.metadata || {};
        return String(meta.prompt || meta.content || "").trim();
    }

    function titleOf(node) {
        const title = String(node?.title || "").trim();
        if (title) return title;
        const first = promptOf(node).split("\n")[0];
        return first ? first.slice(0, 24) : node?.id || "未命名";
    }

    function generationModeOf(node) {
        if (!node) return "";
        if (GENERATION_MODES.has(node.type)) return node.type;
        const meta = node?.metadata || {};
        return GENERATION_MODES.has(meta.generationMode) ? meta.generationMode : "";
    }

    function supportsWrite(node) {
        return Boolean(node) && !SKIP_TYPES.has(node.type);
    }

    /** 画布上从这张卡连出去的下游节点，作为唯一目标来源。 */
    function linkedTarget(ctx) {
        let list = [];
        try {
            list = ctx.getDownstream?.() || [];
        } catch {
            list = [];
        }
        return list.filter(supportsWrite)[0] || null;
    }

    /**
     * 目标卡上游的全部图片节点（靠连线提供的参考图，可能有多张）。
     * 克隆出来的新卡逐张共连同一批输入图，而不是只连第一张。
     */
    function upstreamImages(ctx, nodeId) {
        const connections = ctx.getConnections?.() || [];
        const seen = new Set();
        const sources = [];
        for (const connection of connections) {
            if (connection.toNodeId !== nodeId || connection.role === "lineage") continue;
            const source = ctx.getNode?.(connection.fromNodeId);
            if (source && source.type === "image" && !seen.has(source.id)) {
                seen.add(source.id);
                sources.push(source);
            }
        }
        return sources;
    }

    /** 按 id / 标题解一条消息里显式指定的目标（可选，用于临时改投）。 */
    function pickByHint(nodes, hint) {
        const raw = String(hint || "").trim();
        if (!raw) return null;
        const lower = raw.toLowerCase();
        return (
            nodes.find((node) => node.id === raw) ||
            nodes.find((node) => titleOf(node).toLowerCase() === lower) ||
            nodes.find((node) => titleOf(node).toLowerCase().includes(lower)) ||
            null
        );
    }

    function patchFor(node, text) {
        // 生成卡的提示词按 composerContent ?? prompt 取值，空串不会回退到 prompt。
        // 两个字段一起写，卡面才显示得出词，生成时也才取得到。
        return node && node.type === "text" ? { content: text, prompt: text } : { prompt: text, composerContent: text };
    }

    /* ---------- 视觉零件 ---------- */

    function Badge({ children, color, bg, title }) {
        return h(
            "span",
            {
                title,
                style: {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    height: 18,
                    padding: "0 7px",
                    borderRadius: 999,
                    fontSize: 10,
                    fontWeight: 600,
                    lineHeight: "18px",
                    color,
                    background: bg,
                    whiteSpace: "nowrap",
                    flex: "0 0 auto",
                },
            },
            children,
        );
    }

    function Dot({ ok }) {
        const color = ok ? OK : BAD;
        return h("span", {
            style: {
                width: 8,
                height: 8,
                borderRadius: 999,
                flex: "0 0 auto",
                background: color,
                boxShadow: `0 0 0 3px ${ok ? "rgba(22,163,74,.18)" : "rgba(220,38,38,.16)"}`,
            },
        });
    }

    function Section({ palette, label, hint, children }) {
        return h(
            "div",
            {
                style: {
                    background: tint(palette, "block"),
                    border: `1px solid ${palette.node.stroke}`,
                    borderRadius: 8,
                    padding: "8px 9px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    boxSizing: "border-box",
                    width: "100%",
                },
            },
            h(
                "div",
                { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, minWidth: 0 } },
                h("span", { style: { fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: palette.node.faint } }, label),
                hint ? h("span", { style: { fontSize: 10, color: palette.node.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, hint) : null,
            ),
            children,
        );
    }

    /* ---------- 卡片表面 ---------- */

    function Content({ ctx }) {
        const palette = paletteOf(ctx.theme);
        const [connected, setConnected] = useState(false);
        const [pending, setPending] = useState(0);
        const [queue, setQueue] = useState([]);
        const [mismatch, setMismatch] = useState(false);
        const [legacy, setLegacy] = useState(false);
        const [last, setLast] = useState("");

        const ctxRef = useRef(ctx);
        ctxRef.current = ctx;

        const meta = ctx.node?.metadata || {};
        const bridgeBase = baseOf(ctx.node);
        const target = linkedTarget(ctx);
        const autoRun = meta.bridgeAutoRun !== false;

        useEffect(() => {
            let stopped = false;
            let busy = false;

            const tick = async () => {
                if (stopped || busy) return;
                busy = true;
                try {
                    const current = ctxRef.current;
                    const base = baseOf(current.node);
                    const response = await fetch(`${base}/queue`, { cache: "no-store" });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const data = await response.json();
                    const remoteContract = data ? data.contract : undefined;
                    if (remoteContract === undefined || remoteContract === null) {
                        // 旧版邮筒还没有 contract 字段：照常工作，只提示升级
                        setLegacy(true);
                        setMismatch(false);
                    } else if (Number(remoteContract) !== CONTRACT) {
                        setConnected(false);
                        setMismatch(true);
                        return;
                    } else {
                        setLegacy(false);
                        setMismatch(false);
                    }
                    const items = Array.isArray(data && data.items) ? data.items : [];
                    setConnected(true);
                    setPending(items.length);
                    setQueue(items.slice(0, 8));
                    if (!items.length) return;

                    const all = (current.getNodes?.() || []).filter(supportsWrite);
                    const linked = linkedTarget(current);
                    const selfMeta = current.node?.metadata || {};
                    const shouldRun = selfMeta.bridgeAutoRun !== false;
                    // 队列模式：第一条写进连线指向的那张卡，第二条起各自新建一张卡并各自触发生成。
                    // 这样连好的生成卡不会白等着不用，也不会被后续几条轮流覆盖。
                    // metadata.bridgeQueue 设为 "stack" 可退回旧行为（全部写同一张卡，后一条覆盖前一条）。
                    const clonePerItem = selfMeta.bridgeQueue !== "stack";
                    let alreadySeeded = selfMeta.bridgeFirstDone === true;
                    const done = [];
                    const summary = [];
                    let handled = 0;
                    let spawned = 0;

                    for (const item of items) {
                        // 目标：消息显式指定 > 画布连线
                        const match = (item.target ? pickByHint(all, item.target) : null) || linked || linkedTarget(current);
                        const text = String(item.text || "").trim();
                        if (!match || !text) {
                            await fetch(`${base}/ack`, {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ ids: [item.id] }),
                            }).catch(() => undefined);
                            done.push(item.id);
                            setLast(`跳过 #${item.id}：这张卡还没有连到目标节点`);
                            continue;
                        }

                        const mode = shouldRun ? generationModeOf(match) : "";
                        // 第一条落到连好的卡上，之后每一条各建一张新卡
                        const reuse = !clonePerItem || !alreadySeeded;
                        let ops;

                        if (reuse) {
                            ops = [{ type: "update_node", id: match.id, metadata: patchFor(match, text) }];
                            if (mode) ops.push({ type: "run_generation", nodeId: match.id, mode });
                        } else {
                            spawned += 1;
                            const id = `bridge-${match.type}-${Date.now()}-${spawned}`;
                            // 排布：从目标卡右下开始铺成网格。两个方向同时累加会斜着跑到几千像素外，
                            // 九张卡一排到底又太宽，取 3 列折中。
                            const stepX = Math.round((match.width || 320) + 48);
                            const stepY = Math.round((match.height || 320) + 48);
                            const col = (spawned - 1) % 3;
                            const row = Math.floor((spawned - 1) / 3);
                            // 只继承配置，剥掉上一轮的结果与任务状态
                            const pristine = { ...(match.metadata || {}) };
                            RESULT_KEYS.forEach((key) => delete pristine[key]);
                            // 图片卡的 content 是上一张图的数据（常为 base64）。复制九份，画布上就是
                            // 九张一模一样的输入图，体积也翻九倍——生成卡不需要它。
                            if (match.type !== "text") delete pristine.content;
                            // 目标卡本来就靠连线取参考图时，去掉自带的 references，
                            // 改成让九张新卡共连同一张输入图。
                            const sources = upstreamImages(current, match.id);
                            if (sources.length) delete pristine.references;
                            ops = [
                                {
                                    type: "add_node",
                                    id,
                                    nodeType: match.type,
                                    title: `${titleOf(match)} #${spawned + 1}`,
                                    position: {
                                        x: (match.position?.x || 0) + stepX * (col + 1),
                                        y: (match.position?.y || 0) + stepY * (row + 1),
                                    },
                                    width: match.width,
                                    height: match.height,
                                    metadata: { ...pristine, ...patchFor(match, text) },
                                },
                            ];
                            for (const source of sources) ops.push({ type: "connect_nodes", fromNodeId: source.id, toNodeId: id });
                            if (mode) ops.push({ type: "run_generation", nodeId: id, mode });
                        }

                        current.applyOps(ops);
                        if (reuse && clonePerItem) {
                            alreadySeeded = true;
                            current.applyOps([{ type: "update_node", id: current.node.id, metadata: { bridgeFirstDone: true } }]);
                        }
                        handled += 1;
                        done.push(item.id);
                        await fetch(`${base}/ack`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ ids: [item.id] }),
                        }).catch(() => undefined);
                        summary.push(`#${item.id} ${reuse ? "写原卡" : "新建卡"}${mode ? " · 已排队生成" : ""}`);
                    }

                    if (summary.length) {
                        setLast(summary.length > 1 ? `共 ${summary.length} 条：${summary.join("；")}` : summary[0]);
                    }

                    if (done.length) setPending((n) => Math.max(0, items.length - done.length));
                } catch {
                    setConnected(false);
                } finally {
                    busy = false;
                }
            };

            tick();
            const timer = setInterval(tick, POLL_MS);
            return () => {
                stopped = true;
                clearInterval(timer);
            };
        }, []);

        const line = { display: "flex", alignItems: "center", gap: 6, minWidth: 0, width: "100%" };

        return h(
            "div",
            {
                style: {
                    height: "100%",
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "10px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    color: palette.node.text,
                    fontSize: 12,
                    lineHeight: 1.45,
                    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
                    overflow: "hidden",
                },
            },

            // ① 状态行
            h(
                "div",
                { style: { ...line, justifyContent: "space-between" } },
                h(
                    "div",
                    { style: { ...line, flex: "1 1 auto" } },
                    h(Dot, { ok: connected }),
                    h(
                        "span",
                        { style: { fontWeight: 700, fontSize: 12, color: mismatch ? BAD : legacy ? WARN : connected ? OK : BAD, whiteSpace: "nowrap" } },
                        mismatch ? "协议不匹配" : legacy ? "旧版邮筒" : connected ? "已连接" : "未连接",
                    ),
                    h(
                        "span",
                        { style: { color: palette.node.faint, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                        bridgeBase.replace(/^https?:\/\//, ""),
                    ),
                ),
                pending > 0 ? h(Badge, { color: WARN, bg: tint(palette, "warnSoft") }, `${pending} 待取`) : null,
            ),

            // ② 目标（连线）
            h(
                "div",
                {
                    style: {
                        ...line,
                        gap: 8,
                        background: tint(palette, target ? "accSoft" : "warnSoft"),
                        border: `1px solid ${target ? palette.node.stroke : "rgba(217,119,6,.45)"}`,
                        borderRadius: 8,
                        padding: "7px 9px",
                        boxSizing: "border-box",
                    },
                },
                h("span", { style: { fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: palette.node.faint, flex: "0 0 auto" } }, "写入"),
                h(
                    "span",
                    {
                        style: {
                            flex: "1 1 auto",
                            minWidth: 0,
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: target ? palette.node.text : WARN,
                        },
                    },
                    target ? `${typeLabel(target.type)} · ${titleOf(target)}` : "未连线 · 拖一条线到目标节点",
                ),
            ),

            // ③ 行为徽标
            h(
                "div",
                { style: { ...line, gap: 6, flexWrap: "nowrap" } },
                h(
                    Badge,
                    { color: autoRun ? OK : palette.node.muted, bg: autoRun ? tint(palette, "okSoft") : tint(palette, "block") },
                    autoRun ? "写入即生成" : "仅写入",
                ),
                target && generationModeOf(target) ? h(Badge, { color: ACCENT, bg: tint(palette, "accSoft") }, generationModeOf(target)) : null,
                h("span", { style: { marginLeft: "auto", fontSize: 9, letterSpacing: ".06em", color: palette.node.faint, whiteSpace: "nowrap" } }, `v${VERSION}`),
            ),

            // ④ 队列
            queue.length
                ? h(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: 3, minHeight: 0 } },
                      h("div", { style: { fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: palette.node.faint } }, `队列 ${pending}`),
                      ...queue.slice(0, 3).map((item) =>
                          h(
                              "div",
                              {
                                  key: item.id,
                                  title: item.text,
                                  style: {
                                      fontSize: 11,
                                      color: palette.node.muted,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                  },
                              },
                              `#${item.id} ${item.text}`,
                          ),
                      ),
                      queue.length > 3 ? h("div", { style: { fontSize: 10, color: palette.node.faint } }, `还有 ${queue.length - 3} 条…`) : null,
                  )
                : null,

            // ⑤ 最近活动
            last
                ? h(
                      "div",
                      {
                          style: {
                              fontSize: 11,
                              color: palette.node.muted,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                          },
                      },
                      last,
                  )
                : null,
        );
    }

    /* ---------- 面板 ---------- */

    function Panel({ ctx }) {
        const palette = paletteOf(ctx.theme);
        const [status, setStatus] = useState("");
        const [draftBase, setDraftBase] = useState("");
        const [queue, setQueue] = useState([]);
        const [confirming, setConfirming] = useState(false);

        const meta = ctx.node?.metadata || {};
        const autoRun = meta.bridgeAutoRun !== false;
        const target = linkedTarget(ctx);
        const bridgeBase = baseOf(ctx.node);
        const clones = (ctx.getNodes() || [])
            .filter((node) => String(node.id).startsWith("bridge-"))
            .map((node) => node.id);

        useEffect(() => {
            let stopped = false;
            const load = async () => {
                try {
                    const response = await fetch(`${bridgeBase}/queue`, { cache: "no-store" });
                    if (!response.ok) return;
                    const data = await response.json();
                    if (!stopped) setQueue(Array.isArray(data && data.items) ? data.items : []);
                } catch {
                    if (!stopped) setQueue([]);
                }
            };
            load();
            const timer = setInterval(load, 2000);
            return () => {
                stopped = true;
                clearInterval(timer);
            };
        }, [bridgeBase]);

        useEffect(() => {
            setDraftBase(String((ctx.node?.metadata || {}).bridgeBase || ""));
        }, [ctx.node?.id, ctx.node?.metadata?.bridgeBase]);

        const row = { display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 };
        const inputStyle = {
            flex: "1 1 auto",
            minWidth: 0,
            height: 30,
            padding: "0 9px",
            borderRadius: 7,
            border: `1px solid ${palette.node.stroke}`,
            background: palette.node.panel,
            color: palette.node.text,
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            outline: "none",
            boxSizing: "border-box",
        };

        return h(
            "div",
            {
                style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: 9,
                    padding: "10px 12px 12px",
                    width: "100%",
                    boxSizing: "border-box",
                    color: palette.node.text,
                    fontSize: 12,
                    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
                },
            },

            // 目标（只读，来自连线）
            h(
                Section,
                { palette, label: "写入目标", hint: target ? typeLabel(target.type) : "未连线" },
                h(
                    "div",
                    {
                        style: {
                            ...row,
                            background: palette.node.panel,
                            border: `1px solid ${target ? palette.node.stroke : "rgba(217,119,6,.45)"}`,
                            borderRadius: 7,
                            padding: "6px 8px",
                            boxSizing: "border-box",
                        },
                    },
                    h(
                        "span",
                        {
                            style: {
                                flex: "1 1 auto",
                                minWidth: 0,
                                fontWeight: 600,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                color: target ? palette.node.text : WARN,
                            },
                        },
                        target ? `${typeLabel(target.type)} · ${titleOf(target)}` : "把这张卡连到目标节点",
                    ),
                    target && generationModeOf(target) ? h(Badge, { color: ACCENT, bg: tint(palette, "accSoft") }, generationModeOf(target)) : null,
                ),
                h(
                    "div",
                    { style: { fontSize: 10, color: palette.node.faint, lineHeight: 1.4 } },
                    target
                        ? "目标由画布连线决定；把线改接到别的节点，写入目标随之改变"
                        : "在画布上从这张卡拖一条线到目标节点，即可自动识别",
                ),
            ),

            // 邮筒地址
            h(
                Section,
                { palette, label: "邮筒地址", hint: "DSH 那台机器" },
                h(
                    "div",
                    { style: row },
                    h("input", {
                        value: draftBase,
                        placeholder: DEFAULT_BASE,
                        spellCheck: false,
                        onChange: (event) => setDraftBase(event.target.value),
                        style: inputStyle,
                    }),
                    h(
                        Button,
                        {
                            size: "small",
                            type: "primary",
                            onClick: () => {
                                const value = String(draftBase || "").trim().replace(/\/+$/, "");
                                ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { bridgeBase: value } }]);
                                setStatus(value ? `地址已保存：${value}` : "已恢复默认地址");
                            },
                        },
                        "保存",
                    ),
                ),
            ),

            // 行为
            h(
                Section,
                { palette, label: "写入后", hint: target ? generationModeOf(target) || "不支持生成" : "先连线" },
                h(
                    "label",
                    { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 } },
                    h("input", {
                        type: "checkbox",
                        checked: autoRun,
                        onChange: () => {
                            ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { bridgeAutoRun: !autoRun } }]);
                            setStatus(!autoRun ? "写入后自动生成" : "写入后只写提示词");
                        },
                        style: { width: 15, height: 15, accentColor: ACCENT, cursor: "pointer", margin: 0 },
                    }),
                    h("span", { style: { fontWeight: 500 } }, "自动生成"),
                    h("span", { style: { color: palette.node.faint, fontSize: 10 } }, autoRun ? "写入完成立即开跑" : "只改提示词，你自己点生成"),
                ),
            ),

            // 队列
            // 清理克隆卡
            h(
                Section,
                { palette, label: "克隆卡", hint: `${clones.length} 张` },
                h(
                    "div",
                    { style: { display: "flex", alignItems: "center", gap: 8, width: "100%", justifyContent: "space-between" } },
                    h(
                        Button,
                        {
                            size: "small",
                            disabled: clones.length === 0,
                            onClick: () => {
                                ctx.applyOps([{ type: "select_nodes", ids: clones }]);
                                setStatus(`已选中 ${clones.length} 张克隆卡`);
                            },
                        },
                        "选中全部",
                    ),
                    h(
                        Button,
                        {
                            size: "small",
                            danger: true,
                            disabled: clones.length === 0,
                            onClick: () => {
                                if (!confirming) {
                                    setConfirming(true);
                                    setStatus(`再点一次「确认删除」，会删掉 ${clones.length} 张克隆卡`);
                                    return;
                                }
                                ctx.applyOps([{ type: "delete_node", ids: clones }]);
                                setConfirming(false);
                                setStatus(`已删除 ${clones.length} 张克隆卡`);
                            },
                        },
                        confirming ? "确认删除" : "删除全部",
                    ),
                ),
                h(
                    "div",
                    { style: { fontSize: 10, color: palette.node.faint, lineHeight: 1.4 } },
                    "只删本插件克隆出来的卡（id 以 bridge- 开头）；你原来连的那张卡不动",
                ),
            ),

            h(
                Section,
                { palette, label: "队列", hint: `${queue.length} 条待取` },
                queue.length
                    ? h(
                          "div",
                          { style: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 120, overflowY: "auto" } },
                          ...queue.map((item) =>
                              h(
                                  "div",
                                  {
                                      key: item.id,
                                      title: item.text,
                                      style: {
                                          fontSize: 11,
                                          color: palette.node.text,
                                          background: palette.node.panel,
                                          border: `1px solid ${palette.node.stroke}`,
                                          borderRadius: 6,
                                          padding: "4px 7px",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                      },
                                  },
                                  `#${item.id} ${item.text}`,
                              ),
                          ),
                      )
                    : h("div", { style: { fontSize: 11, color: palette.node.faint } }, "队列为空"),
            ),

            // 队列操作
            h(
                "div",
                { style: { ...row, justifyContent: "space-between" } },
                h(
                    Button,
                    {
                        size: "small",
                        onClick: async () => {
                            try {
                                const response = await fetch(`${bridgeBase}/health`, { cache: "no-store" });
                                const data = await response.json();
                                setStatus(`连通，待处理 ${data.pending} 条`);
                            } catch (error) {
                                setStatus(`不可达：${bridgeBase}`);
                            }
                        },
                    },
                    "测试连接",
                ),
                h(
                    Button,
                    {
                        size: "small",
                        danger: true,
                        onClick: async () => {
                            await fetch(`${bridgeBase}/clear`, { method: "POST" }).catch(() => undefined);
                            setStatus("队列已清空");
                        },
                    },
                    "清空队列",
                ),
            ),

            status
                ? h(
                      "div",
                      {
                          style: {
                              fontSize: 11,
                              color: palette.node.text,
                              background: tint(palette, "accSoft"),
                              border: `1px solid ${palette.node.stroke}`,
                              borderRadius: 7,
                              padding: "6px 8px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                          },
                      },
                      status,
                  )
                : null,
        );
    }

    return {
        id: "prompt-bridge",
        name: "提示词桥",
        version: VERSION,
        description: "轮询 DSH 插件内置的提示词邮筒，写入连线指向的节点，可选写入后自动生成。",
        defaultEnabled: true,
        nodes: [
            {
                type: NODE_TYPE,
                title: "提示词桥",
                icon: h("span", { style: { fontSize: 10, fontWeight: 700, letterSpacing: "-.02em" } }, "BRG"),
                defaultSize: { width: 316, height: 214 },
                defaultMetadata: { bridgeAutoRun: true },
                showInCreateMenu: true,
                autoOpenPanel: true,
                Content,
                Panel,
            },
        ],
    };
}
