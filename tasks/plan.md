# Implementation Plan: Fleet Armada Cerdas (C2)

**Skema desain:** `FLEET-C2-DESIGN.md` (v0.2.0, §1–11)  
**Spesifikasi lebih lanjut:** `SPEC-FLEET-C2.md`  
**Rencana pekerjaan asli:** `FLEET-C2-IMPLEMENTATION-PLAN.md`

**Batas kerja (dari desain):**
- Gateway polling keluar saja; node tidak push telemetry.
- `proxy.js` tidak diubah; `proxy.setPool()` satu-satunya jalur tulis ke `proxy.json`.
- Pool terkunci env → `apply-pool` menolak.
- Satu pool, tidak ada subset.
- `bun:sqlite` native (telah diverifikasi).

---

## Task List

### Phase 1: Foundation — database + API register

- [x] Task 1: Skema `fleet.db` + fungsi init/read write
  - **Description:** Buat module `fleet.js` baru: `状态目录()`, `DBPath()`, `initDB()`, `registerNode()`, `getNodes()`, `getNode()`, `updateNode()`, `writeEvent()`, `writeQuotaSignal()`, `writeHealth()`. Schema sesuai `SPEC-FLEET-C2.md` (§3 + §5; 4 tabel + 5 index) menggunakan `bun:sqlite` (WAL). Gunakan pola fallback yang sudah ada di repo.
  - **Acceptance criteria:**
    - [x] `fleet.db` tercipta di `<state dir>/fleet.db` (fallback `~/.fucking-opencode`), tabel & index sesuai spesifikasi.
    - [x] `registerNode()` idempotent: panggil dua kali label sama → id sama, hanya 1 baris.
    - [x] `getNodes()` mengembalikan semua node, `updateNode()` mengubah `reachable`/`last_heartbeat_at`.
    - [x] Tidak ada perubahan ke `proxy.js`, `server.js`, `warp-farm.js`, atau modul lain.
  - **Verifikasi:**
    - [ ] Smoke: `/api/fleet/init` → file db ada; `/api/fleet/register` → idempotent.
    - [ ] Grep: `grep -rn "fleet.js" server.js` → fungsi register butuh register ke internal registry jika `server.js` membutuhkannya (cek `配置`/`模块加载`).
  - **Dependencies:** None
  - **Files:** `fleet.js` (baru), `SPEC-FLEET-C2.md` (update referensi)
  - **Estimated scope:** S (1–2 files)

- [ ] Task 2: Endpoint init & register di server.js
  - **Description:** Daftarkan `/api/fleet/init` (POST) dan `/api/fleet/register` (POST) di dalam rantai route `/api/*` yang sudah ada di `server.js` (gaya yang sama dengan `/api/observability`, `/api/proxy`, dst). Respons format JSON `{ok, ...}` / `{error:{message,type,code}}` seperti modul lain.
  - **Acceptance criteria:**
    - [ ] `/api/fleet/init` → `{ok:true, dbPath}`.
    - [ ] `/api/fleet/register` dengan `{label, node_type, connect_kind, egress_spec, tags?}` → `{ok:true, nodeId}`, id dibuat server-side, idempotent.
    - [ ] Endpoint hanya bisa diakses dari session admin (cek pola di bagian route: `dashboardApi.处理` atau admin guard).
    - [ ] Module `fleet.js` dimuat via `加载本地模块("fleet", FALLBACK_FLEET)` di `server.js`.
  - **Verifikasi:**
    - [ ] Run gateway, curl `/api/fleet/init` & `/api/fleet/register` → tampilan respons sesuai akseptansi.
  - **Dependencies:** Task 1
  - **Files:** `server.js`, `fleet.js`
  - **Estimated scope:** M (3–5 files)

### Checkpoint: Foundation
- [ ] `fleet.db` terbentuk dengan schema & index benar.
- [ ] `registerNode()` idempotent, `getNodes()` berfungsi.
- [ ] `/api/fleet/init` & `/api/fleet/register` jalan dari gateway.
- [ ] Review manusia sebelum lanjut ke Fase 2.

---

### Phase 2: Reachability — probe node

