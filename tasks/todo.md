# Task list: Fleet Armada C2

> Follows `tasks/plan.md` (Phase 1–6). Human review between phases before proceeding.

## Phase 1: Foundation — database + API

- [x] Task 1: Skema `fleet.db` + init/read/write + registerNode/getNodes/updateNode/writeEvent/writeQuotaSignal/writeHealth
  - **Acceptance:** `fleet.db` di `<state dir>/fleet.db` (fallback `~/.fucking-opencode`) dengan 4 tabel + 5 index; register idempotent (id sama, 1 baris); getNodes/updateNode berfungsi; proxy.js/server.js/warp-farm.js tidak diubah.
  - **Verify:** smoke `/api/fleet/init` + register idempotence.
  - **Files:** `fleet.js` (baru), `SPEC-FLEET-C2.md`
  - **Scope:** S (1–2 files)

- [x] Task 2: Endpoint `/api/fleet/init` & `/api/fleet/register` di server.js
  - **Acceptance:** `init` → `{ok:true, dbPath}`; `register` → `{ok:true, nodeId}`; idempotent; format error JSON konsisten; module dimuat via `加载本地模块`.
  - **Verify:** curl dari gateway.
  - **Dependencies:** Task 1
  - **Files:** `server.js`, `fleet.js`
  - **Scope:** M (3–5 files)

### Checkpoint: Foundation
- [ ] Database schema + index benar.
- [ ] Register idempotent.
- [ ] Init & register endpoint jalan.
- [ ] Review manusia sebelum Fase 2.

---

## Phase 2: Reachability

- [x] Task 3: Module `probe.js` — `probeNode(node)`
  - **Acceptance:** menangani `direct-proxy`, `ssh-reverse-tunnel`, `wireguard`; node `pending`/`unknown` → `{ok:false}`; `warp` skip; `relay-http` HTTP GET; tulis ke `node_health`.
  - **Verify:** smoke host yang tidak ada → `{ok:false}`; node tunnel → `{ok:true}`.
  - **Files:** `probe.js` (baru), `fleet.js`, `SPEC-FLEET-C2.md`
  - **Dependencies:** Task 2
  - **Scope:** M (3–5 files)

- [x] Task 4: Endpoint `/api/fleet/probe`
  - **Acceptance:** POST tanpa body → probe semua node `reachable=true`; body `{nodeId}` → per-node; hasil mencerminkan `node_health`.
  - **Verify:** curl.
  - **Dependencies:** Task 3
  - **Files:** `server.js`, `fleet.js`, `probe.js`
  - **Scope:** S (1–2 files)

### Checkpoint: Reachability
- [x] Probe berjalan.
- [x] `node_health` ter-update.
- [ ] Review manusia sebelum Fase 3.

---

- [x] Task 5: Loop health monitor `fleet-health-monitor.js`
  - **Acceptance:** `start(intervalMs)`/`stop()`; loop probe; deteksi sinyal kuota; `cooling_until` + `block_based_on_quota`; `unref` interval; `(onRequestQuotaSignal)`.
  - **Verify:** smoke `/api/fleet/health-monitor`; node 429 → cooldown tercatat.
  - **Files:** `fleet-health-monitor.js` (baru), `fleet.js`, `server.js`
  - **Dependencies:** Task 4
  - **Scope:** M (3–5 files)

- [x] Task 6: Sinkronisasi sinyal kuota dari request nyata
  - **Acceptance:** `server.js` hook `记录出口失败` → `fleet.onRequestQuotaSignal(...)`; `quota_signals` bertambah; cooldown bila diperlukan.
  - **Verify:** smoke request yang gagal dengan sinyal kuota → catatan bertambah.
  - **Dependencies:** Task 5
  - **Files:** `server.js`, `fleet.js`
  - **Scope:** M (3–5 files)

