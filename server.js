const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   SUPABASE
========================= */
const rawSupabaseUrl = String(process.env.SUPABASE_URL || "").trim();
// Render/Supabase users sometimes paste a URL ending with /storage/v1 or /rest/v1.
// createClient expects the project root URL, so normalize those accidental suffixes.
const SUPABASE_URL = rawSupabaseUrl.replace(/\/(storage\/v1|rest\/v1)\/?$/i, "").replace(/\/+$/, "");
const SUPABASE_KEY =
  String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Не задані SUPABASE_URL та SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function looksLikeAnonJwt(key) {
  try {
    const parts = String(key).split(".");
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload?.role === "anon" || payload?.role === "authenticated";
  } catch { return false; }
}

const USING_PUBLIC_JWT = looksLikeAnonJwt(SUPABASE_KEY);
if (USING_PUBLIC_JWT) {
  console.warn("⚠️ SUPABASE_SERVICE_ROLE_KEY схожий на public/anon JWT. Завантаження файлів може бути заблоковане RLS.");
}

const VIDEO_BUCKET = "videos";
const THUMBNAIL_BUCKET = "thumbnails";
const AVATAR_BUCKET = "avatars";
const BANNER_BUCKET = "banners";
const THUMBNAIL_UPLOAD_BUCKET = THUMBNAIL_BUCKET;

/* =========================
   EXPRESS
========================= */
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(express.static(__dirname, { index: "index.html", maxAge: "1h" }));

/* =========================
   DATABASE
========================= */
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL не встановлено");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function q(sql, params = []) {
  return pool.query(sql, params);
}

/* =========================
   HELPERS
========================= */
function id() {
  return crypto.randomUUID();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function ident(req, res) {
  let key = req.cookies.lt_identity;
  if (!key || !/^[0-9a-f-]{36}$/i.test(key)) {
    key = id();
    res.cookie("lt_identity", key, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 365 * 5,
      path: "/"
    });
  }
  return key;
}

function isOwner(req) {
  return req.cookies.lt_owner === "1";
}

function isImage(file) {
  return /^image\/(jpeg|png|webp)$/i.test(file.mimetype);
}

function publicUrl(bucket, filePath) {
  return supabase.storage.from(bucket).getPublicUrl(filePath).data.publicUrl;
}

