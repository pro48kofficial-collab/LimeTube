let homeCache = null;
const app = document.getElementById("app");
const searchInput = document.getElementById("search");

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
}[c]));

const placeholderAvatar = "https://placehold.co/96x96/20271f/b8ff3d?text=LT";
const placeholderBanner = "https://placehold.co/1200x340/141816/b8ff3d?text=LimeTube";
const placeholderThumb = "https://placehold.co/640x360/141816/b8ff3d?text=LimeTube";

async function api(url, options = {}) {
  const opts = { ...options, credentials: "same-origin" };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  }
  const r = await fetch(url, opts);
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || `Помилка ${r.status}`);
  return data;
}

function go(hash) {
  location.hash = hash;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function render() {
  const x = location.hash.slice(1) || "home";
  try {
    if (x === "home") await renderHome();
    else if (x === "subscriptions") await renderSubscriptions();
    else if (x === "profile") await renderProfile();
    else if (x === "edit-channel") await renderEditChannel();
    else if (x === "owner") await renderOwner();
    else if (x.startsWith("search/")) await renderSearch(decodeURIComponent(x.slice(7)));
    else if (x.startsWith("channel/")) await renderChannel(x.split("/")[1]);
    else if (x.startsWith("video/")) await renderVideo(x.split("/")[1]);
    else await renderHome();
  } catch (e) {
    app.innerHTML = `<div class="panel error"><h2>⚠️ ${esc(e.message)}</h2><button onclick="go('home')">На головну</button></div>`;
  }
}

async function refreshHeaderProfile() {
  try {
    const p = await api("/api/profile");
    const img = document.getElementById("profileTopAvatar");
    if (img) img.src = p?.avatar_url || placeholderAvatar;
  } catch {}
}

async function renderHome() {
  if (!homeCache) homeCache = await api("/api/home");
  const videos = homeCache.videos || [];
  app.innerHTML = `<div class="page-title"><div><span class="lime">НОВІ ВІДЕО</span><h1>Головна</h1></div></div>
    <div class="grid">${videos.map(videoCard).join("") || `<div class="panel empty"><h2>Відео ще немає</h2><p class="muted">Першим опублікуй відео на своєму каналі.</p></div>`}</div>`;
}

function videoCard(v) {
  return `<article class="card video-card" onclick="go('video/${esc(v.id)}')">
    <img class="thumb" src="${esc(v.thumbnail_url || placeholderThumb)}" onerror="this.src='${placeholderThumb}'">
    <div class="pad">
      <div class="title">${esc(v.title)}</div>
      <div class="channel-mini" onclick="event.stopPropagation();go('channel/${esc(v.channel_id)}')">
        <img class="avatar tiny" src="${esc(v.channel_avatar || placeholderAvatar)}" onerror="this.src='${placeholderAvatar}'">
        <span>${esc(v.channel_name || "Канал")}</span>
      </div>
      <div class="muted meta">${Number(v.views || 0)} переглядів · ❤️ ${Number(v.likes || 0)}</div>
    </div>
  </article>`;
}

function channelCard(c) {
  return `<article class="channel-result" onclick="go('channel/${esc(c.id)}')">
    <img class="avatar big" src="${esc(c.avatar_url || placeholderAvatar)}" onerror="this.src='${placeholderAvatar}'">
    <div><h3>${esc(c.name)}</h3><div class="muted">${Number(c.subscribers || 0)} підписників</div><p class="muted">${esc(c.description || "")}</p></div>
  </article>`;
}

async function renderSearch(q) {
  if (!q.trim()) return renderHome();
  const d = await api(`/api/search?q=${encodeURIComponent(q)}`);
  app.innerHTML = `<div class="page-title"><div><span class="lime">ПОШУК</span><h1>${esc(q)}</h1></div></div>
    <h2>Канали</h2><div class="channel-results">${d.channels.map(channelCard).join("") || `<p class="muted">Каналів не знайдено.</p>`}</div>
    <h2>Відео</h2><div class="grid">${d.videos.map(videoCard).join("") || `<p class="muted">Відео не знайдено.</p>`}</div>`;
}

async function renderSubscriptions() {
  const d = await api("/api/subscriptions");
  app.innerHTML = `<div class="page-title"><div><span class="lime">ТВОЯ СТРІЧКА</span><h1>Підписки</h1></div></div>
    ${d.channels?.length ? `<div class="subscription-list">${d.channels.map(subscriptionCard).join("")}</div>` : `<div class="panel empty"><h2>Тут поки порожньо</h2><p class="muted">Підпишись на канал, і він з'явиться тут.</p></div>`}`;
}

function subscriptionCard(c) {
  return `<article class="subscription-card" onclick="go('channel/${esc(c.id)}')">
    <img class="avatar big" src="${esc(c.avatar_url || placeholderAvatar)}" onerror="this.src='${placeholderAvatar}'">
    <div class="grow"><h2>${esc(c.name)}</h2><div class="muted">${Number(c.subscribers || 0)} підписників</div></div>
    <span class="pill">Підписка ✓</span>
  </article>`;
}

async function renderProfile() {
  const [p, c] = await Promise.all([api("/api/profile"), api("/api/profile/channel")]);
  if (!p) {
    app.innerHTML = `<div class="panel profile-welcome"><span class="lime">LimeTube</span><h1>Створи свій профіль 👋</h1><p class="muted">Профіль зберігається в базі даних, тому перезапуск або сон Render його не видалить.</p>${profileForm({})}</div>`;
    return;
  }
  app.innerHTML = `<div class="profile-head panel">
      <img class="avatar profile-avatar" src="${esc(p.avatar_url || placeholderAvatar)}" onerror="this.src='${placeholderAvatar}'">
      <div class="grow"><span class="lime">МІЙ ПРОФІЛЬ</span><h1>${esc(p.username)}</h1><p class="muted">${esc(p.bio || "")}</p></div>
    </div>
    ${profileForm(p)}
    ${c ? `<div class="panel"><div class="section-head"><div><span class="lime">МІЙ КАНАЛ</span><h2>${esc(c.name)}</h2></div><img class="avatar" src="${esc(c.avatar_url || placeholderAvatar)}"></div><div class="actions"><button class="sub" onclick="go('channel/${c.id}')">Відкрити канал →</button><button onclick="go('edit-channel')">✏️ Редагувати канал</button></div></div>` : `<div class="panel"><span class="lime">НОВИЙ ПРОСТІР</span><h2>Створити канал</h2>${channelForm()}</div>`}`;
}

function profileForm(p) {
  return `<div class="panel"><h2>Налаштування профілю</h2><form class="form" onsubmit="saveProfile(event)">
    <div class="image-picker"><img id="profilePreview" class="avatar profile-avatar" src="${esc(p.avatar_url || placeholderAvatar)}" onerror="this.src='${placeholderAvatar}'"><label class="file-btn">📷 Вибрати аватарку<input id="profileFile" type="file" accept="image/jpeg,image/png,image/webp" onchange="previewAndResize(this,'profilePreview','avatar')"></label></div>
    <input id="pn" required maxlength="40" placeholder="Ім'я" value="${esc(p.username || "")}">
    <textarea id="pb" maxlength="500" placeholder="Про себе">${esc(p.bio || "")}</textarea>
    <input id="pa" type="hidden" value="${esc(p.avatar_url || "")}">
    <button class="sub">Зберегти профіль</button>
  </form></div>`;
}

function channelForm() {
  return `<form class="form" onsubmit="saveChannel(event)">
    <input id="cn" required maxlength="80" placeholder="Назва каналу">
    <textarea id="cd" maxlength="1000" placeholder="Опис каналу"></textarea>
    <div class="image-picker"><img id="channelAvatarPreview" class="avatar profile-avatar" src="${placeholderAvatar}"><label class="file-btn">🖼️ Аватарка з галереї<input id="caf" type="file" accept="image/jpeg,image/png,image/webp" onchange="previewAndResize(this,'channelAvatarPreview','avatar')"></label></div>
    <input id="ca" type="hidden">
    <div><img id="channelBannerPreview" class="banner-preview" src="${placeholderBanner}"><label class="file-btn">🌄 Банер з галереї<input id="cbf" type="file" accept="image/jpeg,image/png,image/webp" onchange="previewAndResize(this,'channelBannerPreview','banner')"></label></div>
    <input id="cb" type="hidden">
    <button class="sub">Створити канал</button>
  </form>`;
}

async function saveProfile(e) {
  e.preventDefault();
  try {
    let avatar = document.getElementById("pa").value;
    const file = document.getElementById("profileFile")?.files[0];
    if (file) avatar = await imageToDataUrl(file, "avatar");
    await api("/api/profile", { method:"POST", body:JSON.stringify({
      username:document.getElementById("pn").value,
      bio:document.getElementById("pb").value,
      avatar_url:avatar
    })});
    await refreshHeaderProfile();
    await renderProfile();
  } catch (e) { alert(e.message); }
}

async function saveChannel(e) {
  e.preventDefault();
  try {
    let avatar = document.getElementById("ca").value;
    let banner = document.getElementById("cb").value;
    const af = document.getElementById("caf")?.files[0];
    const bf = document.getElementById("cbf")?.files[0];
    if (af) avatar = await imageToDataUrl(af, "avatar");
    if (bf) banner = await imageToDataUrl(bf, "banner");
    const c = await api("/api/channel", { method:"POST", body:JSON.stringify({
      name:document.getElementById("cn").value,
      description:document.getElementById("cd").value,
      avatar_url:avatar,
      banner_url:banner
    })});
    go(`channel/${c.id}`);
  } catch (e) { alert(e.message); }
}

async function imageToDataUrl(file, type) {
  const targetW = type === "banner" ? 1600 : type === "thumbnail" ? 1280 : 256;
  const targetH = type === "banner" ? 450 : type === "thumbnail" ? 720 : 256;
  const blob = await resizeImage(file, targetW, targetH, "cover");
  if (blob.size > 700000) throw new Error("Зображення після стиснення завелике. Вибери інше фото.");
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не вдалося підготувати зображення"));
    reader.readAsDataURL(blob);
  });
}

