// 提示词桥（画布侧）：轮询 DSH 插件内置的邮筒，写入指定节点，可选自动生成。
// 视觉：语义色（蓝=可操作 / 绿=已连接·自动 / 红=断开 / 琥珀=积压），分区浅底块增加层次。
// 只依赖运行时保证提供的 antd Button / Select，其余用原生元素 + 内联样式。
export default function (runtime) {
    const { React, antd } = runtime;
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;
    const { Button, Select } = antd || {};

    const NODE_TYPE = "prompt-bridge:card";
    const VERSION = "2.1.0";
    const POLL_MS = 1500;
    const PAGE_HOST = (typeof window !== "undefined" && window.location && window.location.hostname) || "127.0.0.1";
    const DEFAULT_BASE = `http://${PAGE_HOST}:8799`;

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

    function listTargets(nodes, selfId) {
        return (Array.isArray(nodes) ? nodes : [])
            .filter((node) => node && node.id !== selfId && !SKIP_TYPES.has(node.type))
            .sort((a, b) => (a.position?.y || 0) - (b.position?.y || 0) || (a.position?.x || 0) - (b.position?.x || 0));
    }

    function matchTarget(nodes, hint) {
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
        return node && node.type === "text" ? { content: text } : { prompt: text };
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
        const [last, setLast] = useState("");

        const ctxRef = useRef(ctx);
        ctxRef.current = ctx;

        const meta = ctx.node?.metadata || {};
        const bridgeBase = baseOf(ctx.node);
        const targetId = String(meta.bridgeTarget || "");
        const target = targetId ? ctx.getNode(targetId) : null;
        const autoRun = meta.bridgeAutoRun !== false;

        useEffect(() => {
            let stopped = false;
            let busy = false;

            const tick = async () => {
                if (stopped || busy) return;
                busy = true;
                try {
                    const base = baseOf(ctxRef.current.node);
                    const response = await fetch(`${base}/queue`, { cache: "no-store" });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const data = await response.json();
                    const items = Array.isArray(data && data.items) ? data.items : [];
                    setConnected(true);
                    setPending(items.length);
                    if (!items.length) return;

                    const current = ctxRef.current;
                    const nodes = listTargets(current.getNodes(), current.node && current.node.id);
                    const selfMeta = current.node?.metadata || {};
                    const chosen = String(selfMeta.bridgeTarget || "");
                    const shouldRun = selfMeta.bridgeAutoRun !== false;
                    const done = [];

                    for (const item of items) {
                        const match = (item.target ? matchTarget(nodes, item.target) : null) || matchTarget(nodes, chosen);
                        const text = String(item.text || "").trim();
                        if (!match || !text) {
                            done.push(item.id);
                            setLast(`跳过 #${item.id}：${item.target ? `找不到「${item.target}」` : "未选目标"}`);
                            continue;
                        }
                        const ops = [{ type: "update_node", id: match.id, metadata: patchFor(match, text) }];
                        const mode = shouldRun ? generationModeOf(match) : "";
                        if (mode) ops.push({ type: "run_generation", nodeId: match.id, mode });
                        current.applyOps(ops);
                        done.push(item.id);
                        setLast(`#${item.id} → ${typeLabel(match.type)} · ${titleOf(match)}${mode ? " · 已生成" : ""}`);
                    }

                    if (done.length) {
                        await fetch(`${base}/ack`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ ids: done }),
                        }).catch(() => undefined);
                        setPending((n) => Math.max(0, n - done.length));
                    }
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
                        { style: { fontWeight: 700, fontSize: 12, color: connected ? OK : BAD, whiteSpace: "nowrap" } },
                        connected ? "已连接" : "未连接",
                    ),
                    h(
                        "span",
                        { style: { color: palette.node.faint, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                        bridgeBase.replace(/^https?:\/\//, ""),
                    ),
                ),
                pending > 0 ? h(Badge, { color: WARN, bg: tint(palette, "warnSoft") }, `${pending} 待取`) : null,
            ),

            // ② 目标
            h(
                "div",
                {
                    style: {
                        ...line,
                        gap: 8,
                        background: tint(palette, "block"),
                        border: `1px solid ${palette.node.stroke}`,
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
                            color: target ? palette.node.text : palette.node.placeholder,
                        },
                    },
                    target ? `${typeLabel(target.type)} · ${titleOf(target)}` : "未选择节点",
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
                target && generationModeOf(target)
                    ? h(Badge, { color: ACCENT, bg: tint(palette, "accSoft") }, generationModeOf(target))
                    : null,
                h(
                    "span",
                    { style: { marginLeft: "auto", fontSize: 9, letterSpacing: ".06em", color: palette.node.faint, whiteSpace: "nowrap" } },
                    `v${VERSION}`,
                ),
            ),

            // ④ 最近活动
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
        const [tick, setTick] = useState(0);
        const [status, setStatus] = useState("");
        const [draftBase, setDraftBase] = useState("");

        const nodes = useMemo(() => listTargets(ctx.getNodes(), ctx.node && ctx.node.id), [tick]);
        const meta = ctx.node?.metadata || {};
        const targetId = String(meta.bridgeTarget || "");
        const autoRun = meta.bridgeAutoRun !== false;
        const target = targetId ? ctx.getNode(targetId) : null;
        const bridgeBase = baseOf(ctx.node);

        useEffect(() => {
            setDraftBase(String((ctx.node?.metadata || {}).bridgeBase || ""));
        }, [ctx.node?.id, ctx.node?.metadata?.bridgeBase]);

        const options = nodes.map((node) => ({
            value: node.id,
            label: `${typeLabel(node.type)} · ${titleOf(node)}`,
        }));

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

            // 目标
            h(
                Section,
                { palette, label: "写入目标", hint: target ? typeLabel(target.type) : "未选择" },
                h(
                    "div",
                    { style: row },
                    h(Select, {
                        style: { flex: "1 1 auto", minWidth: 0 },
                        placeholder: "选择接收提示词的节点",
                        showSearch: true,
                        optionFilterProp: "label",
                        value: targetId || undefined,
                        options,
                        onChange: (value) => {
                            ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { bridgeTarget: value } }]);
                            const found = options.find((item) => item.value === value);
                            setStatus(`目标：${found ? found.label : value}`);
                        },
                    }),
                    h(Button, { size: "small", onClick: () => setTick((n) => n + 1) }, "刷新"),
                ),
            ),

            // 行为
            h(
                Section,
                { palette, label: "写入后", hint: target ? generationModeOf(target) || "不支持生成" : "先选目标" },
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
        description: "轮询 DSH 插件内置的提示词邮筒，写入指定画布节点，可选写入后自动生成。",
        defaultEnabled: true,
        nodes: [
            {
                type: NODE_TYPE,
                title: "提示词桥",
                icon: h("span", { style: { fontSize: 10, fontWeight: 700, letterSpacing: "-.02em" } }, "BRG"),
                defaultSize: { width: 316, height: 186 },
                defaultMetadata: { bridgeAutoRun: true },
                showInCreateMenu: true,
                autoOpenPanel: true,
                Content,
                Panel,
            },
        ],
    };
}