- [ ] Task 3: Module `probe.js` — `probeNode(node)`
  - **Description:** Buat `probe.js` yang mengekspor `probeNode(node)`. Membaca `node.connect_kind` dan `node.egress_spec.proxyUrl`, mengeksekusi probe menggunakan mekanisme yang ada dan menulis hasil ke format `{ok, exitIp, latencyMs, httpStatus, error}`. Node `pending`/`unknown` → `{ok:false, error:"..."}`. `warp` → skip probe manual (farm sudah punya status). `relay-http` → HTTP GET ke URL relay.
  - **Acceptance criteria:**
    - [ ] `probeNode()` menangani `direct-proxy`, `ssh-reverse-tunnel`, `wireguard`.
    - [ ] Node tidak reachable/format salah → `{ok:false, error}`.
    - [ ] Hasil ditulis ke `node_health` via `fleet.writeHealth()`.
    - [ ] Tidak mengubah `proxy.js` atau `warp-farm.js`.
  - **Verifikasi:**
    - [ ] Smoke: probe node dummy ke host yang tidak ada → `{ok:false}`.
    - [ ] Smoke: probe node `socks5://127.0.0.1:9999` (jika tunnel aktif) → `{ok:true, exitIp, latencyMs}`.
  - **Dependencies:** Task 2
  - **Files:** `probe.js` (baru), `fleet.js`, `SPEC-FLEET-C2.md`
  - **Estimated scope:** M (3–5 files)

- [ ] Task 4: Endpoint `/api/fleet/probe`
  - **Description:** Tambahkan `/api/fleet/probe` (POST). Body opsional `{nodeId}`: jika kosong, probe semua node yang `reachable=true` (bukan `pending`/`unknown`). Kembalikan daftar hasil per node.
  - **Acceptance criteria:**
    - [ ] `/api/fleet/probe` tanpa body → daftar semua node yang dijawab probe.
    - [ ] `/api/fleet/probe?nodeId=x` → probe hanya node yang diminta.
    - [ ] Hasil mencerminkan `node_health` yang baru.
  - **Verifikasi:**
    - [ ] Run gateway, curl `/api/fleet/probe` → JSON daftar hasil.
  - **Dependencies:** Task 3
  - **Files:** `server.js`, `fleet.js`, `probe.js`
  - **Estimated scope:** S (1–2 files)

### Checkpoint: Reachability
- [ ] Semua node reachable berhasil di-probe.
- [ ] `node_health` ter-update dari hasil probe.
- [ ] Review manusia sebelum lanjut ke Fase 3.

---

### Phase 3: Health monitoring

- [ ] Task 5: Loop health monitor (`fleet-health-monitor.js`)
  - **Description:** Buat `fleet-health-monitor.js` ekspor `start(intervalMs)` dan `stop()`. Loop setiap interval: baca semua node, lakukan probe, tulis ke `node_health`, deteksi sinyal kuota (respon HTTP 429/403 + keyword kuota/free-tier/capacity/gate → catat `quota_signal`), set cooldown `cooling_until = now + FLEET_COOLDOWN_BASE_MS` saat `block_based_on_quota` naik, update `last_heartbeat_at` bila probe sukses. Gunakan `setInterval` + `unref` (polanya sama dengan `warp-farm.js`/`autoheal.js`).
  - **Acceptance criteria:**
    - [ ] `start()` jalan tanpa blocking proses (gateway tetap bisa mati secara normal).
    - [ ] Sinyal kuota terdeteksi dari probe + dari hook request nyata (`onRequestQuotaSignal` di `fleet.js`).
    - [ ] `quota_signals` bertambah + `node_health.cooling_until` terisi saat sinyal terdeteksi.
  - **Verifikasi:**
    - [ ] Smoke: panggil `/api/fleet/health-monitor` → `node_health` & `quota_signals` berubah.
    - [ ] Smoke: node dirubah ke 429 (proxy mock / kondisi sengaja) → cooldown tercatat.
  - **Dependencies:** Task 4
  - **Files:** `fleet-health-monitor.js` (baru), `fleet.js`, `server.js` (hook)
  - **Estimated scope:** M (3–5 files)

