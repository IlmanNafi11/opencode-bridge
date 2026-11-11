package main

// This directory is a separate program that speaks SOCKS5 to the gateway. It
// is adapted from:
//
//   github.com/jasonxu114514/opencode2api  (internal/warp, internal/identity)
//     GPL-3.0 — registration envelope, freebind bind, exit probe, egress /64
//     scope, WARP stack selection.
//
//   github.com/sudogeeker/ai-route  (upstream of the above)
//     MIT — original WARP registration and netstack tunnel layout.
//
// Changes from the reference: the pool/lease manager and HTTP gateway are
// dropped; each lane owns one listener and one exit, rotation swaps the exit
// in place, and the control surface is a small loopback HTTP JSON API.
//
// Because it is derived from GPL-3.0 code, this directory is licensed
// GPL-3.0-or-later (see LICENSE). The rest of fucking-opencode is not part of
// this program and keeps its own license. The gateway only talks to this
// process over SOCKS5 and HTTP, so no GPL code is linked into server.js.
