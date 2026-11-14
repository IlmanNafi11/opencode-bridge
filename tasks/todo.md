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
- [ ] Probe berjalan.
- [ ] `node_health` ter-update.
- [ ] Review manusia sebelum Fase 3.

---

## Phase 3: Health monitoring

- [ ] Task 5: Loop health monitor `fleet-health-monitor.js`
  - **Acceptance:** `start(intervalMs)`/`stop()`; loop probe; deteksi sinyal kuota; `cooling_until` + `block_based_on_quota`; `unref` interval; `(onRequestQuotaSignal)`.
  - **Verify:** smoke `/api/fleet/health-monitor`; node 429 → cooldown tercatat.
  - **Files:** `fleet-health-monitor.js` (baru), `fleet.js`, `server.js`
  - **Dependencies:** Task 4
  - **Scope:** M (3–5 files)

- [ ] Task 6: Sinkronisasi sinyal kuota dari request nyata
  - **Acceptance:** `server.js` hook `记录出口失败` → `fleet.onRequestQuotaSignal(...)`; `quota_signals` bertambah; cooldown bila diperlukan.
  - **Verify:** smoke request yang gagal dengan sinyal kuota → catatan bertambah.
  - **Dependencies:** Task 5
  - **Files:** `server.js`, `fleet.js`
  - **Scope:** M (3–5 files)

### Checkpoint: Health
- [ ] Monitor berjalan.
- [ ] Sinyal kuota + cooldown terdeteksi.
- [ ] Review manusia sebelum Fase 4.

---

## Phase 4: Pool orchestration

- [ ] Task 7: `fleet-orchestrator.js` — `applyToPool()`
  - **Acceptance:** filter node `reachable=true`, cooling null/<now, bukan pending/unknown/relay-http; gabung WARP farm lane yang ready (`warp-f<n>`); `proxy.setPool()`; env terkunci → reject yang jelas.
  - **Verify:** smoke register node → pool berubah; env terkunci → reject.
  - **Files:** `fleet-orchestrator.js` (baru), `server.js`, `fleet.js`
  - **Dependencies:** Task 6
  - **Scope:** M (3–5 files)

- [ ] Task 8: Endpoint `/api/fleet/apply-pool`
  - **Acceptance:** POST → `applyToPool()`; admin-only; output `{ok, entryCount, farmCount, strategy}`; error format konsisten.
  - **Verify:** curl.
  - **Dependencies:** Task 7
  - **Files:** `server.js`, `fleet-orchestrator.js`
  - **Scope:** S (1–2 files)

### Checkpoint: Pool
- [ ] Pool diperbarui.
- [ ] Env terkunci → reject.
- [ ] Farm digabung bila aktif.
- [ ] Review manusia sebelum Fase 5.

---

## Phase 5: Observability

- [ ] Task 9: Endpoint `/api/fleet/status` & `/api/fleet/events`
  - **Acceptance:** status → `{nodes, healthSummarize, quotaSignalCounts, poolConfig, lastAppliedAt}`; events filter; ringkasan OK/DEGRADED/CRITICAL.
  - **Verify:** curl kedua endpoint.
  - **Dependencies:** Task 8
  - **Files:** `fleet-panel-routes.js` (baru), `server.js`
  - **Scope:** M (3–5 files)

### Checkpoint: Observability
- [ ] Status & event endpoint konsisten.
- [ ] Review manusia sebelum Fase 6.

---

## Phase 6: Ops + maintenance

- [ ] Task 10: AutoActions & notifikasi
  - **Acceptance:** notifikasi saat cooling/kuota habis/pool kosong (dalam konfigurasi); penskalaan toggle; opsional.
  - **Verify:** smoke kondisi → log.
  - **Dependencies:** Task 8
  - **Files:** `fleet.js`, `notify.js`, `server.js` (opt)
  - **Scope:** S (1–2 files)

- [ ] Task 11: Dokumentasi & changelog
  - **Acceptance:** README + CHANGELOG hadir; env contoh; db backup note.
  - **Dependencies:** Task 9
  - **Files:** `README.md`, `CHANGELOG.md`
  - **Scope:** S (1–2 files)

### Checkpoint: Complete
- [ ] Semua fase 1–5 selesai & smoke lulus.
- [ ] Code review human sebelum penyerahan.

---

## Overlay (nov 2024 / update terbaru)
- Menambahkan `@SPEC-FLEET-C2.md` sebagai sumber kebenaran.
- Notifikasi & penskalaan opsional, terpisah dari fase inti (6b/6c).