async function uploadImage(file, type) {
  const dataUrl = await imageToDataUrl(file, type);
  const fd = new FormData();
  fd.append("type", type);
  const blob = await (await fetch(dataUrl)).blob();
  fd.append("image", blob, `${type}-${Date.now()}.jpg`);
  const d = await api("/api/upload-image", { method:"POST", body:fd });
  return d.url;
}

function resizeImage(file, targetW, targetH, mode = "cover") {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = targetW; canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      const scale = mode === "cover" ? Math.max(targetW / img.width, targetH / img.height) : Math.min(targetW / img.width, targetH / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (targetW-w)/2, (targetH-h)/2, w, h);
      canvas.toBlob(blob => { URL.revokeObjectURL(url); blob ? resolve(blob) : reject(new Error("Не вдалося обробити зображення")); }, "image/jpeg", .88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Не вдалося відкрити зображення")); };
    img.src = url;
  });
}

async function previewAndResize(input, previewId, type) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const targetW = type === "banner" ? 1600 : type === "thumbnail" ? 1280 : 256;
    const targetH = type === "banner" ? 450 : type === "thumbnail" ? 720 : 256;
    const blob = await resizeImage(file, targetW, targetH);
    const url = URL.createObjectURL(blob);
    document.getElementById(previewId).src = url;
  } catch (e) { alert(e.message); }
}