async function uploadToStorage(bucket, file, forcedExt = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase не налаштований у Render");
  const ext = forcedExt || path.extname(file.originalname).toLowerCase() || ".bin";
  const filePath = `${crypto.randomUUID()}${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(filePath, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
    cacheControl: "31536000"
  });
  if (error) throw new Error(`Supabase: ${error.message}`);
  return { path: filePath, url: publicUrl(bucket, filePath) };
}

function storagePath(url, bucket) {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const i = String(url).indexOf(marker);
  if (i < 0) return null;
  return decodeURIComponent(String(url).slice(i + marker.length));
}

async function deleteFromStorage(bucket, url) {
  const p = storagePath(url, bucket);
  if (!p) return;
  const { error } = await supabase.storage.from(bucket).remove([p]);
  if (error) console.warn(`Storage delete ${bucket}: ${error.message}`);
}

async function ensureBucket(name) {
  // Storage must never prevent the web server from starting.
  // If the bucket is missing, the upload endpoint will return a clear error.
  try {
    const { data, error } = await supabase.storage.getBucket(name);
    if (data) {
      // Public URLs are used by the player/cards, so keep these buckets public.
      try {
        const { error: updateError } = await supabase.storage.updateBucket(name, { public: true });
        if (updateError) console.warn(`⚠️ Bucket ${name} є, але не вдалося зробити public: ${updateError.message}`);
      } catch (e) {
        console.warn(`⚠️ Не вдалося оновити bucket ${name}: ${e.message}`);
      }
      return true;
    }
    if (error && /not found|404/i.test(error.message || "")) {
      const { error: createError } = await supabase.storage.createBucket(name, { public: true });
      if (!createError || /already exists/i.test(createError.message || "")) return true;
      console.warn(`⚠️ Bucket ${name} не створено: ${createError.message}`);
      return false;
    }
    if (error) console.warn(`⚠️ Не вдалося перевірити bucket ${name}: ${error.message}`);
  } catch (e) {
    console.warn(`⚠️ Storage ${name} тимчасово недоступний: ${e.message}`);
  }
  return false;
}

/* =========================
   UPLOADS
========================= */
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(isImage(file) ? null : new Error("Потрібне JPG, PNG або WebP"), isImage(file))
});

const videoLimitMb = Math.max(10, Number(process.env.MAX_FILE_SIZE_MB || 100));
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: videoLimitMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^(video\/(mp4|webm|quicktime)|image\/(jpeg|png|webp))$/i.test(file.mimetype);
    cb(ok ? null : new Error("Підтримуються MP4, WebM, MOV, JPG, PNG, WebP"), ok);
  }
});

/* =========================
   DATABASE INIT / MIGRATION
========================= */
async function init() {
  await q(`CREATE TABLE IF NOT EXISTS profiles(
    id UUID PRIMARY KEY,
    username TEXT NOT NULL,
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS channels(
    id UUID PRIMARY KEY,
    owner_profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    banner_url TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS videos(
    id UUID PRIMARY KEY,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    thumbnail_url TEXT DEFAULT '',
    video_url TEXT NOT NULL,
    views BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS subscriptions(
    id BIGSERIAL PRIMARY KEY,
    subscriber_key TEXT NOT NULL,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(subscriber_key, channel_id)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS video_likes(
    id BIGSERIAL PRIMARY KEY,
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    user_key TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(video_id, user_key)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS comments(
    id UUID PRIMARY KEY,
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    user_key TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);

  // V3.1 stored some images as truncated data URLs. They cannot be displayed reliably;
  // clear only those legacy broken values so new Supabase URLs work correctly.
  await q(`UPDATE profiles SET avatar_url='' WHERE avatar_url LIKE 'data:%'`);
  await q(`UPDATE channels SET avatar_url='' WHERE avatar_url LIKE 'data:%' OR banner_url LIKE 'data:%'`);

  await q(`CREATE INDEX IF NOT EXISTS videos_created_idx ON videos(created_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS comments_video_idx ON comments(video_id, created_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS channels_name_idx ON channels(name)`);

  // Storage checks are deliberately non-fatal. A bad/missing bucket must not
  // make Render crash during boot. Existing PostgreSQL data remains untouched.
  const storageResults = await Promise.all([
    ensureBucket(VIDEO_BUCKET),
    ensureBucket(THUMBNAIL_BUCKET),
    ensureBucket(AVATAR_BUCKET),
    ensureBucket(BANNER_BUCKET)
  ]);
  console.log(`✅ Database initialized. Storage ready: ${storageResults.filter(Boolean).length}/4 buckets`);
}

/* =========================
   HEALTH / HOME
========================= */
app.get("/api/storage-status", async (req, res) => {
  const result = {};
  for (const bucket of [VIDEO_BUCKET, THUMBNAIL_BUCKET]) {
    try {
      const { data, error } = await supabase.storage.getBucket(bucket);
      result[bucket] = !!data && !error;
    } catch { result[bucket] = false; }
  }
  res.json({ ok: true, buckets: result, publicKeyDetected: USING_PUBLIC_JWT });
});

app.get("/health", (req, res) => res.json({ ok: true, service: "LimeTube" }));

app.get("/api/home", async (req, res) => {
  try {
    const v = await q(`SELECT
      v.*, c.name AS channel_name, c.avatar_url AS channel_avatar,
      (SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) AS subscribers,
      (SELECT count(*) FROM video_likes l WHERE l.video_id=v.id) AS likes
      FROM videos v JOIN channels c ON c.id=v.channel_id
      ORDER BY v.created_at DESC LIMIT 100`);
    res.json({ videos: v.rows });
  } catch (e) {
    console.error("HOME ERROR", e);
    res.status(500).json({ error: "Не вдалося завантажити відео" });
  }
});

/* =========================
   SEARCH
========================= */
app.get("/api/search", async (req, res) => {
  try {
    const term = String(req.query.q || "").trim();
    if (!term) return res.json({ channels: [], videos: [] });
    const like = `%${term}%`;
    const [channels, videos] = await Promise.all([
      q(`SELECT c.*,
        (SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) AS subscribers
        FROM channels c
        WHERE c.name ILIKE $1 OR c.description ILIKE $1
        ORDER BY c.created_at DESC LIMIT 50`, [like]),
      q(`SELECT v.*, c.name AS channel_name, c.avatar_url AS channel_avatar,
        (SELECT count(*) FROM video_likes l WHERE l.video_id=v.id) AS likes
        FROM videos v JOIN channels c ON c.id=v.channel_id
        WHERE v.title ILIKE $1 OR v.description ILIKE $1 OR c.name ILIKE $1
        ORDER BY v.created_at DESC LIMIT 100`, [like])
    ]);
    res.json({ channels: channels.rows, videos: videos.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   PROFILE
========================= */
app.get("/api/profile", async (req, res) => {
  try {
    const r = await q("SELECT * FROM profiles WHERE id=$1", [ident(req, res)]);
    res.json(r.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: "Не вдалося завантажити профіль" });
  }
});

function validImageUrl(value, maxChars = 2000) {
  if (!value) return true;
  const s = String(value).trim();
  return s.length <= maxChars && /^https?:\/\//i.test(s);
}

app.post("/api/profile", async (req, res) => {
  try {
    const profile = ident(req, res);
    const username = String(req.body.username || "").trim();
    const bio = String(req.body.bio || "");
    const avatarUrl = String(req.body.avatar_url || "");
    if (username.length < 2) return res.status(400).json({ error: "Вкажи ім'я мінімум з 2 символів" });
    if (!validImageUrl(avatarUrl)) return res.status(400).json({ error: "Некоректна аватарка" });

    const r = await q(`INSERT INTO profiles(id,username,bio,avatar_url)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET username=$2,bio=$3,avatar_url=$4
      RETURNING *`, [profile, username.slice(0, 40), bio.slice(0, 500), avatarUrl.slice(0, 2000)]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/upload-image", imageUpload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Вибери зображення" });
    const type = ["banner", "thumbnail", "avatar"].includes(req.body.type) ? req.body.type : "avatar";
    const bucket = type === "banner" ? BANNER_BUCKET : type === "thumbnail" ? THUMBNAIL_UPLOAD_BUCKET : AVATAR_BUCKET;
    const out = await uploadToStorage(bucket, req.file);
    res.json({ url: out.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* =========================
   MY CHANNEL
========================= */
app.get("/api/profile/channel", async (req, res) => {
  try {
    const r = await q(`SELECT c.*,
      (SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) AS subscribers
      FROM channels c WHERE c.owner_profile_id=$1
      ORDER BY c.created_at DESC LIMIT 1`, [ident(req, res)]);
    res.json(r.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/channel", async (req, res) => {
  try {
    const profile = ident(req, res);
    const p = await q("SELECT id FROM profiles WHERE id=$1", [profile]);
    if (!p.rows.length) return res.status(400).json({ error: "Спочатку створи профіль" });

    const exists = await q("SELECT id FROM channels WHERE owner_profile_id=$1 LIMIT 1", [profile]);
    if (exists.rows.length) return res.status(400).json({ error: "У тебе вже є канал" });

    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Потрібна назва каналу" });
    if (!validImageUrl(req.body.avatar_url) || !validImageUrl(req.body.banner_url)) return res.status(400).json({ error: "Некоректна аватарка або банер" });

    const r = await q(`INSERT INTO channels(id,owner_profile_id,name,description,avatar_url,banner_url)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [
      id(), profile, name.slice(0, 80), String(req.body.description || "").slice(0, 1000),
      String(req.body.avatar_url || "").slice(0, 2000), String(req.body.banner_url || "").slice(0, 2000)
    ]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   CHANNEL
========================= */
app.get("/api/channels/:id", async (req, res) => {
  try {
    const c = await q(`SELECT c.*,
      (SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) AS subscribers
      FROM channels c WHERE c.id=$1`, [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: "Канал не знайдено" });

    const v = await q(`SELECT v.*,
      (SELECT count(*) FROM video_likes l WHERE l.video_id=v.id) AS likes
      FROM videos v WHERE v.channel_id=$1 ORDER BY v.created_at DESC`, [req.params.id]);

    res.json({
      channel: c.rows[0],
      videos: v.rows,
      isOwner: c.rows[0].owner_profile_id === ident(req, res)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/channels/:id", async (req, res) => {
  try {
    const c = await q("SELECT * FROM channels WHERE id=$1", [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: "Канал не знайдено" });
    if (c.rows[0].owner_profile_id !== ident(req, res)) return res.status(403).json({ error: "Тільки власник каналу" });

    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Потрібна назва" });
    if (!validImageUrl(req.body.avatar_url) || !validImageUrl(req.body.banner_url)) return res.status(400).json({ error: "Некоректна аватарка або банер" });

    const r = await q(`UPDATE channels SET name=$2,description=$3,avatar_url=$4,banner_url=$5
      WHERE id=$1 RETURNING *`, [
      req.params.id, name.slice(0, 80), String(req.body.description || "").slice(0, 1000),
      String(req.body.avatar_url || "").slice(0, 2000), String(req.body.banner_url || "").slice(0, 2000)
    ]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   SUBSCRIPTIONS
========================= */
app.get("/api/channels/:id/subscribed", async (req, res) => {
  try {
    const r = await q(`SELECT 1 FROM subscriptions WHERE subscriber_key=$1 AND channel_id=$2`, [ident(req, res), req.params.id]);
    res.json({ subscribed: !!r.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/channels/:id/subscribe", async (req, res) => {
  try {
    await q(`INSERT INTO subscriptions(subscriber_key,channel_id) VALUES($1,$2)
      ON CONFLICT(subscriber_key,channel_id) DO NOTHING`, [ident(req, res), req.params.id]);
    const r = await q("SELECT count(*) FROM subscriptions WHERE channel_id=$1", [req.params.id]);
    res.json({ subscribed: true, subscribers: Number(r.rows[0].count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/channels/:id/subscribe", async (req, res) => {
  try {
    await q("DELETE FROM subscriptions WHERE subscriber_key=$1 AND channel_id=$2", [ident(req, res), req.params.id]);
    const r = await q("SELECT count(*) FROM subscriptions WHERE channel_id=$1", [req.params.id]);
    res.json({ subscribed: false, subscribers: Number(r.rows[0].count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/subscriptions", async (req, res) => {
  try {
    const r = await q(`SELECT c.*,
      (SELECT count(*) FROM subscriptions s2 WHERE s2.channel_id=c.id) AS subscribers
      FROM subscriptions s JOIN channels c ON c.id=s.channel_id
      WHERE s.subscriber_key=$1 ORDER BY s.created_at DESC`, [ident(req, res)]);
    res.json({ channels: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   CREATE VIDEO BY URL
========================= */
app.post("/api/channels/:id/videos", async (req, res) => {
  try {
    const c = await q("SELECT owner_profile_id FROM channels WHERE id=$1", [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: "Канал не знайдено" });
    if (c.rows[0].owner_profile_id !== ident(req, res)) return res.status(403).json({ error: "Тільки власник каналу" });

    const title = String(req.body.title || "").trim();
    const videoUrl = String(req.body.video_url || "").trim();
    if (!title || !videoUrl) return res.status(400).json({ error: "Потрібні назва та відео" });

    const r = await q(`INSERT INTO videos(id,channel_id,title,description,thumbnail_url,video_url)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [
      id(), req.params.id, title.slice(0, 160), String(req.body.description || "").slice(0, 5000),
      String(req.body.thumbnail_url || "").slice(0, 2000), videoUrl.slice(0, 2000)
    ]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   UPLOAD VIDEO + THUMBNAIL
========================= */
app.post("/api/upload", videoUpload.fields([
  { name: "video", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 }
]), async (req, res) => {
  let uploadedVideo = null;
  let uploadedThumb = null;
  try {
    if (!req.files?.video?.[0]) return res.status(400).json({ error: "Вибери відео" });

    const channelId = String(req.body.channel_id || "");
    const c = await q("SELECT owner_profile_id FROM channels WHERE id=$1", [channelId]);
    if (!c.rows.length) return res.status(404).json({ error: "Канал не знайдено" });
    if (c.rows[0].owner_profile_id !== ident(req, res)) return res.status(403).json({ error: "Тільки власник каналу" });

    const title = String(req.body.title || "Без назви").trim().slice(0, 160);
    if (!title) return res.status(400).json({ error: "Вкажи назву відео" });

    uploadedVideo = await uploadToStorage(VIDEO_BUCKET, req.files.video[0]);
    if (req.files.thumbnail?.[0]) uploadedThumb = await uploadToStorage(THUMBNAIL_BUCKET, req.files.thumbnail[0]);

    const r = await q(`INSERT INTO videos(id,channel_id,title,description,thumbnail_url,video_url)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [
      id(), channelId, title, String(req.body.description || "").slice(0, 5000),
      uploadedThumb?.url || "", uploadedVideo.url
    ]);

    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    if (uploadedVideo) await deleteFromStorage(VIDEO_BUCKET, uploadedVideo.url);
    if (uploadedThumb) await deleteFromStorage(THUMBNAIL_BUCKET, uploadedThumb.url);
    let msg = /File too large/i.test(e.message) ? `Файл завеликий. Максимум ${videoLimitMb} MB.` : e.message;
    if (/row-level security|RLS|not found|Bucket not found/i.test(String(msg))) {
      msg = "Supabase Storage не дозволив завантаження. Перевір, що в Render заданий SUPABASE_SERVICE_ROLE_KEY (або новий Secret key), а bucket videos існує.";
    }
    res.status(400).json({ error: msg || "Не вдалося опублікувати відео" });
  }
});

/* =========================
   OWNER CHANNEL VIDEO DELETE
========================= */
app.delete("/api/channels/:channelId/videos/:videoId", async (req, res) => {
  try {
    const c = await q("SELECT owner_profile_id FROM channels WHERE id=$1", [req.params.channelId]);
    if (!c.rows.length) return res.status(404).json({ error: "Канал не знайдено" });
    if (c.rows[0].owner_profile_id !== ident(req, res)) return res.status(403).json({ error: "Тільки власник каналу" });

    const v = await q("SELECT video_url,thumbnail_url FROM videos WHERE id=$1 AND channel_id=$2", [req.params.videoId, req.params.channelId]);
    if (!v.rows.length) return res.status(404).json({ error: "Відео не знайдено" });

    await deleteFromStorage(VIDEO_BUCKET, v.rows[0].video_url);
    await deleteFromStorage(THUMBNAIL_BUCKET, v.rows[0].thumbnail_url);
    await q("DELETE FROM videos WHERE id=$1 AND channel_id=$2", [req.params.videoId, req.params.channelId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   VIDEO
========================= */
app.get("/api/videos/:id", async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "Некоректний ID відео" });
  try {
    const r = await q(`SELECT v.*, c.name AS channel_name, c.avatar_url AS channel_avatar,
      (SELECT count(*) FROM video_likes l WHERE l.video_id=v.id) AS likes,
      EXISTS(SELECT 1 FROM video_likes l2 WHERE l2.video_id=v.id AND l2.user_key=$2) AS liked,
      (c.owner_profile_id=$2) AS is_owner
      FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.id=$1`, [req.params.id, ident(req, res)]);
    if (!r.rows.length) return res.status(404).json({ error: "Відео не знайдено" });
    await q("UPDATE videos SET views=views+1 WHERE id=$1", [req.params.id]);
    r.rows[0].views = Number(r.rows[0].views) + 1;
    r.rows[0].likes = Number(r.rows[0].likes);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/videos/:id/like", async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "Некоректний ID відео" });
  try {
    const user = ident(req, res);
    const exists = await q("SELECT id FROM video_likes WHERE video_id=$1 AND user_key=$2", [req.params.id, user]);
    if (exists.rows.length) await q("DELETE FROM video_likes WHERE id=$1", [exists.rows[0].id]);
    else await q("INSERT INTO video_likes(video_id,user_key) VALUES($1,$2) ON CONFLICT(video_id,user_key) DO NOTHING", [req.params.id, user]);
    const r = await q("SELECT count(*) FROM video_likes WHERE video_id=$1", [req.params.id]);
    res.json({ liked: !exists.rows.length, likes: Number(r.rows[0].count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/videos/:id/comments", async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "Некоректний ID відео" });
  try {
    const r = await q(`SELECT c.id,c.video_id,c.user_key,c.text,c.created_at,
      p.username,p.avatar_url FROM comments c
      LEFT JOIN profiles p ON p.id=c.profile_id
      WHERE c.video_id=$1 ORDER BY c.created_at DESC LIMIT 200`, [req.params.id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/videos/:id/comments", async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "Некоректний ID відео" });
  try {
    const user = ident(req, res);
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "Напиши коментар" });
    if (text.length > 1000) return res.status(400).json({ error: "Коментар занадто довгий" });
    const p = await q("SELECT id FROM profiles WHERE id=$1", [user]);
    const r = await q(`INSERT INTO comments(id,video_id,profile_id,user_key,text)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [id(), req.params.id, p.rows[0]?.id || null, user, text]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/comments/:id", async (req, res) => {
  try {
    const user = ident(req, res);
    const c = await q("SELECT user_key FROM comments WHERE id=$1", [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: "Коментар не знайдено" });
    if (c.rows[0].user_key !== user && !isOwner(req)) return res.status(403).json({ error: "Не можна видалити цей коментар" });
    await q("DELETE FROM comments WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   OWNER
========================= */
app.post("/api/owner/login", (req, res) => {
  if (process.env.OWNER_PASSWORD && String(req.body.password || "") === process.env.OWNER_PASSWORD) {
    res.cookie("lt_owner", "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24,
      path: "/"
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Неправильний пароль" });
});

app.post("/api/owner/logout", (req, res) => {
  res.clearCookie("lt_owner", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/owner/check", (req, res) => res.json({ owner: isOwner(req) }));

app.get("/api/owner/data", async (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ error: "Owner only" });
  try {
    const [v, c] = await Promise.all([
      q(`SELECT v.*,c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id ORDER BY v.created_at DESC`),
      q(`SELECT c.*,(SELECT count(*) FROM subscriptions s WHERE s.channel_id=c.id) AS subscribers FROM channels c ORDER BY c.created_at DESC`)
    ]);
    res.json({ videos: v.rows, channels: c.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/owner/videos/:id", async (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ error: "Owner only" });
  try {
    const r = await q("SELECT video_url,thumbnail_url FROM videos WHERE id=$1", [req.params.id]);
    if (r.rows[0]) {
      await deleteFromStorage(VIDEO_BUCKET, r.rows[0].video_url);
      await deleteFromStorage(THUMBNAIL_BUCKET, r.rows[0].thumbnail_url);
    }
    await q("DELETE FROM videos WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/owner/channels/:id", async (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ error: "Owner only" });
  try {
    const c = await q("SELECT avatar_url,banner_url FROM channels WHERE id=$1", [req.params.id]);
    const v = await q("SELECT video_url,thumbnail_url FROM videos WHERE channel_id=$1", [req.params.id]);
    for (const x of v.rows) {
      await deleteFromStorage(VIDEO_BUCKET, x.video_url);
      await deleteFromStorage(THUMBNAIL_BUCKET, x.thumbnail_url);
    }
    if (c.rows[0]) {
      await deleteFromStorage(AVATAR_BUCKET, c.rows[0].avatar_url);
      await deleteFromStorage(BANNER_BUCKET, c.rows[0].banner_url);
    }
    await q("DELETE FROM channels WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   MULTER / GENERAL ERRORS
========================= */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `Файл завеликий. Максимум ${videoLimitMb} MB для відео або 8 MB для зображення.` });
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    console.error("SERVER ERROR", err);
    return res.status(500).json({ error: err.message || "Помилка сервера" });
  }
  next();
});

/* =========================
   FRONTEND FALLBACK — NO PUBLIC FOLDER
========================= */
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

init().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`🍋 LimeTube started on ${PORT}`));
}).catch(e => {
  console.error("❌ CRITICAL START ERROR:", e);
  process.exit(1);
});
