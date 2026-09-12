# LimeTube V3.2 FIX

Deploy-ready версія LimeTube для Render + PostgreSQL + Supabase Storage.
**Папки `public` немає** — `index.html`, `app.js` і `style.css` лежать у корені проєкту.

## Що виправлено у FIX

- Виправлено помилку `operator does not exist: uuid = text` при відкритті відео: ID відео перевіряється як UUID.
- Аватар профілю тепер реально завантажується в Supabase Storage.
- Аватар каналу та банер теж завантажуються в Supabase Storage.
- Редагування каналу використовує той самий надійний upload.
- Виправлено стару проблему, коли великі `data:image/...` значення обрізались до 2000 символів і тому картинки ламались.
- Додані/використовуються buckets `avatars` і `banners`.
- Зберігаються лайки, коментарі та підписки через PostgreSQL.
- Є завантаження відео + прев'ю в Supabase Storage.
- Є видалення власних відео та секретна панель власника.
- Render запускається без `public` folder.
- Старі зламані `data:` URL у БД очищаються під час запуску, щоб не заважати новим URL.

## Render Environment

Потрібні змінні:

- `DATABASE_URL` — Render PostgreSQL. У `render.yaml` він підключений автоматично до `limetube-db`.
- `OWNER_PASSWORD` — твій секретний пароль для панелі власника.
- `SUPABASE_URL` — тільки корінь проєкту, наприклад `https://xxxx.supabase.co`.
- `SUPABASE_SECRET_KEY` — сучасний Secret key Supabase **або**
- `SUPABASE_SERVICE_ROLE_KEY` — старий Service Role key.
- `MAX_FILE_SIZE_MB=100` — максимальний розмір відео.

**Не використовуй anon/public key для серверних завантажень. Secret/Service Role key не публікуй у GitHub або чаті.**

## Supabase Storage

Сервер автоматично перевіряє та намагається створити як public такі buckets:

- `videos`
- `thumbnails`
- `avatars`
- `banners`

Якщо buckets уже існують, сервер намагається зробити їх public, щоб `getPublicUrl()` працював.

## Deploy

1. Розпакуй ZIP.
2. Завантаж файли в репозиторій LimeTube у корінь.
3. Не створюй папку `public`.
4. Commit / Push у GitHub.
5. Render → Manual Deploy → Deploy latest commit.
6. У логах має бути приблизно:
   `🍋 LimeTube started on ...`

## Якщо Storage не завантажує файл

Перевір у Render Environment Variables:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` **або** `SUPABASE_SERVICE_ROLE_KEY`

Якщо бачиш RLS / permission denied / upload blocked — найчастіше встановлено anon/public key замість серверного Secret/Service Role key.