- [ ] Task 6: Sinkronisasi sinyal kuota dari request nyata
  - **Description:** Pada `server.js`, di handler `记录出口失败` (saat exit gagal/kuota terisi): cek apakah URL exit cocok dengan node di registry, lalu panggil `fleet.onRequestQuotaSignal(...)` yang menulis ke `quota_signals` + mark `node_health` cooldown jika diperlukan.
  - **Acceptance criteria:**
    - [ ] Hook jalan saat request nyata gagal dengan sinyal kuota.
    - [ ] `quota_signals` bertambah sesuai tipe: `429` | `quota` | `free-tier` | `capacity` | `ip-abuse`.
    - [ ] `node_health.quota_signal` & `block_based_on_quota` terkunci bila diperlukan.
  - **Verifikasi:**
    - [ ] Smoke: request keluar dari node yang terdaftar dan gagal dengan sinyal kuota → catatan `quota_signals` bertambah.
  - **Dependencies:** Task 5
  - **Files:** `server.js`, `fleet.js`
  - **Estimated scope:** M (3–5 files)

### Checkpoint: Health
- [ ] Health monitor berjalan, deteksi sinyal kuota kerja.
- [ ] Cooldown & quota signal direkam.
- [ ] Review manusia sebelum lanjut ke Fase 4.

---

### Phase 4: Pool orchestration

- [ ] Task 7: `fleet-orchestrator.js` — `applyToPool()`
  - **Description:** Buat `fleet-orchestrator.js` dengan `applyToPool()` yang baca `nodes` + `node_health` dari `fleet.js`, filter `reachable=true`, `cooling_until` null/< sekarang, `connect_kind` bukan `pending`/`unknown`/`relay-http`; baca `warpFarm.状态()` untuk gabungkan lane yang ready sebagai entry `warp-f<n>`; panggil `proxy.setPool()` dengan entry gabungan. Hanya aktif kalau pool berasal dari file (bukan env).
  - **Acceptance criteria:**
    - [ ] `applyToPool()` menghasilkan entry array gabungan node + farm lane.
    - [ ] Memanggil `proxy.setPool()` → `proxy.json` diperbarui.
    - [ ] Env terkunci → `applyToPool()` menolak dengan error yang jelas.
    - [ ] Selalu ada log/ringkasan entry yang dipakai.
  - **Verifikasi:**
    - [ ] Smoke: daftarkan 1 node reachable → `proxy.describe().pool.entries` berisi entry baru.
    - [ ] Smoke: set env `UPSTREAM_PROXY_POOL` → `/api/fleet/apply-pool` menolak.
  - **Dependencies:** Task 6
  - **Files:** `fleet-orchestrator.js` (baru), `server.js`, `fleet.js`
  - **Estimated scope:** M (3–5 files)

- [x] Task 8: Endpoint `/api/fleet/apply-pool`
  - **Acceptance criteria:**
    - [ ] Endpoint jalan dari admin.
    - [ ] Hasil mencerminkan pool baru.
    - [ ] Error dari `applyToPool()` ditampilkan dengan format error yang konsisten.
  - **Verifikasi:**
    - [ ] Run gateway, curl `/api/fleet/apply-pool` → output sesuai.
  - **Dependencies:** Task 7
  - **Files:** `server.js`, `fleet-orchestrator.js`
  - **Estimated scope:** S (1–2 files)

### Checkpoint: Pool
- [ ] Pool diperbarui lewat `/api/fleet/apply-pool`.
- [ ] Env terkunci → reject yang benar.
- [ ] WARP farm digabung bila aktif.
- [ ] Review manusia sebelum lanjut ke Fase 5.

---

### Phase 5: Observability

- [x] Task 9: Endpoint `/api/fleet/status` & `/api/fleet/events`
  - **Description:** Buat `fleet-panel-routes.js` yang mendaftarkan `/api/fleet/status` (GET) → `{nodes, health, quotaSignalCounts, poolConfig, lastAppliedAt, summary}` dan `/api/fleet/events` (GET) dengan filter `{nodeId?, action?, since?}`. Gunakan pola yang ada.
  - **Acceptance criteria:**
    - [x] `/api/fleet/status` → JSON konsisten dengan field yang disebut.
    - [x] `/api/fleet/events` → event terbaru / diff filter.
    - [x] Ringkasan kondisi pool: `OK`/`DEGRADED`/`CRITICAL`.
  - **Verifikasi:**
    - [x] Smoke: curl kedua endpoint → isi sesuai spesifikasi.
  - **Dependencies:** Task 8
  - **Files:** `fleet-panel-routes.js` (baru), `server.js`
  - **Estimated scope:** M (3–5 files)