async function renderChannel(id) {
  const [d, s] = await Promise.all([api(`/api/channels/${id}`), api(`/api/channels/${id}/subscribed`)]);
  const c = d.channel;
  const videos = d.videos.map(v => `<article class="card" onclick="go('video/${v.id}')">
    <img class="thumb" src="${esc(v.thumbnail_url || placeholderThumb)}" onerror="this.src='${placeholderThumb}'">
    <div class="pad"><div class="title">${esc(v.title)}</div><div class="muted meta">${Number(v.views || 0)} переглядів · ❤️ ${Number(v.likes || 0)}</div>
    ${d.isOwner ? `<button class="danger small-btn" onclick="event.stopPropagation();deleteMyVideo('${id}','${v.id}')">🗑️ Видалити</button>` : ""}</div>
  </article>`).join("");

  app.innerHTML = `<img class="channel-banner" src="${esc(c.banner_url || placeholderBanner)}" onerror="this.src='${placeholderBanner}'">
    <div class="panel channel-header"><div class="channel-profile-row"><img class="avatar channel-avatar" src="${esc(c.avatar_url || placeholderAvatar)}" onerror="this.src='${placeholderAvatar}'"><div class="grow"><span class="lime">КАНАЛ</span><h1>${esc(c.name)}</h1><div class="muted">${Number(c.subscribers || 0)} підписників</div></div></div><p>${esc(c.description || "")}</p>
    <div class="actions">${d.isOwner ? `<button class="sub" onclick="showUpload('${id}')">＋ Завантажити відео</button><button onclick="go('edit-channel')">✏️ Редагувати</button>` : `<button class="sub" onclick="toggleSub('${id}',${s.subscribed})">${s.subscribed ? "Підписка ✓" : "Підписатись +"}</button>`}</div></div>
    <h2>Історія відео</h2><div class="grid">${videos || `<p class="muted">Відео ще немає.</p>`}</div>`;
}

