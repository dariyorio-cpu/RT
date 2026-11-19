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
//   POST {action:"auth", nama, pin}            -> TANPA token sinkron:
//        memvalidasi nama+PIN terhadap state yang tersimpan di
//        Turso (pengguna bernama di state.users, nama Super Admin di
//        state.nama, atau PIN peran bawaan di state.pins), lalu
//        mengembalikan {ok:true, sessionToken, state,
//        updatedAt, deviceId, peran, nama, userId}. Peran ditentukan
//        dari nama+PIN yang cocok — klien tidak lagi memilih peran.
//        sessionToken berlaku 30 hari dan bisa dipakai sebagai
//        pengganti SYNC_TOKEN untuk ping/load/save (hanya lewat body
//        POST — TIDAK PERNAH lewat URL).
//        PIN/nama salah -> {ok:false, error:"auth_gagal"} (sama untuk
//        nama salah maupun PIN salah); 5x salah -> terkunci 15 menit
//        ({ok:false, error:"locked"}); belum ada state tersimpan ->
//        {ok:false, error:"no_account"}.
//        Kompatibel mundur: klien lama yang masih mengirim "peran"
//        tetap dilayani dengan perilaku lama (pengguna bernama harus
//        cocok peran+nama; kunci peran|nama / peran|*).
// Validasi state minimal: houses/collections/expenses harus array dan
// settings harus object — sama seperti validasi backend Drive.
//
// Kredensial HANYA dari environment variable (tidak ada yang di-hardcode):
//   TURSO_DATABASE_URL  — mis. libsql://si-rt-rw-sync-....turso.io
//   TURSO_AUTH_TOKEN    — token database Turso (jangan dibagikan ke warga)
//   SYNC_TOKEN          — token sinkronisasi yang diisi pengurus di aplikasi
//                         (Super Admin > Sinkronisasi Cloud > Token)
// Seluruh state aplikasi (18 daftar data + seq) disimpan sebagai satu
// baris JSON di tabel sync_state (lihat schema.sql). Sesi server (tabel
// sessions) dan kunci percobaan gagal (tabel auth_locks) dibuat otomatis
// per request seperti sync_state. Token sesi hanya disimpan sebagai
// sha256 — nilai aslinya tidak pernah tersimpan di database dan tidak
// pernah ditulis ke log.

"use strict";

const crypto = require("crypto");
const { createClient } = require("@libsql/client");