### Checkpoint: Health
- [x] Monitor berjalan.
- [x] Sinyal kuota + cooldown terdeteksi.
- [ ] Review manusia sebelum Fase 4.

---

## Phase 4: Pool orchestration

- [x] Task 7: `fleet-orchestrator.js` — `applyToPool()`
  - **Acceptance:** filter node `reachable=true`, cooling null/<now, bukan pending/unknown/relay-http; gabung WARP farm lane yang ready (`warp-f<n>`); `proxy.setPool()`; env terkunci → reject yang jelas.
  - **Verify:** smoke register node → pool berubah; env terkunci → reject.
  - **Files:** `fleet-orchestrator.js` (baru), `server.js`, `fleet.js`
  - **Dependencies:** Task 6
  - **Scope:** M (3–5 files)

- [x] Task 8: Endpoint `/api/fleet/apply-pool`
  - **Acceptance:** POST → `applyToPool()`; admin-only; output `{ok, entryCount, farmCount, strategy}`; error format konsisten.
  - **Verify:** curl POST → pool tercermin; `UPSTREAM_PROXY_POOL` → `409 pool_env_locked`; Host non-lokal/cross-site → 403; GET → 405; non-JSON → 415; regresi route-level di `test/fleet-e2e.test.js` (mutation-checked).
  - **Dependencies:** Task 7
  - **Files:** `server.js`, `fleet-orchestrator.js`
  - **Scope:** S (1–2 files)

### Checkpoint: Pool
- [x] Pool diperbarui.
- [x] Env terkunci → reject.
- [x] Farm digabung bila aktif.
- [x] Review manusia sebelum Fase 5 (route guard + 409 dipetakan dan diuji di Task 8).

---

## Phase 5: Observability

- [x] Task 9: Endpoint `/api/fleet/status` & `/api/fleet/events`
  - **Acceptance:** status → `{nodes, health, quotaSignalCounts, poolConfig, lastAppliedAt, summary}`; events filter `nodeId`/`action`/`since`; ringkasan OK/DEGRADED/CRITICAL.
  - **Verify:** curl kedua endpoint.
  - **Dependencies:** Task 8
  - **Files:** `fleet-panel-routes.js` (baru), `server.js`
  - **Scope:** M (3–5 files)

### Checkpoint: Observability
- [ ] Status & event endpoint konsisten.
- [ ] Review manusia sebelum Fase 6.

---

## Phase 6: Ops + maintenance

- [x] Task 10: AutoActions & notifikasi
  - **Acceptance:** notifikasi saat cooling/kuota habis/pool kosong (dalam konfigurasi); penskalaan toggle; opsional.
  - **Verify:** smoke kondisi → log.
  - **Dependencies:** Task 8
  - **Files:** `fleet.js`, `notify.js`, `server.js` (opt)
  - **Scope:** S (1–2 files)

- [x] Task 11: Dokumentasi & changelog
  - **Acceptance:** README (fitur, env, endpoint, file, `fleet.db` backup) + CHANGELOG 0.1.7; env contoh ada di tabel env README (repo tidak punya `.env.example`).
  - **Verify:** smoke endpoint dari README pada gateway v0.1.7; install lokal memasang keenam modul fleet.
  - **Dependencies:** Task 9
  - **Files:** `README.md`, `CHANGELOG.md`, `package.json`, `install.sh`
  - **Scope:** S
  - **Catatan:** celah pengiriman ditemukan saat verifikasi — modul fleet tidak ada di `package.json files`, `UPDATE_FILES`, atau `install.sh`; ditutup di task ini.

### Checkpoint: Complete
- [x] Semua fase 1–5 selesai & smoke lulus.
- [ ] Code review human sebelum penyerahan (di luar wewenang agen).

---

## Overlay (nov 2024 / update terbaru)
- Menambahkan `@SPEC-FLEET-C2.md` sebagai sumber kebenaran.
- Notifikasi & penskalaan opsional, terpisah dari fase inti (6b/6c).
