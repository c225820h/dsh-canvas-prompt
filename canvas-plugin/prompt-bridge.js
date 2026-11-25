// 提示词桥（画布侧）：轮询 DSH 插件内置的邮筒，写入指定节点，可选自动生成。
// 视觉跟随画布主题（ctx.theme），只依赖运行时保证提供的 antd Button / Select。
export default function (runtime) {
    const { React, antd } = runtime;
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;
    const { Button, Select } = antd || {};

    const NODE_TYPE = "prompt-bridge:card";
    const POLL_MS = 1500;
    const PAGE_HOST = (typeof window !== "undefined" && window.location && window.location.hostname) || "127.0.0.1";
    const DEFAULT_BASE = `http://${PAGE_HOST}:8799`;

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

    /* ---------- 小部件 ---------- */

    function Dot({ ok, color, muted }) {
        return h("span", {
            style: {
                width: 7,
                height: 7,
                borderRadius: 999,
                flex: "0 0 auto",
                background: ok ? "#22c55e" : color || "#ef4444",
                boxShadow: ok ? "0 0 0 3px rgba(34,197,94,.16)" : "0 0 0 3px rgba(239,68,68,.14)",
                opacity: muted ? 0.5 : 1,
            },
        });
    }

    function Pill({ children, tone, palette }) {
        const tones = {
            neutral: { bg: palette.node.fill, fg: palette.node.muted },
            accent: { bg: "rgba(59,130,246,.12)", fg: "#2563eb" },
            success: { bg: "rgba(34,197,94,.12)", fg: "#16a34a" },
        };
        const picked = tones[tone] || tones.neutral;
        return h(
            "span",
            {
                style: {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "1px 7px",
                    borderRadius: 999,
                    fontSize: 10,
                    lineHeight: "16px",
                    fontWeight: 500,
                    background: picked.bg,
                    color: picked.fg,
                    whiteSpace: "nowrap",
                },
            },
            children,
        );
    }

    function SectionLabel({ children, palette }) {
        return h(
            "div",
            {
                style: {
                    fontSize: 10,
                    letterSpacing: ".08em",
                    textTransform: "uppercase",
                    color: palette.node.faint,
                    fontWeight: 600,
                    marginBottom: 6,
                },
            },
            children,
        );
    }

    function Divider({ palette }) {
        return h("div", { style: { height: 1, background: palette.node.stroke, opacity: 0.6, margin: "2px 0" } });
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
                        const suffix = mode ? " · 已生成" : shouldRun ? " · 该节点不支持生成" : "";
                        setLast(`#${item.id} → ${typeLabel(match.type)} · ${titleOf(match)}${suffix}`);
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

        const row = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };

        return h(
            "div",
            {
                style: {
                    height: "100%",
                    boxSizing: "border-box",
                    padding: "11px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 7,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: palette.node.text,
                    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
                },
            },
            // 状态行
            h(
                "div",
                { style: { ...row, justifyContent: "space-between" } },
                h(
                    "div",
                    { style: row },
                    h(Dot, { ok: connected, palette }),
                    h(
                        "span",
                        { style: { fontWeight: 600, fontSize: 12 } },
                        connected ? "邮筒已连接" : "邮筒未连接",
                    ),
                ),
                pending > 0 ? h(Pill, { tone: "accent", palette }, `${pending} 条待取`) : null,
            ),
            // 目标行
            h(
                "div",
                { style: { ...row, gap: 6 } },
                h("span", { style: { color: palette.node.faint, fontSize: 11, flex: "0 0 auto" } }, "写入"),
                h(
                    "span",
                    {
                        style: {
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
            // 行为 + 地址
            h(
                "div",
                { style: { ...row, gap: 6, flexWrap: "wrap" } },
                h(Pill, { tone: autoRun ? "success" : "neutral", palette }, autoRun ? "写入即生成" : "仅写入"),
                target && GENERATION_MODES.has(target.type)
                    ? h(Pill, { tone: "neutral", palette }, `模式 ${generationModeOf(target)}`)
                    : null,
                h(
                    "span",
                    {
                        style: {
                            color: palette.node.faint,
                            fontSize: 10,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            minWidth: 0,
                        },
                    },
                    bridgeBase.replace(/^https?:\/\//, ""),
                ),
            ),
            last
                ? h(
                      "div",
                      {
                          style: {
                              color: palette.node.muted,
                              fontSize: 11,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              borderTop: `1px solid ${palette.node.stroke}`,
                              paddingTop: 6,
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

        const inputStyle = {
            flex: 1,
            minWidth: 0,
            height: 30,
            padding: "0 9px",
            borderRadius: 7,
            border: `1px solid ${palette.node.stroke}`,
            background: palette.node.panel,
            color: palette.node.text,
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            outline: "none",
        };

        const stack = { display: "flex", flexDirection: "column", gap: 10, width: "100%", padding: "4px 2px 8px" };
        const row = { display: "flex", gap: 8, alignItems: "center", width: "100%" };

        return h(
            "div",
            { style: { ...stack, color: palette.node.text, fontSize: 12, fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' } },

            // 连接
            h(
                "div",
                null,
                h(SectionLabel, { palette }, "邮筒地址"),
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
                            onClick: () => {
                                const value = String(draftBase || "").trim().replace(/\/+$/, "");
                                ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { bridgeBase: value } }]);
                                setStatus(value ? `已保存 ${value}` : "已恢复默认地址");
                            },
                        },
                        "保存",
                    ),
                ),
                h(
                    "div",
                    { style: { color: palette.node.faint, fontSize: 10, marginTop: 4 } },
                    "邮筒在 DSH 那台机器的插件里；默认取同名主机的 8799 端口。",
                ),
            ),

            h(Divider, { palette }),

            // 目标
            h(
                "div",
                null,
                h(SectionLabel, { palette }, "写入目标"),
                h(
                    "div",
                    { style: row },
                    h(Select, {
                        style: { flex: 1, minWidth: 0 },
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

            h(Divider, { palette }),

            // 行为
            h(
                "div",
                null,
                h(SectionLabel, { palette }, "写入后"),
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
                        style: { width: 14, height: 14, accentColor: "#2563eb", cursor: "pointer" },
                    }),
                    h("span", null, "自动生成"),
                    h(
                        "span",
                        { style: { color: palette.node.faint, fontSize: 10 } },
                        target
                            ? GENERATION_MODES.has(target.type)
                                ? `（${generationModeOf(target)}）`
                                : "（该节点不支持）"
                            : "（先选目标）",
                    ),
                ),
            ),

            // 队列操作
            h(
                "div",
                { style: { ...row, justifyContent: "space-between", marginTop: 2 } },
                h(
                    Button,
                    {
                        size: "small",
                        onClick: async () => {
                            try {
                                const response = await fetch(`${bridgeBase}/health`, { cache: "no-store" });
                                const data = await response.json();
                                setStatus(`连通 · 待处理 ${data.pending} 条`);
                            } catch (error) {
                                setStatus(`不可达：${bridgeBase}`);
                            }
                        },
                    },
                    "测试",
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
                              color: palette.node.muted,
                              background: palette.node.fill,
                              borderRadius: 6,
                              padding: "5px 8px",
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
        version: "2.0.0",
        description: "轮询 DSH 插件内置的提示词邮筒，写入指定画布节点，可选写入后自动生成。",
        defaultEnabled: true,
        nodes: [
            {
                type: NODE_TYPE,
                title: "提示词桥",
                icon: h("span", { style: { fontSize: 10, fontWeight: 700, letterSpacing: "-.02em" } }, "BRG"),
                defaultSize: { width: 300, height: 176 },
                defaultMetadata: { bridgeAutoRun: true },
                showInCreateMenu: true,
                autoOpenPanel: true,
                Content,
                Panel,
            },
        ],
    };
}
