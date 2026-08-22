// ==UserScript==
// @name         MWI 数据桥接（推送到本机迷宫模拟器）
// @name:zh-CN   MWI 数据桥接（推送到本机迷宫模拟器）
// @namespace    local.mwi.labyrinth.optimizer
// @version      2.1.0
// @description  自动捕获游戏登录/刷新时的角色与客户端数据，仅推送到本机回环地址，并提供手动下载。
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://test.milkywayidlecn.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    "use strict";
    const PANEL_ID = "mwi-labyrinth-bridge-panel";
    const PORTS = Array.from({ length: 12 }, (_, index) => 8765 + index);
    const data = { character: null, client: null };
    const sources = { character: "", client: "" };
    let activePort = null;

    function isCharacter(value) {
        return value && typeof value === "object" && Array.isArray(value.characterItems) && Array.isArray(value.characterAbilities);
    }
    function isClient(value) {
        return value && typeof value === "object" && value.itemDetailMap && value.abilityDetailMap && value.combatMonsterDetailMap;
    }
    function findPayload(value) {
        if (!value || typeof value !== "object") return;
        const candidates = [value, value.data, value.payload, value.result];
        for (const candidate of candidates) {
            if (isCharacter(candidate)) capture("character", candidate, "游戏 WebSocket");
            if (isClient(candidate)) capture("client", candidate, "游戏 WebSocket");
        }
    }
    function capture(kind, value, source) {
        data[kind] = value;
        sources[kind] = source;
        render();
        push(kind, value, source);
    }
    function inspect(raw) {
        if (typeof raw !== "string" || raw.length < 20) return;
        try { findPayload(JSON.parse(raw)); } catch (_) { /* unrelated frame */ }
    }
    function installHook() {
        if (window.__MWI_LABYRINTH_BRIDGE_HOOKED__) return;
        window.__MWI_LABYRINTH_BRIDGE_HOOKED__ = true;
        const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
        const descriptor = Object.getOwnPropertyDescriptor(pageWindow.MessageEvent.prototype, "data");
        if (!descriptor?.get) return;
        Object.defineProperty(pageWindow.MessageEvent.prototype, "data", { ...descriptor, get: function () { const value = descriptor.get.call(this); try { inspect(value); } catch (_) {} return value; } });
    }
    function captureCachedClient() {
        try {
            const raw = localStorage.getItem("initClientData");
            if (!raw) return;
            let value = null;
            try { value = JSON.parse(raw); } catch (_) { /* 压缩缓存等待登录 WebSocket 数据 */ }
            if (isClient(value)) capture("client", value, "游戏本地缓存");
        } catch (_) { /* WebSocket hook remains available */ }
    }
    function localRequest(port, payload) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: `http://127.0.0.1:${port}/api/data`,
                headers: { "Content-Type": "application/json", "X-MWI-Labyrinth-Bridge": "2" },
                data: JSON.stringify(payload),
                timeout: 2500,
                onload: (response) => resolve(response.status >= 200 && response.status < 300),
                onerror: () => resolve(false),
                ontimeout: () => resolve(false),
            });
        });
    }
    async function push(kind, value, source) {
        const ports = activePort ? [activePort, ...PORTS.filter((port) => port !== activePort)] : PORTS;
        for (const port of ports) {
            if (await localRequest(port, { kind, data: value, source })) { activePort = port; render(); return true; }
        }
        render("未发现已启动的本机模拟器");
        return false;
    }
    function download(kind) {
        if (!data[kind]) return;
        const blob = new Blob([JSON.stringify(data[kind], null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = kind === "character" ? "init_character_data.json" : `init_client_data_${data.client.gameVersion || "latest"}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
    function render(extra = "") {
        if (!document.documentElement) return;
        let panel = document.getElementById(PANEL_ID);
        if (!panel) { panel = document.createElement("div"); panel.id = PANEL_ID; panel.style.cssText = "position:fixed;left:14px;bottom:14px;z-index:2147483647;width:310px;padding:13px;border:1px solid rgba(255,255,255,.2);border-radius:10px;background:#14231f;color:#eef8f3;box-shadow:0 8px 26px rgba(0,0,0,.35);font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"; document.documentElement.appendChild(panel); }
        const row = (kind, label) => `<div style="margin:5px 0;color:${data[kind] ? "#8fe0b5" : "#ffd38a"}">${label}：${data[kind] ? "已捕获" : "等待中"}</div>`;
        panel.innerHTML = `<div style="font-weight:700;margin-bottom:7px">MWI 数据桥接</div>${row("character", "角色数据")}${row("client", "游戏数据")}<div style="margin-top:9px"><button data-kind="character" ${data.character ? "" : "disabled"}>下载角色</button><button data-kind="client" ${data.client ? "" : "disabled"} style="margin-left:5px">下载游戏数据</button><button data-close style="margin-left:5px">隐藏</button></div><div style="margin-top:8px;color:#9bb1a7;font-size:11px">${activePort ? `已连接本机模拟器端口 ${activePort}` : "登录或刷新游戏即可自动捕获"}${extra ? ` · ${extra}` : ""}</div>`;
        panel.querySelectorAll("[data-kind]").forEach((button) => button.addEventListener("click", () => download(button.dataset.kind)));
        panel.querySelector("[data-close]")?.addEventListener("click", () => panel.remove());
    }
    installHook();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { captureCachedClient(); render(); }, { once: true }); else { captureCachedClient(); render(); }
})();
