#!/usr/bin/env bun
/**
 * panel.js：在 `/` 服务的浏览器面板。
 *
 * 给本地跑桥的开发者用的运维控制台：左栏导航（概览 / 出口代理 / 代理池 /
 * 用量统计 / 请求历史 / 接入点），顶栏面包屑与跳转面板，内容区按视图切换。
 * 所有动态数据来自 `proxy.describe()`、`/api/proxy`、`/api/stats`、
 * `/api/history` 与 `/health`；服务端只插值标量并转义，客户端一律用
 * `textContent` 设置动态字符串，配置里的值变不成 HTML 标记。
 *
 * 设计取向：暖纸与墨色，陶土色只留给主操作、选中态与焦点环；正文用系统
 * UI 字体，只有代理 URL、密钥、时长这类逐字符阅读的内容用等宽。档位：
 * ENERGY 1、RHYTHM 2、MOTION 1 —— 这是设置与观察页，不是落地页。
 */

const STYLE = `
:root {
  color-scheme: light;
  --paper: #f5f1ea;
  --surface: #fffdf8;
  --surface-2: #efe9df;
  --ink: #1d1a15;
  --muted: #625b50;
  --rule: #d9d1c5;
  --field: #a39a8c;
  --accent: #2b4a6f;
  --accent-soft: #dfe6f0;
  --accent-ink: #ffffff;
  --ok: #2c6a33;
  --warn: #8a5a00;
  --bad: #9b2118;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #12110f;
  --surface: #1a1917;
  --surface-2: #23211d;
  --ink: #ece7de;
  --muted: #a49c92;
  --rule: #37332c;
  --field: #7a746a;
  --accent: #9cbcda;
  --accent-soft: #1e2a38;
  --accent-ink: #0c141c;
  --ok: #7bc48a;
  --warn: #e3b25f;
  --bad: #f08c82;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #12110f;
    --surface: #1a1917;
    --surface-2: #23211d;
    --ink: #ece7de;
    --muted: #a49c92;
    --rule: #37332c;
    --field: #7a746a;
    --accent: #9cbcda;
    --accent-soft: #1e2a38;
    --accent-ink: #0c141c;
    --ok: #7bc48a;
    --warn: #e3b25f;
    --bad: #f08c82;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 15px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--ink); }
a:hover { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.skip { position: fixed; left: 12px; top: -48px; z-index: 80; padding: 8px 12px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); color: var(--ink); font-size: 13px; text-decoration: none; }
.skip:focus { top: 12px; }

.app { display: grid; grid-template-columns: 264px minmax(0, 1fr); min-height: 100vh; transition: grid-template-columns .18s ease; }
.app.is-collapsed { grid-template-columns: 0 minmax(0, 1fr); }
.app.is-collapsed .sidebar { padding-left: 0; padding-right: 0; border-right: 0; overflow: hidden; }

.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 14px; padding: 14px 12px; background: var(--surface); border-right: 1px solid var(--rule); overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 6px 14px; border-bottom: 1px solid var(--rule); }
.brand-mark { width: 34px; height: 34px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 9px; background: var(--accent-soft); color: var(--accent); font: 600 12px/1 var(--mono); letter-spacing: .04em; }
.brand-avatar { width: 38px; height: 38px; border-radius: 11px; object-fit: cover; display: block; border: 1px solid var(--rule); background: var(--surface-2); }
.brand-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.brand-name { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brand-sub { color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.nav { display: flex; flex-direction: column; gap: 18px; flex: 1; }
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-heading { padding: 0 10px 6px; color: var(--muted); font-size: 11.5px; font-weight: 600; }
.nav-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
.nav-item:hover { background: var(--surface-2); color: var(--ink); }
.nav-item[aria-current="page"] { background: var(--accent-soft); color: var(--ink); font-weight: 600; }
.nav-item[aria-current="page"] .nav-icon { color: var(--accent); }
.nav-icon { flex: 0 0 16px; color: var(--muted); }
.nav-badge { margin-left: auto; padding: 2px 7px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface-2); color: var(--muted); font: 600 10.5px/1.4 var(--mono); }
.nav-badge[hidden] { display: none; }

.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--field); flex: 0 0 auto; }
.dot[data-state="ok"] { background: var(--ok); }
.dot[data-state="warn"] { background: var(--warn); }
.dot[data-state="bad"] { background: var(--bad); }

.shell { min-width: 0; display: flex; flex-direction: column; }
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 20px; background: var(--paper); border-bottom: 1px solid var(--rule); }
.icon-btn { display: grid; place-items: center; width: 32px; height: 32px; min-height: 32px; padding: 0; flex: 0 0 auto; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); color: var(--muted); cursor: pointer; }
.icon-btn:hover { border-color: var(--field); color: var(--ink); }
.icon-moon { display: none; }
:root[data-theme="dark"] .icon-sun { display: none; }
:root[data-theme="dark"] .icon-moon { display: block; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .icon-sun { display: none; }
  :root:not([data-theme="light"]) .icon-moon { display: block; }
}
.crumb { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: 13px; }
.crumb-root { max-width: 40vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crumb-sep { color: var(--field); }
.crumb strong { color: var(--ink); font-weight: 600; white-space: nowrap; }
.top-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.top-right > * { height: 32px; box-sizing: border-box; }
.top-right button { min-height: 32px; height: 32px; }
.top-right .seg { align-items: center; }
.top-right .seg button { align-self: center; height: 26px; min-height: 26px; }
#logout { height: 32px; min-height: 32px; padding: 0 12px; font-size: 12.5px; }
.kbd-hint { display: flex; align-items: center; gap: 7px; padding: 5px 9px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
.kbd-hint:hover { color: var(--ink); border-color: var(--field); }
.seg { display: flex; padding: 2px; border: 1px solid var(--rule); border-radius: 9px; background: var(--surface); }
.seg button { min-height: 26px; padding: 3px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; font-size: 11.5px; font-weight: 600; }
.seg button:hover:not(:disabled) { border-color: transparent; color: var(--ink); }
.seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--ink); }
.top-link { display: grid; place-items: center; width: 32px; height: 32px; min-height: 32px; padding: 0; flex: 0 0 auto; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); color: var(--muted); }
.top-link:hover { border-color: var(--field); color: var(--ink); }
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 32px; }
.login-card { width: min(560px, 100%); padding: 44px 44px 36px; border: 1px solid var(--rule); border-radius: 18px; background: var(--surface); text-align: center; }
.login-avatar { width: 120px; height: 120px; border-radius: 26px; object-fit: cover; border: 1px solid var(--rule); background: var(--surface-2); }
.login-card h1 { margin: 22px 0 8px; font-size: 32px; letter-spacing: -0.02em; }
.login-sub { margin: 0 0 30px; color: var(--muted); font-size: 15px; }
.login-card .field { text-align: left; }
.login-card label { font-size: 14px; }
.login-card input { width: 100%; height: 52px; font-size: 16px; padding: 0 14px; box-sizing: border-box; }
.login-card .actions { display: block; margin-top: 22px; }
.login-card .actions button { width: 100%; min-height: 52px; font-size: 15.5px; }
.login-error { min-height: 20px; margin: 10px 0 0; color: var(--bad); font-size: 13.5px; }
.login-version { margin: 18px 0 0; color: var(--muted); font: 500 12px/1 var(--mono); letter-spacing: 0.04em; }
.login-lang { position: fixed; top: 20px; right: 20px; }
.login-lang button { min-height: 34px; padding: 4px 14px; font-size: 13px; }
@media (max-width: 520px) {
  .login-card { padding: 32px 22px 28px; border-radius: 14px; }
  .login-avatar { width: 92px; height: 92px; border-radius: 20px; }
  .login-card h1 { font-size: 25px; }
  .login-lang { top: 12px; right: 12px; }
}
.kbd-hint kbd { padding: 2px 5px; border: 1px solid var(--rule); border-radius: 5px; background: var(--surface-2); color: var(--muted); font: 600 10.5px/1 var(--mono); }
main { width: 100%; max-width: 1040px; margin: 0 auto; padding: 26px 28px 64px; }
.view { display: none; }
.view.is-active { display: block; }
.page-head { margin-bottom: 20px; }
h1 { margin: 0 0 4px; font-size: 1.35rem; line-height: 1.25; letter-spacing: -0.01em; }
.page-sub { margin: 0; max-width: 64ch; color: var(--muted); font-size: 13.5px; }
h2 { margin: 0; font-size: 13px; font-weight: 600; }
code { padding: 1px 5px; border: 1px solid var(--rule); border-radius: 5px; background: var(--surface-2); font: 12px var(--mono); }

.card { margin-bottom: 14px; padding: 18px 20px; border: 1px solid var(--rule); border-radius: 12px; background: var(--surface); }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.card-meta { color: var(--muted); font-size: 12px; }
.status-card { display: flex; flex-direction: column; gap: 5px; }
.status-mode { display: flex; align-items: center; gap: 9px; font-size: 1.15rem; font-weight: 600; }
.status-host { color: var(--muted); font: 13.5px var(--mono); overflow-wrap: anywhere; }
.status-note { color: var(--muted); font-size: 12.5px; }
.inline-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid var(--rule); color: var(--muted); font-size: 13px; }
.inline-host { font-family: var(--mono); overflow-wrap: anywhere; }
.fact-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 14px; }
.fact-grid .card { margin-bottom: 0; }
.fact-label { margin-bottom: 6px; color: var(--muted); font-size: 11.5px; }
.fact-value { font-size: 1.3rem; font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; }
.fact-value.mono { font-family: var(--mono); font-size: 1.05rem; }
.fact-sub { margin-top: 4px; color: var(--muted); font-size: 12px; }
.quick-row { display: flex; flex-wrap: wrap; gap: 8px; }

.field { margin-bottom: 18px; }
.field:last-of-type { margin-bottom: 0; }
label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; }
input[type="text"], textarea, select { width: 100%; padding: 9px 11px; border: 1px solid var(--field); border-radius: 8px; background: var(--surface); color: var(--ink); font: 13.5px var(--sans); }
input[type="text"], textarea { font-family: var(--mono); }
textarea { resize: vertical; }
input[type="text"]::placeholder, textarea::placeholder { color: var(--muted); opacity: .8; }
.hint { margin: 6px 0 0; color: var(--muted); font-size: 12.5px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
button { min-height: 36px; padding: 8px 14px; border: 1px solid var(--field); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; transition: border-color .15s ease, background .15s ease, transform .1s ease; }
button:hover:not(:disabled) { border-color: var(--ink); }
button:active:not(:disabled) { transform: translateY(1px); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.primary:hover:not(:disabled) { filter: brightness(1.06); }
button:disabled { opacity: .5; cursor: not-allowed; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.toolbar select { width: auto; min-width: 150px; }

.report { margin-top: 14px; padding: 10px 12px; border-left: 2px solid var(--rule); font-size: 13px; }
.report[hidden] { display: none; }
.report .line { margin: 0 0 3px; }
.report .line:last-child { margin-bottom: 0; }
.report .ok { color: var(--ok); font-weight: 600; }
.report .bad { color: var(--bad); font-weight: 600; }
.report .mono { font-family: var(--mono); }

.empty { margin-top: 12px; padding: 20px; border: 1px dashed var(--rule); border-radius: 10px; color: var(--muted); font-size: 13px; }
.empty strong { display: block; margin-bottom: 3px; color: var(--ink); font-size: 13.5px; }
.empty p { margin: 0; }
.empty[hidden] { display: none; }

.pool-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.pool-list[hidden] { display: none; }
.pool-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 9px 12px; border: 1px solid var(--rule); border-radius: 9px; background: var(--surface-2); font-size: 13px; }
.pool-list .name { font-weight: 600; }
.pool-list .addr { color: var(--muted); font-family: var(--mono); font-size: 12.5px; }
.pool-list .state { margin-left: auto; padding: 2px 7px; border: 1px solid var(--rule); border-radius: 999px; font-size: 11px; font-weight: 600; }
.pool-list .state[data-state="ready"] { color: var(--ok); border-color: var(--ok); }
.pool-list .state[data-state="cooling"] { color: var(--bad); border-color: var(--bad); }
.pool-list .state[data-state="disabled"] { color: var(--muted); }
.pool-list .detail { flex-basis: 100%; color: var(--muted); font-size: 12px; }
.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 14px 0; }
.metric { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface); transition: transform .16s ease, box-shadow .16s ease; }
.metric:hover { transform: translateY(-2px); box-shadow: 0 10px 20px -16px rgba(0, 0, 0, .45); }
.metric-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.metric-icon { display: inline-flex; color: var(--muted); }
.metric-sub { color: var(--muted); font-size: 11.5px; }
.metric-label { color: var(--muted); font-size: 11.5px; }
.metric-value { font: 600 1.05rem/1.3 var(--mono); }
.share-bar { display: flex; gap: 4px; height: 10px; margin: 14px 0 6px; }
.share-seg { min-width: 4px; border-radius: 4px; background: var(--accent-soft); }
.share-seg.is-lead { background: var(--accent); }
.share-note { color: var(--muted); font-size: 11.5px; }

.usage-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(146px, 1fr)); gap: 10px; margin: 14px 0 16px; }
.usage-kpi { position: relative; padding: 14px 16px 12px; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface); overflow: hidden; }
.usage-kpi-label { display: block; color: var(--muted); font: 600 10.5px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
.usage-kpi-value { display: block; margin-top: 6px; font: 600 1.5rem/1.15 var(--mono); letter-spacing: -.01em; color: var(--ink); }
.usage-kpi-sub { display: block; margin-top: 4px; color: var(--muted); font-size: 11.5px; }
.usage-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 12px; margin-bottom: 12px; }
@media (max-width: 900px) { .usage-grid { grid-template-columns: minmax(0, 1fr); } }
.usage-panel { border: 1px solid var(--rule); border-radius: 12px; background: var(--surface); padding: 14px 16px 16px; }
.usage-panel-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; }
.usage-panel-head h2 { margin: 0; font-size: 14px; }
.usage-panel-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.usage-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 8px; background: var(--surface-2); }
.usage-tabs button { border: 0; background: transparent; color: var(--muted); font: 600 11.5px/1 var(--sans); padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.usage-tabs button[aria-selected="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgb(0 0 0 / .12); }
.usage-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.usage-rows { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 4px; }
.usage-row { position: relative; padding: 8px 10px 10px; border-radius: 8px; background: var(--surface-2); overflow: hidden; }
.usage-row::after { content: ""; position: absolute; left: 0; bottom: 0; height: 3px; width: var(--w, 0%); background: var(--tone, var(--accent)); opacity: .55; }
.usage-row-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.usage-row-name { font: 500 12.5px/1.3 var(--mono); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-row-count { font: 600 11.5px/1 var(--mono); color: var(--muted); white-space: nowrap; }
.usage-row-meta { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font: 11px/1.3 var(--mono); }
.usage-row-empty { padding: 18px 4px 6px; color: var(--muted); font-size: 12.5px; }
.usage-chart { width: 100%; height: 240px; margin-top: 10px; overflow: visible; }
.usage-chart .grid-line { stroke: var(--rule); stroke-width: 1; }
.usage-chart .axis-text { fill: var(--muted); font: 10.5px var(--mono); }
.usage-chart .traffic-bar { fill: var(--muted); }
.usage-chart .traffic-bar:hover { fill: var(--ink); }
.usage-empty { display: grid; place-items: center; min-height: 200px; color: var(--muted); font-size: 13px; }
.usage-requests { margin-top: 12px; }
.usage-scope { color: var(--muted); font: 11px/1.5 var(--mono); margin: 0; }
.cell-stack { display: grid; gap: 1px; }
.cell-stack small { color: var(--muted); font: 10.5px/1.2 var(--mono); }
.stats-table tr.is-open td { background: var(--surface-2); }
.stats-table tbody tr[data-open] { cursor: pointer; }

.settings-grid { align-items: start; }
.settings-wide { grid-column: 1 / -1; }
.cred-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; }
.cred-row .field { margin: 0; }
.cred-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.cred-note { margin: 10px 0 0; color: var(--muted); font-size: 11.5px; overflow-wrap: anywhere; }
.cred-preview { margin: 0 0 8px; color: var(--muted); font-size: 12.5px; }
.cred-preview code { font-family: var(--mono); color: var(--ink); }
.key-list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.key-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface-2); }
.key-row.is-off { opacity: 0.55; }
.key-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.key-name { font-weight: 600; overflow-wrap: anywhere; }
.key-preview { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.key-tag { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--muted); white-space: nowrap; }
.key-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.key-actions button { padding: 4px 9px; font-size: 11.5px; }
.key-empty { color: var(--muted); font-size: 12px; margin: 10px 0 0; }
.integration-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
.integration-grid .field { margin: 0; }
.integration-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }

.table-wrap { margin-top: 12px; overflow-x: auto; border: 1px solid var(--rule); border-radius: 10px; }
.stats-table { width: 100%; min-width: 640px; border-collapse: collapse; font-size: 12.5px; }
.stats-table[hidden] { display: none; }
.stats-table th, .stats-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--rule); overflow-wrap: anywhere; }
.stats-table th { background: var(--surface-2); color: var(--muted); font-weight: 600; white-space: nowrap; }
.stats-table tbody tr:last-child td { border-bottom: 0; }
.stats-table .mono { font-family: var(--mono); }
.stats-table .num { text-align: right; font-family: var(--mono); }
.stats-table .st-ok { color: var(--ok); font-weight: 600; }
.stats-table .st-bad { color: var(--bad); font-weight: 600; }
.stats-table .error-row td { font-weight: 400; }

.endpoint-row { display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--rule); font-size: 13px; }
.endpoint-row:last-of-type { border-bottom: 0; }
.endpoint-label { color: var(--muted); }
.endpoint-value { font-family: var(--mono); overflow-wrap: anywhere; }
.endpoint-note { margin-left: 6px; color: var(--muted); font-family: var(--sans); font-size: 12px; }

.kv { display: grid; grid-template-columns: 118px minmax(0, 1fr); gap: 7px 16px; margin: 0; font-size: 13px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.kv dd.mono { font-family: var(--mono); font-size: 11.5px; }
.settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; }
.code { margin: 0; padding: 12px 14px; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface-2); font: 12.5px/1.65 var(--mono); overflow-x: auto; white-space: pre; }
.code + .code { margin-top: 10px; }
.docs-label { margin: 14px 0 6px; color: var(--muted); font-size: 11.5px; font-weight: 600; }
.docs-label:first-child { margin-top: 0; }
.copy-row { display: flex; align-items: center; gap: 8px; }
.copy-row code { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface-2); font: 12.5px var(--mono); overflow-wrap: anywhere; }
.method { display: inline-block; padding: 2px 6px; border: 1px solid var(--rule); border-radius: 5px; font: 600 11px/1.4 var(--mono); color: var(--muted); }
.method.post { color: var(--accent); border-color: var(--accent); }

.nav-backdrop { display: none; }

.palette { position: fixed; inset: 0; z-index: 60; display: flex; justify-content: center; align-items: flex-start; padding: 12vh 16px 16px; }
.palette[hidden] { display: none; }
.palette-backdrop { position: absolute; inset: 0; background: rgba(20, 18, 15, .38); }
.palette-box { position: relative; width: min(560px, 100%); overflow: hidden; border: 1px solid var(--rule); border-radius: 12px; background: var(--surface); box-shadow: 0 18px 48px rgba(0, 0, 0, .22); }
.palette-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--rule); }
.palette-icon { flex: 0 0 16px; color: var(--muted); }
.palette-head input { flex: 1; padding: 4px 0; border: 0; background: transparent; color: var(--ink); font: 14px var(--sans); outline: none; }
.palette-list { list-style: none; margin: 0; padding: 6px; max-height: 46vh; overflow-y: auto; }
.palette-item { padding: 9px 10px; border-radius: 7px; color: var(--ink); font-size: 13.5px; cursor: pointer; }
.palette-item.is-active, .palette-item:hover { background: var(--accent-soft); }
.palette-empty { padding: 12px 10px; color: var(--muted); font-size: 13px; }


/* ---- 路由诊断 与 事件流 ---- */
.events-feed { display: flex; flex-direction: column; gap: 2px; max-height: 62vh; overflow-y: auto; font: 12px/1.7 var(--mono); }
.events-feed .ev { display: flex; gap: 8px; padding: 3px 6px; border-radius: 6px; }
.events-feed .ev:hover { background: var(--surface-2); }
.events-feed .ev .t { color: var(--muted); flex: 0 0 auto; }
.events-feed .ev .lv { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--field); }
.events-feed .ev[data-level="warn"] .lv { background: var(--warn); }
.events-feed .ev[data-level="error"] .lv { background: var(--bad); }
.events-feed .ev .msg { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.diag-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.diag-table th, .diag-table td { padding: 7px 10px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
.diag-table th { color: var(--muted); font-weight: 600; font-size: 11.5px; }
.diag-table td.mono { font-family: var(--mono); font-size: 11.5px; }
.diag-tag { padding: 1px 7px; border: 1px solid var(--rule); border-radius: 999px; font-size: 10.5px; font-weight: 600; white-space: nowrap; }
.diag-tag[data-tone="bad"] { color: var(--bad); border-color: var(--bad); }
.diag-tag[data-tone="warn"] { color: var(--warn); border-color: var(--warn); }
.diag-tag[data-tone="ok"] { color: var(--ok); border-color: var(--ok); }

@media (max-width: 860px) {
  .app, .app.is-collapsed { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: fixed; inset: 0 auto 0 0; z-index: 50; width: 280px; transform: translateX(-100%); transition: transform .18s ease; box-shadow: 0 0 0 1px var(--rule); }
  .app.nav-open .sidebar { transform: none; }
  .app.nav-open .nav-backdrop { display: block; position: fixed; inset: 0; z-index: 45; background: rgba(20, 18, 15, .35); }
  main { padding: 20px 16px 56px; }
  .topbar { padding: 0 12px; }
  .crumb-root, .crumb-sep, .kbd-hint span { display: none; }
  .endpoint-row { grid-template-columns: 92px minmax(0, 1fr) auto; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const AUTH_REQUIRED = document.body.getAttribute("data-auth-required") === "true";
const PANEL_API_KEY = document.body.getAttribute("data-panel-key") || "";

const VIEWS = { overview: "概览", health: "健康检查", diag: "路由诊断", events: "事件流", egress: "出口代理", pool: "代理池", stats: "用量统计", history: "请求历史", endpoint: "接入点", docs: "API 文档", playground: "测试台", settings: "设置" };

// ---- 多语言 ----
// 静态文案按中文原文查表替换；动态内容交给 MutationObserver。
// 不引入构建工具：字典与 DOM 遍历都在本文件内。
const LANG_KEY = "gateway-panel-lang";
const I18N = {
  id: {
    "跳到主内容": "Lewati ke konten utama", "监控": "Pemantauan", "概览": "Ikhtisar", "出口": "Egress", "出口代理": "Proxy Egress", "代理池": "Pool Proxy",
    "数据": "Data", "用量统计": "Statistik Pemakaian", "请求历史": "Riwayat Permintaan", "工具": "Alat", "接入点": "Titik Akses", "API 文档": "Dokumentasi API",
    "测试": "Uji", "冷却中": "Pendingin", "已停用": "Nonaktif",
    "路由诊断": "Diagnostik Rute", "事件流": "Aliran Peristiwa", "暂停": "Jeda", "继续": "Lanjut", "跳到最新": "Ke terbaru",
    "出口健康": "Kesehatan egress", "按出口统计": "Statistik per egress", "模型失败分布": "Distribusi gagal per model",
    "最近错误": "Galat terakhir", "冷却": "Pendingin", "最后成功": "Berhasil terakhir", "失败率": "Tingkat gagal", "刷新": "Segarkan",
    "429 限流": "429 pembatasan", "426 网关": "426 gerbang", "403 拒绝": "403 ditolak", "传输错误": "Galat transport",
    "出口池未启用": "Pool belum aktif", "暂无记录": "Belum ada catatan", "直连": "Langsung",
    "出口健康、按出口的近期结果与模型失败分布；数据全部来自代理池健康与本机请求历史。": "Kesehatan egress, hasil terkini per egress, dan distribusi gagal per model; semua data dari kesehatan pool dan riwayat permintaan lokal.",
    "网关进程的实时日志：重试、冷却、池变化与模型发现。每 2 秒增量拉取，只读本机。": "Log realtime proses gateway: retry, cooldown, perubahan pool, dan penemuan model. Tarik bertahap tiap 2 detik, hanya baca lokal.",
    "测试台": "Playground", "系统": "Sistem", "设置": "Pengaturan", "网关检查中": "Memeriksa gateway", "正在读取 /health": "Membaca /health",
    "查看 /health": "Lihat /health", "跳转": "Lompat", "总请求": "Total permintaan", "读取中": "Memuat", "成功率": "Tingkat sukses",
    "平均耗时": "Rata-rata durasi", "免费模型": "Model gratis", "代理池就绪": "Pool siap", "调度策略": "Strategi",
    "池内条目按此策略轮转": "Entri pool diputar menurut strategi ini", "上游网关": "Gateway hulu", "检查中": "Memeriksa",
    "配置出口": "Atur egress", "管理代理池": "Kelola pool", "查看统计": "Lihat statistik", "代理 URL": "URL proxy", "格式": "Format",
    "保存并启用": "Simpan dan aktifkan", "测试连接": "Uji koneksi", "关闭代理": "Matikan proxy", "每行一个 URL，可用": "Satu URL per baris, bisa pakai",
    "名称=url": "nama=url", "代理列表": "Daftar proxy", "策略": "Strategi", "轮询（均分流量）": "Round-robin (bagi rata)",
    "故障转移（固定用第一个，被拒才换）": "Failover (pakai yang pertama, ganti saat ditolak)", "加权随机": "Acak berbobot",
    "保存代理池": "Simpan pool", "全部测试": "Uji semua", "清空代理池": "Kosongkan pool", "当前条目": "Entri saat ini",
    "代理池未启用": "Pool belum aktif", "本地": "Lokal", "全部": "Semua", "最近 1 天": "1 hari terakhir", "最近 7 天": "7 hari terakhir",
    "最近 30 天": "30 hari terakhir", "刷新统计": "Segarkan statistik", "清空历史": "Kosongkan riwayat", "还没有加载统计": "Statistik belum dimuat",
    "模型": "Model", "请求": "Permintaan", "成功": "Sukses", "失败": "Gagal", "输入词元": "Token input", "输出词元": "Token output",
    "最近 100 条请求记录，字段与": "100 permintaan terakhir; field sama dengan", "一致。": ".", "最近请求": "Permintaan terbaru",
    "还没有加载记录": "Riwayat belum dimuat", "时间": "Waktu", "协议": "Protokol", "状态": "Status", "耗时": "Durasi", "输入": "Input", "输出": "Output",
    "健康检查": "Pemeriksaan kesehatan", "版本": "Versi", "运行时": "Runtime", "OpenAI 兼容": "Kompatibel OpenAI", "鉴权头": "Header auth",
    "Anthropic 兼容": "Kompatibel Anthropic", "端点": "Endpoint", "只列本桥真实路由": "Hanya rute nyata gateway ini", "方法": "Metode",
    "路径": "Path", "说明": "Keterangan", "本桥": "Gateway ini", "面板": "Panel", "当前免费模型": "Model gratis saat ini",
    "读取中…": "Memuat…", "模型 ID": "ID model", "归属": "Pemilik", "还没有模型清单": "Daftar model masih kosong",
    "请求示例": "Contoh permintaan", "按当前 origin 生成": "Dibuat dari origin saat ini", "提示词": "Prompt", "发送": "Kirim", "清空": "Bersihkan",
    "运行": "Runtime", "面板偏好": "Preferensi panel", "/health 刷新间隔": "Interval segar /health", "15 秒": "15 detik",
    "30 秒": "30 detik", "60 秒": "60 detik", "120 秒": "120 detik", "默认统计范围": "Rentang statistik default", "切换主题": "Ganti tema",
    "主导航": "Navigasi utama", "区块": "Bagian", "收起或展开侧栏": "Ciutkan atau buka sidebar", "打开跳转面板": "Buka panel lompat",
    "统计范围": "Rentang statistik", "历史范围": "Rentang riwayat", "复制 Base URL": "Salin Base URL", "复制 API key": "Salin API key",
    "复制鉴权头": "Salin header auth", "从 /v1/models 读取": "Dibaca dari /v1/models", "用一句话介绍这个桥。": "Perkenalkan gateway ini dalam satu kalimat.",
    "跳转到页面区块": "Lompat ke bagian halaman", "跳到...（输入关键字）": "Lompat... (ketik kata kunci)", "搜索区块": "Cari bagian",
    "关闭跳转面板": "Tutup panel lompat", "区块列表": "Daftar bagian",
    "桥的出口与网关状态。改动立即用于下一个请求，无需重启。": "Status egress dan gateway gateway. Perubahan langsung berlaku untuk permintaan berikutnya, tanpa restart.",
    "把桥的所有出站连接指向 HTTP 代理，上游就不会看到本机 IP。": "Arahkan semua koneksi keluar gateway ke proxy HTTP; upstream tidak melihat IP lokal.",
    "。仅支持 HTTP/HTTPS（CONNECT 隧道）。清空后保存即回到直连。": ". Hanya HTTP/HTTPS (tunnel CONNECT). Kosongkan lalu simpan untuk kembali langsung.",
    "加标签。被上游拒绝的条目进入冷却，恢复前自动跳过。": "sebagai label. Entri yang ditolak upstream masuk cooldown dan dilewati sampai pulih.",
    "在上方填写并保存至少一条代理后，这里会显示健康状态与冷却倒计时。": "Isi dan simpan minimal satu proxy di atas; status kesehatan dan hitung mundur cooldown tampil di sini.",
    "汇总，只含模型、耗时、词元与状态，不含消息内容。": "ringkasan; hanya model, durasi, token, dan status, tanpa isi pesan.",
    "选择范围后按「刷新统计」。数据来自本机记录，不含消息内容。": "Pilih rentang lalu tekan Segarkan statistik. Data dari catatan lokal, tanpa isi pesan.",
    "跑一次推理请求后按「最近请求」。记录来自本机": "Jalankan satu permintaan inferensi lalu tekan Permintaan terbaru. Catatan dari lokal",
    "OpenAI 兼容客户端直接指向这里。面板无鉴权，只应绑定回环地址。": "Klien kompatibel OpenAI arahkan ke sini. Panel tanpa autentikasi; hanya ikat ke loopback.",
    "（设了 FUCKING_OPENCODE_API_KEYS 后用该 key）": "(pakai key itu jika FUCKING_OPENCODE_API_KEYS diatur)",
    "本桥实际提供的路由、当前免费模型，以及可直接复制的请求示例。鉴权状态来自对 /v1/models 的探测。": "Rute nyata gateway ini, model gratis aktif, dan contoh permintaan siap salin. Status auth dari probe /v1/models.",
    "健康、出口与网关状态。": "Kesehatan, egress, dan status gateway.", "当前免费模型清单。": "Daftar model gratis saat ini.",
    "对话补全，支持 SSE 流式。": "Penyelesaian percakapan, mendukung SSE.", "Messages API，支持 SSE 流式。": "Messages API, mendukung SSE.",
    "本机用量汇总，可选": "Ringkasan pemakaian lokal, opsional", "最近请求记录，可选": "Catatan permintaan terbaru, opsional",
    "清空本机用量历史。": "Hapus riwayat pemakaian lokal.", "读取出口配置与代理池健康。": "Baca konfigurasi egress dan kesehatan pool.",
    "写入单代理或代理池。": "Tulis proxy tunggal atau pool.", "探测代理，不落盘。": "Uji proxy tanpa menyimpan.",
    "首次发现会在请求 /v1/models 时触发，稍后刷新本页。": "Penemuan pertama dipicu saat /v1/models diminta; segarkan halaman nanti.",
    "OpenAI chat completions（非流式）": "OpenAI chat completions (non-streaming)",
    "用当前出口发一条真实请求，验证模型、凭据和自愈链路是否通畅。": "Kirim permintaan nyata lewat egress aktif untuk memastikan model, kredensial, dan pemulihan berjalan.",
    "会真实消耗上游免费额度；请求为非流式，只展示最终文本与用量。": "Memakai kuota gratis upstream; non-streaming, hanya teks akhir dan pemakaian.",
    "这里只展示进程真实读取到的配置；环境变量类改动需要重启桥。面板偏好只存在本机浏览器。": "Hanya konfigurasi yang benar-benar dibaca proses; perubahan env perlu restart gateway. Preferensi panel tersimpan di browser lokal.",
    "监听": "Listening", "重试冷却": "Cooldown retry", "锚点工具": "Alat anchor", "模式": "Mode", "代理": "Proxy", "来源": "Sumber",
    "环境锁定": "Terkunci env", "配置文件": "Berkas konfigurasi", "未启用": "Tidak aktif", "历史文件": "Berkas riwayat",
    "累计请求": "Total permintaan", "词元覆盖率": "Cakupan token", "API 鉴权": "Auth API", "读取失败": "Gagal membaca", "是": "Ya", "否": "Tidak", "毫秒": "md",
    "已复制。": "Tersalin.", "复制失败，请手动选择文本。": "Gagal menyalin, pilih teks manual.", "内容": "Konten", "健康检查失败": "Pemeriksaan kesehatan gagal",
    "检查失败": "Pemeriksaan gagal", "就绪": "siap", "需要 API 密钥": "Perlu API key", "清单为空": "Daftar kosong",
    "模型清单需要密钥": "Daftar model perlu kunci",
    "Cloudflare WARP": "Cloudflare WARP",
    "可选。仅当服务以 WARP_MANAGE=1 启动且主机安装了 warp-cli 时可用。连接/断开会改变整机路由。": "Opsional. Hanya jika layanan dijalankan dengan WARP_MANAGE=1 dan warp-cli terpasang di host. Connect/disconnect mengubah rute seluruh mesin.",
    "连接": "Hubungkan", "断开": "Putuskan",
    "未启用": "Nonaktif", "未安装 warp-cli": "warp-cli tidak terpasang", "连接中": "Menghubungkan", "已连接": "Terhubung", "已断开": "Terputus", "不可用": "Tidak tersedia", "读取失败": "Gagal membaca",
    "正在连接 WARP…": "Menghubungkan WARP…", "正在断开 WARP…": "Memutuskan WARP…", "WARP 已连接。": "WARP terhubung.", "WARP 已断开。": "WARP terputus.", "WARP 操作失败。": "Operasi WARP gagal.",
    "读取 WARP 状态失败：": "Gagal membaca status WARP: ",
    "代理测试失败。": "Uji proxy gagal.", "原因未知": "Alasan tidak diketahui", "无条目": "Tidak ada entri",
    "本地运维面板": "Panel operasional lokal", "直连（本机 IP）": "Langsung (IP lokal)", "未设置代理": "Proxy belum diatur",
    "网关开放": "Gateway terbuka", "网关冷却中": "Gateway cooldown", "出口 IP 被封": "IP egress diblokir",
    "冷却至": "Cooldown sampai", "最近拒绝：": "Penolakan terbaru:", "无近期拒绝记录": "Tidak ada penolakan terbaru", "未知": "Tidak diketahui",
    "没有匹配的区块。": "Tidak ada bagian yang cocok.", "先填入要测试的代理 URL。": "Isi URL proxy yang akan diuji.",
    "代理已关闭。出口回到直连，使用本机 IP。": "Proxy dimatikan. Egress kembali langsung memakai IP lokal.",
    "至少填一个代理。": "Isi minimal satu proxy.", "至少填一个要测试的代理。": "Isi minimal satu proxy untuk diuji.",
    "没有结果。": "Tidak ada hasil.", "代理池已清空。出口回到单代理或直连。": "Pool dikosongkan. Egress kembali ke proxy tunggal atau langsung.",
    "还没有记录": "Belum ada catatan", "跑一次推理请求后按「最近请求」刷新。": "Jalankan satu permintaan inferensi lalu tekan Permintaan terbaru.",
    "历史已清空": "Riwayat dikosongkan", "跑一次请求后再按「刷新统计」。": "Jalankan satu permintaan lalu tekan Segarkan statistik.",
    "跑一次请求后按「最近请求」刷新。": "Jalankan satu permintaan lalu tekan Permintaan terbaru.",
    "本机用量历史累计": "Akumulasi riwayat pemakaian lokal", "按已记录请求计算": "Dihitung dari permintaan tercatat",
    "读取受限，需 API 密钥": "Akses dibatasi, perlu API key", "先选择或填写模型 ID。": "Pilih atau isi ID model dulu.",
    "提示词不能为空。": "Prompt tidak boleh kosong.", "请求中…": "Meminta…", "默认统计范围已更新。": "Rentang statistik default diperbarui.",
    "（空回复）": "(balasan kosong)",
    "代理池已启用": "Pool aktif", "轮询": "round-robin", "故障转移": "failover", "加权随机": "acak berbobot"
  },
  en: {
    "数据": "Data", "用量统计": "Usage Stats", "请求历史": "Request History", "工具": "Tools", "接入点": "Endpoint", "API 文档": "API Docs",
    "测试": "Test", "冷却中": "Cooling", "已停用": "Disabled",
    "路由诊断": "Routing Diagnostics", "事件流": "Event Stream", "暂停": "Pause", "继续": "Resume", "跳到最新": "Jump to latest",
    "出口健康": "Egress health", "按出口统计": "Per-egress stats", "模型失败分布": "Model failure breakdown",
    "最近错误": "Last error", "冷却": "Cooldown", "最后成功": "Last success", "失败率": "Fail rate", "刷新": "Refresh",
    "429 限流": "429 limited", "426 网关": "426 gate", "403 拒绝": "403 refused", "传输错误": "Transport error",
    "出口池未启用": "Pool not enabled", "暂无记录": "No records yet", "直连": "Direct",
    "出口健康、按出口的近期结果与模型失败分布；数据全部来自代理池健康与本机请求历史。": "Egress health, recent per-egress outcomes, and model failure breakdown; every number comes from pool health and local request history.",
    "网关进程的实时日志：重试、冷却、池变化与模型发现。每 2 秒增量拉取，只读本机。": "Live gateway process log: retries, cooldowns, pool changes, and model discovery. Incremental pull every 2 seconds, local read-only.",
    "跳到主内容": "Skip to main content", "监控": "Monitoring", "概览": "Overview", "出口": "Egress", "出口代理": "Egress Proxy", "代理池": "Proxy Pool",
    "数据": "Data", "用量统计": "Usage Stats", "请求历史": "Request History", "工具": "Tools", "接入点": "Endpoint", "API 文档": "API Docs",
    "测试台": "Playground", "系统": "System", "设置": "Settings", "网关检查中": "Checking gateway", "正在读取 /health": "Reading /health",
    "查看 /health": "View /health", "跳转": "Jump", "总请求": "Total requests", "读取中": "Loading", "成功率": "Success rate",
    "平均耗时": "Average latency", "免费模型": "Free models", "代理池就绪": "Pool ready", "调度策略": "Strategy",
    "池内条目按此策略轮转": "Pool entries rotate by this strategy", "上游网关": "Upstream gateway", "检查中": "Checking",
    "配置出口": "Configure egress", "管理代理池": "Manage pool", "查看统计": "View stats", "代理 URL": "Proxy URL", "格式": "Format",
    "保存并启用": "Save and enable", "测试连接": "Test connection", "关闭代理": "Disable proxy", "每行一个 URL，可用": "One URL per line, optionally",
    "名称=url": "name=url", "代理列表": "Proxy list", "策略": "Strategy", "轮询（均分流量）": "Round-robin (even split)",
    "故障转移（固定用第一个，被拒才换）": "Failover (stick to first, switch when refused)", "加权随机": "Weighted random",
    "保存代理池": "Save pool", "全部测试": "Test all", "清空代理池": "Clear pool", "当前条目": "Current entries",
    "代理池未启用": "Pool not enabled", "本地": "Local", "全部": "All", "最近 1 天": "Last 1 day", "最近 7 天": "Last 7 days",
    "最近 30 天": "Last 30 days", "刷新统计": "Refresh stats", "清空历史": "Clear history", "还没有加载统计": "Stats not loaded yet",
    "模型": "Model", "请求": "Requests", "成功": "OK", "失败": "Fail", "输入词元": "Input tokens", "输出词元": "Output tokens",
    "最近 100 条请求记录，字段与": "Last 100 requests; fields match", "一致。": ".", "最近请求": "Recent requests",
    "还没有加载记录": "No records loaded yet", "时间": "Time", "协议": "Protocol", "状态": "Status", "耗时": "Latency", "输入": "Input", "输出": "Output",
    "健康检查": "Health check", "版本": "Version", "运行时": "Runtime", "OpenAI 兼容": "OpenAI compatible", "鉴权头": "Auth header",
    "Anthropic 兼容": "Anthropic compatible", "端点": "Endpoints", "只列本桥真实路由": "Only actual routes of this gateway", "方法": "Method",
    "路径": "Path", "说明": "Description", "本桥": "This gateway", "面板": "Panel", "当前免费模型": "Current free models",
    "读取中…": "Loading…", "模型 ID": "Model ID", "归属": "Owner", "还没有模型清单": "No model list yet",
    "请求示例": "Request examples", "按当前 origin 生成": "Generated from current origin", "提示词": "Prompt", "发送": "Send", "清空": "Clear",
    "运行": "Runtime", "面板偏好": "Panel preferences", "/health 刷新间隔": "/health refresh interval", "15 秒": "15 seconds",
    "30 秒": "30 seconds", "60 秒": "60 seconds", "120 秒": "120 seconds", "默认统计范围": "Default stats range", "切换主题": "Toggle theme",
    "主导航": "Main navigation", "区块": "Sections", "收起或展开侧栏": "Collapse or expand sidebar", "打开跳转面板": "Open jump palette",
    "统计范围": "Stats range", "历史范围": "History range", "复制 Base URL": "Copy Base URL", "复制 API key": "Copy API key",
    "复制鉴权头": "Copy auth header", "从 /v1/models 读取": "Read from /v1/models", "用一句话介绍这个桥。": "Introduce this gateway in one sentence.",
    "跳转到页面区块": "Jump to a page section", "跳到...（输入关键字）": "Jump to... (type a keyword)", "搜索区块": "Search sections",
    "关闭跳转面板": "Close jump palette", "区块列表": "Section list",
    "桥的出口与网关状态。改动立即用于下一个请求，无需重启。": "Gateway egress and gateway status. Changes apply to the next request; no restart needed.",
    "把桥的所有出站连接指向 HTTP 代理，上游就不会看到本机 IP。": "Route all gateway egress through an HTTP proxy so upstream never sees this machine's IP.",
    "。仅支持 HTTP/HTTPS（CONNECT 隧道）。清空后保存即回到直连。": ". HTTP/HTTPS only (CONNECT tunnel). Clear and save to go direct.",
    "加标签。被上游拒绝的条目进入冷却，恢复前自动跳过。": "as a label. Entries refused upstream cool down and are skipped until recovered.",
    "在上方填写并保存至少一条代理后，这里会显示健康状态与冷却倒计时。": "Fill and save at least one proxy above; health and cooldown countdown appear here.",
    "汇总，只含模型、耗时、词元与状态，不含消息内容。": "summary; models, latency, tokens, and status only, never message content.",
    "选择范围后按「刷新统计」。数据来自本机记录，不含消息内容。": "Pick a range, then Refresh stats. Data comes from local records, never message content.",
    "跑一次推理请求后按「最近请求」。记录来自本机": "Run one inference request, then press Recent requests. Records come from local",
    "OpenAI 兼容客户端直接指向这里。面板无鉴权，只应绑定回环地址。": "Point OpenAI-compatible clients here. The panel has no auth; bind loopback only.",
    "（设了 FUCKING_OPENCODE_API_KEYS 后用该 key）": "(use that key when FUCKING_OPENCODE_API_KEYS is set)",
    "本桥实际提供的路由、当前免费模型，以及可直接复制的请求示例。鉴权状态来自对 /v1/models 的探测。": "This gateway's real routes, active free models, and copy-ready request examples. Auth status comes from probing /v1/models.",
    "健康、出口与网关状态。": "Health, egress, and gateway status.", "当前免费模型清单。": "Current free-model list.",
    "对话补全，支持 SSE 流式。": "Chat completion, supports SSE streaming.", "Messages API，支持 SSE 流式。": "Messages API, supports SSE streaming.",
    "本机用量汇总，可选": "Local usage summary, optional", "最近请求记录，可选": "Recent request records, optional",
    "清空本机用量历史。": "Clear local usage history.", "读取出口配置与代理池健康。": "Read egress config and pool health.",
    "写入单代理或代理池。": "Write a single proxy or pool.", "探测代理，不落盘。": "Probe a proxy without writing to disk.",
    "首次发现会在请求 /v1/models 时触发，稍后刷新本页。": "First discovery triggers on a /v1/models request; refresh later.",
    "OpenAI chat completions（非流式）": "OpenAI chat completions (non-streaming)",
    "用当前出口发一条真实请求，验证模型、凭据和自愈链路是否通畅。": "Send a real request through the active egress to check models, credentials, and recovery.",
    "会真实消耗上游免费额度；请求为非流式，只展示最终文本与用量。": "Consumes upstream free quota; non-streaming, shows final text and usage only.",
    "这里只展示进程真实读取到的配置；环境变量类改动需要重启桥。面板偏好只存在本机浏览器。": "Only config actually read by the process is shown; env changes need a gateway restart. Panel preferences live in this browser.",
    "监听": "Listening", "重试冷却": "Retry cooldown", "锚点工具": "Anchor tools", "模式": "Mode", "代理": "Proxy", "来源": "Source",
    "环境锁定": "Env locked", "配置文件": "Config file", "未启用": "Not enabled", "历史文件": "History file",
    "累计请求": "Total requests", "词元覆盖率": "Token coverage", "API 鉴权": "API auth", "读取失败": "Failed to read", "是": "Yes", "否": "No", "毫秒": "ms",
    "已复制。": "Copied.", "复制失败，请手动选择文本。": "Copy failed; select the text manually.", "内容": "Content", "健康检查失败": "Health check failed",
    "检查失败": "Check failed", "就绪": "ready", "需要 API 密钥": "API key required", "清单为空": "List is empty",
    "模型清单需要密钥": "Model list needs a key",
    "Cloudflare WARP": "Cloudflare WARP",
    "可选。仅当服务以 WARP_MANAGE=1 启动且主机安装了 warp-cli 时可用。连接/断开会改变整机路由。": "Optional. Available only when the service runs with WARP_MANAGE=1 and warp-cli is installed on the host. Connect/disconnect changes whole-machine routing.",
    "连接": "Connect", "断开": "Disconnect",
    "未启用": "Disabled", "未安装 warp-cli": "warp-cli not installed", "连接中": "Connecting", "已连接": "Connected", "已断开": "Disconnected", "不可用": "Unavailable", "读取失败": "Failed to read",
    "正在连接 WARP…": "Connecting WARP…", "正在断开 WARP…": "Disconnecting WARP…", "WARP 已连接。": "WARP connected.", "WARP 已断开。": "WARP disconnected.", "WARP 操作失败。": "WARP operation failed.",
    "读取 WARP 状态失败：": "Failed to read WARP status: ",
    "代理测试失败。": "Proxy test failed.", "原因未知": "Unknown reason", "无条目": "No entries",
    "本地运维面板": "Local ops panel", "直连（本机 IP）": "Direct (local IP)", "未设置代理": "No proxy configured",
    "网关开放": "Gateway open", "网关冷却中": "Gateway cooling down", "出口 IP 被封": "Egress IP blocked",
    "冷却至": "Cooling until", "最近拒绝：": "Latest refusal:", "无近期拒绝记录": "No recent refusals", "未知": "Unknown",
    "没有匹配的区块。": "No matching sections.", "先填入要测试的代理 URL。": "Enter the proxy URL to test first.",
    "代理已关闭。出口回到直连，使用本机 IP。": "Proxy disabled. Egress goes direct with the local IP.",
    "至少填一个代理。": "Add at least one proxy.", "至少填一个要测试的代理。": "Add at least one proxy to test.",
    "没有结果。": "No results.", "代理池已清空。出口回到单代理或直连。": "Pool cleared. Egress falls back to a single proxy or direct.",
    "还没有记录": "No records yet", "跑一次推理请求后按「最近请求」刷新。": "Run one inference request, then press Recent requests.",
    "历史已清空": "History cleared", "跑一次请求后再按「刷新统计」。": "Run one request, then press Refresh stats.",
    "跑一次请求后按「最近请求」刷新。": "Run one request, then press Recent requests.",
    "本机用量历史累计": "Local usage history total", "按已记录请求计算": "Computed from recorded requests",
    "读取受限，需 API 密钥": "Read restricted; API key required", "先选择或填写模型 ID。": "Choose or enter a model ID first.",
    "提示词不能为空。": "Prompt cannot be empty.", "请求中…": "Requesting…", "默认统计范围已更新。": "Default stats range updated.",
    "（空回复）": "(empty reply)",
    "代理池已启用": "Pool enabled", "轮询": "round-robin", "故障转移": "failover", "加权随机": "weighted random"
  }
};

// 新增页面与设置的补充词条：无需改动上面的原有字典结构。
I18N.patch = {
  id: {
    "健康检查": "Pemeriksaan kesehatan", "请求数": "Permintaan", "输入词元": "Token masukan", "缓存词元": "Token cache",
    "输出词元": "Token keluaran", "总词元": "Total token", "本机累计请求": "Permintaan terakumulasi di mesin ini",
    "未包含缓存部分": "Belum termasuk bagian cache", "生成的补全": "Komplet yang dihasilkan", "输入 + 输出": "Masukan + keluaran",
    "免费模型，无计费": "Model gratis, tanpa tagihan", "暂无缓存命中": "Belum ada cache yang cocok",
    "还没有词元记录。发起一次推理后再刷新统计。": "Belum ada catatan token. Jalankan satu inferensi lalu segarkan statistik.",
    "输入、缓存与输出词元随时间的组成。": "Komposisi token masukan, cache, dan keluaran sepanjang waktu.",
    "输入": "Masukan", "缓存": "Cache", "输出": "Keluaran", "访问凭据": "Kredensial akses",
    "API key（下游 Bearer）": "API key (Bearer hilir)", "输入新的 API key": "Masukkan API key baru",
    "保存 key": "Simpan key", "随机生成": "Acak", "删除 key": "Hapus key", "面板登录密码": "Kata sandi login panel",
    "输入新密码": "Masukkan kata sandi baru", "保存密码": "Simpan kata sandi", "清除密码": "Hapus kata sandi",
    "由客户端指定": "Ditentukan klien", "刷新": "Segarkan", "原始响应": "Respons mentah", "读取中…": "Memuat…",
    "状态": "Status", "版本": "Versi", "运行时": "Runtime", "出口": "Egress", "上游网关": "Gateway hulu",
    "模型目录": "Katalog model", "监听": "Mendengarkan", "直连": "langsung", "无冷却": "tanpa jeda",
    "已读取 /health。": "/health sudah dibaca.", "读取 /health 失败：": "Gagal membaca /health: ",
    "读取凭据失败：": "Gagal membaca kredensial: ", "当前 key：": "Key saat ini: ", "（来源：": " (sumber: ",
    "环境变量": "variabel lingkungan", "本机文件": "berkas lokal",
    "当前未设置 key：任何非空 Bearer 都会被接受。": "Key belum diatur: Bearer apa pun yang tidak kosong diterima.",
    "保存到": "Disimpan ke", "密码": "Kata sandi", "已设置": "sudah diatur", "未设置（面板不需登录）": "belum diatur (panel tanpa login)",
    "先填入新的 API key。": "Isi API key baru dulu.", "API key 已保存，立即生效。": "API key tersimpan dan langsung berlaku.",
    "API key 已删除，鉴权关闭。": "API key dihapus; autentikasi dimatikan.", "先填入新密码。": "Isi kata sandi baru dulu.",
    "登录密码已保存，旧会话已失效。": "Kata sandi login tersimpan; sesi lama berakhir.",
    "登录密码已清除，面板不再要求登录。": "Kata sandi login dihapus; panel tidak lagi meminta login.",
    "Agent 集成": "Integrasi Agent",
    "默认模型": "Model default",
    "复制": "Salin",
    "复制示例": "Salin contoh",
    "任何 OpenAI 兼容客户端把 Base URL 指向这里，并在 Authorization 里带上 API key。": "Arahkan Base URL klien apa pun yang kompatibel OpenAI ke sini, lalu kirim API key di header Authorization.",
    "示例请求": "Contoh permintaan",
    "凭据可直接在下方修改并立即生效；其余环境变量改动需要重启桥。面板偏好只存在本机浏览器。": "Kredensial bisa diubah langsung di bawah dan berlaku seketika; perubahan variabel lingkungan lain perlu restart gateway. Preferensi panel hanya tersimpan di browser ini.",
  },
  en: {
    "健康检查": "Health", "请求数": "Requests", "输入词元": "Input tokens", "缓存词元": "Cached tokens",
    "输出词元": "Output tokens", "总词元": "Total tokens", "本机累计请求": "Cumulative requests on this machine",
    "未包含缓存部分": "Excludes cached portion", "生成的补全": "Generated completion", "输入 + 输出": "Input + output",
    "免费模型，无计费": "Free models, no billing", "暂无缓存命中": "No cache hits yet",
    "还没有词元记录。发起一次推理后再刷新统计。": "No token records yet. Run an inference, then refresh stats.",
    "输入、缓存与输出词元随时间的组成。": "Input, cached, and output token composition over time.",
    "输入": "Input", "缓存": "Cached", "输出": "Output", "访问凭据": "Access credentials",
    "API key（下游 Bearer）": "API key (downstream Bearer)", "输入新的 API key": "Enter a new API key",
    "保存 key": "Save key", "随机生成": "Randomize", "删除 key": "Delete key", "面板登录密码": "Panel login password",
    "输入新密码": "Enter a new password", "保存密码": "Save password", "清除密码": "Clear password",
    "由客户端指定": "Set by the client", "刷新": "Refresh", "原始响应": "Raw response", "读取中…": "Loading…",
    "状态": "Status", "版本": "Version", "运行时": "Runtime", "出口": "Egress", "上游网关": "Upstream gateway",
    "模型目录": "Model catalog", "监听": "Listening", "直连": "direct", "无冷却": "no cooldown",
    "已读取 /health。": "/health loaded.", "读取 /health 失败：": "Failed to read /health: ",
    "读取凭据失败：": "Failed to read credentials: ", "当前 key：": "Current key: ", "（来源：": " (source: ",
    "环境变量": "environment variable", "本机文件": "local file",
    "当前未设置 key：任何非空 Bearer 都会被接受。": "No key set: any non-empty Bearer is accepted.",
    "保存到": "Saved to", "密码": "Password", "已设置": "set", "未设置（面板不需登录）": "not set (panel has no login)",
    "先填入新的 API key。": "Enter a new API key first.", "API key 已保存，立即生效。": "API key saved and active immediately.",
    "API key 已删除，鉴权关闭。": "API key deleted; authentication is off.", "先填入新密码。": "Enter a new password first.",
    "登录密码已保存，旧会话已失效。": "Login password saved; old sessions revoked.",
    "登录密码已清除，面板不再要求登录。": "Login password cleared; the panel no longer requires a login.",
    "Agent 集成": "Agent integration",
    "默认模型": "Default model",
    "复制": "Copy",
    "复制示例": "Copy example",
    "任何 OpenAI 兼容客户端把 Base URL 指向这里，并在 Authorization 里带上 API key。": "Point any OpenAI-compatible client's Base URL here and send the API key in the Authorization header.",
    "示例请求": "Example request",
    "凭据可直接在下方修改并立即生效；其余环境变量改动需要重启桥。面板偏好只存在本机浏览器。": "Credentials can be edited below and apply immediately; other env changes need a gateway restart. Panel preferences live in this browser.",
  },
};

// 用量页面（版式对齐参考实现）新增词条：追加合并，不动上面的字典结构。
Object.assign(I18N.patch.id, {
  "个客户端": "klien", "成功": "berhasil", "失败": "gagal", "次": "kali",
  "API 密钥": "Kunci API", "完成": "Selesai",
  "缓存命中": "kena cache", "提示词词元": "Token prompt", "预估费用": "Perkiraan biaya",
  "停用": "Nonaktifkan", "重置": "Atur ulang",
  "免费模型，不计费": "Model gratis, tanpa tagihan", "分类": "Rincian",
  "按请求数排序，条长为该组占比。": "Diurutkan menurut permintaan; panjang bilah = porsi grup.",
  "供应商": "Penyedia", "客户端 IP": "IP klien", "密钥": "Kunci", "流量": "Trafik",
  "按 24 个时间桶统计；无记录的空桶为 0。": "Dihitung dalam 24 ember waktu; ember kosong bernilai 0.",
  "请求": "Permintaan", "词元": "Token", "缓存": "Cache", "时间": "Waktu",
  "供应商 / 模型": "Penyedia / model", "完成": "Selesai",
  "最近 100 条，新的在上；点开一行看错误摘要。": "100 terbaru, terbaru di atas; klik baris untuk ringkasan galat.",
  "这个范围内还没有请求。": "Belum ada permintaan dalam rentang ini.",
  "默认密钥": "Kunci bawaan", "无密钥": "Tanpa kunci",
  "流式": "Streaming", "非流式": "Non-streaming",
  "次请求": "permintaan", "平均": "Rata-rata", "最近": "Terakhir", "天": "hari", "全部": "Semua",
  "统计已更新。": "Statistik diperbarui.",
  "还没有流量记录。发起一次推理后再刷新统计。": "Belum ada catatan trafik. Jalankan satu inferensi lalu segarkan statistik.",
  "这个范围内没有可分组的数据。": "Tidak ada data untuk dikelompokkan dalam rentang ini.",
  "添加下游 key": "Tambah key hilir", "标签（可选）": "Label (opsional)",
  "输入新的 API key": "Masukkan API key baru", "例如：laptop、ci": "mis. laptop, ci",
  "添加 key": "Tambah key", "删除全部": "Hapus semua", "改名": "Ganti nama", "删除": "Hapus",
  "环境变量": "Variabel env", "当前 key：": "Key saat ini: ",
  "当前未设置 key：启用后仅接受已登记的 Bearer。": "Belum ada key: setelah diaktifkan hanya Bearer terdaftar yang diterima.",
  "尚未添加入口 key。": "Belum ada key masuk.",
  "API key 已添加，立即生效。": "API key ditambahkan dan langsung aktif.",
  "标签已更新。": "Label diperbarui.", "key 已停用。": "Key dinonaktifkan.",
  "key 已启用。": "Key diaktifkan.", "key 已删除。": "Key dihapus.",
  "本机保存的 API key 已全部删除。": "Semua API key yang tersimpan di mesin ini dihapus.",
  "连续成功": "Sukses beruntun", "模型冷却": "Pendinginan model",
  "冷却原因": "Alasan pendingin", "剩余": "Sisa",
});

Object.assign(I18N.patch.en, {
  "个客户端": "clients", "成功": "ok", "失败": "failed", "次": "hits",
  "缓存命中": "cache hit", "提示词词元": "Prompt tokens", "预估费用": "Est. cost",
  "免费模型，不计费": "Free models, no billing", "分类": "Breakdown",
  "按请求数排序，条长为该组占比。": "Sorted by requests; bar length is the group share.",
  "供应商": "Provider", "客户端 IP": "Client IP", "密钥": "Key", "流量": "Traffic",
  "按 24 个时间桶统计；无记录的空桶为 0。": "Binned into 24 time buckets; empty buckets read 0.",
  "请求": "Requests", "词元": "Tokens", "缓存": "Cached", "时间": "Time",
  "供应商 / 模型": "Provider / model", "完成": "Done",
  "最近 100 条，新的在上；点开一行看错误摘要。": "Latest 100, newest first; click a row for the error summary.",
  "这个范围内还没有请求。": "No requests in this range.",
  "默认密钥": "Default key", "无密钥": "No key", "API 密钥": "API key",
  "停用": "Disable", "重置": "Reset",
  "流式": "Streaming", "非流式": "Non-streaming",
  "次请求": "calls", "平均": "Avg", "最近": "Last", "天": "days", "全部": "All",
  "统计已更新。": "Stats updated.",
  "还没有流量记录。发起一次推理后再刷新统计。": "No traffic yet. Run one inference, then refresh.",
  "这个范围内没有可分组的数据。": "No groupable data in this range.",
  "添加下游 key": "Add downstream key", "标签（可选）": "Label (optional)",
  "输入新的 API key": "Enter a new API key", "例如：laptop、ci": "e.g. laptop, ci",
  "添加 key": "Add key", "删除全部": "Delete all", "改名": "Rename", "删除": "Delete",
  "环境变量": "Env var", "当前 key：": "Current key: ",
  "当前未设置 key：启用后仅接受已登记的 Bearer。": "No key set: once enabled, only registered Bearer keys are accepted.",
  "尚未添加入口 key。": "No downstream keys yet.",
  "API key 已添加，立即生效。": "API key added and active immediately.",
  "标签已更新。": "Label updated.", "key 已停用。": "Key disabled.",
  "key 已启用。": "Key enabled.", "key 已删除。": "Key deleted.",
  "本机保存的 API key 已全部删除。": "All API keys saved on this machine were deleted.",
  "连续成功": "Success streak", "模型冷却": "Model cooldowns",
  "冷却原因": "Cooldown reason", "剩余": "Remaining",
});

let panelLang = "id";
let currentView = "overview";
const langRecords = [];

function readLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "zh" || saved === "id" || saved === "en") return saved;
  } catch (err) {}
  return "id";
}

function langDict() {
  const base = panelLang === "id" ? I18N.id : panelLang === "en" ? I18N.en : null;
  if (!base) return null;
  const patch = I18N.patch && I18N.patch[panelLang];
  return patch ? { ...base, ...patch } : base;
}

function tr(text) {
  const dict = langDict();
  return dict && dict[text] ? dict[text] : text;
}

function translatePattern(text) {
  const id = panelLang === "id";
  let m;
  if ((m = text.match(/^共 (\\d+) 个 key。$/))) return id ? "Total " + m[1] + " key." : m[1] + " keys.";
  if ((m = text.match(/^当前 key：(.*)。$/))) return (id ? "Key saat ini: " : "Current key: ") + m[1] + ".";
  if ((m = text.match(/^本地运维面板 · (v.+)$/))) return (id ? "Panel operasional lokal · " : "Local ops panel · ") + m[1];
  if ((m = text.match(/^(\\d+) 个模型$/))) return id ? m[1] + " model" : m[1] + " models";
  if ((m = text.match(/^(\\d+) 成功 · (\\d+) 失败$/))) return id ? m[1] + " sukses · " + m[2] + " gagal" : m[1] + " OK · " + m[2] + " fail";
  if ((m = text.match(/^已改为每 (\\d+) 秒刷新 \\/health。$/))) return id ? "Interval /health diubah ke " + m[1] + " detik." : "Changed /health refresh to every " + m[1] + " s.";
  if ((m = text.match(/^范围：最近 (\\d+) 天。$/))) return id ? "Rentang: " + m[1] + " hari terakhir." : "Range: last " + m[1] + " days.";
  if (text === "范围：全部历史。") return id ? "Rentang: semua riwayat." : "Range: all history.";
  if ((m = text.match(/^最近 (\\d+) 条请求。$/))) return id ? m[1] + " permintaan terakhir." : "Last " + m[1] + " requests.";
  if ((m = text.match(/^(\\d+) 条冷却中，共 (\\d+) 条$/))) return id ? m[1] + " dalam cooldown, total " + m[2] : m[1] + " cooling down, " + m[2] + " total";
  if ((m = text.match(/^全部就绪，共 (\\d+) 条$/))) return id ? "Semua siap, total " + m[1] : "All ready, " + m[1] + " total";
  if (text === "尚未配置代理池") return id ? "Pool belum dikonfigurasi" : "No proxy pool configured";
  if ((m = text.match(/^(\\d+) \\/ (\\d+) 就绪 · (.+)$/))) {
    const strategy = { "轮询": id ? "round-robin" : "round-robin", "故障转移": "failover", "加权随机": id ? "acak berbobot" : "weighted random" }[m[3]] || m[3];
    return id ? m[1] + " / " + m[2] + " siap · " + strategy : m[1] + " / " + m[2] + " ready · " + strategy;
  }
  if (text === "已开启（/v1/* 需 Bearer）") return id ? "Aktif (Bearer untuk /v1/*)" : "Enabled (Bearer required for /v1/*)";
  if (text === "未开启（任意非空 key）") return id ? "Nonaktif (key apa pun tidak kosong)" : "Disabled (any non-empty key)";
  if ((m = text.match(/^(\\d+) 毫秒$/))) return id ? m[1] + " md" : m[1] + " ms";
  if ((m = text.match(/^(\\d+) 个$/))) return id ? m[1] + " model" : m[1] + " models";
  if ((m = text.match(/^冷却 (\\d+) 毫秒$/))) return id ? "Cooldown " + m[1] + " md" : "Cooldown " + m[1] + " ms";
  if ((m = text.match(/^读取失败：(.*)$/))) return (id ? "Gagal membaca: " : "Failed to read: ") + m[1];
  if ((m = text.match(/^(.*) 已复制。$/))) return id ? m[1] + " tersalin." : m[1] + " copied.";
  if ((m = text.match(/^加载状态失败：(.*)$/))) return (id ? "Gagal memuat status: " : "Failed to load status: ") + m[1];
  if ((m = text.match(/^加载统计失败：(.*)$/))) return (id ? "Gagal memuat statistik: " : "Failed to load stats: ") + m[1];
  if ((m = text.match(/^读取 WARP 状态失败：(.*)$/))) return (id ? "Gagal membaca status WARP: " : "Failed to read WARP status: ") + m[1];
  if ((m = text.match(/^加载历史失败：(.*)$/))) return (id ? "Gagal memuat riwayat: " : "Failed to load history: ") + m[1];
  if ((m = text.match(/^请求失败：(.*)$/))) return (id ? "Permintaan gagal: " : "Request failed: ") + m[1];
  if ((m = text.match(/^正在测试 (\\d+) 个代理 …$/))) return (id ? "Menguji " + m[1] + " proxy …" : "Testing " + m[1] + " proxies …");
  if ((m = text.match(/^正在测试 (.*) …$/))) return (id ? "Menguji " + m[1] + " …" : "Testing " + m[1] + " …");
  if ((m = text.match(/^代理连通上游（HTTP (\\d+)），耗时 (\\d+) 毫秒。$/))) return id ? "Proxy mencapai upstream (HTTP " + m[1] + ") dalam " + m[2] + " md." : "Proxy reached upstream (HTTP " + m[1] + ") in " + m[2] + " ms.";
  if ((m = text.match(/^出口 IP：(.*)$/))) return "Exit IP: " + m[1];
  if ((m = text.match(/^出口 IP 读取失败：(.*)$/))) return id ? "Gagal membaca exit IP: " + m[1] : "Failed to read exit IP: " + m[1];
  if ((m = text.match(/^(.*) 正常，(\\d+) 毫秒，出口 IP (.*)$/))) return id ? m[1] + " normal, " + m[2] + " md, IP keluar " + m[3] : m[1] + " OK, " + m[2] + " ms, exit IP " + m[3];
  if ((m = text.match(/^(.*) 正常，(\\d+) 毫秒$/))) return id ? m[1] + " normal, " + m[2] + " md" : m[1] + " OK, " + m[2] + " ms";
  if ((m = text.match(/^约 (\\d+) 秒后恢复 · 失败 (\\d+) 次 · (.+)$/))) return id ? "Pulih ~" + m[1] + " dtk · gagal " + m[2] + "× · " + m[3] : "~" + m[1] + " s to recover · " + m[2] + " failures · " + m[3];
  if ((m = text.match(/^约 (\\d+) 秒后恢复$/))) return id ? "Pulih ~" + m[1] + " dtk" : "~" + m[1] + " s to recover";
  if ((m = text.match(/^代理池已启用：(\\d+)\\/(\\d+) 条，策略 (.+)。$/))) return id ? "Pool aktif: " + m[1] + "/" + m[2] + " entri, strategi " + m[3] + "." : "Pool enabled: " + m[1] + "/" + m[2] + " entries, strategy " + m[3] + ".";
  if ((m = text.match(/^HTTP (\\d+) · (\\d+) 毫秒 · 模型 (.+)$/))) return id ? "HTTP " + m[1] + " · " + m[2] + " md · model " + m[3] : "HTTP " + m[1] + " · " + m[2] + " ms · model " + m[3];
  if ((m = text.match(/^词元：输入 (.*) · 输出 (.*)$/))) return id ? "Token: input " + m[1] + " · output " + m[2] : "Tokens: input " + m[1] + " · output " + m[2];
  if ((m = text.match(/^(\\d+) 就绪 · (\\d+) 启用 · (\\d+) 总计$/))) return id ? m[1] + " siap · " + m[2] + " aktif · " + m[3] + " total" : m[1] + " ready · " + m[2] + " enabled · " + m[3] + " total";
  if ((m = text.match(/^失败 (\\d+) 次 · (.*)$/))) return (id ? "Gagal " : "Failed ") + m[1] + "× · " + m[2];
  if ((m = text.match(/^失败 (\\d+) 次$/))) return (id ? "Gagal " : "Failed ") + m[1] + "×";
  if ((m = text.match(/^当前 key：(.*)（来源：(.*)）$/))) {
    const source = m[2] === "环境变量" ? (id ? "variabel lingkungan" : "environment variable") : id ? "berkas lokal" : "local file";
    return (id ? "Key saat ini: " : "Current key: ") + m[1] + " (" + (id ? "sumber: " : "source: ") + source + ")";
  }
  if ((m = text.match(/^密码(已设置|未设置（面板不需登录）)。保存到本机 (.*)，权限 0600，改密码后旧会话立即失效。$/))) {
    const state = m[1] === "已设置" ? (id ? "sudah diatur" : "set") : id ? "belum diatur (panel tanpa login)" : "not set (panel has no login)";
    return id
      ? "Kata sandi " + state + ". Disimpan di " + m[2] + " lokal dengan izin 0600; sesi lama langsung berakhir saat kata sandi diganti."
      : "Password " + state + ". Saved to local " + m[2] + " with mode 0600; existing sessions end immediately after a change.";
  }
  if ((m = text.match(/^([\\d.]+)% 的输入$/))) return id ? m[1] + "% dari input" : m[1] + "% of input";
  if ((m = text.match(/^权重 (.*)$/))) return (id ? "Bobot " : "Weight ") + m[1];
  if (text === "无条目") return id ? "Tidak ada entri" : "No entries";
  if ((m = text.match(/^配置保存在 (.*)$/))) return (id ? "Konfigurasi tersimpan di " : "Config saved at ") + m[1];
  if ((m = text.match(/^保存到 (.*)$/))) return (id ? "Disimpan di " : "Saved to ") + m[1];
  if ((m = text.match(/^([\\d.]+) 秒$/))) return m[1] + (id ? " detik" : " s");
  if ((m = text.match(/^冷却至 (.*)$/))) return (id ? "Cooldown sampai " : "Cooling until ") + m[1];
  if ((m = text.match(/^最近拒绝：(.*)$/))) return (id ? "Penolakan terbaru: " : "Latest refusal: ") + m[1];
  return null;
}

function translateTextNode(node, dict) {
  const parent = node.parentElement;
  if (parent && (parent.tagName === "SCRIPT" || parent.tagName === "STYLE")) return;
  const value = node.textContent;
  const key = value.trim();
  if (!key) return;
  const target = dict[key] || translatePattern(key);
  if (!target || target === key) return;
  const lead = value.slice(0, value.indexOf(key));
  const trail = value.slice(value.indexOf(key) + key.length);
  const translated = lead + target + trail;
  if (node.textContent === translated) return;
  langRecords.push({ node, attr: null, original: value, applied: translated });
  node.textContent = translated;
}

function translateAttrs(el, dict) {
  for (const attr of ["placeholder", "aria-label", "title"]) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const target = dict[value.trim()];
    if (!target || target === value) continue;
    langRecords.push({ node: el, attr, original: value, applied: target });
    el.setAttribute(attr, target);
  }
}

function translateRoot(root, dict) {
  if (root.nodeType === 3) {
    translateTextNode(root, dict);
    return;
  }
  if (root.nodeType !== 1) return;
  if (root.tagName === "SCRIPT" || root.tagName === "STYLE") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) translateTextNode(walker.currentNode, dict);
  translateAttrs(root, dict);
  root.querySelectorAll("*").forEach((el) => translateAttrs(el, dict));
}

function restoreLang() {
  for (const rec of langRecords) {
    if (!rec.node.isConnected) continue;
    if (rec.attr) rec.node.setAttribute(rec.attr, rec.original);
    else rec.node.textContent = rec.original;
  }
  langRecords.length = 0;
}

function applyLang(lang) {
  if (lang !== "zh" && lang !== "id" && lang !== "en") lang = "id";
  restoreLang();
  panelLang = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch (err) {}
  document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
  const dict = langDict();
  if (dict) translateRoot(document.body, dict);
  $$("[data-lang]").forEach((btn) => btn.setAttribute("aria-pressed", btn.dataset.lang === lang ? "true" : "false"));
  $("crumb").textContent = tr(VIEWS[currentView]);
  document.title = tr(VIEWS[currentView]) + " · Fucking Opencode";
  // 动态渲染的区块（用量页）需要按新语言重建文字。
  document.dispatchEvent(new CustomEvent("panel-lang", { detail: lang }));
}

const langObserver = new MutationObserver((mutations) => {
  if (panelLang === "zh") return;
  const dict = langDict();
  for (const mutation of mutations) {
    if (mutation.type === "characterData") {
      translateTextNode(mutation.target, dict);
    } else {
      mutation.addedNodes.forEach((node) => translateRoot(node, dict));
    }
  }
});

$$("[data-lang]").forEach((btn) => btn.addEventListener("click", () => applyLang(btn.dataset.lang)));

const logoutBtn = $("logout");
logoutBtn.addEventListener("click", async () => {
  logoutBtn.disabled = true;
  try { await fetch("/api/logout", { method: "POST" }); } catch (err) {}
  location.reload();
});


function setText(sel, text) {
  $$(sel).forEach((el) => { el.textContent = text; });
}

function line(text, cls) {
  const p = document.createElement("p");
  p.className = "line" + (cls ? " " + cls : "");
  p.textContent = text;
  return p;
}

function showReport(box, nodes) {
  box.replaceChildren(...nodes);
  box.hidden = false;
}

function setEmpty(box, title, text) {
  const strong = document.createElement("strong");
  strong.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  box.replaceChildren(strong, p);
  box.hidden = false;
}

function go(view, opts) {
  const options = opts || {};
  if (!VIEWS[view]) view = "overview";
  currentView = view;
  $$(".view").forEach((el) => el.classList.toggle("is-active", el.dataset.view === view));
  $$(".nav-item[data-go]").forEach((btn) => {
    if (btn.dataset.go === view) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  $("crumb").textContent = tr(VIEWS[view]);
  document.title = tr(VIEWS[view]) + " · Fucking Opencode";
  if (view === "overview") loadOverviewMetrics();
  else if (view === "health") loadHealthView();
  else if (view === "diag") 载入路由诊断();
  else if (view === "events") 载入事件流();
  else if (view === "stats") {
    const btn = $("stats-load");
    if (btn) btn.click();
  }
  else if (view === "egress") 载入WARP();
  else if (view === "docs") loadDocs();
  else if (view === "playground") loadPlayground();
  else if (view === "settings") loadSettings();
  if (options.hash !== false && location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  closePalette();
  closeNav();
  if (options.scroll !== false) window.scrollTo(0, 0);
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-go]");
  if (target) go(target.dataset.go);
});

window.addEventListener("hashchange", () => {
  const view = location.hash.replace("#", "");
  go(VIEWS[view] ? view : "overview", { hash: false, scroll: false });
});

const app = $("app");
const navToggle = $("sidebar-toggle");
const narrow = window.matchMedia("(max-width: 860px)");

function closeNav() {
  app.classList.remove("nav-open");
  navToggle.setAttribute("aria-expanded", narrow.matches ? "false" : "true");
}

navToggle.addEventListener("click", () => {
  if (narrow.matches) {
    const open = app.classList.toggle("nav-open");
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
  } else {
    const collapsed = app.classList.toggle("is-collapsed");
    navToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
});

$("nav-backdrop").addEventListener("click", closeNav);

const themeBtn = $("theme-toggle");

function effectiveDark() {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function themeLabel() {
  return effectiveDark() ? "切换到浅色主题" : "切换到深色主题";
}

try {
  const saved = localStorage.getItem("gateway-panel-theme");
  if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
} catch (err) {}

themeBtn.setAttribute("aria-label", themeLabel());
themeBtn.title = themeLabel();
themeBtn.addEventListener("click", () => {
  const next = effectiveDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("gateway-panel-theme", next); } catch (err) {}
  themeBtn.setAttribute("aria-label", themeLabel());
  themeBtn.title = themeLabel();
});
const palette = $("palette");
const paletteInput = $("palette-input");
const paletteList = $("palette-list");

function navButtons() {
  return $$(".nav-item[data-go]");
}

function renderPalette(query) {
  const q = query.trim().toLowerCase();
  const matches = navButtons().filter((btn) => {
    if (!q) return true;
    return btn.textContent.trim().toLowerCase().includes(q) || btn.dataset.go.includes(q);
  });
  const nodes = matches.map((btn, index) => {
    const li = document.createElement("li");
    li.className = "palette-item" + (index === 0 ? " is-active" : "");
    li.setAttribute("role", "option");
    li.textContent = btn.textContent.trim();
    li.dataset.go = btn.dataset.go;
    return li;
  });
  if (!nodes.length) {
    const li = document.createElement("li");
    li.className = "palette-empty";
    li.textContent = "没有匹配的区块。";
    nodes.push(li);
  }
  paletteList.replaceChildren(...nodes);
}

function openPalette() {
  palette.hidden = false;
  paletteInput.value = "";
  renderPalette("");
  paletteInput.focus();
}

function closePalette() {
  palette.hidden = true;
}

const paletteOpenBtn = $("palette-open");
if (paletteOpenBtn) paletteOpenBtn.addEventListener("click", openPalette);
$("palette-close").addEventListener("click", closePalette);
$("palette-backdrop").addEventListener("click", closePalette);
paletteInput.addEventListener("input", () => renderPalette(paletteInput.value));

paletteInput.addEventListener("keydown", (event) => {
  const items = $$("#palette-list .palette-item");
  const index = items.findIndex((el) => el.classList.contains("is-active"));
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const next = items[Math.min(index + 1, items.length - 1)];
    items.forEach((el) => el.classList.remove("is-active"));
    if (next) next.classList.add("is-active");
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const prev = items[Math.max(index - 1, 0)];
    items.forEach((el) => el.classList.remove("is-active"));
    if (prev) prev.classList.add("is-active");
  } else if (event.key === "Enter") {
    event.preventDefault();
    const pick = items.find((el) => el.classList.contains("is-active")) || items[0];
    if (pick && pick.dataset.go) go(pick.dataset.go);
  }
});

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "k") {
    event.preventDefault();
    if (palette.hidden) openPalette();
    else closePalette();
    return;
  }
  if (event.key === "Escape") {
    if (!palette.hidden) closePalette();
    else if (app.classList.contains("nav-open")) closeNav();
  }
});
const urlInput = $("proxy-url");
const saveBtn = $("save");
const testBtn = $("test");
const directBtn = $("direct");
const report = $("report");
const form = $("form");

let locked = false;

function setBusy(busy) {
  saveBtn.disabled = busy || locked;
  directBtn.disabled = busy || locked;
  testBtn.disabled = busy;
  const poolSave = $("pool-save");
  const poolClear = $("pool-clear");
  const poolTest = $("pool-test");
  if (poolSave) poolSave.disabled = busy || locked;
  if (poolClear) poolClear.disabled = busy || locked;
  if (poolTest) poolTest.disabled = busy;
}

const STRATEGY_LABELS = { "round-robin": "轮询", failover: "故障转移", random: "加权随机" };

function renderPoolFacts(pool) {
  const state = pool || {};
  const active = Boolean(state.active);
  $("fact-pool-ready").textContent = active ? state.ready + " / " + state.enabled : "-";
  $("fact-pool-sub").textContent = active
    ? state.cooling > 0
      ? state.cooling + " 条冷却中，共 " + state.size + " 条"
      : "全部就绪，共 " + state.size + " 条"
    : "尚未配置代理池";
  $("fact-strategy").textContent = active ? STRATEGY_LABELS[state.strategy] || state.strategy : "未启用";
  $("pool-count").textContent = active
    ? state.ready + " 就绪 · " + state.enabled + " 启用 · " + state.size + " 总计"
    : "无条目";
  const badge = $("nav-pool-badge");
  if (active) {
    badge.hidden = false;
    badge.textContent = state.ready + "/" + state.enabled;
  } else {
    badge.hidden = true;
  }
}

function renderPoolList(pool) {
  const list = $("pool-list");
  const state = pool || {};
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const empty = $("pool-empty");

  if (!state.active || entries.length === 0) {
    list.hidden = true;
    list.replaceChildren();
    setEmpty(empty, "代理池未启用", "在上方填写并保存至少一条代理后，这里会显示健康状态与冷却倒计时。");
    return;
  }
  empty.hidden = true;

  list.replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.label || entry.id;

      const addr = document.createElement("span");
      addr.className = "addr";
      addr.textContent = entry.host || "?";

      const badge = document.createElement("span");
      badge.className = "state";
      badge.dataset.state = entry.state;
      badge.textContent = entry.state === "ready" ? "就绪" : entry.state === "cooling" ? "冷却中" : "已停用";

      li.append(name, addr, badge);

      // 单条目操作：启用/停用、探测、清冷却。URL 不出网关，动作走服务端。
      const ops = document.createElement("span");
      ops.className = "ops";
      const mkBtn = (action, label, cls) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bw-btn" + (cls ? " " + cls : "");
        b.dataset.poolAction = action;
        b.dataset.poolId = entry.id;
        b.textContent = label;
        return b;
      };
      ops.append(
        mkBtn("test", "测试"),
        mkBtn("toggle", entry.enabled ? "停用" : "启用"),
      );
      ops.append(mkBtn("clearcool", "重置"));
      li.append(ops);

      const bits = [];
      if (entry.state === "cooling" && entry.cooldownMsLeft) {
        bits.push("约 " + Math.ceil(entry.cooldownMsLeft / 1000) + " 秒后恢复");
      }
      if (entry.failures) bits.push("失败 " + entry.failures + " 次");
      if (entry.lastError) bits.push(entry.lastError);
      if (entry.weight !== 1) bits.push("权重 " + entry.weight);
      if (bits.length) {
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = bits.join(" · ");
        li.append(detail);
      }

      return li;
    })
  );
  list.hidden = false;
}

// 池条目动作（事件委托在列表上；动作在服务端完成，结果整池刷新）。
$("pool-list").addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-pool-action]");
  if (!btn) return;
  event.preventDefault();
  const action = btn.dataset.poolAction, id = btn.dataset.poolId;
  btn.disabled = true;
  try {
    if (action === "test") {
      const result = await send("/api/proxy/test", { testId: id });
      showReport($("pool-report"), [
        result.ok
          ? line((result.label || result.id) + " 正常，" + result.latencyMs + " 毫秒，出口 IP " + (result.exitIp || tr("读取失败")), "ok")
          : line((result.label || result.id) + " " + (result.error || tr("失败")), "bad"),
      ]);
    } else if (action === "toggle") {
      const state = await send("/api/proxy", { toggle: id });
      renderStatus(state);
      showReport($("pool-report"), [line("条目已切换。", "ok")]);
    } else if (action === "clearcool") {
      const state = await send("/api/proxy", { coolClear: id });
      renderStatus(state);
      showReport($("pool-report"), [line("条目已重置。", "ok")]);
    }
  } catch (err) {
    showReport($("pool-report"), [line(err.message, "bad")]);
  } finally {
    btn.disabled = false;
  }
});

function renderStatus(state) {
  const label = state.mode === "pool" ? "代理池已启用" : state.mode === "proxy" ? "经代理" : "直连（本机 IP）";
  setText(".js-mode", label);
  $$(".js-mode-dot").forEach((dot) => {
    dot.dataset.state = state.mode === "direct" ? "idle" : "ok";
  });
  setText(".js-host", state.proxy || "未设置代理");

  const notes = [];
  if (state.locked) notes.push("已被环境变量锁定（" + state.source + "）：请修改环境变量后重启服务。");
  if (state.hasCredentials) notes.push("已保存代理凭据（绝不显示）。");
  if (state.source === "file") notes.push("配置保存在 " + state.configPath);
  if (state.error) notes.push(state.error);
  $("note").textContent = notes.join(" ");
  $("note").hidden = notes.length === 0;

  renderPoolFacts(state.pool);
  renderPoolList(state.pool);
}

function readPoolInput() {
  return $("pool-entries")
    .value.split("\\n")
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const eq = row.indexOf("=");
      if (eq > 0 && !row.slice(0, eq).includes("/")) {
        return { label: row.slice(0, eq).trim(), url: row.slice(eq + 1).trim() };
      }
      return { url: row };
    });
}

function poolEntriesToText(pool) {
  const entries = Array.isArray(pool && pool.entries) ? pool.entries : [];
  return entries
    .map((entry) => (entry.label && entry.label !== entry.id ? entry.label + "=" : "") + (entry.host || ""))
    .join("\\n");
}

async function readJson(res) {
  if (res.status === 401 && /\\/api\\//.test(res.url || "")) {
    // 面板会话失效（例如服务重启），回到登录页而不是显示原始 401。
    location.replace("/");
    throw new Error("Panel login required.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

async function load() {
  try {
    const state = await readJson(await fetch("/api/proxy"));
    renderStatus(state);

    const poolState = state.pool || {};
    $("pool-entries").value = poolEntriesToText(poolState);
    $("pool-strategy").value = poolState.strategy || "round-robin";

    locked = state.locked;
    saveBtn.disabled = locked;
    directBtn.disabled = locked;
    $("pool-save").disabled = locked;
    $("pool-clear").disabled = locked;
  } catch (err) {
    showReport(report, [line("加载状态失败：" + err.message, "bad")]);
  }
}

async function send(path, payload) {
  setBusy(true);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await readJson(res);
  } finally {
    setBusy(false);
  }
}

async function save() {
  try {
    const state = await send("/api/proxy", { url: urlInput.value });
    renderStatus(state);
    urlInput.value = "";
    showReport(report, [line(state.mode === "proxy" ? "代理已启用。下一个请求就走这个出口。" : "代理已关闭。出口回到直连。", "ok")]);
  } catch (err) {
    showReport(report, [line(err.message, "bad")]);
  }
}

saveBtn.addEventListener("click", save);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  save();
});

testBtn.addEventListener("click", async () => {
  const target = urlInput.value.trim();
  if (!target) {
    showReport(report, [line("先填入要测试的代理 URL。", "bad")]);
    return;
  }
  showReport(report, [line("正在测试 " + target + " …")]);
  try {
    const result = await send("/api/proxy/test", { url: target });
    const nodes = [];
    if (result.ok) {
      nodes.push(line("代理连通上游（HTTP " + result.apiStatus + "），耗时 " + result.latencyMs + " 毫秒。", "ok"));
      if (result.exitIp) nodes.push(line("出口 IP：" + result.exitIp, "mono"));
      else nodes.push(line("出口 IP 读取失败：" + (result.exitError || "原因未知"), "bad"));
    } else {
      nodes.push(line(result.error || "代理测试失败。", "bad"));
      if (result.exitIp) nodes.push(line("出口 IP：" + result.exitIp, "mono"));
    }
    showReport(report, nodes);
  } catch (err) {
    showReport(report, [line(err.message, "bad")]);
  }
});

directBtn.addEventListener("click", async () => {
  try {
    const state = await send("/api/proxy", { url: "" });
    renderStatus(state);
    urlInput.value = "";
    showReport(report, [line("代理已关闭。出口回到直连，使用本机 IP。", "ok")]);
  } catch (err) {
    showReport(report, [line(err.message, "bad")]);
  }
});

let warpBusy = false;

function 渲染WARP(state) {
  const meta = $("warp-meta");
  if (!meta) return;
  const 未启用 = state && state.enabled === false;
  const 不可用 = state && state.available === false;
  let 文案 = "不可用";
  if (未启用) 文案 = "未启用";
  else if (不可用) 文案 = "未安装 warp-cli";
  else if (state.connecting) 文案 = "连接中";
  else if (state.connected) 文案 = "已连接";
  else 文案 = "已断开";
  meta.textContent = state && state.version ? tr(文案) + " · " + state.version : tr(文案);
  const connect = $("warp-connect");
  const disconnect = $("warp-disconnect");
  const 可操作 = Boolean(state && state.enabled && state.available) && !warpBusy;
  connect.disabled = !可操作 || Boolean(state.connected);
  disconnect.disabled = !可操作 || !state.connected;
}

async function 载入WARP() {
  const meta = $("warp-meta");
  if (!meta) return;
  try {
    渲染WARP(await readJson(await fetch("/api/warp")));
  } catch (err) {
    meta.textContent = tr("读取失败");
    showReport($("warp-report"), [line("读取 WARP 状态失败：" + err.message, "bad")]);
  }
}

async function WARP动作(action) {
  if (warpBusy) return;
  warpBusy = true;
  $("warp-connect").disabled = true;
  $("warp-disconnect").disabled = true;
  showReport($("warp-report"), [line(action === "connect" ? "正在连接 WARP…" : "正在断开 WARP…")]);
  try {
    const result = await send("/api/warp", { action });
    if (result.status) 渲染WARP(result.status);
    const 提示 = result.ok
      ? (action === "connect" ? "WARP 已连接。" : "WARP 已断开。")
      : (result.error || "WARP 操作失败。");
    showReport($("warp-report"), [line(提示, result.ok ? "ok" : "bad")]);
    if (!result.ok) await 载入WARP();
  } catch (err) {
    showReport($("warp-report"), [line(err.message, "bad")]);
    await 载入WARP();
  } finally {
    warpBusy = false;
  }
}

$("warp-connect").addEventListener("click", () => WARP动作("connect"));
$("warp-disconnect").addEventListener("click", () => WARP动作("disconnect"));
$("warp-refresh").addEventListener("click", 载入WARP);

$("pool-save").addEventListener("click", async () => {
  const entries = readPoolInput();
  if (entries.length === 0) {
    showReport($("pool-report"), [line("至少填一个代理。", "bad")]);
    return;
  }
  try {
    const state = await send("/api/proxy", {
      entries,
      strategy: $("pool-strategy").value,
    });
    renderStatus(state);
    showReport($("pool-report"), [
      line("代理池已启用：" + state.pool.enabled + "/" + state.pool.size + " 条，策略 " + (STRATEGY_LABELS[state.pool.strategy] || state.pool.strategy) + "。", "ok"),
    ]);
  } catch (err) {
    showReport($("pool-report"), [line(err.message, "bad")]);
  }
});

$("pool-test").addEventListener("click", async () => {
  const entries = readPoolInput();
  if (entries.length === 0) {
    showReport($("pool-report"), [line("至少填一个要测试的代理。", "bad")]);
    return;
  }
  showReport($("pool-report"), [line("正在测试 " + entries.length + " 个代理 …")]);
  try {
    const result = await send("/api/proxy/test", { entries });
    const nodes = (result.entries || []).map((entry) => {
      const head = (entry.label || entry.host || entry.id) + " · ";
      if (entry.ok) {
        return line(head + "正常，" + entry.latencyMs + " 毫秒，出口 IP " + (entry.exitIp || tr("读取失败")), "ok");
      }
      return line(head + (entry.error || tr("失败")), "bad");
    });
    showReport($("pool-report"), nodes.length ? nodes : [line("没有结果。", "bad")]);
  } catch (err) {
    showReport($("pool-report"), [line(err.message, "bad")]);
  }
});

$("pool-clear").addEventListener("click", async () => {
  try {
    const state = await send("/api/proxy", { entries: [] });
    renderStatus(state);
    $("pool-entries").value = "";
    showReport($("pool-report"), [line("代理池已清空。出口回到单代理或直连。", "ok")]);
  } catch (err) {
    showReport($("pool-report"), [line(err.message, "bad")]);
  }
});

// ---- 用量统计与请求历史 ----
function fmtNum(n) {
  return (n == null ? 0 : n).toLocaleString("zh-CN");
}

function fmtMs(ms) {
  if (ms == null) return "-";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + " 秒" : ms + " 毫秒";
}

function fmtTime(at) {
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

/** 词元数字缩写：1.2M / 34.5K，图表与关键指标卡共用。 */
function fmtTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1e9) return (value / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(value));
}

function cell(text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function rangeValue(id) {
  const el = $(id);
  return el ? Number(el.value) || 0 : 0;
}

function addMetric(box, label, value) {
  const metric = document.createElement("div");
  metric.className = "metric";
  const name = document.createElement("span");
  name.className = "metric-label";
  name.textContent = label;
  const val = document.createElement("span");
  val.className = "metric-value";
  val.textContent = value;
  metric.append(name, val);
  box.append(metric);
}

/** 用量视图状态：分面维度与流量指标只影响渲染，不额外请求。 */
const 用量视图 = { 统计: null, 请求: [], 分类: "model", 流量: "requests" };

/** 密钥标签的机器值 → 面板文案；服务端只存 default / none。 */
const 密钥标签 = { default: "默认密钥", none: "无密钥" };

function 分类数据() {
  const s = 用量视图.统计 || {};
  if (用量视图.分类 === "provider") return s.providers || [];
  if (用量视图.分类 === "client") return s.clients || [];
  if (用量视图.分类 === "key") return s.keys || [];
  // 模型分组沿用旧字段名 model，统一成 key 供渲染使用。
  return (s.models || []).map((m) => ({ ...m, key: m.model }));
}

function 分类名称(行) {
  const 键 = String(行.key || "");
  if (!键 || 键 === "(未知)") return tr("未知");
  return 用量视图.分类 === "key" ? 密钥标签[键] || 键 : 键;
}

function renderUsageKpis(stats) {
  const box = $("usage-kpis");
  if (!box) return;
  const 命中率 = stats.input_tokens ? ((stats.cached_tokens / stats.input_tokens) * 100).toFixed(1) + "%" : "0.0%";
  const 客户端 = stats.client_count ? " · " + stats.client_count + " " + tr("个客户端") : "";
  const cards = [
    ["请求数", fmtNum(stats.total), stats.ok + " " + tr("成功") + " · " + stats.fail + " " + tr("失败") + 客户端],
    ["输入词元", fmtTokens(stats.input_tokens), "提示词词元"],
    ["缓存词元", fmtTokens(stats.cached_tokens), 命中率 + " " + tr("缓存命中")],
    ["输出词元", fmtTokens(stats.output_tokens), "生成的补全"],
  ];
  box.replaceChildren(
    ...cards.map(([label, value, sub]) => {
      const card = document.createElement("div");
      card.className = "usage-kpi";
      const name = document.createElement("span");
      name.className = "usage-kpi-label";
      name.textContent = label;
      const val = document.createElement("span");
      val.className = "usage-kpi-value";
      val.textContent = value;
      const note = document.createElement("span");
      note.className = "usage-kpi-sub";
      note.textContent = sub;
      card.append(name, val, note);
      return card;
    })
  );
}

/** 毫秒缩写：图表与分位行共用，单位用 ASCII 避免二次翻译。 */
function 短毫秒(ms) {
  if (ms == null) return "–";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}

/** 流量折线图：单指标切换（请求 / 词元 / 缓存），24 个时间桶。 */
function renderUsageTraffic() {
  const box = $("usage-chart");
  if (!box) return;
  const series = (用量视图.统计 && 用量视图.统计.series) || [];
  const 指标 = 用量视图.流量;
  const 取值 = (p) =>
    指标 === "requests" ? p.requests || 0 : 指标 === "cached" ? p.cached || 0 : (p.input || 0) + (p.output || 0);
  const points = series.map((p) => ({ t: p.t, v: 取值(p), raw: p }));
  if (!points.length || !points.some((p) => p.v > 0)) {
    const empty = document.createElement("div");
    empty.className = "usage-empty";
    empty.textContent = "还没有流量记录。发起一次推理后再刷新统计。";
    box.replaceChildren(empty);
    return;
  }
  const W = 480;
  const H = 240;
  const left = 46;
  const right = 10;
  const top = 12;
  const bottom = 26;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const max = Math.max(...points.map((p) => p.v), 1);
  // 请求数只画整数刻度：步长取 1/2/5×10ⁿ，避免 0.5 四舍五入出重复标签。
  const ticks = 4;
  const 步长 = (() => {
    const raw = Math.max(max / ticks, 指标 === "requests" ? 1 : max / ticks);
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  })();
  const 上界 = 步长 * ticks;
  const x = (i) => left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => top + innerH - Math.min(v / 上界, 1) * innerH;
  const base = y(0);

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("class", "usage-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "按时间桶的流量趋势");

  const label = (v) => (指标 === "requests" ? fmtNum(Math.round(v)) : fmtTokens(Math.round(v)));
  for (let i = 0; i <= ticks; i += 1) {
    const value = 步长 * i;
    const gy = y(value);
    const lineEl = document.createElementNS(ns, "line");
    lineEl.setAttribute("x1", left);
    lineEl.setAttribute("x2", W - right);
    lineEl.setAttribute("y1", gy);
    lineEl.setAttribute("y2", gy);
    lineEl.setAttribute("class", "grid-line");
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", left - 10);
    text.setAttribute("y", gy + 3);
    text.setAttribute("text-anchor", "end");
    text.setAttribute("class", "axis-text");
    text.textContent = label(value);
    svg.append(lineEl, text);
  }

  const gap = points.length === 1 ? innerW : x(1) - x(0);
  const barW = Math.max(2, Math.min(18, gap * 0.6));
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const h = Math.max(p.v > 0 ? 2 : 1.5, base - y(p.v));
    const bar = document.createElementNS(ns, "rect");
    bar.setAttribute("x", x(i) - barW / 2);
    bar.setAttribute("y", base - h);
    bar.setAttribute("width", barW);
    bar.setAttribute("height", h);
    bar.setAttribute("rx", 1.5);
    bar.setAttribute("class", "traffic-bar");
    const title = document.createElementNS(ns, "title");
    title.textContent =
      new Date(p.t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) +
      " · " + label(p.v) + (指标 === "tokens" ? "（输入 " + fmtTokens(p.raw.input || 0) + " / 输出 " + fmtTokens(p.raw.output || 0) + "）" : "");
    bar.append(title);
    svg.append(bar);
  }
  const last = points.length - 1;

  const marks = [0, Math.floor(points.length / 2), last];
  for (const i of [...new Set(marks)]) {
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", x(i));
    text.setAttribute("y", H - 8);
    text.setAttribute("text-anchor", i === 0 ? "start" : i === last ? "end" : "middle");
    text.setAttribute("class", "axis-text");
    text.textContent = new Date(points[i].t).toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    svg.append(text);
  }
  box.replaceChildren(svg);
}

/** 分类列表：请求数排序，条长为该组占最大组的比例。 */
function renderUsageBreakdown() {
  const box = $("usage-rows");
  if (!box) return;
  const rows = 分类数据();
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "usage-row-empty";
    empty.textContent = "这个范围内没有可分组的数据。";
    box.replaceChildren(empty);
    return;
  }
  const max = Math.max(...rows.map((r) => r.requests || 0), 1);
  box.replaceChildren(
    ...rows.slice(0, 8).map((row) => {
      const li = document.createElement("li");
      li.className = "usage-row";
      li.style.setProperty("--w", ((row.requests / max) * 100).toFixed(1) + "%");
      const top = document.createElement("div");
      top.className = "usage-row-top";
      const name = document.createElement("span");
      name.className = "usage-row-name";
      name.textContent = 分类名称(row);
      const count = document.createElement("span");
      count.className = "usage-row-count";
      count.textContent = row.requests + " " + tr("次");
      top.append(name, count);
      const meta = document.createElement("div");
      meta.className = "usage-row-meta";
      const parts = [row.ok + " " + tr("成功"), tr("输出") + " " + fmtTokens(row.output_tokens)];
      if (row.requests) parts.push(tr("平均") + " " + 短毫秒(Math.round(row.total_ms / row.requests)));
      for (const text of parts) {
        const span = document.createElement("span");
        span.textContent = text;
        meta.append(span);
      }
      li.append(top, meta);
      return li;
    })
  );
}

/** 最近请求表：时间、供应商/模型、密钥、状态、词元、TPS、TTFT、完成。 */
function renderUsageRequests() {
  const table = $("usage-recent");
  if (!table) return;
  const rows = 用量视图.请求 || [];
  const tbody = table.querySelector("tbody");
  tbody.replaceChildren();
  table.hidden = rows.length === 0;
  const empty = $("usage-recent-empty");
  if (empty) empty.hidden = rows.length > 0;
  for (const row of rows) {
    const ok = row.status >= 200 && row.status < 300;
    const 行 = document.createElement("tr");
    const 模型 = document.createElement("td");
    const stack = document.createElement("div");
    stack.className = "cell-stack";
    const 供应商 = document.createElement("small");
    供应商.textContent = row.provider || "opencode";
    const 名称 = document.createElement("span");
    名称.textContent = row.model || "-";
    stack.append(供应商, 名称);
    模型.append(stack);
    const tps = row.output_tokens != null && row.ms > 0 ? (row.output_tokens / (row.ms / 1000)).toFixed(1) : "–";
    行.append(
      cell(fmtTime(row.at)),
      模型,
      cell(密钥标签[row.key_label] || "—"),
      cell((row.stream ? tr("流式") : tr("非流式")) + " " + (row.status == null ? "-" : row.status), ok ? "st-ok" : "st-bad"),
      cell("↑" + (row.input_tokens != null ? fmtNum(row.input_tokens) : "-") + " ↓" + (row.output_tokens != null ? fmtNum(row.output_tokens) : "-"), "num"),
      cell(tps, "num"),
      cell(row.ttft_ms != null ? 短毫秒(row.ttft_ms) : "–", "num"),
      cell(短毫秒(row.ms), "num")
    );
    if (row.error) {
      行.dataset.open = "0";
      行.addEventListener("click", () => {
        const next = 行.nextElementSibling;
        if (next && next.classList.contains("error-row")) {
          next.remove();
          行.dataset.open = "0";
          行.classList.remove("is-open");
          return;
        }
        const detail = document.createElement("tr");
        const td = cell(row.error);
        td.colSpan = 8;
        td.className = "st-bad error-row";
        detail.append(td);
        行.after(detail);
        行.dataset.open = "1";
        行.classList.add("is-open");
      });
    }
    tbody.append(行);
  }
  const s = 用量视图.统计 || {};
  const latency = $("usage-latency");
  if (latency) {
    latency.textContent = [
      "P50 " + 短毫秒(s.p50_ms),
      "P95 " + 短毫秒(s.p95_ms),
      "P99 " + 短毫秒(s.p99_ms),
      s.ttft_samples ? "TTFT " + 短毫秒(s.ttft_avg_ms) : "",
    ].filter(Boolean).join(" · ");
  }
}

/** 一次刷新只发两个请求：汇总与最近请求。 */
async function 载入用量() {
  const days = rangeValue("stats-days");
  const [stats, history] = await Promise.all([
    fetch("/api/stats" + (days ? "?days=" + days : "")).then(readJson),
    fetch("/api/history?limit=100" + (days ? "&days=" + days : "")).then(readJson),
  ]);
  用量视图.统计 = stats;
  用量视图.请求 = history.requests || [];
  $("stats-empty").hidden = true;
  $("stats-summary").hidden = false;
  renderUsageKpis(stats);
  renderUsageBreakdown();
  renderUsageTraffic();
  renderUsageRequests();
  渲染范围摘要(days, stats);
}

/** 副标题摘要：范围、请求数、词元与平均耗时。 */
function 渲染范围摘要(days, stats) {
  const 词元 = (stats.input_tokens || 0) + (stats.output_tokens || 0);
  const 范围 = days ? tr("最近") + " " + days + " " + tr("天") : tr("全部");
  const scope = $("stats-scope");
  if (!scope) return;
  scope.textContent = [
    范围,
    stats.total + " " + tr("次请求"),
    fmtTokens(词元) + " " + tr("词元"),
    tr("平均") + " " + 短毫秒(stats.avg_ms),
  ].join(" · ");
}

$("stats-load").addEventListener("click", async () => {
  const btn = $("stats-load");
  btn.disabled = true;
  try {
    await 载入用量();
    showReport($("stats-report"), [line("统计已更新。", "ok")]);
  } catch (err) {
    showReport($("stats-report"), [line("加载统计失败：" + err.message, "bad")]);
  } finally {
    btn.disabled = false;
  }
});

for (const btn of document.querySelectorAll("#usage-tabs button")) {
  btn.addEventListener("click", () => {
    用量视图.分类 = btn.dataset.bk;
    for (const 其他 of document.querySelectorAll("#usage-tabs button")) {
      其他.setAttribute("aria-selected", String(其他 === btn));
    }
    renderUsageBreakdown();
  });
}

for (const btn of document.querySelectorAll("#traffic-tabs button")) {
  btn.addEventListener("click", () => {
    用量视图.流量 = btn.dataset.tm;
    for (const 其他 of document.querySelectorAll("#traffic-tabs button")) {
      其他.setAttribute("aria-selected", String(其他 === btn));
    }
    renderUsageTraffic();
  });
}

// 切语言时句式文案（“33 berhasil · 0 gagal”）必须按新语言重建。
document.addEventListener("panel-lang", () => {
  const s = 用量视图.统计;
  if (!s) return;
  renderUsageKpis(s);
  renderUsageBreakdown();
  renderUsageTraffic();
  renderUsageRequests();
  渲染范围摘要(rangeValue("stats-days"), s);
});

$("stats-history").addEventListener("click", async () => {
  const btn = $("stats-history");
  btn.disabled = true;
  try {
    const days = rangeValue("history-days");
    const history = await readJson(await fetch("/api/history?limit=100" + (days ? "&days=" + days : "")));
    const rows = history.requests || [];
    const table = $("history-table");
    const tbody = table.querySelector("tbody");
    tbody.replaceChildren();
    for (const row of rows) {
      const ok = row.status >= 200 && row.status < 300;
      const tr = document.createElement("tr");
      tr.append(
        cell(fmtTime(row.at)),
        cell(row.protocol || "openai"),
        cell(row.model || "-"),
        cell(String(row.status == null ? "-" : row.status), ok ? "st-ok" : "st-bad"),
        cell(fmtMs(row.ms), "num"),
        cell(row.input_tokens != null ? fmtNum(row.input_tokens) : "-", "num"),
        cell(row.output_tokens != null ? fmtNum(row.output_tokens) : "-", "num"),
        cell(row.egress || "-")
      );
      tbody.append(tr);
      if (row.error) {
        const wrap = document.createElement("tr");
        const errTd = cell(row.error);
        errTd.colSpan = 8;
        errTd.className = "st-bad error-row";
        wrap.append(errTd);
        tbody.append(wrap);
      }
    }
    table.hidden = rows.length === 0;
    if (!rows.length) {
      setEmpty($("history-empty"), "还没有记录", "跑一次推理请求后按「最近请求」刷新。");
    } else {
      $("history-empty").hidden = true;
    }
    showReport($("history-report"), [line(rows.length ? "最近 " + rows.length + " 条请求。" : "没有记录。")]);
  } catch (err) {
    showReport($("history-report"), [line("加载历史失败：" + err.message, "bad")]);
  } finally {
    btn.disabled = false;
  }
});

$("stats-clear").addEventListener("click", async () => {
  if (!confirm("确定清空全部本地用量历史？此操作不可撤销。")) return;
  try {
    const res = await fetch("/api/history/clear", { method: "POST" });
    await readJson(res);
    $("stats-summary").hidden = true;
    $("usage-kpis").replaceChildren();
    $("usage-rows").replaceChildren();
    $("usage-chart").replaceChildren();
    const recent = $("usage-recent");
    recent.hidden = true;
    recent.querySelector("tbody").replaceChildren();
    $("usage-recent-empty").hidden = true;
    用量视图.统计 = null;
    用量视图.请求 = [];
    setEmpty($("stats-empty"), "历史已清空", "跑一次请求后再按「刷新统计」。");
    showReport($("stats-report"), [line("历史已清空。", "ok")]);

    const table = $("history-table");
    table.hidden = true;
    table.querySelector("tbody").replaceChildren();
    setEmpty($("history-empty"), "历史已清空", "跑一次请求后按「最近请求」刷新。");
  } catch (err) {
    showReport($("stats-report"), [line(err.message, "bad")]);
  }
});

for (const id of ["stats-days", "history-days"]) {
  const el = $(id);
  if (!el) continue;
  el.addEventListener("change", () => {
    for (const other of ["stats-days", "history-days"]) {
      const node = $(other);
      if (node && node !== el) node.value = el.value;
    }
  });
}


// ---- 路由诊断 与 事件流 ----
// 全部数据来自本机：/api/proxy（池健康）、/api/history（请求历史）、
// /api/stats（按模型汇总）、/api/events（进程日志环）。不虚构任何数字。
// 说明：CSS 类名保留 ASCII——它们要进 querySelector 与 DOM API，混排
// 容易在转义上出错；JavaScript 标识符按要求用中文。

const 事件流状态 = { 最后序号: 0, 暂停: false, 计时器: 0, 首屏已载: false };

/** 把上游/传输错误归类成面板可读的标签；空文本返回 null（健康）。 */
function 分类错误(文本) {
  const s = String(文本 || "");
  if (s.includes("429")) return ["429 限流", "bad"];
  if (s.includes("426")) return ["426 网关", "warn"];
  if (s.includes("403")) return ["403 拒绝", "bad"];
  if (s) return ["传输错误", "warn"];
  return null;
}

async function 载入路由诊断() {
  const 容器 = $("diag-egress");
  if (!容器) return;
  let 池 = null, 历史 = null, 诊断 = null;
  try {
    [池, 历史, 诊断] = await Promise.all([
      readJson(await fetch("/api/proxy")),
      readJson(await fetch("/api/history?limit=500")).catch(() => null),
      readJson(await fetch("/api/diagnostics?hours=24")).catch(() => null),
    ]);
  } catch (err) {
    showReport($("diag-report"), [line("读取失败：" + err.message, "bad")]);
    return;
  }

  // 表一：出口健康（代理池条目 + 内置直连一行）。
  const 条目 = (池 && 池.pool && 池.pool.entries) || [];
  const 表体 = 容器.querySelector("tbody");
  表体.replaceChildren();
  if (!条目.length) {
    const baris = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "diag-empty";
    td.textContent = tr("出口池未启用");
    baris.append(td);
    表体.append(baris);
  } else {
    for (const e of 条目) {
      const baris = document.createElement("tr");
      const tdName = document.createElement("td");
      tdName.textContent = (e.label || e.id) + (e.enabled ? "" : "（已停用）");
      const tdState = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "diag-tag";
      badge.dataset.state = e.state;
      badge.dataset.tone = e.state === "ready" ? "ok" : e.state === "cooling" ? "warn" : "";
      badge.textContent = e.state === "ready" ? tr("就绪") : e.state === "cooling" ? tr("冷却中") : tr("已停用");
      tdState.append(badge);
      const tdFail = document.createElement("td");
      tdFail.className = "mono";
      tdFail.textContent = String(e.failures || 0);
      const tdKind = document.createElement("td");
      const kind = 分类错误(e.lastError);
      if (kind) {
        const tag = document.createElement("span");
        tag.className = "diag-tag";
        tag.dataset.tone = kind[1];
        tag.textContent = tr(kind[0]);
        tdKind.append(tag);
      } else tdKind.textContent = "-";
      const tdCool = document.createElement("td");
      tdCool.className = "mono";
      tdCool.textContent = e.state === "cooling" && e.cooldownMsLeft ? Math.ceil(e.cooldownMsLeft / 1000) + "s" : "-";
      const tdOk = document.createElement("td");
      tdOk.className = "mono";
      tdOk.textContent = e.lastOkAt ? new Date(e.lastOkAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "-";
      const tdErr = document.createElement("td");
      tdErr.className = "mono";
      tdErr.textContent = e.lastError ? String(e.lastError).slice(0, 70) : "-";
      baris.append(tdName, tdState, tdFail, tdKind, tdCool, tdOk, tdErr);
      表体.append(baris);
    }
  }
  $("diag-pool-meta").textContent = 条目.length ? 条目.filter((e) => e.enabled).length + "/" + 条目.length + " " + tr("就绪") : "-";

  // 表二：按出口统计（最近 500 条历史按 egress 聚合）。
  const 行 = (历史 && 历史.requests) || [];
  const 按出口 = new Map();
  for (const r of 行) {
    const key = r.egress || "-";
    const cur = 按出口.get(key) || { n: 0, ok: 0, fail: 0, ms: 0 };
    cur.n += 1;
    if (r.status >= 200 && r.status < 300) cur.ok += 1; else cur.fail += 1;
    cur.ms += r.ms || 0;
    按出口.set(key, cur);
  }
  const 诊断出口 = new Map(((诊断 && 诊断.egress) || []).map((e) => [e.key, e]));
  const 表体二 = $("diag-egress-stats").querySelector("tbody");
  表体二.replaceChildren();
  if (!按出口.size) {
    const baris = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.textContent = tr("暂无记录");
    baris.append(td);
    表体二.append(baris);
  } else {
    for (const [name, s] of [...按出口.entries()].sort((a, b) => b[1].n - a[1].n)) {
      const baris = document.createElement("tr");
      const d = 诊断出口.get(name);
      const cells = [name, String(s.n), String(s.ok), String(s.fail), String(d ? d.rate429 : 0), String(d ? d.连续成功 : 0), fmtMs(s.n ? Math.round(s.ms / s.n) : null)];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i > 0) td.className = "mono";
        td.textContent = text;
        baris.append(td);
      });
      表体二.append(baris);
    }
  }

  // 表三：模型失败分布（诊断窗口内失败过的模型，含 429 次数）。
  const 模型 = (诊断 && 诊断.models) || [];
  const 有失败 = 模型.filter((m) => m.fail > 0).sort((a, b) => b.fail - a.fail);
  const 表体三 = $("diag-models").querySelector("tbody");
  表体三.replaceChildren();
  $("diag-models-meta").textContent = 模型.length ? tr("模型") + " " + 有失败.length + "/" + 模型.length : "-";
  if (!有失败.length) {
    const baris = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = tr("暂无记录");
    baris.append(td);
    表体三.append(baris);
  } else {
    for (const m of 有失败) {
      const baris = document.createElement("tr");
      const cells = [m.key, String(m.requests), String(m.ok), String(m.fail), String(m.rate429), Math.round((m.fail / m.requests) * 100) + "%"];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i > 0) td.className = "mono";
        td.textContent = text;
        baris.append(td);
      });
      表体三.append(baris);
    }
  }

  // 表四：模型冷却（model-health.json 的当前条目）。
  const 冷却 = (诊断 && 诊断.cooldowns) || [];
  const 表体四 = $("diag-cooldowns").querySelector("tbody");
  表体四.replaceChildren();
  $("diag-cooldown-meta").textContent = 冷却.length ? String(冷却.length) : "-";
  if (!冷却.length) {
    const baris = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.textContent = tr("暂无记录");
    baris.append(td);
    表体四.append(baris);
  } else {
    for (const c of 冷却) {
      const baris = document.createElement("tr");
      const cells = [c.model, c.reason, Math.ceil(c.remainingMs / 1000) + "s"];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i === 2) td.className = "mono";
        td.textContent = text;
        baris.append(td);
      });
      表体四.append(baris);
    }
  }
  showReport($("diag-report"), [line("路由诊断已刷新。", "ok")]);
}

function 事件行(e) {
  const div = document.createElement("div");
  div.className = "ev";
  div.dataset.level = e.level;
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false });
  const lv = document.createElement("span");
  lv.className = "lv";
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = e.line;
  div.append(t, lv, msg);
  return div;
}

/** 增量拉取事件：按最后序号续传，DOM 只保留最新 400 行。 */
async function 拉取事件增量() {
  const feed = $("events-feed");
  if (!feed) return;
  try {
    const res = await readJson(await fetch("/api/events?after=" + 事件流状态.最后序号));
    for (const e of res.events || []) feed.append(事件行(e));
    事件流状态.最后序号 = res.last || 事件流状态.最后序号;
    while (feed.children.length > 400) feed.firstElementChild.remove();
    feed.scrollTop = feed.scrollHeight;
  } catch (err) {}
}

function 载入事件流() {
  if (!事件流状态.首屏已载) {
    事件流状态.首屏已载 = true;
    $("events-feed").replaceChildren();
    拉取事件增量();
  }
  if (!事件流状态.计时器) {
    事件流状态.计时器 = window.setInterval(() => {
      if (!document.hidden && currentView === "events" && !事件流状态.暂停) 拉取事件增量();
    }, 2000);
  }
}

function 接线路由诊断() {
  $("diag-refresh").addEventListener("click", async () => {
    const btn = $("diag-refresh");
    btn.disabled = true;
    await 载入路由诊断();
    btn.disabled = false;
  });
  $("events-pause").addEventListener("click", () => {
    事件流状态.暂停 = !事件流状态.暂停;
    const btn = $("events-pause");
    btn.setAttribute("aria-pressed", String(事件流状态.暂停));
    btn.textContent = 事件流状态.暂停 ? tr("继续") : tr("暂停");
  });
  $("events-jump").addEventListener("click", () => {
    const feed = $("events-feed");
    feed.scrollTop = feed.scrollHeight;
  });
}
接线路由诊断();

// ---- 复制 ----
async function copyText(text, label, boxId) {
  const box = $(boxId || "endpoint-report") || $("docs-report");
  try {
    await navigator.clipboard.writeText(text);
    showReport(box, [line(label + "已复制。", "ok")]);
  } catch (err) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    area.remove();
    if (ok) showReport(box, [line(label + "已复制。", "ok")]);
    else showReport(box, [line("复制失败，请手动选择文本。", "bad")]);
  }
}

$("copy-base").addEventListener("click", () => copyText($("endpoint-base").textContent, "Base URL "));
$("copy-key").addEventListener("click", () => copyText("public", "API key "));

document.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-copy-target]");
  if (!btn) return;
  const src = $(btn.dataset.copyTarget);
  if (src) copyText(src.textContent, "内容", "docs-report");
});

// ---- 概览指标 ----
async function loadOverviewMetrics() {
  try {
    const stats = await readJson(await fetch("/api/stats"));
    $("kpi-total").textContent = fmtNum(stats.total);
    $("kpi-total-sub").textContent = "本机用量历史累计";
    const rate = stats.total ? Math.round((stats.ok / stats.total) * 100) : null;
    $("kpi-ok").textContent = rate == null ? "-" : rate + "%";
    $("kpi-ok-sub").textContent = fmtNum(stats.ok) + " 成功 · " + fmtNum(stats.fail) + " 失败";
    $("kpi-latency").textContent = stats.avg_ms == null ? "-" : fmtMs(stats.avg_ms);
    $("kpi-latency-sub").textContent = "按已记录请求计算";
  } catch (err) {
    $("kpi-total").textContent = "-";
    $("kpi-ok").textContent = "-";
    $("kpi-latency").textContent = "-";
    $("kpi-total-sub").textContent = "读取失败";
    $("kpi-ok-sub").textContent = "读取失败";
    $("kpi-latency-sub").textContent = "读取失败";
  }
  try {
    const res = await fetch("/v1/models");
    const models = res.ok ? (await res.json()).data || [] : [];
    $("kpi-models").textContent = res.ok ? String(models.length) : "-";
    $("kpi-models-sub").textContent = res.ok ? "当前免费模型" : "读取受限，需 API 密钥";
  } catch (err) {
    $("kpi-models").textContent = "-";
    $("kpi-models-sub").textContent = "读取失败";
  }
}

// ---- 健康检查 ----
async function loadHealth() {
  try {
    const health = await readJson(await fetch("/health"));
    const gate = (health.identity && health.identity.gate) || {};
    const status = gate.status || "open";
    const labels = { open: "网关开放", throttled: "网关冷却中", "ip-blocked": "出口 IP 被封" };
    const states = { open: "ok", throttled: "warn", "ip-blocked": "bad" };
    let detail = "无近期拒绝记录";
    if (status === "throttled" && gate.throttledUntil) detail = "冷却至 " + fmtTime(gate.throttledUntil);
    if (status === "ip-blocked" && gate.ipBlockedSince) detail = "最近拒绝：" + fmtTime(gate.ipBlockedSince);

    setText(".js-gate-status", labels[status] || "未知");
    $$(".js-gate-dot").forEach((dot) => { dot.dataset.state = states[status] || "idle"; });
    setText(".js-gate-detail", detail);
    $("fact-gate").textContent = labels[status] || "未知";
    $("fact-gate-sub").textContent = detail;
    setText(".js-version", "本地运维面板");
    setText(".js-runtime", health.runtime || "-");
  } catch (err) {
    setText(".js-gate-status", "健康检查失败");
    $$(".js-gate-dot").forEach((dot) => { dot.dataset.state = "bad"; });
    setText(".js-gate-detail", err.message);
    $("fact-gate").textContent = "检查失败";
    $("fact-gate-sub").textContent = err.message;
  }
}

// ---- 健康检查页面 ----
async function loadHealthView() {
  const box = $("health-facts");
  const raw = $("health-raw");
  if (!box || !raw) return;
  try {
    const health = await readJson(await fetch("/health"));
    const gate = (health.identity && health.identity.gate) || {};
    const egress = health.egress || {};
    const proxyInfo = egress.proxy || {};
    const pool = proxyInfo.pool || {};
    const facts = [
      ["状态", health.status || "-", "进程存活即 ok"],
      ["版本", health.version || "-", health.runtime || ""],
      ["出口", egress.mode || "-", proxyInfo.mode === "pool" ? pool.ready + " / " + pool.enabled + " 就绪 · " + (STRATEGY_LABELS[pool.strategy] || pool.strategy) : proxyInfo.mode || "直连"],
      ["上游网关", gate.status || "open", gate.cooldownMs != null ? "冷却 " + gate.cooldownMs + " 毫秒" : "无冷却"],
      ["模型目录", health.discoveredModels != null ? health.discoveredModels + " 个" : "-", "免费模型"],
      ["监听", location.host, ""],
    ];
    box.replaceChildren(
      ...facts.map(([label, value, sub]) => {
        const card = document.createElement("div");
        card.className = "metric";
        const name = document.createElement("span");
        name.className = "metric-label";
        name.textContent = label;
        const val = document.createElement("span");
        val.className = "metric-value";
        val.textContent = String(value);
        card.append(name, val);
        if (sub) {
          const note = document.createElement("span");
          note.className = "metric-sub";
          note.textContent = String(sub);
          card.append(note);
        }
        return card;
      })
    );
    raw.textContent = JSON.stringify(health, null, 2);
    showReport($("health-report"), [line("已读取 /health。", "ok")]);
  } catch (err) {
    box.replaceChildren();
    raw.textContent = "读取失败：" + err.message;
    showReport($("health-report"), [line("读取 /health 失败：" + err.message, "bad")]);
  }
}

const healthRefresh = $("health-refresh");
if (healthRefresh) healthRefresh.addEventListener("click", loadHealthView);

// ---- API 文档 ----
let docsModels = [];

function renderModelTable(models) {
  const table = $("docs-models");
  const tbody = table.querySelector("tbody");
  tbody.replaceChildren(
    ...models.map((model) => {
      const tr = document.createElement("tr");
      const idTd = document.createElement("td");
      idTd.className = "mono";
      idTd.textContent = model.id || "-";
      const ownerTd = document.createElement("td");
      ownerTd.textContent = model.owned_by || "-";
      tr.append(idTd, ownerTd);
      return tr;
    })
  );
  table.hidden = models.length === 0;
}

async function loadDocs() {
  const base = location.origin + "/v1";
  const baseOpenai = $("docs-base-openai");
  const baseAnthropic = $("docs-base-anthropic");
  if (baseOpenai) baseOpenai.textContent = base;
  if (baseAnthropic) baseAnthropic.textContent = base;

  const note = $("docs-model-note");
  const empty = $("docs-models-empty");
  let required = false;

  try {
    const res = await fetch("/v1/models");
    required = res.status === 401;
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    docsModels = Array.isArray(data.data) ? data.data : [];
    renderModelTable(docsModels);
    if (note) note.textContent = docsModels.length ? docsModels.length + " 个模型" : "清单为空";
    if (empty) empty.hidden = docsModels.length > 0;
  } catch (err) {
    docsModels = [];
    renderModelTable(docsModels);
    if (note) note.textContent = required ? "需要 API 密钥" : "读取失败";
    if (empty) {
      setEmpty(
        empty,
        required ? "模型清单需要密钥" : "读取失败",
        required ? "已设置 FUCKING_OPENCODE_API_KEYS，带 Bearer 访问 /v1/models 即可看到清单。" : err.message
      );
    }
  }

  const key = PANEL_API_KEY || (required || AUTH_REQUIRED ? "<API_KEY>" : "public");
  const model = (docsModels[0] && docsModels[0].id) || "<模型 ID>";

  const authOpenai = $("docs-auth-openai");
  const authAnthropic = $("docs-auth-anthropic");
  if (authOpenai) authOpenai.textContent = "Authorization: Bearer " + key;
  if (authAnthropic) authAnthropic.textContent = "x-api-key: " + key;

  const openaiBody = JSON.stringify({ model: model, messages: [{ role: "user", content: "你好" }] });
  const anthropicBody = JSON.stringify({ model: model, max_tokens: 256, messages: [{ role: "user", content: "你好" }] });
  const openaiCurl = [
    "curl " + base + "/chat/completions \\\\",
    '  -H "Authorization: Bearer ' + key + '" \\\\',
    '  -H "Content-Type: application/json" \\\\',
    "  -d '" + openaiBody + "'",
  ].join("\\n");
  const anthropicCurl = [
    "curl " + base + "/messages \\\\",
    '  -H "x-api-key: ' + key + '" \\\\',
    '  -H "anthropic-version: 2023-06-01" \\\\',
    '  -H "Content-Type: application/json" \\\\',
    "  -d '" + anthropicBody + "'",
  ].join("\\n");
  const curlOpenai = $("docs-curl-openai");
  const curlAnthropic = $("docs-curl-anthropic");
  if (curlOpenai) curlOpenai.textContent = openaiCurl;
  if (curlAnthropic) curlAnthropic.textContent = anthropicCurl;
}

// ---- 测试台 ----
let playModelsLoaded = false;

async function loadPlayground() {
  if (playModelsLoaded) return;
  try {
    const res = await fetch("/v1/models");
    if (!res.ok) return;
    const data = await res.json();
    const models = Array.isArray(data.data) ? data.data : [];
    const list = $("play-models");
    const input = $("play-model");
    if (!list || !input) return;
    list.replaceChildren(
      ...models.map((model) => {
        const option = document.createElement("option");
        option.value = model.id || "";
        return option;
      })
    );
    if (!input.value && models.length) input.value = models[0].id;
    playModelsLoaded = true;
  } catch (err) {}
}

$("play-clear").addEventListener("click", () => {
  $("play-prompt").value = "";
  const out = $("play-output");
  out.hidden = true;
  out.textContent = "";
  const report = $("play-report");
  report.hidden = true;
  report.replaceChildren();
});

$("play-send").addEventListener("click", async () => {
  const model = $("play-model").value.trim();
  const prompt = $("play-prompt").value.trim();
  const report = $("play-report");
  const out = $("play-output");
  if (!model) {
    showReport(report, [line("先选择或填写模型 ID。", "bad")]);
    return;
  }
  if (!prompt) {
    showReport(report, [line("提示词不能为空。", "bad")]);
    return;
  }
  const btn = $("play-send");
  btn.disabled = true;
  showReport(report, [line("请求中…")]);
  const started = performance.now();
  try {
    const res = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], stream: false }),
    });
    const data = await res.json().catch(() => ({}));
    const ms = Math.round(performance.now() - started);
    if (!res.ok) {
      const detail = data.error && (data.error.message || data.error);
      throw new Error(detail || "HTTP " + res.status);
    }
    const choice = (data.choices && data.choices[0]) || {};
    const text = (choice.message && choice.message.content) || "";
    const usage = data.usage || {};
    const nodes = [line("HTTP " + res.status + " · " + ms + " 毫秒 · 模型 " + (data.model || model), "ok")];
    const input = usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens;
    const output = usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens;
    if (input != null || output != null) {
      nodes.push(line("词元：输入 " + (input == null ? "-" : input) + " · 输出 " + (output == null ? "-" : output), "mono"));
    }
    showReport(report, nodes);
    out.textContent = text || "（空回复）";
    out.hidden = false;
  } catch (err) {
    showReport(report, [line("请求失败：" + err.message, "bad")]);
    out.hidden = true;
  } finally {
    btn.disabled = false;
  }
});

// ---- 设置与面板偏好 ----
const PREF_KEY = "gateway-panel-prefs";

function readPrefs() {
  const fallback = { refresh: 60, days: 7 };
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    return {
      refresh: [15, 30, 60, 120].includes(Number(saved.refresh)) ? Number(saved.refresh) : fallback.refresh,
      days: [0, 1, 7, 30].includes(Number(saved.days)) ? Number(saved.days) : fallback.days,
    };
  } catch (err) {
    return fallback;
  }
}

function writePrefs(next) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch (err) {}
}

let healthTimer = null;

function scheduleHealth() {
  clearInterval(healthTimer);
  healthTimer = setInterval(loadHealth, readPrefs().refresh * 1000);
}

function applyPrefs() {
  const prefs = readPrefs();
  for (const id of ["stats-days", "history-days"]) {
    const el = $(id);
    if (el) el.value = String(prefs.days);
  }
  return prefs;
}

function fillKv(container, rows) {
  if (!container) return;
  const dl = document.createElement("dl");
  dl.className = "kv";
  for (const [label, value, mono] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value == null || value === "" ? "-" : String(value);
    if (mono) dd.classList.add("mono");
    dl.append(dt, dd);
  }
  container.replaceChildren(dl);
}

async function loadSettings() {
  const prefs = readPrefs();
  if ($("pref-refresh")) $("pref-refresh").value = String(prefs.refresh);
  if ($("pref-days")) $("pref-days").value = String(prefs.days);

  try {
    const health = await readJson(await fetch("/health"));
    const gate = (health.identity && health.identity.gate) || {};
    fillKv($("set-runtime"), [
      ["版本", health.version],
      ["运行时", health.runtime],
      ["监听", location.host],
      ["Base URL", location.origin + "/v1", true],
      ["状态", health.status],
    ]);
    fillKv($("set-gate"), [
      ["状态", gate.status || "open"],
      ["重试冷却", gate.cooldownMs != null ? gate.cooldownMs + " 毫秒" : ""],
      ["锚点工具", (gate.anchors && gate.anchors.tools ? gate.anchors.tools : []).join(", ")],
    ]);
  } catch (err) {
    fillKv($("set-runtime"), [["读取失败", err.message]]);
    fillKv($("set-gate"), [["读取失败", err.message]]);
  }

  try {
    const settings = await readJson(await fetch("/api/settings"));
    renderCredentials(settings);
  } catch (err) {
    const preview = $("cred-key-preview");
    if (preview) preview.textContent = "读取凭据失败：" + err.message;
  }

  try {
    const state = await readJson(await fetch("/api/proxy"));
    const pool = state.pool || {};
    fillKv($("set-egress"), [
      ["模式", state.mode],
      ["代理", state.proxy || "", true],
      ["来源", state.source],
      ["环境锁定", state.locked ? "是" : "否"],
      ["配置文件", state.configPath || "", true],
      ["代理池", pool.active ? pool.ready + " / " + pool.enabled + " 就绪 · " + (STRATEGY_LABELS[pool.strategy] || pool.strategy) : "未启用"],
    ]);
  } catch (err) {
    fillKv($("set-egress"), [["读取失败", err.message]]);
  }

  try {
    const [historyRes, statsRes, modelsRes] = await Promise.all([
      fetch("/api/history?limit=1"),
      fetch("/api/stats"),
      fetch("/v1/models"),
    ]);
    const history = await readJson(historyRes);
    const stats = await readJson(statsRes);
    fillKv($("set-data"), [
      ["历史文件", history.file || "", true],
      ["累计请求", fmtNum(stats.total)],
      ["词元覆盖率", (stats.token_coverage == null ? 0 : stats.token_coverage) + "%"],
      ["API 鉴权", modelsRes.status === 401 ? "已开启（/v1/* 需 Bearer）" : "未开启（任意非空 key）"],
    ]);
  } catch (err) {
    fillKv($("set-data"), [["读取失败", err.message]]);
  }
}

function renderKeyRows(keys) {
  const list = $("cred-key-list");
  if (!list) return;
  list.replaceChildren();
  if (!keys.length) {
    const empty = document.createElement("p");
    empty.className = "key-empty";
    empty.textContent = "尚未添加入口 key。";
    list.append(empty);
    return;
  }
  for (const entry of keys) {
    const row = document.createElement("div");
    row.className = "key-row" + (entry.enabled ? "" : " is-off");
    const main = document.createElement("div");
    main.className = "key-main";
    const name = document.createElement("div");
    name.className = "key-name";
    name.textContent = entry.label;
    const preview = document.createElement("div");
    preview.className = "key-preview";
    preview.textContent = entry.preview;
    if (entry.source === "env") {
      const tag = document.createElement("span");
      tag.className = "key-tag";
      tag.textContent = "环境变量";
      preview.append(" ", tag);
    }
    main.append(name, preview);
    const actions = document.createElement("div");
    actions.className = "key-actions";
    if (entry.source !== "env") {
      const rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "改名";
      rename.addEventListener("click", async () => {
        const label = prompt("新的标签", entry.label);
        if (label === null) return;
        const saved = await savePanelSettings({ updateApiKey: { id: entry.id, label } }, "标签已更新。");
        if (saved) renderCredentials(saved);
      });
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = entry.enabled ? "停用" : "启用";
      toggle.addEventListener("click", async () => {
        const saved = await savePanelSettings(
          { updateApiKey: { id: entry.id, enabled: !entry.enabled } },
          entry.enabled ? "key 已停用。" : "key 已启用。",
        );
        if (saved) renderCredentials(saved);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        if (!confirm("删除 key「" + entry.label + "」？使用它的客户端会立即收到 401。")) return;
        const saved = await savePanelSettings({ deleteApiKey: entry.id }, "key 已删除。");
        if (saved) renderCredentials(saved);
      });
      actions.append(rename, toggle, del);
    }
    row.append(main, actions);
    list.append(row);
  }
}

function renderCredentials(settings) {
  const password = settings.panelPassword || {};
  const keys = Array.isArray(settings.apiKeys) ? settings.apiKeys : [];
  const preview = $("cred-key-preview");
  if (preview) {
    preview.textContent = keys.length
      ? (keys.length === 1 ? "当前 key：" + keys[0].preview + "。" : "共 " + keys.length + " 个 key。")
      : "当前未设置 key：启用后仅接受已登记的 Bearer。";
  }
  renderKeyRows(keys);
  const file = $("cred-file");
  if (file) file.textContent = settings.file ? "保存到 " + settings.file : "";
  const note = $("cred-note");
  if (note && password.configured != null) {
    note.textContent =
      "密码" + (password.configured ? "已设置" : "未设置（面板不需登录）") +
      "。保存到本机 settings.json，权限 0600，改密码后旧会话立即失效。";
  }
  const base = $("integration-base");
  if (base) base.textContent = location.origin + "/v1";
  const model = $("integration-model");
  if (model) model.textContent = settings.defaultModel || "由客户端指定";
  const curl = $("integration-curl");
  if (curl) {
    const nl = String.fromCharCode(10);
    const bslash = "\\\\";
    const q = String.fromCharCode(34);
    const payload = JSON.stringify({ model: "<MODEL>", messages: [{ role: "user", content: "Halo" }], stream: true });
    curl.textContent = [
      "curl " + location.origin + "/v1/chat/completions " + bslash,
      "  -H " + q + "Authorization: Bearer <API_KEY>" + q + " " + bslash,
      "  -H " + q + "Content-Type: application/json" + q + " " + bslash,
      "  -d '" + payload + "'",
    ].join(nl);
  }
}

async function savePanelSettings(payload, okText) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await readJson(res);
    renderCredentials(body);
    showReport($("cred-report"), [line(okText, "ok")]);
    return body;
  } catch (err) {
    showReport($("cred-report"), [line(err.message, "bad")]);
    return null;
  }
}

const credSaveKey = $("cred-save-key");
if (credSaveKey) {
  credSaveKey.addEventListener("click", async () => {
    const value = $("cred-api-key").value.trim();
    if (!value) {
      showReport($("cred-report"), [line("先填入新的 API key。", "bad")]);
      return;
    }
    const label = $("cred-key-label") ? $("cred-key-label").value.trim() : "";
    const saved = await savePanelSettings({ addApiKey: { label, key: value } }, "API key 已添加，立即生效。");
    if (saved) {
      $("cred-api-key").value = "";
      if ($("cred-key-label")) $("cred-key-label").value = "";
    }
  });
}

const credRandomKey = $("cred-random-key");
if (credRandomKey) {
  credRandomKey.addEventListener("click", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    $("cred-api-key").value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  });
}

const credClearKey = $("cred-clear-key");
if (credClearKey) {
  credClearKey.addEventListener("click", () => {
    if (!confirm("删除本机保存的全部 API key？使用这些 key 的客户端会立即收到 401。")) return;
    savePanelSettings({ clearApiKey: true }, "本机保存的 API key 已全部删除。");
  });
}

const credSavePass = $("cred-save-pass");
if (credSavePass) {
  credSavePass.addEventListener("click", async () => {
    const value = $("cred-password").value;
    if (!value) {
      showReport($("cred-report"), [line("先填入新密码。", "bad")]);
      return;
    }
    const saved = await savePanelSettings({ panelPassword: value }, "登录密码已保存，旧会话已失效。");
    if (saved) $("cred-password").value = "";
  });
}

const credClearPass = $("cred-clear-pass");
if (credClearPass) {
  credClearPass.addEventListener("click", () => savePanelSettings({ clearPanelPassword: true }, "登录密码已清除，面板不再要求登录。"));
}

const copyIntegrationBase = $("copy-integration-base");
if (copyIntegrationBase) copyIntegrationBase.addEventListener("click", () => copyText(location.origin + "/v1", "Base URL", "cred-report"));
const copyIntegrationCurl = $("copy-integration-curl");
if (copyIntegrationCurl) copyIntegrationCurl.addEventListener("click", () => copyText($("integration-curl").textContent, "示例请求", "cred-report"));

$("pref-refresh").addEventListener("change", () => {
  const prefs = readPrefs();
  prefs.refresh = Number($("pref-refresh").value) || 60;
  writePrefs(prefs);
  scheduleHealth();
  showReport($("pref-report"), [line("已改为每 " + prefs.refresh + " 秒刷新 /health。", "ok")]);
});

$("pref-days").addEventListener("change", () => {
  const prefs = readPrefs();
  prefs.days = Number($("pref-days").value) || 0;
  writePrefs(prefs);
  for (const id of ["stats-days", "history-days"]) {
    const el = $(id);
    if (el) el.value = String(prefs.days);
  }
  showReport($("pref-report"), [line("默认统计范围已更新。", "ok")]);
});

$("pref-theme").addEventListener("click", () => themeBtn.click());

// ---- 启动 ----
applyPrefs();
applyLang(readLang());
langObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
const initialView = location.hash.replace("#", "");
go(VIEWS[initialView] ? initialView : "overview", { hash: false, scroll: false });
load();
loadHealth();
scheduleHealth();
`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** 完整面板文档。`description` 是 `proxy.describe()`；只读取标量字段并转义，
 * 配置文件里的值变不成 HTML 标记。
 */