async function toggleSub(id, subscribed) {
  try { await api(`/api/channels/${id}/subscribe`, { method: subscribed ? "DELETE" : "POST" }); await renderChannel(id); }
  catch (e) { alert(e.message); }
}

function showUpload(id) {
  const old = document.getElementById("uploadPanel");
  if (old) old.remove();
  app.insertAdjacentHTML("beforeend", `<div class="panel" id="uploadPanel"><h2>Опублікувати відео</h2><form class="form" onsubmit="uploadVideo(event,'${id}')">
    <input id="ut" required maxlength="160" placeholder="Назва відео">
    <textarea id="ud" maxlength="5000" placeholder="Опис відео"></textarea>
    <label>Відео (MP4 / WebM / MOV)<input id="uf" type="file" accept="video/mp4,video/webm,video/quicktime" required></label>
    <label>Прев'ю з галереї<input id="uth" type="file" accept="image/jpeg,image/png,image/webp" onchange="previewAndResize(this,'uploadThumbPreview','thumb')"></label>
    <img id="uploadThumbPreview" class="upload-preview" src="${placeholderThumb}">
    <div class="progress"><i id="bar"></i></div><div id="uploadStatus" class="muted"></div>
    <button class="sub" id="publishBtn">Опублікувати</button></form></div>`);
  document.getElementById("uploadPanel").scrollIntoView({ behavior:"smooth" });
}

async function uploadVideo(e, channelId) {
  e.preventDefault();
  const btn = document.getElementById("publishBtn");
  const status = document.getElementById("uploadStatus");
  const video = document.getElementById("uf").files[0];
  const thumb = document.getElementById("uth").files[0];
  if (!video) return alert("Вибери відео");
  btn.disabled = true; status.textContent = "Завантаження... не закривай сторінку";
  try {
    const fd = new FormData();
    fd.append("channel_id", channelId);
    fd.append("title", document.getElementById("ut").value);
    fd.append("description", document.getElementById("ud").value);
    fd.append("video", video);
    if (thumb) {
      status.textContent = "Обробляю прев'ю...";
      const thumbBlob = await resizeImage(thumb, 1280, 720, "cover");
      fd.append("thumbnail", thumbBlob, "thumbnail.jpg");
    }
    // The server also accepts the original thumbnail file. If we already uploaded
    // the resized thumbnail, we don't send it twice.
    const result = await xhrUpload("/api/upload", fd, pct => {
      document.getElementById("bar").style.width = `${pct}%`;
      status.textContent = `Завантаження відео: ${pct}%`;
    });
    status.textContent = "Опубліковано!";
    alert("Відео успішно опубліковано 🎉");
    homeCache = null;
    await renderChannel(channelId);
  } catch (e) {
    status.textContent = "Помилка публікації";
    alert(e.message || "Не вдалося опублікувати відео");
  } finally { btn.disabled = false; }
}