### Checkpoint: Observability
- [ ] Status & event endpoint konsisten.
- [ ] Review manusia sebelum lanjut.

---

### Phase 6: Ops + maintenance

- [ ] Task 10: AutoActions & notifikasi
  - **Description:** Opsional: buat notifikasi ke `notify.js` saat node masuk cooling, pool kosong, atau kuota habis (panggil dari `fleet.js` callback). Penskalaan dasar: aktifkan node cadangan bila `applyToPool` kosong & ada node dengan `connect_kind` yang siap. Log icelandic.
  - **Acceptance criteria:**
    - [ ] Notifikasi dikirim saat kondisi yang ditentukan (tergantung konfigurasi operator).
    - [ ] Penskalaan hanya aktif bila operator mengaktifkannya (env toggle).
  - **Verification:**
    - [ ] Smoke: set kondisi → log notifikasi.
  - **Dependencies:** Task 8
  - **Files:** `fleet.js`, `notify.js`, `server.js` (opt)
  - **Estimated scope:** S (1–2 files)

- [ ] Task 11: Dokumentasi, changelog, migration note
  - **Description:** Update `README.md` & `CHANGELOG.md` dengan fitur baru; catat tanggung jawab `fleet.db` backup; tambahkan `FLEET_DB_PATH` & env lainnya ke contoh `.env`.
  - **Acceptance criteria:**
    - [ ] Dokumentasi mencakup fitur baru + lokasi db + env.
    - [ ] `CHANGELOG.md` ada entri baru (opsional).
  - **Dependencies:** Task 9
  - **Files:** `README.md`, `CHANGELOG.md`, `FLEET-C2-DESIGN.md` (opsional)
  - **Estimated scope:** S (1–2 files)

### Checkpoint: Complete
- [ ] Semua fase 1–5 selesai & diverifikasi.
- [ ] Semua smoke test lulus.
- [ ] Code review human sebelum merge/penyerahan.

---

## Dependencies

```
Task1 (db/schema) → Task2 (init/register)
Task2 → Task3 (probe)
Task3 → Task4 (probe endpoint)
Task4 → Task5 (health loop)
Task5 → Task6 (sinkron sinyal)
Task6 → Task7 (orchestrator)
Task7 → Task8 (apply-pool endpoint)
Task8 → Task9 (status/events)
Task9 → Task10 (autoactions)
Task10 → Task11 (docs)
```

Jalur yang harus berurutan: Task1→2→3→4→5→6→7→8→9→10→11.

---

## Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| `fleet.js` berubah terlalu sering di `server.js` | Lokasi module bisa rancu (modul lain di server.js). | Tambahkan require di posisi yang konsisten dan teruji. |
| Sinyal kuota dari probe vs request nyata tumpang tindih | Reset cooldown terlalu agresif | Prioritaskan sinyal dari hook request nyata; probe cuma memperkuat. |
| `proxy.setPool` menolak entry | Pool tidak berubah karena schema/entry tidak sesuai | Error handling memadai di `applyToPool` + smoke test dulu. |
| Env terkunci | `apply-pool` selalu menolak (intentional) | Mendokumentasikan semua, komunikasi ke operator. |
| Free-tier runner mereka tidak pingable | Node `relay-http` tetap masuk registry, reachability false → tidak masuk pool | Filter `reachable=false` secara otomatis. |

---

## Pertanyaan terbuka untuk manusia

1. **Tunnel NAT sudah keluar?** Berapa VPS NAT yang sudah punya proxy URL (SSH reverse / WireGuard)? Kalau belum, node NAT akan menunggu sampai tunnel dibuat.
2. **Runner free dipakai?** Cloudflare/Netlify sebagai relay HTTP → dipakai tidak? Ada URL masuk?
3. **Pool terkunci env?** Apakah `UPSTREAM_PROXY_POOL` / `UPSTREAM_PROXY_URL` terisi saat ini? Kalau ya, Fase 4 `apply-pool` menolak — dua opsi: kosongkan env, atau hapus batasan tersebut.

Simpan `tasks/todo.md` dan `tasks/plan.md` berikut saat review manusia selesai.

---

**Catatan kontribusi:** (opsional, diisi oleh penulis)
