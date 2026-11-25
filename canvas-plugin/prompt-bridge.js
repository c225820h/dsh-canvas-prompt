// 提示词桥（画布侧）：轮询 DSH 插件内置的邮筒，把提示词写进你指定的节点，可选自动生成。
// 邮筒地址可在这张卡里填（因为邮筒跑在 DSH 那台机器上，页面无法自动推断）。
export default function (runtime) {
    const { React, antd } = runtime;
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;
    const { Button, Select } = antd || {};

    const NODE_TYPE = "prompt-bridge:card";
    const POLL_MS = 1500;
    const PAGE_HOST = (typeof window !== "undefined" && window.location && window.location.hostname) || "127.0.0.1";
    const DEFAULT_BASE = `http://${PAGE_HOST}:8799`;

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

    const caption = { fontSize: 12, color: "#888", lineHeight: 1.5 };

    function Content({ ctx }) {
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
                            setLast(`跳过 #${item.id}：${item.target ? `找不到节点「${item.target}」` : "还没选目标节点"}`);
                            continue;
                        }
                        const ops = [{ type: "update_node", id: match.id, metadata: patchFor(match, text) }];
                        const mode = shouldRun ? generationModeOf(match) : "";
                        if (mode) ops.push({ type: "run_generation", nodeId: match.id, mode });
                        current.applyOps(ops);
                        done.push(item.id);
                        const suffix = mode ? "，已触发生成" : shouldRun ? "，该节点不支持自动生成" : "";
                        setLast(`#${item.id} → ${typeLabel(match.type)} · ${titleOf(match)}（${text.length} 字${suffix}）`);
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

        return h(
            "div",
            { style: { padding: 12, fontSize: 12, lineHeight: 1.55, height: "100%", overflow: "hidden" } },
            h("div", { style: { color: connected ? "#389e0d" : "#cf1322", fontWeight: 600 } }, connected ? `邮筒已连接 · 待处理 ${pending}` : `邮筒未连接（${bridgeBase}）`),
            h("div", { style: { ...caption, marginTop: 4 } }, "写入目标"),
            h("div", { style: { fontWeight: 600 } }, target ? `${typeLabel(target.type)} · ${titleOf(target)}` : "（未选择，点开卡片选择）"),
            h("div", { style: { ...caption, marginTop: 4 } }, autoRun ? "写入后：自动生成" : "写入后：只写提示词"),
            last ? h("div", { style: { ...caption, marginTop: 4, whiteSpace: "pre-wrap", maxHeight: 40, overflow: "hidden" } }, last) : null,
        );
    }

    function Panel({ ctx }) {
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

        const choose = (value) => {
            ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { bridgeTarget: value } }]);
            const found = options.find((item) => item.value === value);
            setStatus(`目标已设为 ${found ? found.label : value}`);
        };

        const row = { display: "flex", gap: 8, alignItems: "center", width: "100%" };
        const inputStyle = { flex: 1, minWidth: 200, height: 28, padding: "0 8px", borderRadius: 6, border: "1px solid #d9d9d9", fontSize: 12 };

        return h(
            "div",
            { style: { width: "100%", padding: 12, display: "flex", flexDirection: "column", gap: 8 } },
            h("div", { style: caption }, "邮筒跑在 DSH 那台机器的插件里；这里填它的地址（默认同名主机的 8799 端口）。"),
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
                h(Button, {
                    size: "small",
                    onClick: () => {
                        const value = String(draftBase || "").trim().replace(/\/+$/, "");
                        ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { bridgeBase: value } }]);
                        setStatus(value ? `邮筒地址已设为 ${value}` : "已恢复默认地址");
                    },
                }, "保存地址"),
            ),
            h(
                "div",
                { style: row },
                h(Select, {
                    style: { flex: 1, minWidth: 200 },
                    placeholder: "选择接收提示词的节点",
                    showSearch: true,
                    optionFilterProp: "label",
                    value: targetId || undefined,
                    options,
                    onChange: choose,
                }),
                h(Button, { size: "small", onClick: () => setTick((n) => n + 1) }, "刷新列表"),
            ),
            h(
                "div",
                { style: row },
                h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" } },
                    h("input", {
                        type: "checkbox",
                        checked: autoRun,
                        onChange: () => {
                            ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { bridgeAutoRun: !autoRun } }]);
                            setStatus(!autoRun ? "写入后会自动生成" : "写入后只写提示词");
                        },
                    }),
                    h("span", null, "写入后自动生成"),
                ),
                h("span", { style: { ...caption, color: "#1677ff" } }, target ? `模式：${generationModeOf(target) || "不支持"}` : ""),
            ),
            h(
                "div",
                { style: row },
                h(Button, {
                    size: "small",
                    onClick: async () => {
                        try {
                            const response = await fetch(`${bridgeBase}/health`, { cache: "no-store" });
                            const data = await response.json();
                            setStatus(`邮筒正常（${bridgeBase}），待处理 ${data.pending} 条`);
                        } catch (error) {
                            setStatus(`邮筒不可达：${bridgeBase}`);
                        }
                    },
                }, "测试邮筒"),
                h(Button, {
                    size: "small",
                    danger: true,
                    onClick: async () => {
                        await fetch(`${bridgeBase}/clear`, { method: "POST" }).catch(() => undefined);
                        setStatus("已清空邮筒队列");
                    },
                }, "清空队列"),
            ),
            status ? h("div", { style: { ...caption, color: "#1677ff" } }, status) : null,
        );
    }

    return {
        id: "prompt-bridge",
        name: "提示词桥",
        version: "1.4.0",
        description: "轮询 DSH 插件内置的提示词邮筒，写入你指定的画布节点，可选写入后自动生成。",
        defaultEnabled: true,
        nodes: [
            {
                type: NODE_TYPE,
                title: "提示词桥",
                icon: h("span", { style: { fontSize: 10, fontWeight: 700 } }, "BRG"),
                defaultSize: { width: 300, height: 190 },
                defaultMetadata: { bridgeAutoRun: true },
                showInCreateMenu: true,
                autoOpenPanel: true,
                Content,
                Panel,
            },
        ],
    };
}
