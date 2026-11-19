# SI-RT/RW Digital — Jimpitan Warga RT

Aplikasi web RT/RW dengan fitur utama **Jimpitan Harian** + modul Manajemen RT/RW Versi 2.

Tampilan disamakan dengan video demo SI-RT/RW Digital V2: halaman depan publik (hero "Bersama Warga, Membangun Lingkungan yang Nyaman dan Harmonis"), warna biru Bootstrap `#0d6efd`, font Inter, dan sidebar admin.

## Aturan yang terkunci

- Jimpitan **Rp500 per rumah per hari**, keliling setiap hari.
- **Jadwal Keliling**: admin menetapkan kelompok yang bertugas per tanggal (menu Jadwal Keliling); hanya anggota kelompok yang bertugas pada tanggal itu yang bisa mencatat setoran — berlaku untuk semua peran, termasuk Super Admin. Tanpa jadwal aktif, tidak ada yang bisa mencatat.
- Setoran **Rp1.000 otomatis terpecah** jadi Rp500 jimpitan + Rp500 kelebihan. Kelebihan tercatat terpisah tapi sumbernya tetap terlihat (nomor rumah, tanggal, petugas).
- Peran terpisah: **Petugas** mencatat, **Bendahara** memverifikasi dan mengelola kas, **Warga** hanya melihat transparansi.
- Koreksi pakai status batal beralasan, bukan hapus data.

## Modul RT/RW (dari script Manajemen RTRW V2)

- Profil Warga & KK, Ceklist Iuran Bulanan Rp20.000/KK (nominal bisa diubah di Pengaturan)
- Arus Kas gabungan: saldo = jimpitan + iuran − pengeluaran
- Layanan Warga: Pengumuman, Agenda, Surat, Peminjaman Aset, Aset, Pengaduan, UMKM, Jejak Aktivitas (Audit Log)
- Direktori UMKM dengan tombol Chat WhatsApp ke pemilik usaha
- Laporan bulanan (unduh CSV) dan cadangan data JSON (ekspor/impor)

## File

- `index.html` — aplikasi lengkap dalam satu file statis (tanpa build step, tanpa server).
- `vercel.json` — konfigurasi Vercel.

## Deploy gratis ke Vercel

1. Push repo ini ke GitHub (sudah di `main`).
2. Buka [vercel.com](https://vercel.com) → Add New → Project → Import repo ini.
3. Framework Preset: **Other**. Build Command dan Output Directory dikosongkan.
4. Deploy. Selesai — tidak ada biaya di paket Hobby Vercel.

## Catatan data (penting)

Versi statis ini menyimpan data di perangkat yang dipakai (in-memory) dan dipindahkan antarperangkat lewat **ekspor/impor cadangan JSON** di dalam aplikasi (menu Deploy / Pengaturan). Tidak ada sinkronisasi otomatis antarperangkat. Untuk sinkronisasi otomatis, gunakan versi utama (server) dari aplikasi ini.

## Menjalankan lokal

Buka `index.html` langsung di browser, atau jalankan server statis apa pun, contoh:

```sh
npx serve .
```

