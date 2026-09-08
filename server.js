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

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Не задані SUPABASE_URL та SUPABASE_KEY");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const VIDEO_BUCKET = "videos";
const THUMBNAIL_BUCKET = "thumbnails";

/* =========================
   EXPRESS
========================= */

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

app.use(
  express.static(path.join(__dirname, "public"))
);

/* =========================
   DATABASE
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
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

function ident(req, res) {
  let x = req.cookies.lt_identity;

  if (!x) {
    x = id();

    res.cookie("lt_identity", x, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 31536000000
    });
  }

  return x;
}

function isOwner(req) {
  return req.cookies.lt_owner === "1";
}

/* =========================
   MULTER
========================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: process.env.MAX_FILE_SIZE_MB
      ? Number(process.env.MAX_FILE_SIZE_MB) * 1024 * 1024
      : 50 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    const ok =
      /^(video\/(mp4|webm|quicktime)|image\/(jpeg|png|webp))$/i.test(
        file.mimetype
      );

    cb(
      ok ? null : new Error("Unsupported file type"),
      ok
    );
  }
});

/* =========================
   SUPABASE STORAGE HELPERS
========================= */

function getPublicUrl(bucket, filePath) {
  const { data } = supabase.storage
    .from(bucket)
    .getPublicUrl(filePath);

  return data.publicUrl;
}

async function uploadToStorage(bucket, file) {
  const ext = path
    .extname(file.originalname)
    .toLowerCase();

  const filePath = `${crypto.randomUUID()}${ext}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(filePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });

  if (error) {
    throw new Error(
      `Supabase upload error: ${error.message}`
    );
  }

  return {
    path: filePath,
    url: getPublicUrl(bucket, filePath)
  };
}

function extractStoragePath(url, bucket) {
  if (!url) return null;

  const marker =
    `/storage/v1/object/public/${bucket}/`;

  const index = url.indexOf(marker);

  if (index === -1) return null;

  return decodeURIComponent(
    url.substring(index + marker.length)
  );
}

async function deleteFromStorage(bucket, url) {
  const filePath = extractStoragePath(url, bucket);

  if (!filePath) return;

  const { error } = await supabase.storage
    .from(bucket)
    .remove([filePath]);

  if (error) {
    console.error(
      `Помилка видалення ${bucket}:`,
      error.message
    );
  }
}

/* =========================
   DATABASE INIT
========================= */

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS profiles(
      id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      bio TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS channels(
      id UUID PRIMARY KEY,
      owner_profile_id UUID
        REFERENCES profiles(id)
        ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS videos(
      id UUID PRIMARY KEY,
      channel_id UUID
        REFERENCES channels(id)
        ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      thumbnail_url TEXT DEFAULT '',
      video_url TEXT NOT NULL,
      views BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS subscriptions(
      id BIGSERIAL PRIMARY KEY,
      subscriber_key TEXT NOT NULL,
      channel_id UUID
        REFERENCES channels(id)
        ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(subscriber_key, channel_id)
    )
  `);

  await q(`
    CREATE INDEX IF NOT EXISTS videos_created_idx
    ON videos(created_at DESC)
  `);

  console.log("✅ Database initialized");
}

/* =========================
   HOME
========================= */

app.get("/api/home", async (req, res) => {
  try {
    const v = await q(`
      SELECT
        v.*,
        c.name AS channel_name,
        c.avatar_url AS channel_avatar,
        (
          SELECT count(*)
          FROM subscriptions s
          WHERE s.channel_id = c.id
        ) AS subscribers
      FROM videos v
      JOIN channels c
        ON c.id = v.channel_id
      ORDER BY v.created_at DESC
      LIMIT 100
    `);

    const c = await q(`
      SELECT
        c.*,
        (
          SELECT count(*)
          FROM subscriptions s
          WHERE s.channel_id = c.id
        ) AS subscribers
      FROM channels c
      ORDER BY c.created_at DESC
      LIMIT 50
    `);

    res.json({
      videos: v.rows,
      channels: c.rows
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: "Database error"
    });
  }
});

