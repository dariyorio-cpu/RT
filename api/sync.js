// SI-RT/RW Digital — endpoint sinkronisasi Turso.
// Vercel Serverless Function (Node, CommonJS). BUKAN Next.js: situs tetap
// satu file HTML statis, fungsi ini hanya endpoint /api/sync.
//
// Kontrak (sama persis dengan backend Google Apps Script sebelumnya):
//   GET  ?action=ping                          -> {ok:true, service, version, time}
//   GET  ?action=load&token=...                -> {ok, exists, updatedAt, deviceId, state}
//   POST {token, action:"save", updatedAt, deviceId, state}
//        -> {ok:true, updatedAt}
//        -> {ok:false, error:"conflict", serverUpdatedAt, serverDeviceId}
//           bila updatedAt yang dikirim lebih lama dari yang tersimpan
//           (last-write-wins; perangkat yang kalah harus mengunduh dulu)
//   Tanpa token yang benar -> {ok:false, error:"unauthorized"}
// Validasi state minimal: houses/collections/expenses harus array dan
// settings harus object — sama seperti validasi backend Drive.
//
// Kredensial HANYA dari environment variable (tidak ada yang di-hardcode):
//   TURSO_DATABASE_URL  — mis. libsql://si-rt-rw-sync-....turso.io
//   TURSO_AUTH_TOKEN    — token database Turso (jangan dibagikan ke warga)
//   SYNC_TOKEN          — token sinkronisasi yang diisi pengurus di aplikasi
//                         (Super Admin > Sinkronisasi Cloud > Token)
// Seluruh state aplikasi (18 daftar data + seq) disimpan sebagai satu
// baris JSON di tabel sync_state (lihat schema.sql).

"use strict";

const { createClient } = require("@libsql/client");

const SERVICE = "si-rt-rw-sync";
const VERSION = 1;
const SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS sync_state (" +
  "id INTEGER PRIMARY KEY CHECK (id = 1), " +
  "updated_at TEXT NOT NULL, " +
  "device_id TEXT NOT NULL, " +
  "state_json TEXT NOT NULL)";

let client = null;

function getClient() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error("TURSO_DATABASE_URL belum dikonfigurasi");
  }
  // Untuk URL libsql:// (cloud), authToken wajib. Untuk file: (pengujian
  // lokal), authToken boleh kosong.
  client = createClient({ url, authToken: authToken || undefined });
  return client;
}

async function ensureSchema(db) {
  await db.execute(SCHEMA_SQL);
}

function validState(s) {
  return (
    s &&
    typeof s === "object" &&
    Array.isArray(s.houses) &&
    Array.isArray(s.collections) &&
    Array.isArray(s.expenses) &&
    s.settings &&
    typeof s.settings === "object"
  );
}

function send(res, status, obj) {
  res.status(status).json(obj);
}

function readBody(req) {
  // Vercel sudah mem-parse body untuk content-type JSON; klien aplikasi
  // mengirim text/plain, jadi body bisa berupa string yang harus di-parse.
  if (req.body === undefined || req.body === null) return null;
  if (typeof req.body === "string") {
    if (!req.body.trim()) return null;
    try {
      return JSON.parse(req.body);
    } catch (e) {
      return { __badJson: true };
    }
  }
  return req.body;
}

function getQuery(req) {
  let q = {};
  try {
    const u = new URL(req.url || "/", "http://localhost");
    u.searchParams.forEach((v, k) => {
      q[k] = v;
    });
  } catch (e) {
    /* abaikan — pakai req.query saja */
  }
  if (req.query && typeof req.query === "object") {
    Object.keys(req.query).forEach((k) => {
      q[k] = req.query[k];
    });
  }
  return q;
}

async function handlePing(res) {
  send(res, 200, {
    ok: true,
    service: SERVICE,
    version: VERSION,
    time: new Date().toISOString(),
  });
}