function renderPanel(description, { version = "", port = "", authRequired = false, apiKey = "" } = {}) {
  const state = description || {};
  const pool = state.pool || {};
  const modeText = state.mode === "pool" ? "代理池已启用" : state.mode === "proxy" ? "经代理" : "直连（本机 IP）";
  const hostText = state.proxy || "未设置代理";
  const strategyText = !pool.active
    ? "未启用"
    : pool.strategy === "round-robin"
      ? "轮询"
      : pool.strategy === "failover"
        ? "故障转移"
        : pool.strategy === "random"
          ? "加权随机"
          : String(pool.strategy || "-");
  const poolReady = pool.active ? String(pool.ready) + " / " + String(pool.enabled) : "-";
  const poolSub = pool.active
    ? Number(pool.cooling) > 0
      ? pool.cooling + " 条冷却中，共 " + pool.size + " 条"
      : "全部就绪，共 " + pool.size + " 条"
    : "尚未配置代理池";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>概览 · Fucking Opencode</title>
<link rel="icon" type="image/png" href="/panel-avatar.png">
<style>${STYLE}</style>
</head>
<body data-auth-required="${authRequired ? "true" : "false"}" data-panel-key="${escapeHtml(apiKey)}">
<a class="skip" href="#main">跳到主内容</a>
<div class="app" id="app">
  <aside class="sidebar" id="sidebar" aria-label="主导航">
    <div class="brand">
      <img class="brand-mark brand-avatar" src="/panel-avatar.png" alt="" onerror="this.hidden=true">
      <div class="brand-text">
        <span class="brand-name" title="Fucking Opencode">Fucking Opencode</span>
        <span class="brand-sub js-version">本地运维面板</span>
      </div>
    </div>
    <nav class="nav" aria-label="区块">
      <div class="nav-group">
        <span class="nav-heading">监控</span>
        <button type="button" class="nav-item" data-go="overview" aria-current="page">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>
          <span>概览</span>
        </button>
        <button type="button" class="nav-item" data-go="health">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 8h3l1.4-2.6L8.6 11l1.5-3h4.1"/></svg>
          <span>健康检查</span>
        </button>
        <button type="button" class="nav-item" data-go="diag">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
          <span>路由诊断</span>
        </button>
        <button type="button" class="nav-item" data-go="events">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11"/><path d="M2.5 8h11"/><path d="M2.5 11.5h7"/></svg>
          <span>事件流</span>
        </button>
      </div>
      <div class="nav-group">
        <span class="nav-heading">出口</span>
        <button type="button" class="nav-item" data-go="egress">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5c-1.6 1.5-2.5 3.4-2.5 5.5s.9 4 2.5 5.5c1.6-1.5 2.5-3.4 2.5-5.5S9.6 4 8 2.5Z"/></svg>
          <span>出口代理</span>
        </button>
        <button type="button" class="nav-item" data-go="pool">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2.5 5.5 2.7L8 7.9 2.5 5.2 8 2.5Z"/><path d="m2.5 8.2 5.5 2.7 5.5-2.7"/><path d="m2.5 11.2 5.5 2.7 5.5-2.7"/></svg>
          <span>代理池</span>
          <span class="nav-badge" id="nav-pool-badge" hidden></span>
        </button>
      </div>
      <div class="nav-group">
        <span class="nav-heading">数据</span>
        <button type="button" class="nav-item" data-go="stats">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 12.5V8.5"/><path d="M8 12.5V4.5"/><path d="M13 12.5V6.5"/></svg>
          <span>用量统计</span>
        </button>
        <button type="button" class="nav-item" data-go="history">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.4"/></svg>
          <span>请求历史</span>
        </button>
      </div>
      <div class="nav-group">
        <span class="nav-heading">工具</span>
        <button type="button" class="nav-item" data-go="endpoint">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5v3M10 2.5v3"/><path d="M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0V5.5Z"/><path d="M8 11.2v2.3"/></svg>
          <span>接入点</span>
        </button>
        <button type="button" class="nav-item" data-go="docs">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h5.2l2.8 2.8v8.2H4Z"/><path d="M9.2 2.5v2.8H12"/><path d="M6 8h4M6 10.4h3"/></svg>
          <span>API 文档</span>
        </button>
        <button type="button" class="nav-item" data-go="playground">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.8 3.5h10.4v6.6H7.2L4.4 12.4V10.1H2.8Z"/><path d="M5.4 6h5.2M5.4 8h3.4"/></svg>
          <span>测试台</span>
        </button>
      </div>
      <div class="nav-group">
        <span class="nav-heading">系统</span>
        <button type="button" class="nav-item" data-go="settings">
          <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.7"/><circle cx="10.3" cy="11" r="1.7"/></svg>
          <span>设置</span>
        </button>
      </div>
    </nav>
  </aside>
  <div class="nav-backdrop" id="nav-backdrop"></div>
  <div class="shell">
    <header class="topbar">
      <button type="button" class="icon-btn" id="sidebar-toggle" aria-expanded="true" aria-controls="sidebar" aria-label="收起或展开侧栏">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.5 3v10"/></svg>
      </button>
      <div class="crumb">
        <span class="crumb-root">Fucking Opencode</span>
        <span class="crumb-sep">/</span>
        <strong id="crumb">概览</strong>
      </div>
      <div class="top-right">
        <div class="seg" role="group" aria-label="Language">
          <button type="button" data-lang="zh" aria-pressed="false">中文</button>
          <button type="button" data-lang="id" aria-pressed="true">ID</button>
          <button type="button" data-lang="en" aria-pressed="false">EN</button>
        </div>
        <a class="top-link" href="https://github.com/ShinRyu04/Fucking-Opencode" target="_blank" rel="noreferrer noopener" aria-label="GitHub">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
        </a>
        <button type="button" class="icon-btn" id="theme-toggle" aria-label="切换主题">
          <svg class="icon-sun" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.6v1.4M8 13v1.4M1.6 8H3M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1"/></svg>
          <svg class="icon-moon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path transform="translate(0.45 -0.45)" d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z"/></svg>
        </button>
        <button type="button" id="logout"${authRequired ? "" : " hidden"}>Out</button>
      </div>
    </header>
    <main id="main">      <section class="view is-active" data-view="overview" aria-labelledby="overview-title">
        <div class="page-head">
          <h1 id="overview-title">概览</h1>
          <p class="page-sub">桥的出口与网关状态。改动立即用于下一个请求，无需重启。</p>
        </div>
        <div class="card status-card">
          <div class="status-mode">
            <span class="dot js-mode-dot" data-state="idle"></span>
            <span class="js-mode" id="mode">${escapeHtml(modeText)}</span>
          </div>
          <div class="status-host js-host" id="host">${escapeHtml(hostText)}</div>
          <div class="status-note" id="note" hidden></div>
        </div>
        <div class="metric-grid">
          <div class="metric">
            <div class="metric-head">
              <span class="metric-label">总请求</span>
              <span class="metric-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12.5h12M4 12.5V8M8 12.5V4.5M12 12.5V6.5"/></svg></span>
            </div>
            <span class="metric-value" id="kpi-total">-</span>
            <span class="metric-sub" id="kpi-total-sub">读取中</span>
          </div>
          <div class="metric">
            <div class="metric-head">
              <span class="metric-label">成功率</span>
              <span class="metric-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.6"/><path d="M5.4 8.2l1.7 1.7 3.5-3.7"/></svg></span>
            </div>
            <span class="metric-value" id="kpi-ok">-</span>
            <span class="metric-sub" id="kpi-ok-sub">读取中</span>
          </div>
          <div class="metric">
            <div class="metric-head">
              <span class="metric-label">平均耗时</span>
              <span class="metric-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/></svg></span>
            </div>
            <span class="metric-value" id="kpi-latency">-</span>
            <span class="metric-sub" id="kpi-latency-sub">读取中</span>
          </div>
          <div class="metric">
            <div class="metric-head">
              <span class="metric-label">免费模型</span>
              <span class="metric-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2l5.4 2.7L8 7.6 2.6 4.9 8 2.2Z"/><path d="M2.6 7.4L8 10.1l5.4-2.7M2.6 9.9L8 12.6l5.4-2.7"/></svg></span>
            </div>
            <span class="metric-value" id="kpi-models">-</span>
            <span class="metric-sub" id="kpi-models-sub">读取中</span>
          </div>
        </div>
        <div class="fact-grid">
          <div class="card">
            <div class="fact-label">代理池就绪</div>
            <div class="fact-value" id="fact-pool-ready">${escapeHtml(poolReady)}</div>
            <div class="fact-sub" id="fact-pool-sub">${escapeHtml(poolSub)}</div>
          </div>
          <div class="card">
            <div class="fact-label">调度策略</div>
            <div class="fact-value mono" id="fact-strategy">${escapeHtml(strategyText)}</div>
            <div class="fact-sub">池内条目按此策略轮转</div>
          </div>
          <div class="card">
            <div class="fact-label">上游网关</div>
            <div class="fact-value" id="fact-gate">检查中</div>
            <div class="fact-sub" id="fact-gate-sub">正在读取 /health</div>
          </div>
        </div>
        <div class="quick-row">
          <button type="button" class="primary" data-go="egress">配置出口</button>
          <button type="button" data-go="pool">管理代理池</button>
          <button type="button" data-go="stats">查看统计</button>
        </div>
      </section>

      <section class="view" data-view="health" aria-labelledby="health-title">
        <div class="page-head">
          <h1 id="health-title">健康检查</h1>
          <p class="page-sub">直接读取 <code>/health</code>：进程、网关、出口与模型目录的当前状态。</p>
        </div>
        <div class="card">
          <div class="toolbar">
            <button type="button" class="primary" id="health-refresh">刷新</button>
            <a class="top-link" href="/health" target="_blank" rel="noreferrer noopener" aria-label="打开 /health" style="margin-left:auto; border-color:var(--rule); background:var(--surface)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h6v9h-6"/><path d="M4 8h6"/><path d="m7.5 5.5 2.5 2.5-2.5 2.5"/></svg>
            </a>
          </div>
          <div class="report" id="health-report" role="status" aria-live="polite" hidden></div>
          <div class="metric-grid" id="health-facts"></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>原始响应</h2><span class="card-meta">application/json</span></div>
          <pre class="code" id="health-raw">读取中…</pre>
        </div>
      </section>

      <section class="view" data-view="diag" aria-labelledby="diag-title">
        <div class="page-head">
          <h1 id="diag-title">路由诊断</h1>
          <p class="page-sub">出口健康、按出口的近期结果与模型失败分布；数据全部来自代理池健康与本机请求历史。</p>
        </div>
        <div class="toolbar">
          <button type="button" class="primary" id="diag-refresh">刷新</button>
        </div>
        <div class="report" id="diag-report" role="status" aria-live="polite" hidden></div>
        <div class="card">
          <div class="card-head"><h2>出口健康</h2><span class="card-meta" id="diag-pool-meta">-</span></div>
          <div class="table-wrap">
            <table class="diag-table" id="diag-egress">
              <thead><tr><th scope="col">出口</th><th scope="col">状态</th><th scope="col" class="num">失败</th><th scope="col">分类</th><th scope="col" class="num">冷却</th><th scope="col">最后成功</th><th scope="col">最近错误</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>按出口统计</h2><span class="card-meta">最近 500 条</span></div>
          <div class="table-wrap">
            <table class="diag-table" id="diag-egress-stats">
              <thead><tr><th scope="col">出口</th><th scope="col" class="num">请求</th><th scope="col" class="num">成功</th><th scope="col" class="num">失败</th><th scope="col" class="num">429</th><th scope="col" class="num">连续成功</th><th scope="col" class="num">平均耗时</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>模型失败分布</h2><span class="card-meta" id="diag-models-meta">-</span></div>
          <div class="table-wrap">
            <table class="diag-table" id="diag-models">
              <thead><tr><th scope="col">模型</th><th scope="col" class="num">请求</th><th scope="col" class="num">成功</th><th scope="col" class="num">失败</th><th scope="col" class="num">429</th><th scope="col" class="num">失败率</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>模型冷却</h2><span class="card-meta" id="diag-cooldown-meta">-</span></div>
          <div class="table-wrap">
            <table class="diag-table" id="diag-cooldowns">
              <thead><tr><th scope="col">模型</th><th scope="col">冷却原因</th><th scope="col" class="num">剩余</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="view" data-view="events" aria-labelledby="events-title">
        <div class="page-head">
          <h1 id="events-title">事件流</h1>
          <p class="page-sub">网关进程的实时日志：重试、冷却、池变化与模型发现。每 2 秒增量拉取，只读本机。</p>
        </div>
        <div class="toolbar">
          <button type="button" id="events-pause" aria-pressed="false">暂停</button>
          <button type="button" id="events-jump">跳到最新</button>
        </div>
        <div class="card">
          <div class="events-feed" id="events-feed" aria-live="polite" aria-label="网关事件流"></div>
        </div>
      </section>


      <section class="view" data-view="egress" aria-labelledby="egress-title">
        <div class="page-head">
          <h1 id="egress-title">出口代理</h1>
          <p class="page-sub">把桥的所有出站连接指向 HTTP 代理，上游就不会看到本机 IP。</p>
        </div>
        <div class="card">
          <div class="inline-status">
            <span class="dot js-mode-dot" data-state="idle"></span>
            <span class="js-mode">${escapeHtml(modeText)}</span>
            <span class="inline-host js-host">${escapeHtml(hostText)}</span>
          </div>
          <form id="form" novalidate>
            <div class="field">
              <label for="proxy-url">代理 URL</label>
              <input id="proxy-url" name="proxy-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://user:pass@host:8080" aria-describedby="url-hint">
              <p class="hint" id="url-hint">格式 <code>http://[user:pass@]host:port</code>。仅支持 HTTP/HTTPS（CONNECT 隧道）。清空后保存即回到直连。</p>
            </div>
            <div class="actions">
              <button type="button" class="primary" id="save">保存并启用</button>
              <button type="button" id="test">测试连接</button>
              <button type="button" id="direct">关闭代理</button>
            </div>
            <div class="report" id="report" role="status" aria-live="polite" hidden></div>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><h2>Cloudflare WARP</h2><span class="card-meta" id="warp-meta">-</span></div>
          <p class="hint" id="warp-hint">可选。仅当服务以 WARP_MANAGE=1 启动且主机安装了 warp-cli 时可用。连接/断开会改变整机路由。</p>
          <div class="actions">
            <button type="button" class="primary" id="warp-connect">连接</button>
            <button type="button" id="warp-disconnect">断开</button>
            <button type="button" id="warp-refresh">刷新</button>
          </div>
          <div class="report" id="warp-report" role="status" aria-live="polite" hidden></div>
        </div>
      </section>

      <section class="view" data-view="pool" aria-labelledby="pool-title">
        <div class="page-head">
          <h1 id="pool-title">代理池</h1>
          <p class="page-sub">每行一个 URL，可用 <code>名称=url</code> 加标签。被上游拒绝的条目进入冷却，恢复前自动跳过。</p>
        </div>
        <div class="card">
          <div class="field">
            <label for="pool-entries">代理列表</label>
            <textarea id="pool-entries" rows="6" spellcheck="false" placeholder="med1=http://10.0.0.1:8888&#10;med2=http://10.0.0.2:8888"></textarea>
          </div>
          <div class="field">
            <label for="pool-strategy">策略</label>
            <select id="pool-strategy">
              <option value="round-robin">轮询（均分流量）</option>
              <option value="failover">故障转移（固定用第一个，被拒才换）</option>
              <option value="random">加权随机</option>
            </select>
          </div>
          <div class="actions">
            <button type="button" class="primary" id="pool-save">保存代理池</button>
            <button type="button" id="pool-test">全部测试</button>
            <button type="button" id="pool-clear">清空代理池</button>
          </div>
          <div class="report" id="pool-report" role="status" aria-live="polite" hidden></div>
        </div>
        <div class="card">
          <div class="card-head">
            <h2>当前条目</h2>
            <span class="card-meta" id="pool-count">-</span>
          </div>
          <ul class="pool-list" id="pool-list" hidden></ul>
          <div class="empty" id="pool-empty">
            <strong>代理池未启用</strong>
            <p>在上方填写并保存至少一条代理后，这里会显示健康状态与冷却倒计时。</p>
          </div>
        </div>
      </section>

      <section class="view" data-view="stats" aria-labelledby="stats-title">
        <div class="page-head">
          <h1 id="stats-title">用量统计</h1>
          <p class="page-sub" id="stats-scope">本地 <code>usage.jsonl</code> 汇总，只含模型、耗时、词元与状态，不含消息内容。</p>
        </div>
        <div class="card">
          <div class="toolbar">
            <select id="stats-days" aria-label="统计范围">
              <option value="0">全部</option>
              <option value="1">最近 1 天</option>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
            </select>
            <button type="button" class="primary" id="stats-load">刷新统计</button>
            <button type="button" id="stats-clear">清空历史</button>
          </div>
          <div class="report" id="stats-report" role="status" aria-live="polite" hidden></div>
          <div class="empty" id="stats-empty">
            <strong>还没有加载统计</strong>
            <p>选择范围后按「刷新统计」。数据来自本机记录，不含消息内容。</p>
          </div>
          <div id="stats-summary" hidden>
            <div class="usage-kpis" id="usage-kpis"></div>
            <div class="usage-grid">
              <div class="usage-panel">
                <div class="usage-panel-head">
                  <div>
                    <h2>分类</h2>
                    <p id="usage-breakdown-note">按请求数排序，条长为该组占比。</p>
                  </div>
                  <div class="usage-tabs" id="usage-tabs" role="tablist" aria-label="分类维度">
                    <button type="button" role="tab" data-bk="model" aria-selected="true">模型</button>
                    <button type="button" role="tab" data-bk="provider" aria-selected="false">供应商</button>
                    <button type="button" role="tab" data-bk="client" aria-selected="false">客户端 IP</button>
                    <button type="button" role="tab" data-bk="key" aria-selected="false">密钥</button>
                  </div>
                </div>
                <ul class="usage-rows" id="usage-rows"></ul>
              </div>
              <div class="usage-panel">
                <div class="usage-panel-head">
                  <div>
                    <h2>流量</h2>
                    <p id="usage-traffic-note">按 24 个时间桶统计；无记录的空桶为 0。</p>
                  </div>
                  <div class="usage-tabs" id="traffic-tabs" role="tablist" aria-label="流量指标">
                    <button type="button" role="tab" data-tm="requests" aria-selected="true">请求</button>
                    <button type="button" role="tab" data-tm="tokens" aria-selected="false">词元</button>
                    <button type="button" role="tab" data-tm="cached" aria-selected="false">缓存</button>
                  </div>
                </div>
                <div id="usage-chart"></div>
              </div>
            </div>
            <div class="usage-panel usage-requests">
              <div class="usage-panel-head">
                <div>
                  <h2>请求</h2>
                  <p>最近 100 条，新的在上；点开一行看错误摘要。</p>
                </div>
                <p class="usage-scope" id="usage-latency"></p>
              </div>
              <div class="table-wrap">
                <table class="stats-table" id="usage-recent" hidden>
                  <thead><tr><th scope="col">时间</th><th scope="col">供应商 / 模型</th><th scope="col">API 密钥</th><th scope="col">状态</th><th scope="col" class="num">词元</th><th scope="col" class="num">TPS</th><th scope="col" class="num">TTFT</th><th scope="col" class="num">完成</th></tr></thead>
                  <tbody></tbody>
                </table>
              </div>
              <div class="usage-row-empty" id="usage-recent-empty" hidden>这个范围内还没有请求。</div>
            </div>
          </div>
        </div>
      </section>

      <section class="view" data-view="history" aria-labelledby="history-title">
        <div class="page-head">
          <h1 id="history-title">请求历史</h1>
          <p class="page-sub">最近 100 条请求记录，字段与 <code>/api/history</code> 一致。</p>
        </div>
        <div class="card">
          <div class="toolbar">
            <select id="history-days" aria-label="历史范围">
              <option value="0">全部</option>
              <option value="1">最近 1 天</option>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
            </select>
            <button type="button" class="primary" id="stats-history">最近请求</button>
          </div>
          <div class="report" id="history-report" role="status" aria-live="polite" hidden></div>
          <div class="empty" id="history-empty">
            <strong>还没有加载记录</strong>
            <p>跑一次推理请求后按「最近请求」。记录来自本机 <code>usage.jsonl</code>。</p>
          </div>
          <div class="table-wrap">
            <table class="stats-table" id="history-table" hidden>
              <thead><tr><th scope="col">时间</th><th scope="col">协议</th><th scope="col">模型</th><th scope="col">状态</th><th scope="col" class="num">耗时</th><th scope="col" class="num">输入</th><th scope="col" class="num">输出</th><th scope="col">出口</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="view" data-view="endpoint" aria-labelledby="endpoint-title">
        <div class="page-head">
          <h1 id="endpoint-title">接入点</h1>
          <p class="page-sub">OpenAI 兼容客户端直接指向这里。面板只应绑定回环地址；登录密码与 API key 在「设置」里配置。</p>
        </div>
        <div class="card">
          <div class="endpoint-row">
            <span class="endpoint-label">Base URL</span>
            <span class="endpoint-value" id="endpoint-base">http://127.0.0.1:${escapeHtml(port || "20134")}/v1</span>
            <button type="button" class="icon-btn" id="copy-base" aria-label="复制 Base URL">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4.5A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>
            </button>
          </div>
          <div class="endpoint-row">
            <span class="endpoint-label">API key</span>
            <span class="endpoint-value">public<span class="endpoint-note">（设了 FUCKING_OPENCODE_API_KEYS 后用该 key）</span></span>
            <button type="button" class="icon-btn" id="copy-key" aria-label="复制 API key">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4.5A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>
            </button>
          </div>
          <div class="endpoint-row">
            <span class="endpoint-label">健康检查</span>
            <span class="endpoint-value"><a href="/health">/health</a></span>
            <span></span>
          </div>
          <div class="endpoint-row">
            <span class="endpoint-label">版本</span>
            <span class="endpoint-value">${escapeHtml(version || "-")}</span>
            <span></span>
          </div>
          <div class="endpoint-row">
            <span class="endpoint-label">运行时</span>
            <span class="endpoint-value js-runtime">-</span>
            <span></span>
          </div>
          <div class="report" id="endpoint-report" role="status" aria-live="polite" hidden></div>
        </div>
      </section>

      <section class="view" data-view="docs" aria-labelledby="docs-title">
        <div class="page-head">
          <h1 id="docs-title">API 文档</h1>
          <p class="page-sub">本桥实际提供的路由、当前免费模型，以及可直接复制的请求示例。鉴权状态来自对 /v1/models 的探测。</p>
        </div>
        <div class="settings-grid">
          <div class="card">
            <div class="card-head"><h2>OpenAI 兼容</h2><span class="card-meta">/v1/chat/completions</span></div>
            <p class="docs-label">Base URL</p>
            <div class="copy-row">
              <code id="docs-base-openai">http://127.0.0.1:${escapeHtml(port || "20134")}/v1</code>
              <button type="button" class="icon-btn" data-copy-target="docs-base-openai" aria-label="复制 Base URL">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4.5A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>
              </button>
            </div>
            <p class="docs-label">鉴权头</p>
            <div class="copy-row">
              <code id="docs-auth-openai">Authorization: Bearer &lt;API_KEY&gt;</code>
              <button type="button" class="icon-btn" data-copy-target="docs-auth-openai" aria-label="复制鉴权头">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4.5A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>
              </button>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Anthropic 兼容</h2><span class="card-meta">/v1/messages</span></div>
            <p class="docs-label">Base URL</p>
            <div class="copy-row">
              <code id="docs-base-anthropic">http://127.0.0.1:${escapeHtml(port || "20134")}/v1</code>
              <button type="button" class="icon-btn" data-copy-target="docs-base-anthropic" aria-label="复制 Base URL">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4.5A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>
              </button>
            </div>
            <p class="docs-label">鉴权头</p>
            <div class="copy-row">
              <code id="docs-auth-anthropic">x-api-key: &lt;API_KEY&gt;</code>
              <button type="button" class="icon-btn" data-copy-target="docs-auth-anthropic" aria-label="复制鉴权头">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4.5A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>端点</h2><span class="card-meta">只列本桥真实路由</span></div>
          <div class="table-wrap">
            <table class="stats-table">
              <thead><tr><th scope="col">方法</th><th scope="col">路径</th><th scope="col">协议</th><th scope="col">说明</th></tr></thead>
              <tbody>
                <tr><td><span class="method">GET</span></td><td class="mono">/health</td><td>本桥</td><td>健康、出口与网关状态。</td></tr>
                <tr><td><span class="method">GET</span></td><td class="mono">/v1/models</td><td>OpenAI</td><td>当前免费模型清单。</td></tr>
                <tr><td><span class="method post">POST</span></td><td class="mono">/v1/chat/completions</td><td>OpenAI</td><td>对话补全，支持 SSE 流式。</td></tr>
                <tr><td><span class="method post">POST</span></td><td class="mono">/v1/responses</td><td>OpenAI</td><td>Responses API。</td></tr>
                <tr><td><span class="method post">POST</span></td><td class="mono">/v1/messages</td><td>Anthropic</td><td>Messages API，支持 SSE 流式。</td></tr>
                <tr><td><span class="method">GET</span></td><td class="mono">/api/stats</td><td>面板</td><td>本机用量汇总，可选 <code>?days=</code>。</td></tr>
                <tr><td><span class="method">GET</span></td><td class="mono">/api/history</td><td>面板</td><td>最近请求记录，可选 <code>?limit=&amp;days=</code>。</td></tr>
                <tr><td><span class="method post">POST</span></td><td class="mono">/api/history/clear</td><td>面板</td><td>清空本机用量历史。</td></tr>
                <tr><td><span class="method">GET</span></td><td class="mono">/api/proxy</td><td>面板</td><td>读取出口配置与代理池健康。</td></tr>
                <tr><td><span class="method post">POST</span></td><td class="mono">/api/proxy</td><td>面板</td><td>写入单代理或代理池。</td></tr>
                <tr><td><span class="method post">POST</span></td><td class="mono">/api/proxy/test</td><td>面板</td><td>探测代理，不落盘。</td></tr>
                <tr><td><span class="method">GET</span></td><td class="mono">/api/warp</td><td>面板</td><td>读取可选的 Cloudflare WARP 状态。</td></tr>
                <tr><td><span class="method post">POST</span></td><td class="mono">/api/warp</td><td>面板</td><td>连接或断开 WARP（需 WARP_MANAGE=1）。</td></tr>
              </tbody>
            </table>
          </div>
          <div class="report" id="docs-report" role="status" aria-live="polite" hidden></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>当前免费模型</h2><span class="card-meta" id="docs-model-note">读取中…</span></div>
          <div class="table-wrap">
            <table class="stats-table" id="docs-models" hidden>
              <thead><tr><th scope="col">模型 ID</th><th scope="col">归属</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="empty" id="docs-models-empty">
            <strong>还没有模型清单</strong>
            <p>首次发现会在请求 /v1/models 时触发，稍后刷新本页。</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>请求示例</h2><span class="card-meta">按当前 origin 生成</span></div>
          <p class="docs-label">OpenAI chat completions（非流式）</p>
          <pre class="code" id="docs-curl-openai"></pre>
          <p class="docs-label">Anthropic messages</p>
          <pre class="code" id="docs-curl-anthropic"></pre>
        </div>
      </section>

      <section class="view" data-view="playground" aria-labelledby="playground-title">
        <div class="page-head">
          <h1 id="playground-title">测试台</h1>
          <p class="page-sub">用当前出口发一条真实请求，验证模型、凭据和自愈链路是否通畅。</p>
        </div>
        <div class="card">
          <div class="field">
            <label for="play-model">模型</label>
            <input id="play-model" list="play-models" autocomplete="off" spellcheck="false" placeholder="从 /v1/models 读取">
            <datalist id="play-models"></datalist>
          </div>
          <div class="field">
            <label for="play-prompt">提示词</label>
            <textarea id="play-prompt" rows="4" spellcheck="false" placeholder="用一句话介绍这个桥。"></textarea>
          </div>
          <div class="actions">
            <button type="button" class="primary" id="play-send">发送</button>
            <button type="button" id="play-clear">清空</button>
          </div>
          <p class="hint">会真实消耗上游免费额度；请求为非流式，只展示最终文本与用量。</p>
          <div class="report" id="play-report" role="status" aria-live="polite" hidden></div>
          <pre class="code" id="play-output" hidden></pre>
        </div>
      </section>

      <section class="view" data-view="settings" aria-labelledby="settings-title">
        <div class="page-head">
          <h1 id="settings-title">设置</h1>
          <p class="page-sub">凭据可直接在下方修改并立即生效；其余环境变量改动需要重启桥。面板偏好只存在本机浏览器。</p>
        </div>
        <div class="settings-grid">
          <div class="card settings-wide">
            <div class="card-head"><h2>访问凭据</h2><span class="card-meta" id="cred-file"></span></div>
            <p class="cred-preview" id="cred-key-preview">读取中…</p>
            <div class="integration-grid">
              <div>
                <div class="field">
                  <label for="cred-api-key">API key（下游 Bearer）</label>
                  <input type="text" id="cred-api-key" autocomplete="off" spellcheck="false" placeholder="输入新的 API key">
                </div>
                <div class="field">
                  <label for="cred-key-label">标签（可选）</label>
                  <input type="text" id="cred-key-label" autocomplete="off" spellcheck="false" maxlength="40" placeholder="例如：laptop、ci">
                </div>
                <div class="cred-actions">
                  <button type="button" class="primary" id="cred-save-key">添加 key</button>
                  <button type="button" id="cred-random-key">随机生成</button>
                  <button type="button" class="danger" id="cred-clear-key">删除全部</button>
                </div>
                <div class="key-list" id="cred-key-list"></div>
              </div>
              <div>
                <div class="field">
                  <label for="cred-password">面板登录密码</label>
                  <input type="password" id="cred-password" autocomplete="new-password" placeholder="输入新密码">
                </div>
                <div class="cred-actions">
                  <button type="button" class="primary" id="cred-save-pass">保存密码</button>
                  <button type="button" class="danger" id="cred-clear-pass">清除密码</button>
                </div>
              </div>
            </div>
            <p class="cred-note" id="cred-note">保存在本机状态目录的 <code>settings.json</code>（权限 0600）。保存后立即生效，无需重启。</p>
            <div class="report" id="cred-report" role="status" aria-live="polite" hidden></div>
          </div>
          <div class="card settings-wide">
            <div class="card-head"><h2>Agent 集成</h2><span class="card-meta">OpenAI 兼容</span></div>
            <div class="integration-grid">
              <div class="field">
                <label for="integration-base">Base URL</label>
                <div class="copy-row"><code id="integration-base"></code><button type="button" id="copy-integration-base">复制</button></div>
              </div>
              <div class="field">
                <label for="integration-model">默认模型</label>
                <div class="copy-row"><code id="integration-model"></code></div>
              </div>
            </div>
            <div class="field">
              <label for="integration-curl">示例请求</label>
              <pre class="code" id="integration-curl"></pre>
            </div>
            <div class="integration-actions">
              <button type="button" id="copy-integration-curl">复制示例</button>
            </div>
            <p class="cred-note" id="integration-note">任何 OpenAI 兼容客户端把 Base URL 指向这里，并在 Authorization 里带上 API key。</p>
          </div>
          <div class="card">
            <div class="card-head"><h2>运行</h2></div>
            <div id="set-runtime"><p class="hint">读取中…</p></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>出口</h2></div>
            <div id="set-egress"><p class="hint">读取中…</p></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>上游网关</h2></div>
            <div id="set-gate"><p class="hint">读取中…</p></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>数据</h2></div>
            <div id="set-data"><p class="hint">读取中…</p></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>面板偏好</h2><span class="card-meta">localStorage</span></div>
            <div class="field">
              <label for="pref-refresh">/health 刷新间隔</label>
              <select id="pref-refresh">
                <option value="15">15 秒</option>
                <option value="30">30 秒</option>
                <option value="60">60 秒</option>
                <option value="120">120 秒</option>
              </select>
            </div>
            <div class="field">
              <label for="pref-days">默认统计范围</label>
              <select id="pref-days">
                <option value="0">全部</option>
                <option value="1">最近 1 天</option>
                <option value="7">最近 7 天</option>
                <option value="30">最近 30 天</option>
              </select>
            </div>
            <div class="actions">
              <button type="button" id="pref-theme">切换主题</button>
            </div>
            <div class="report" id="pref-report" role="status" aria-live="polite" hidden></div>
          </div>
        </div>
      </section>
    </main>
  </div>
</div>

<div class="palette" id="palette" hidden>
  <div class="palette-backdrop" id="palette-backdrop"></div>
  <div class="palette-box" role="dialog" aria-modal="true" aria-label="跳转到页面区块">
    <div class="palette-head">
      <svg class="palette-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg>
      <input id="palette-input" type="text" autocomplete="off" spellcheck="false" placeholder="跳到...（输入关键字）" aria-label="搜索区块">
      <button type="button" class="icon-btn" id="palette-close" aria-label="关闭跳转面板">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>
      </button>
    </div>
    <ul class="palette-list" id="palette-list" role="listbox" aria-label="区块列表"></ul>
  </div>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/**
 * 登录页：`PANEL_PASSWORD` 设置后，未带有效会话 cookie 的 GET / 返回此页。
 * 与面板共用样式表；脚本只提交密码，不内联任何密钥。
 */
function renderLogin({ version = "", port = "" } = {}) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Masuk · Fucking Opencode</title>
<link rel="icon" type="image/png" href="/panel-avatar.png">
<style>${STYLE}</style>
</head>
<body>
<div class="login-wrap">
  <div class="login-card">
    <img class="login-avatar" src="/panel-avatar.png" alt="" onerror="this.hidden=true">
    <h1>Fucking Opencode</h1>
    <p class="login-sub" id="login-sub">Masuk untuk membuka panel operasi gateway.</p>
    <form id="login-form" novalidate>
      <div class="field">
        <label for="panel-pass" id="login-label">Kata sandi</label>
        <input id="panel-pass" name="password" type="password" autocomplete="current-password" required autofocus>
      </div>
      <div class="actions">
        <button class="primary" type="submit" id="login-submit">Masuk</button>
      </div>
      <p class="login-error" id="login-error" role="alert"></p>
    </form>
  </div>
</div>
<div class="login-lang seg" role="group" aria-label="Language">
  <button type="button" data-lang="zh">中文</button>
  <button type="button" data-lang="id">ID</button>
  <button type="button" data-lang="en">EN</button>
</div>
<script>
const LOGIN_I18N = {
  id: { sub: "Masuk untuk membuka panel operasi gateway.", label: "Kata sandi", button: "Masuk", wrong: "Kata sandi salah.", limited: "Terlalu banyak percobaan. Tunggu sebentar.", failed: "Gagal masuk. Coba lagi." },
  en: { sub: "Sign in to open the gateway operations panel.", label: "Password", button: "Sign in", wrong: "Wrong password.", limited: "Too many attempts. Wait a moment.", failed: "Sign-in failed. Try again." },
  zh: { sub: "登录后打开桥的运维面板。", label: "密码", button: "登录", wrong: "密码错误。", limited: "尝试次数过多，请稍后再试。", failed: "登录失败，请重试。" }
};
let lang = "id";
try {
  const saved = localStorage.getItem("gateway-panel-lang");
  if (saved === "zh" || saved === "id" || saved === "en") lang = saved;
} catch (err) {}
try {
  const theme = localStorage.getItem("gateway-panel-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (err) {}
function applyLoginLang(next) {
  lang = next;
  const dict = LOGIN_I18N[next] || LOGIN_I18N.id;
  document.documentElement.lang = next === "zh" ? "zh-CN" : next;
  document.getElementById("login-sub").textContent = dict.sub;
  document.getElementById("login-label").textContent = dict.label;
  document.getElementById("login-submit").textContent = dict.button;
  document.querySelectorAll("[data-lang]").forEach((btn) => btn.setAttribute("aria-pressed", btn.dataset.lang === next ? "true" : "false"));
}
document.querySelectorAll("[data-lang]").forEach((btn) => btn.addEventListener("click", () => {
  try { localStorage.setItem("gateway-panel-lang", btn.dataset.lang); } catch (err) {}
  applyLoginLang(btn.dataset.lang);
}));
document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const dict = LOGIN_I18N[lang] || LOGIN_I18N.id;
  const input = document.getElementById("panel-pass");
  const error = document.getElementById("login-error");
  const submit = document.getElementById("login-submit");
  error.textContent = "";
  submit.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value })
    });
    if (res.ok) {
      location.replace("/");
      return;
    }
    error.textContent = res.status === 429 ? dict.limited : dict.wrong;
  } catch (err) {
    error.textContent = dict.failed;
  } finally {
    submit.disabled = false;
  }
});
applyLoginLang(lang);
</script>
</body>
</html>`;
}

module.exports = { renderPanel, renderLogin };