/* =========================
   PROFILE
========================= */

app.get("/api/profile", async (req, res) => {
  try {
    const r = await q(
      "SELECT * FROM profiles WHERE id=$1",
      [ident(req, res)]
    );

    res.json(r.rows[0] || null);

  } catch (e) {
    res.status(500).json({
      error: "Database error"
    });
  }
});

app.post("/api/profile", async (req, res) => {
  try {
    const profile = ident(req, res);

    const {
      username,
      bio = "",
      avatar_url = ""
    } = req.body;

    if (
      !username ||
      username.trim().length < 2
    ) {
      return res.status(400).json({
        error: "Вкажи ім'я"
      });
    }

    const r = await q(`
      INSERT INTO profiles(
        id,
        username,
        bio,
        avatar_url
      )
      VALUES($1,$2,$3,$4)

      ON CONFLICT(id)
      DO UPDATE SET
        username=$2,
        bio=$3,
        avatar_url=$4

      RETURNING *
    `, [
      profile,
      username.trim().slice(0, 40),
      String(bio).slice(0, 500),
      String(avatar_url).slice(0, 1500)
    ]);

    res.json(r.rows[0]);

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

/* =========================
   CHANNEL
========================= */

app.post("/api/channel", async (req, res) => {
  try {
    const p = ident(req, res);

    const check = await q(
      "SELECT id FROM profiles WHERE id=$1",
      [p]
    );

    if (!check.rows.length) {
      return res.status(400).json({
        error: "Спочатку створи профіль"
      });
    }

    const {
      name,
      description = "",
      avatar_url = "",
      banner_url = ""
    } = req.body;

    if (!name) {
      return res.status(400).json({
        error: "Потрібна назва"
      });
    }

    const r = await q(`
      INSERT INTO channels(
        id,
        owner_profile_id,
        name,
        description,
        avatar_url,
        banner_url
      )
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [
      id(),
      p,
      String(name).slice(0, 80),
      String(description).slice(0, 1000),
      String(avatar_url).slice(0, 1500),
      String(banner_url).slice(0, 1500)
    ]);

    res.json(r.rows[0]);

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

/* =========================
   CHANNEL INFO
========================= */

app.get("/api/channels/:id", async (req, res) => {
  try {
    const c = await q(`
      SELECT
        c.*,
        (
          SELECT count(*)
          FROM subscriptions s
          WHERE s.channel_id=c.id
        ) subscribers
      FROM channels c
      WHERE c.id=$1
    `, [req.params.id]);

    if (!c.rows.length) {
      return res.status(404).json({
        error: "Канал не знайдено"
      });
    }

    const v = await q(`
      SELECT *
      FROM videos
      WHERE channel_id=$1
      ORDER BY created_at DESC
    `, [req.params.id]);

    res.json({
      channel: c.rows[0],
      videos: v.rows
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

/* =========================
   SUBSCRIBE
========================= */

app.get("/api/channels/:id/subscribed", async (req, res) => {
  const r = await q(
    `
    SELECT 1
    FROM subscriptions
    WHERE subscriber_key=$1
    AND channel_id=$2
    `,
    [
      ident(req, res),
      req.params.id
    ]
  );

  res.json({
    subscribed: !!r.rows.length
  });
});

app.post("/api/channels/:id/subscribe", async (req, res) => {
  try {
    await q(
      `
      INSERT INTO subscriptions(
        subscriber_key,
        channel_id
      )
      VALUES($1,$2)
      `,
      [
        ident(req, res),
        req.params.id
      ]
    );

  } catch (e) {
    if (e.code !== "23505") {
      throw e;
    }
  }

  const r = await q(
    `
    SELECT count(*)
    FROM subscriptions
    WHERE channel_id=$1
    `,
    [req.params.id]
  );

  res.json({
    subscribed: true,
    subscribers: Number(r.rows[0].count)
  });
});

app.delete("/api/channels/:id/subscribe", async (req, res) => {
  await q(
    `
    DELETE FROM subscriptions
    WHERE subscriber_key=$1
    AND channel_id=$2
    `,
    [
      ident(req, res),
      req.params.id
    ]
  );

  const r = await q(
    `
    SELECT count(*)
    FROM subscriptions
    WHERE channel_id=$1
    `,
    [req.params.id]
  );

  res.json({
    subscribed: false,
    subscribers: Number(r.rows[0].count)
  });
});

/* =========================
   CREATE VIDEO BY URL
========================= */

app.post("/api/channels/:id/videos", async (req, res) => {
  const {
    title,
    description = "",
    thumbnail_url = "",
    video_url
  } = req.body;

  const c = await q(
    `
    SELECT owner_profile_id
    FROM channels
    WHERE id=$1
    `,
    [req.params.id]
  );

  if (!c.rows.length) {
    return res.status(404).json({
      error: "Канал не знайдено"
    });
  }

  if (
    c.rows[0].owner_profile_id !==
    ident(req, res)
  ) {
    return res.status(403).json({
      error: "Тільки власник каналу"
    });
  }

  if (!title || !video_url) {
    return res.status(400).json({
      error: "Потрібні назва та відео"
    });
  }

  const r = await q(`
    INSERT INTO videos(
      id,
      channel_id,
      title,
      description,
      thumbnail_url,
      video_url
    )
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING *
  `, [
    id(),
    req.params.id,
    String(title).slice(0, 160),
    String(description).slice(0, 5000),
    String(thumbnail_url).slice(0, 1500),
    String(video_url).slice(0, 2000)
  ]);

  res.json(r.rows[0]);
});

/* =========================
   UPLOAD VIDEO + THUMBNAIL
========================= */

app.post(
  "/api/upload",
  upload.fields([
    {
      name: "video",
      maxCount: 1
    },
    {
      name: "thumbnail",
      maxCount: 1
    }
  ]),
  async (req, res) => {

    let uploadedVideo = null;
    let uploadedThumb = null;

    try {
      if (!req.files?.video?.[0]) {
        return res.status(400).json({
          error: "Вибери відео"
        });
      }

      const c = await q(
        `
        SELECT owner_profile_id
        FROM channels
        WHERE id=$1
        `,
        [req.body.channel_id]
      );

      if (!c.rows.length) {
        return res.status(404).json({
          error: "Канал не знайдено"
        });
      }

      if (
        c.rows[0].owner_profile_id !==
        ident(req, res)
      ) {
        return res.status(403).json({
          error: "Тільки власник каналу"
        });
      }

      /* VIDEO */

      uploadedVideo = await uploadToStorage(
        VIDEO_BUCKET,
        req.files.video[0]
      );

      /* THUMBNAIL */

      if (req.files.thumbnail?.[0]) {
        uploadedThumb = await uploadToStorage(
          THUMBNAIL_BUCKET,
          req.files.thumbnail[0]
        );
      }

      /* DATABASE */

      const r = await q(`
        INSERT INTO videos(
          id,
          channel_id,
          title,
          description,
          thumbnail_url,
          video_url
        )
        VALUES($1,$2,$3,$4,$5,$6)
        RETURNING *
      `, [
        id(),
        req.body.channel_id,
        String(
          req.body.title || "Без назви"
        ).slice(0, 160),

        String(
          req.body.description || ""
        ).slice(0, 5000),

        uploadedThumb
          ? uploadedThumb.url
          : "",

        uploadedVideo.url
      ]);

      res.json(r.rows[0]);

    } catch (e) {

      console.error(
        "UPLOAD ERROR:",
        e
      );

      /* Якщо БД не записалась —
         прибираємо вже завантажені файли */

      if (uploadedVideo) {
        await deleteFromStorage(
          VIDEO_BUCKET,
          uploadedVideo.url
        );
      }

      if (uploadedThumb) {
        await deleteFromStorage(
          THUMBNAIL_BUCKET,
          uploadedThumb.url
        );
      }

      res.status(400).json({
        error: e.message
      });
    }
  }
);

/* =========================
   VIDEO
========================= */

app.get("/api/videos/:id", async (req, res) => {
  const r = await q(`
    SELECT
      v.*,
      c.name AS channel_name,
      c.avatar_url AS channel_avatar
    FROM videos v
    JOIN channels c
      ON c.id=v.channel_id
    WHERE v.id=$1
  `, [req.params.id]);

  if (!r.rows.length) {
    return res.status(404).json({
      error: "Відео не знайдено"
    });
  }

  await q(
    "UPDATE videos SET views=views+1 WHERE id=$1",
    [req.params.id]
  );

  r.rows[0].views =
    Number(r.rows[0].views) + 1;

  res.json(r.rows[0]);
});

/* =========================
   OWNER LOGIN
========================= */

app.post("/api/owner/login", (req, res) => {
  if (
    req.body.password &&
    process.env.OWNER_PASSWORD &&
    req.body.password ===
      process.env.OWNER_PASSWORD
  ) {

    res.cookie("lt_owner", "1", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 86400000
    });

    return res.json({
      ok: true
    });
  }

  res.status(401).json({
    error: "Неправильний пароль"
  });
});

app.post("/api/owner/logout", (req, res) => {
  res.clearCookie("lt_owner");

  res.json({
    ok: true
  });
});

app.get("/api/owner/check", (req, res) => {
  res.json({
    owner: isOwner(req)
  });
});

/* =========================
   OWNER DATA
========================= */

app.get("/api/owner/data", async (req, res) => {
  if (!isOwner(req)) {
    return res.status(403).json({
      error: "Owner only"
    });
  }

  const [v, c] = await Promise.all([
    q(`
      SELECT
        v.*,
        c.name AS channel_name
      FROM videos v
      JOIN channels c
        ON c.id=v.channel_id
      ORDER BY v.created_at DESC
    `),

    q(`
      SELECT
        c.*,
        (
          SELECT count(*)
          FROM subscriptions s
          WHERE s.channel_id=c.id
        ) subscribers
      FROM channels c
      ORDER BY c.created_at DESC
    `)
  ]);

  res.json({
    videos: v.rows,
    channels: c.rows
  });
});

/* =========================
   OWNER DELETE VIDEO
========================= */

app.delete(
  "/api/owner/videos/:id",
  async (req, res) => {

    if (!isOwner(req)) {
      return res.status(403).json({
        error: "Owner only"
      });
    }

    const r = await q(
      `
      SELECT
        video_url,
        thumbnail_url
      FROM videos
      WHERE id=$1
      `,
      [req.params.id]
    );

    if (r.rows[0]) {

      await deleteFromStorage(
        VIDEO_BUCKET,
        r.rows[0].video_url
      );

      await deleteFromStorage(
        THUMBNAIL_BUCKET,
        r.rows[0].thumbnail_url
      );
    }

    await q(
      "DELETE FROM videos WHERE id=$1",
      [req.params.id]
    );

    res.json({
      ok: true
    });
  }
);

/* =========================
   OWNER DELETE CHANNEL
========================= */

app.delete(
  "/api/owner/channels/:id",
  async (req, res) => {

    if (!isOwner(req)) {
      return res.status(403).json({
        error: "Owner only"
      });
    }

    const v = await q(
      `
      SELECT
        video_url,
        thumbnail_url
      FROM videos
      WHERE channel_id=$1
      `,
      [req.params.id]
    );

    for (const x of v.rows) {

      await deleteFromStorage(
        VIDEO_BUCKET,
        x.video_url
      );

      await deleteFromStorage(
        THUMBNAIL_BUCKET,
        x.thumbnail_url
      );
    }

    await q(
      "DELETE FROM channels WHERE id=$1",
      [req.params.id]
    );

    res.json({
      ok: true
    });
  }
);

/* =========================
   FRONTEND
========================= */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/* =========================
   START
========================= */

init()
  .then(() => {

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `🍋 LimeTube started on port ${PORT}`
        );
      }
    );

  })
  .catch(e => {
    console.error(
      "❌ CRITICAL DATABASE ERROR:",
      e
    );

    process.exit(1);
  });