const SERVICE = "si-rt-rw-sync";
const VERSION = 1;
const SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS sync_state (" +
  "id INTEGER PRIMARY KEY CHECK (id = 1), " +
  "updated_at TEXT NOT NULL, " +
  "device_id TEXT NOT NULL, " +
  "state_json TEXT NOT NULL)";
const SCHEMA_SESSIONS_SQL =
  "CREATE TABLE IF NOT EXISTS sessions (" +
  "token_hash TEXT PRIMARY KEY, " +
  "peran TEXT NOT NULL, " +
  "nama TEXT NOT NULL, " +
  "user_id TEXT, " +
  "expires_at TEXT NOT NULL)";
const SCHEMA_LOCKS_SQL =
  "CREATE TABLE IF NOT EXISTS auth_locks (" +
  "kunci TEXT PRIMARY KEY, " +
  "gagal INTEGER NOT NULL DEFAULT 0, " +
  "terkunci_sampai TEXT)";

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
  await db.execute(SCHEMA_SESSIONS_SQL);
  await db.execute(SCHEMA_LOCKS_SQL);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

/* Baca baris state tersimpan. Mengembalikan null bila belum ada baris,
   {corrupt:true} bila JSON-nya rusak, atau {updatedAt, deviceId, state}. */
async function loadStateRow(db) {
  const rs = await db.execute(
    "SELECT updated_at, device_id, state_json FROM sync_state WHERE id = 1"
  );
  if (rs.rows.length === 0) return null;
  const row = rs.rows[0];
  let state = null;
  try {
    state = JSON.parse(row.state_json);
  } catch (e) {
    return { corrupt: true };
  }
  return {
    updatedAt: String(row.updated_at),
    deviceId: String(row.device_id),
    state,
  };
}

/* Otorisasi ping/load/save. SYNC_TOKEN selalu diterima (GET maupun POST).
   Token sesi hanya diterima lewat body POST — token sesi tidak boleh
   masuk ke URL (query string), jadi GET hanya mengenal SYNC_TOKEN. */
async function authorize(db, token, syncToken, allowSession) {
  if (!token) return false;
  if (token === syncToken) return true;
  if (!allowSession) return false;
  const now = new Date().toISOString();
  const rs = await db.execute({
    sql: "SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?",
    args: [sha256Hex(token), now],
  });
  return rs.rows.length > 0;
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
  const row = await loadStateRow(db);
  if (row === null) {
    send(res, 200, {
      ok: true,
      exists: false,
      updatedAt: null,
      deviceId: null,
      state: null,
    });
    return;
  }
  if (row.corrupt) {
    send(res, 200, { ok: false, error: "server_error", message: "state tersimpan rusak" });
    return;
  }
  send(res, 200, {
    ok: true,
    exists: true,
    updatedAt: row.updatedAt,
    deviceId: row.deviceId,
    state: row.state,
  });
}

/* Masuk dengan akun server (nama + PIN yang tersimpan di Turso).
   Dipanggil TANPA token sinkron. Peran ditentukan dari nama+PIN yang
   cocok — klien tidak lagi memilih peran. Urutan pencocokan:
     a. pengguna bernama aktif di state.users dengan nama yang sama
        (trim, case-insensitive); PIN menentukan bila nama sama ada di
        dua peran; PIN tidak cocok dengan satu pun -> gagal;
     b. bila tidak ada pengguna bernama itu: nama cocok dengan nama
        Super Admin dari penyiapan (settings.namaSuperAdmin, atau
        state.nama sebagai cadangan) -> cek PIN Super Admin; bila
        tidak cocok lanjut ke (c);
     c. PIN cocok dengan TEPAT SATU dari ketiga PIN peran bawaan
        (superadmin/bendahara/petugas) -> masuk sebagai peran itu
        dengan nama yang diketik.
   Kunci percobaan gagal memakai nama saja (nama-lower).
   Kompatibel mundur: bila body masih menyertakan "peran" yang valid,
   dipakai perilaku lama (pengguna bernama harus cocok peran+nama,
   jatuh ke PIN peran itu; kunci peran|nama / peran|*).
   Mengembalikan state utuh + sessionToken bila cocok. Pesan gagal
   sengaja sama untuk nama salah maupun PIN salah, dan tidak pernah
   mengembalikan daftar pengguna/PIN. */
async function handleAuth(db, res, body) {
  if (!body || body.__badJson) {
    send(res, 400, { ok: false, error: "bad_state" });
    return;
  }
  const nama = String(body.nama || "").trim();
  const pin = String(body.pin || "").trim();
  const peranLama = String(body.peran || "").trim();
  const modeLama =
    ["petugas", "bendahara", "admin", "superadmin", "warga"].indexOf(peranLama) >= 0;
  if (!nama || !pin) {
    send(res, 200, { ok: false, error: "auth_gagal" });
    return;
  }
  const now = new Date().toISOString();
  // Hapus sesi kedaluwarsa secara oportunistik.
  try {
    await db.execute({
      sql: "DELETE FROM sessions WHERE expires_at <= ?",
      args: [now],
    });
  } catch (e) {
    /* abaikan — pembersihan oportunistik, bukan syarat masuk */
  }
  const row = await loadStateRow(db);
  if (row === null) {
    send(res, 200, { ok: false, error: "no_account" });
    return;
  }
  if (row.corrupt) {
    send(res, 200, { ok: false, error: "server_error" });
    return;
  }
  const state = row.state || {};
  const namaKecil = nama.toLowerCase();
  const users = Array.isArray(state.users) ? state.users : [];
  const pins = state.pins || {};
  let peran = null;
  let userId = null;
  let namaSesi = nama;
  let cocok = false;
  let kunci = namaKecil;
  if (modeLama) {
    // --- Perilaku lama (klien lama masih mengirim peran) ---
    let named = null;
    users.forEach(function (u) {
      if (
        !named &&
        u &&
        u.peran === peranLama &&
        u.aktif !== false &&
        String(u.nama || "").trim().toLowerCase() === namaKecil
      ) {
        named = u;
      }
    });
    kunci = named ? peranLama + "|" + namaKecil : peranLama + "|*";
    if (named) {
      cocok = String(named.pin || "") !== "" && String(named.pin || "") === pin;
      if (cocok) {
        peran = named.peran;
        userId = named.id !== undefined && named.id !== null ? String(named.id) : null;
        namaSesi = String(named.nama || nama);
      }
    } else {
      const pinPeran = pins[peranLama];
      cocok = !!pinPeran && String(pinPeran) === pin;
      if (cocok) peran = peranLama;
    }
  } else {
    // --- Nama + PIN saja: peran ditentukan dari yang cocok ---
    const bernama = users.filter(function (u) {
      return (
        u &&
        u.aktif !== false &&
        String(u.nama || "").trim().toLowerCase() === namaKecil
      );
    });
    if (bernama.length > 0) {
      // (a) Pengguna bernama — PIN menentukan bila nama sama ada di dua peran.
      let ketemu = null;
      bernama.forEach(function (u) {
        if (!ketemu && String(u.pin || "") !== "" && String(u.pin || "") === pin) ketemu = u;
      });
      if (ketemu) {
        cocok = true;
        peran = ketemu.peran;
        userId = ketemu.id !== undefined && ketemu.id !== null ? String(ketemu.id) : null;
        namaSesi = String(ketemu.nama || nama);
      }
      // PIN tidak cocok dengan satu pun pengguna bernama itu -> gagal.
    } else if (String((state.settings && state.settings.namaSuperAdmin) || state.nama || "").trim().toLowerCase() === namaKecil) {
      // (b) Nama Super Admin dari penyiapan pertama (ikut tersinkron
      // di settings.namaSuperAdmin; state.nama sebagai cadangan).
      const pinSA = pins.superadmin;
      if (pinSA && String(pinSA) === pin) {
        cocok = true;
        peran = "superadmin";
      }
      // Bila PIN Super Admin tidak cocok, lanjut ke (c).
    }
    if (!cocok && bernama.length === 0) {
      // (c) PIN peran bawaan — harus cocok dengan TEPAT SATU peran.
      const cocokPeran = [];
      ["superadmin", "bendahara", "petugas"].forEach(function (r) {
        const p = pins[r];
        if (p && String(p) === pin) cocokPeran.push(r);
      });
      if (cocokPeran.length === 1) {
        cocok = true;
        peran = cocokPeran[0];
      }
    }
  }
  const lock = await db.execute({
    sql: "SELECT gagal, terkunci_sampai FROM auth_locks WHERE kunci = ?",
    args: [kunci],
  });
  if (lock.rows.length > 0) {
    const sampai = String(lock.rows[0].terkunci_sampai || "");
    if (sampai && sampai > now) {
      send(res, 200, { ok: false, error: "locked" });
      return;
    }
  }
  if (!cocok) {
    // Gagal: tambah hitungan; 5x gagal -> kunci 15 menit. Satu pernyataan
    // atomik (tidak ada jendela balapan check-then-write).
    const sampaiBaru = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await db.execute({
      sql:
        "INSERT INTO auth_locks (kunci, gagal, terkunci_sampai) VALUES (?, 1, NULL) " +
        "ON CONFLICT(kunci) DO UPDATE SET gagal = auth_locks.gagal + 1, " +
        "terkunci_sampai = CASE WHEN auth_locks.gagal + 1 >= 5 THEN ? ELSE auth_locks.terkunci_sampai END",
      args: [kunci, sampaiBaru],
    });
    send(res, 200, { ok: false, error: "auth_gagal" });
    return;
  }
  // Sukses: hapus kunci percobaan, buat token sesi 30 hari.
  await db.execute({ sql: "DELETE FROM auth_locks WHERE kunci = ?", args: [kunci] });
  const tokenSesi = crypto.randomBytes(32).toString("hex");
  const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.execute({
    sql: "INSERT INTO sessions (token_hash, peran, nama, user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
    args: [sha256Hex(tokenSesi), peran, namaSesi, userId, exp],
  });
  send(res, 200, {
    ok: true,
    sessionToken: tokenSesi,
    state,
    updatedAt: row.updatedAt,
    deviceId: row.deviceId,
    peran,
    nama: namaSesi,
    userId,
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

    // Aksi auth tidak memakai token sinkron — dicek SEBELUM pemeriksaan
    // SYNC_TOKEN, supaya masuk dengan akun server tetap bisa walau
    // SYNC_TOKEN belum dikonfigurasi di server.
    const q = getQuery(req);
    const body = req.method === "POST" ? readBody(req) : null;

    const db = getClient();
    await ensureSchema(db);

    if (req.method === "POST" && body && body.action === "auth") {
      await handleAuth(db, res, body);
      return;
    }

    // Token sinkronisasi klien — dicek SEBELUM aksi ping/load/save.
    const syncToken = process.env.SYNC_TOKEN;
    if (!syncToken) {
      send(res, 500, {
        ok: false,
        error: "server_error",
        message: "SYNC_TOKEN belum dikonfigurasi di server",
      });
      return;
    }
    const token = req.method === "POST" ? (body && body.token) || "" : q.token || "";
    // Token sesi hanya diterima lewat body POST (tidak pernah lewat URL).
    const okAuth = await authorize(db, String(token), syncToken, req.method === "POST");
    if (!okAuth) {
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

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
      } else if (action === "load") {
        // Muat lewat POST dipakai perangkat yang masuk lewat akun server,
        // supaya token sesi tidak masuk ke URL.
        await handleLoad(db, res);
      } else if (action === "ping") {
        await handlePing(res);
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