async function handleLoad(db, res) {
  const rs = await db.execute(
    "SELECT updated_at, device_id, state_json FROM sync_state WHERE id = 1"
  );
  if (rs.rows.length === 0) {
    send(res, 200, {
      ok: true,
      exists: false,
      updatedAt: null,
      deviceId: null,
      state: null,
    });
    return;
  }
  const row = rs.rows[0];
  let state = null;
  try {
    state = JSON.parse(row.state_json);
  } catch (e) {
    send(res, 200, { ok: false, error: "server_error", message: "state tersimpan rusak" });
    return;
  }
  send(res, 200, {
    ok: true,
    exists: true,
    updatedAt: String(row.updated_at),
    deviceId: String(row.device_id),
    state,
  });
}

async function handleSave(db, res, body) {
  if (!body || body.__badJson) {
    send(res, 400, { ok: false, error: "bad_state" });
    return;
  }
  const state = body.state;
  if (!validState(state)) {
    send(res, 400, { ok: false, error: "bad_state" });
    return;
  }
  const updatedAt = String(body.updatedAt || "");
  if (!updatedAt) {
    send(res, 400, { ok: false, error: "bad_updatedAt" });
    return;
  }
  const deviceId = String(body.deviceId || "unknown");
  const stateJson = JSON.stringify(state);

  // Upsert atomik dengan guard last-write-wins: baris hanya ditulis bila
  // belum ada baris, atau updatedAt baru >= updatedAt tersimpan. Bila
  // baris tersimpan lebih baru, tidak ada baris yang berubah (rowsAffected
  // 0) dan kita menjawab conflict — tanpa jendela balapan check-then-write.
  const rs = await db.execute({
    sql:
      "INSERT INTO sync_state (id, updated_at, device_id, state_json) " +
      "VALUES (1, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "updated_at = excluded.updated_at, " +
      "device_id = excluded.device_id, " +
      "state_json = excluded.state_json " +
      "WHERE excluded.updated_at >= sync_state.updated_at",
    args: [updatedAt, deviceId, stateJson],
  });
  if (rs.rowsAffected === 0) {
    const cur = await db.execute(
      "SELECT updated_at, device_id FROM sync_state WHERE id = 1"
    );
    const row = cur.rows[0] || {};
    send(res, 200, {
      ok: false,
      error: "conflict",
      serverUpdatedAt: String(row.updated_at || ""),
      serverDeviceId: String(row.device_id || ""),
    });
    return;
  }
  send(res, 200, { ok: true, updatedAt });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    // Token sinkronisasi klien — dicek SEBELUM aksi apa pun.
    const syncToken = process.env.SYNC_TOKEN;
    if (!syncToken) {
      send(res, 500, {
        ok: false,
        error: "server_error",
        message: "SYNC_TOKEN belum dikonfigurasi di server",
      });
      return;
    }
    const q = getQuery(req);
    const body = req.method === "POST" ? readBody(req) : null;
    const token = req.method === "POST" ? (body && body.token) || "" : q.token || "";
    if (String(token) !== syncToken) {
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const db = getClient();
    await ensureSchema(db);

    if (req.method === "GET") {
      const action = String(q.action || "ping");
      if (action === "ping") {
        await handlePing(res);
      } else if (action === "load") {
        await handleLoad(db, res);
      } else {
        send(res, 400, { ok: false, error: "unknown_action" });
      }
      return;
    }

    if (req.method === "POST") {
      const action = String((body && body.action) || "");
      if (action === "save") {
        await handleSave(db, res, body);
      } else {
        send(res, 400, { ok: false, error: "unknown_action" });
      }
      return;
    }

    send(res, 405, { ok: false, error: "unknown_action" });
  } catch (err) {
    // Jangan bocorkan detail error internal ke klien; cukup kodenya.
    try {
      send(res, 500, { ok: false, error: "server_error" });
    } catch (e) {
      /* res sudah terkirim */
    }
  }
};