function xhrUpload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      let d = {};
      try { d = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error(d.error || `Помилка сервера ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("Не вдалося з'єднатися з сервером. Спробуй ще раз."));
    xhr.ontimeout = () => reject(new Error("Сервер не встиг обробити завантаження. Спробуй ще раз."));
    xhr.timeout = 30 * 60 * 1000;
    xhr.send(formData);
  });
}

async function deleteMyVideo(channelId, videoId) {
  if (!confirm("Видалити це відео?")) return;
  try { await api(`/api/channels/${channelId}/videos/${videoId}`, { method:"DELETE" }); homeCache = null; await renderChannel(channelId); }
  catch (e) { alert(e.message); }
}

async function renderEditChannel() {
  const c = await api("/api/profile/channel");
  if (!c) return go("profile");
  app.innerHTML = `<div class="panel"><span class="lime">НАЛАШТУВАННЯ КАНАЛУ</span><h1>Редагувати канал</h1><form class="form" onsubmit="updateChannel(event,'${c.id}')">
    <input id="ecn" required maxlength="80" value="${esc(c.name)}" placeholder="Назва">
    <textarea id="ecd" maxlength="1000" placeholder="Опис">${esc(c.description || "")}</textarea>
    <div class="image-picker"><img id="editAvatarPreview" class="avatar profile-avatar" src="${esc(c.avatar_url || placeholderAvatar)}"><label class="file-btn">📷 Нова аватарка<input id="ecaf" type="file" accept="image/jpeg,image/png,image/webp" onchange="previewAndResize(this,'editAvatarPreview','avatar')"></label></div>
    <input id="eca" type="hidden" value="${esc(c.avatar_url || "")}">
    <div><img id="editBannerPreview" class="banner-preview" src="${esc(c.banner_url || placeholderBanner)}"><label class="file-btn">🌄 Новий банер<input id="ecbf" type="file" accept="image/jpeg,image/png,image/webp" onchange="previewAndResize(this,'editBannerPreview','banner')"></label></div>
    <input id="ecb" type="hidden" value="${esc(c.banner_url || "")}">
    <div class="actions"><button class="sub">Зберегти</button><button type="button" onclick="go('channel/${c.id}')">Скасувати</button></div>
  </form></div>`;
}

async function updateChannel(e, id) {
  e.preventDefault();
  try {
    let avatar = document.getElementById("eca").value;
    let banner = document.getElementById("ecb").value;
    const af = document.getElementById("ecaf").files[0];
    const bf = document.getElementById("ecbf").files[0];
    if (af) avatar = await imageToDataUrl(af, "avatar");
    if (bf) banner = await imageToDataUrl(bf, "banner");
    await api(`/api/channels/${id}`, { method:"PUT", body:JSON.stringify({
      name:document.getElementById("ecn").value,
      description:document.getElementById("ecd").value,
      avatar_url:avatar,
      banner_url:banner
    })});
    go(`channel/${id}`);
  } catch (e) { alert(e.message); }
}

async function renderVideo(id) {
  const [v, comments] = await Promise.all([api(`/api/videos/${id}`), api(`/api/videos/${id}/comments`)]);
  app.innerHTML = `<div class="panel video-page"><video class="video" controls playsinline poster="${esc(v.thumbnail_url || "")}" src="${esc(v.video_url)}"></video>
    <div class="video-info"><div><h1>${esc(v.title)}</h1><div class="muted">${Number(v.views || 0)} переглядів</div></div><button class="like ${v.liked ? "liked" : ""}" onclick="likeVideo('${id}')">❤️ ${Number(v.likes || 0)}</button></div>
    <div class="video-channel" onclick="go('channel/${v.channel_id}')"><img class="avatar" src="${esc(v.channel_avatar || placeholderAvatar)}" onerror="this.src='${placeholderAvatar}'"><div><b>${esc(v.channel_name)}</b><div class="muted">Переглянути канал та всі відео →</div></div></div>
    <p class="description">${esc(v.description || "")}</p>${v.is_owner ? `<button class="danger" onclick="deleteMyVideo('${v.channel_id}','${id}')">🗑️ Видалити моє відео</button>` : ""}</div>
    <div class="panel"><h2>💬 Коментарі</h2><form class="form" onsubmit="addComment(event,'${id}')"><textarea id="commentText" maxlength="1000" required placeholder="Напиши коментар..."></textarea><button class="sub">Додати коментар</button></form><div class="comments">${comments.map(commentCard).join("") || `<p class="muted">Коментарів ще немає.</p>`}</div></div>`;
}

function commentCard(c) {
  const canDelete = c.user_key; // server checks ownership; button is harmless if server rejects
  return `<div class="comment"><div class="channel-mini"><img class="avatar small-avatar" src="${esc(c.avatar_url || placeholderAvatar)}"><div><b>${esc(c.username || "Користувач")}</b><div class="muted">${new Date(c.created_at).toLocaleString("uk-UA")}</div></div></div><p>${esc(c.text)}</p>${canDelete ? `<button class="mini danger" onclick="deleteComment('${c.id}')">Видалити</button>` : ""}</div>`;
}

async function likeVideo(id) {
  try { await api(`/api/videos/${id}/like`, { method:"POST" }); await renderVideo(id); }
  catch (e) { alert(e.message); }
}

async function addComment(e, id) {
  e.preventDefault();
  try { await api(`/api/videos/${id}/comments`, { method:"POST", body:JSON.stringify({ text:document.getElementById("commentText").value }) }); await renderVideo(id); }
  catch (e) { alert(e.message); }
}

async function deleteComment(id) {
  if (!confirm("Видалити коментар?")) return;
  try { await api(`/api/comments/${id}`, { method:"DELETE" }); await render(); }
  catch (e) { alert(e.message); }
}

async function renderOwner() {
  const c = await api("/api/owner/check");
  if (!c.owner) {
    app.innerHTML = `<div class="panel owner-login"><span class="lime">ВЛАСНИК</span><h1>🔐 Секретна панель</h1><p class="muted">Введи пароль власника, щоб відкрити керування LimeTube.</p><form class="form" onsubmit="login(event)"><input id="op" type="password" autocomplete="current-password" placeholder="Секретний пароль" required><button class="sub">Увійти</button></form></div>`;
    return;
  }
  const d = await api("/api/owner/data");
  app.innerHTML = `<div class="panel owner-head"><span class="lime">ADMIN ACCESS</span><h1>🛡️ LimeTube Owner</h1><p class="muted">Доступ відкрито. Тут можна керувати відео та каналами.</p><button onclick="logout()">Вийти</button></div>
    <div class="panel"><h2>Відео</h2>${d.videos.map(v => `<div class="actions row"><span>${esc(v.title)} — ${esc(v.channel_name)}</span><button class="danger" onclick="delV('${v.id}')">Видалити</button></div>`).join("") || `<p class="muted">Немає відео</p>`}</div>
    <div class="panel"><h2>Канали</h2>${d.channels.map(c => `<div class="actions row"><span>${esc(c.name)} — ${Number(c.subscribers || 0)} підписників</span><button class="danger" onclick="delC('${c.id}')">Видалити канал</button></div>`).join("") || `<p class="muted">Немає каналів</p>`}</div>`;
}

async function login(e) {
  e.preventDefault();
  try { await api("/api/owner/login", { method:"POST", body:JSON.stringify({ password:document.getElementById("op").value }) }); await renderOwner(); }
  catch (e) { alert(e.message); }
}
async function logout() { await api("/api/owner/logout", { method:"POST" }); await renderOwner(); }
async function delV(id) { if (!confirm("Видалити відео?")) return; await api(`/api/owner/videos/${id}`, { method:"DELETE" }); homeCache=null; await renderOwner(); }
async function delC(id) { if (!confirm("Видалити канал і всі його відео?")) return; await api(`/api/owner/channels/${id}`, { method:"DELETE" }); homeCache=null; await renderOwner(); }

// Make inline handlers available on every browser, including mobile WebViews.
Object.assign(window, {
  go, renderHome, renderSubscriptions, renderProfile, renderChannel, renderVideo,
  renderEditChannel, renderOwner, saveProfile, saveChannel, toggleSub, showUpload,
  uploadVideo, deleteMyVideo, updateChannel, likeVideo, addComment, deleteComment,
  login, logout, delV, delC, previewAndResize
});

let searchTimer;
searchInput?.addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (!q) go("home");
    else go(`search/${encodeURIComponent(q)}`);
  }, 300);
});

window.addEventListener("hashchange", render);
refreshHeaderProfile();
render();
