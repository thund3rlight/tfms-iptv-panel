export default {
   async fetch(request, env, ctx) {
    const { pathname, searchParams } = new URL(request.url);
    const db = env.DB;

    // Bootstrap required D1 tables on first run. This keeps the project simple for Cloudflare deploys.
    async function ensureDatabaseSchema() {
      await db.prepare(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        admin_user TEXT DEFAULT 'admin',
        admin_pass TEXT DEFAULT 'SecretPassword123',
        tmdb_api_key TEXT DEFAULT '',
        dashboard_links TEXT DEFAULT ''
      )`).run();
      await db.prepare(`INSERT OR IGNORE INTO settings (id, admin_user, admin_pass, tmdb_api_key, dashboard_links)
        VALUES (1, 'admin', 'SecretPassword123', '', '')`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        exp_date TEXT DEFAULT 'Never',
        max_connections INTEGER DEFAULT 1
      )`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS streams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        category TEXT DEFAULT 'Live',
        image_url TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        referer TEXT DEFAULT '',
        content_type TEXT DEFAULT 'live',
        tmdb_id TEXT DEFAULT '',
        tmdb_type TEXT DEFAULT 'movie',
        tmdb_poster_url TEXT DEFAULT '',
        tmdb_backdrop_url TEXT DEFAULT '',
        tmdb_overview TEXT DEFAULT '',
        tmdb_year TEXT DEFAULT '',
        tmdb_rating TEXT DEFAULT ''
      )`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL
      )`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY,
        content TEXT DEFAULT '',
        updated_at TEXT DEFAULT ''
      )`).run();
      await db.prepare(`INSERT OR IGNORE INTO comments (id, content, updated_at) VALUES (1, '', '')`).run();
    }

    await ensureDatabaseSchema();
    try { await db.prepare("ALTER TABLE settings ADD COLUMN tmdb_api_key TEXT DEFAULT ''").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE settings ADD COLUMN dashboard_links TEXT DEFAULT ''").run(); } catch (e) {}
    const settings = await db
  .prepare("SELECT admin_user, admin_pass, tmdb_api_key, dashboard_links FROM settings WHERE id = 1")
  .first();

const ADMIN_USER = settings?.admin_user || "admin";
const ADMIN_PASS = settings?.admin_pass || "SecretPassword123";

    const hostUrl = new URL(request.url).origin;

// Auto-add optional stream header columns if this D1 database was created before this update.
// Safe to leave in place: existing-column errors are ignored.
async function ensureStreamHeaderColumns() {
  try { await db.prepare("ALTER TABLE streams ADD COLUMN user_agent TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN referer TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN content_type TEXT DEFAULT 'live'").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN image_url TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN tmdb_id TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN tmdb_type TEXT DEFAULT 'movie'").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN tmdb_poster_url TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN tmdb_backdrop_url TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN tmdb_overview TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN tmdb_year TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE streams ADD COLUMN tmdb_rating TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE settings ADD COLUMN tmdb_api_key TEXT DEFAULT ''").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE settings ADD COLUMN dashboard_links TEXT DEFAULT ''").run(); } catch (e) {}
}

await ensureStreamHeaderColumns();

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const getTmdbKey = () => env.TMDB_API_KEY || settings?.tmdb_api_key || "";
const tmdbImageUrl = (path) => path ? `${TMDB_IMAGE_BASE}${path}` : "";
const cleanVodTitle = (title) => String(title || "")
  .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
  .replace(/\b(19|20)\d{2}\b/g, " ")
  .replace(/\b(1080p|720p|2160p|4k|uhd|hdr|bluray|web[- ]?dl|x264|x265|hevc|aac|multi|proper|repack)\b/gi, " ")
  .replace(/[._-]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const splitCategoryImage = (category = "") => ({
  category: String(category || "").trim(),
  image_url: ""
});

const parseM3uAttributes = (line = "") => {
  const attrs = {};
  const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
};

async function fetchTmdbMeta(title, mediaType = "movie") {
  const apiKey = getTmdbKey();
  const query = cleanVodTitle(title);
  if (!apiKey || !query) return null;

  const type = mediaType === "tv" ? "tv" : "movie";
  const tmdbUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}&include_adult=false`;
  const res = await fetch(tmdbUrl);
  if (!res.ok) return null;

  const data = await res.json();
  const item = data.results?.[0];
  if (!item) return null;

  return {
    tmdb_id: String(item.id || ""),
    tmdb_type: type,
    name: item.title || item.name || title,
    poster: tmdbImageUrl(item.poster_path),
    backdrop: tmdbImageUrl(item.backdrop_path),
    overview: item.overview || "",
    year: (item.release_date || item.first_air_date || "").slice(0, 4),
    rating: item.vote_average ? String(Math.round(item.vote_average * 10) / 10) : ""
  };
}

async function buildVodPayload(body) {
  const useTmdb = body.tmdb_autofill !== false;
  const tmdbType = body.tmdb_type === "tv" ? "tv" : "movie";
  const meta = useTmdb ? await fetchTmdbMeta(body.name, tmdbType) : null;
  const poster = meta?.poster || body.tmdb_poster_url || "";
  const baseCategory = (body.category || "VOD").split("|")[0] || "VOD";

  return {
    name: meta?.name || body.name,
    url: body.url,
    category: baseCategory || "VOD",
    user_agent: body.user_agent || "",
    referer: body.referer || "",
    tmdb_id: meta?.tmdb_id || body.tmdb_id || "",
    tmdb_type: meta?.tmdb_type || tmdbType,
    image_url: poster || body.image_url || "",
    tmdb_poster_url: poster,
    tmdb_backdrop_url: meta?.backdrop || body.tmdb_backdrop_url || "",
    tmdb_overview: meta?.overview || body.tmdb_overview || "",
    tmdb_year: meta?.year || body.tmdb_year || "",
    tmdb_rating: meta?.rating || body.tmdb_rating || ""
  };
}


const isAccountExpired = (expDateStr) => {
  if (!expDateStr || expDateStr === "Never") return false;
  const expiry = new Date(expDateStr + "T23:59:59");
  if (isNaN(expiry.getTime())) return false;
  return Date.now() > expiry.getTime();
};

  if (pathname === "/proxy") {

  const encoded = searchParams.get("data");
  const user = searchParams.get("user");
  const pass = searchParams.get("pass");

  if (!encoded) {
    return new Response("Missing Stream URL", { status: 400 });
  }

  let streamUrl;

  try {
    streamUrl = atob(encoded);
  } catch {
    return new Response("Invalid Stream Token", { status: 400 });
  }

      if (!streamUrl) return new Response("Missing Stream URL", { status: 400 });
      if (!user || !pass) return new Response("Missing Credentials", { status: 401 });

      const userCheck = await db.prepare("SELECT * FROM users WHERE username = ? AND password = ? AND status = 'active'").bind(user, pass).first();
      if (!userCheck) return new Response("Unauthorized Line", { status: 401 });

      if (isAccountExpired(userCheck.exp_date)) {
        return new Response("Subscription Expired. Access Denied.", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      // KV connection tracking has been intentionally removed for 1-click deploy simplicity.
      // max_connections is still stored per user, but active live connection counting is disabled.

      try {
        const customUA = searchParams.get("ua");
const customReferer = searchParams.get("referer");

/** @type {Record<string, string>} */
const proxyHeaders = {};

if (customUA) {
  proxyHeaders["User-Agent"] = customUA;
}

if (customReferer) {
  proxyHeaders["Referer"] = customReferer;
}

const response = await fetch(streamUrl, {
  headers: proxyHeaders
});
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");

        return new Response(response.body, { status: response.status, headers: newHeaders });

      } catch (e) {
        return new Response("Proxy Playback Error: " + e.message, { status: 500 });
      }
    }

if (pathname.startsWith("/play/")) {

  const user = searchParams.get("user");
  const pass = searchParams.get("pass");

  const streamId = pathname.split("/play/")[1];

  const userCheck = await db.prepare(
    "SELECT * FROM users WHERE username = ? AND password = ? AND status='active'"
  )
  .bind(user, pass)
  .first();

  if (!userCheck) {
    return new Response("Unauthorized", { status: 401 });
  }

  const stream = await db.prepare(
    "SELECT * FROM streams WHERE id = ?"
  )
  .bind(streamId)
  .first();

  if (!stream) {
    return new Response("Stream Not Found", { status: 404 });
  }

/** @type {Record<string, string>} */
const playHeaders = {};

if (stream.user_agent) {
  playHeaders["User-Agent"] = stream.user_agent;
}

if (stream.referer) {
  playHeaders["Referer"] = stream.referer;
}

const response = await fetch(stream.url, {
  headers: playHeaders
});

const playResponseHeaders = new Headers(response.headers);
playResponseHeaders.set("Access-Control-Allow-Origin", "*");

return new Response(response.body, {
  status: response.status,
  headers: playResponseHeaders
});
}

    if (pathname === "/get_playlist") {
      const user = searchParams.get("user");
      const pass = searchParams.get("pass");
      const proxyId = searchParams.get("proxy");
      const includeVod = searchParams.get("include_vod") !== "0";

      const userCheck = await db.prepare("SELECT * FROM users WHERE username = ? AND password = ? AND status = 'active'").bind(user, pass).first();
      if (!userCheck) return new Response("Unauthorized Account", { status: 401 });

      if (isAccountExpired(userCheck.exp_date)) {
        return new Response("Subscription Expired. Playlist generation locked.", { status: 403 });
      }

      let baseProxyString = "";
      let isBuiltIn = false;
      let isNoProxy = false;

      if (proxyId === 'none') {
        isNoProxy = true;
      } else if (proxyId === 'default' || !proxyId) {
        baseProxyString = `${hostUrl}/proxy?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}&data=`;
        isBuiltIn = true;
      } else {
        const proxy = await db.prepare("SELECT url FROM proxies WHERE id = ?").bind(proxyId).first();
        if (proxy) baseProxyString = proxy.url;
      }

      const streams = await db.prepare(
        includeVod
          ? "SELECT * FROM streams"
          : "SELECT * FROM streams WHERE COALESCE(content_type, 'live') != 'vod'"
      ).all();
      const EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz";
      let m3u = `#EXTM3U url-tvg="${EPG_URL}"\n`;

      for (const stream of streams.results) {
        let targetUrl = stream.url;
        
if (!isNoProxy) {

if (isBuiltIn) {
  const encodedUrl = btoa(stream.url);
  targetUrl = `${baseProxyString}${encodeURIComponent(encodedUrl)}`;

  if (stream.user_agent) {
    targetUrl += `&ua=${encodeURIComponent(stream.user_agent)}`;
  }

  if (stream.referer) {
    targetUrl += `&referer=${encodeURIComponent(stream.referer)}`;
  }
}

else if (baseProxyString) {
let computedProxy = baseProxyString
.replace(/{user}/g, encodeURIComponent(user))
.replace(/{pass}/g, encodeURIComponent(pass))
.replace(/{ua}/g, encodeURIComponent(stream.user_agent || ""))
.replace(/{user_agent}/g, encodeURIComponent(stream.user_agent || ""))
.replace(/{referer}/g, encodeURIComponent(stream.referer || ""));

targetUrl = `${computedProxy}${stream.url}`;
}}

        let category = stream.category || "";
let logo = stream.image_url || "";


const directTmdbLogo = stream.tmdb_poster_url || logo;
const logoTag = directTmdbLogo ? `tvg-logo="${directTmdbLogo}"` : "";
const yearTag = stream.tmdb_year ? ` tvg-year="${stream.tmdb_year}"` : "";
const ratingTag = stream.tmdb_rating ? ` tvg-rating="${stream.tmdb_rating}"` : "";

m3u += `#EXTINF:-1 tvg-name="${stream.name}" ${logoTag}${yearTag}${ratingTag} group-title="${category}",${stream.name}\n`;

if (stream.user_agent) {
  m3u += `#EXTVLCOPT:http-user-agent=${stream.user_agent}\n`;
}

if (stream.referer) {
  m3u += `#EXTVLCOPT:http-referrer=${stream.referer}\n`;
}

m3u += `${targetUrl}\n`;
      }

      return new Response(m3u, {
        headers: {
          "Content-Type": "application/mpegurl",
          "Content-Disposition": `attachment; filename="${user}_playlist.m3u"`,
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

const COOKIE_NAME = "tfms_admin_session";

function getCookies(req) {
  const cookieHeader = req.headers.get("Cookie") || "";
  return Object.fromEntries(
    cookieHeader.split(";").map(c => {
      const parts = c.trim().split("=");
      return [parts[0], parts[1]];
    })
  );
}

const cookies = getCookies(request);

if (pathname === "/login" && request.method === "GET") {

  return new Response(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TFMS Admin Login</title>
<link rel="stylesheet" href="https://tfms.xyz/firestick/core/css/panel.login.css">
</head>
<body>
<div class="login-box">
<h1>TFMS IPTV</h1>
${
  searchParams.get("error")
    ? `<div class="error">Invalid login</div>`
    : ""
}
<form method="POST" action="/login">
<input type="text" name="username" placeholder="Username" required>
<input type="password" name="password" placeholder="Password" required>
<button type="submit">Login</button>
</form>
</div>
</body>
</html>

`, {
    headers: {
      "Content-Type": "text/html"
    }
  });
}

if (pathname === "/login" && request.method === "POST") {
  const form = await request.formData();
  const username = form.get("username");
  const password = form.get("password");

  if (
    username === ADMIN_USER &&
    password === ADMIN_PASS
  ) {

    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/",
        "Set-Cookie":
          `${COOKIE_NAME}=authorized; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
      }
    });
  }

  return Response.redirect(`${hostUrl}/login?error=1`, 302);
}

if (pathname === "/logout") {
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/login",
      "Set-Cookie":
        `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`
    }
  });
}

const publicRoutes = [
  "/proxy",
  "/get_playlist",
  "/login"
];

const isPublic =
  publicRoutes.some(route => pathname.startsWith(route));

if (!isPublic) {

  if (cookies[COOKIE_NAME] !== "authorized") {
    return Response.redirect(`${hostUrl}/login`, 302);
  }

}

    if (request.method === "POST" && pathname.startsWith("/api/")) {
      const body = await request.json();

if (pathname === "/api/tinyurl") {
  const longUrl = body.url;

  if (!longUrl || typeof longUrl !== "string") {
    return Response.json({ error: "Missing URL" }, { status: 400 });
  }

  try {
    const tinyRes = await fetch(
      "https://tinyurl.com/api-create.php?url=" + encodeURIComponent(longUrl)
    );

    if (!tinyRes.ok) {
      return Response.json({ error: "TinyURL request failed" }, { status: 500 });
    }

    const tinyUrl = (await tinyRes.text()).trim();

    if (!tinyUrl.startsWith("http")) {
      return Response.json({ error: tinyUrl || "TinyURL returned an invalid response" }, { status: 500 });
    }

    return Response.json({ success: true, tinyUrl });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

if (pathname === "/api/settings/save") {

  await db.prepare(`
    UPDATE settings
    SET admin_user = ?, admin_pass = ?, tmdb_api_key = ?
    WHERE id = 1
  `)
  .bind(body.admin_user, body.admin_pass, body.tmdb_api_key || "")
  .run();

  return Response.json({ success: true });
}

if (pathname === "/api/dashboard_links/save") {
  const links = Array.isArray(body.links) ? body.links : [];
  const cleanLinks = links.slice(0, 20).map(link => ({
    name: String(link?.name || "Quick Link").trim().slice(0, 80) || "Quick Link",
    url: String(link?.url || "").trim().slice(0, 1000)
  }));

  await db.prepare(`
    UPDATE settings
    SET dashboard_links = ?
    WHERE id = 1
  `)
  .bind(JSON.stringify(cleanLinks))
  .run();

  return Response.json({ success: true, links: cleanLinks });
}

if (pathname === "/api/comments/save") {
  const content = body.content || "";

  const exists = await db.prepare("SELECT id FROM comments WHERE id = 1").first();

  if (exists) {
    await db.prepare(
      "UPDATE comments SET content = ?, updated_at = ? WHERE id = 1"
    ).bind(content, new Date().toISOString()).run();
  } else {
    await db.prepare(
      "INSERT INTO comments (id, content, updated_at) VALUES (1, ?, ?)"
    ).bind(content, new Date().toISOString()).run();
  }

  return Response.json({ success: true });
}

if (pathname === "/api/tmdb/search") {
  const meta = await fetchTmdbMeta(body.title || body.name, body.tmdb_type || "movie");
  if (!meta) return Response.json({ error: "TMDB match not found or API key missing" }, { status: 404 });
  return Response.json({ success: true, meta });
}

      if (pathname === "/api/users/add") {
        await db.prepare("INSERT INTO users (username, password, exp_date, max_connections) VALUES (?, ?, ?, ?)")
          .bind(body.username, body.password, body.exp_date || "Never", parseInt(body.max_connections) || 1).run();
        return Response.json({ success: true });
      }

      if (pathname === "/api/users/edit") {
        await db.prepare("UPDATE users SET password = ?, status = ?, exp_date = ?, max_connections = ? WHERE id = ?")
          .bind(body.password, body.status, body.exp_date, parseInt(body.max_connections) || 1, body.id).run();
        return Response.json({ success: true });
      }

      if (pathname === "/api/users/delete") {
        await db.prepare("DELETE FROM users WHERE id = ?").bind(body.id).run();
        return Response.json({ success: true });
      }

      if (pathname === "/api/streams/add") {
        const catImg = splitCategoryImage(body.category || "Live");
        const imageUrl = body.image_url || catImg.image_url || "";
        await db.prepare("INSERT INTO streams (name, url, category, image_url, user_agent, referer, content_type) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(body.name, body.url, catImg.category || "Live", imageUrl, body.user_agent || "", body.referer || "", "live").run();
        return Response.json({ success: true });
      }

      if (pathname === "/api/vod/add") {
        const vod = await buildVodPayload(body);
        await db.prepare("INSERT INTO streams (name, url, category, image_url, user_agent, referer, content_type, tmdb_id, tmdb_type, tmdb_poster_url, tmdb_backdrop_url, tmdb_overview, tmdb_year, tmdb_rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(vod.name, vod.url, vod.category, vod.image_url || vod.tmdb_poster_url || "", vod.user_agent, vod.referer, "vod", vod.tmdb_id, vod.tmdb_type, vod.tmdb_poster_url, vod.tmdb_backdrop_url, vod.tmdb_overview, vod.tmdb_year, vod.tmdb_rating).run();
        return Response.json({ success: true, vod });
      }

if (pathname === "/api/backup/sql_import") {
  const sql = body.sql;

  if (!sql || typeof sql !== "string") {
    return Response.json({ error: "Invalid SQL input" }, { status: 400 });
  }

  const cleaned = sql
    .replace(/BEGIN TRANSACTION;?/gi, "")
    .replace(/COMMIT;?/gi, "");

  const statements = cleaned
    .split(";\n")
    .map(s => s.trim())
    .filter(Boolean);

  const errors = [];
  let successCount = 0;

  for (const stmt of statements) {
    try {
      await db.prepare(stmt).run();
      successCount++;
    } catch (e) {
      errors.push({
        statement: stmt.slice(0, 120),
        error: e.message
      });
    }
  }

  return Response.json({
    success: true,
    executed: successCount,
    failed: errors.length,
    errors
  });
}

if (pathname === "/api/backup/sql") {
  const users = await db.prepare("SELECT * FROM users").all();
  const streams = await db.prepare("SELECT * FROM streams").all();
  const proxies = await db.prepare("SELECT * FROM proxies").all();

  const esc = (v) =>
    String(v ?? "").replace(/'/g, "''");

  let sql = "-- TFMS IPTV Backup\nBEGIN TRANSACTION;\n\n";

  for (const u of users.results) {
    sql += `INSERT INTO users (id, username, password, status, exp_date, max_connections) VALUES (` +
      `${u.id}, '${esc(u.username)}', '${esc(u.password)}', '${esc(u.status)}', '${esc(u.exp_date)}', ${u.max_connections || 1});\n`;
  }

  sql += "\n";

  for (const s of streams.results) {
    sql += `INSERT INTO streams (id, name, url, category, image_url, user_agent, referer, content_type, tmdb_id, tmdb_type, tmdb_poster_url, tmdb_backdrop_url, tmdb_overview, tmdb_year, tmdb_rating) VALUES (` +
      `${s.id}, '${esc(s.name)}', '${esc(s.url)}', '${esc(s.category)}', '${esc(s.image_url)}', '${esc(s.user_agent)}', '${esc(s.referer)}', '${esc(s.content_type || 'live')}', '${esc(s.tmdb_id)}', '${esc(s.tmdb_type)}', '${esc(s.tmdb_poster_url)}', '${esc(s.tmdb_backdrop_url)}', '${esc(s.tmdb_overview)}', '${esc(s.tmdb_year)}', '${esc(s.tmdb_rating)}');\n`;
  }

  sql += "\n";

  for (const p of proxies.results) {
    sql += `INSERT INTO proxies (id, name, url) VALUES (` +
      `${p.id}, '${esc(p.name)}', '${esc(p.url)}');\n`;
  }

  sql += "\nCOMMIT;";

  return new Response(sql, {
    headers: {
      "Content-Type": "text/plain",
      "Content-Disposition": `attachment; filename="tfms_backup.sql"`,
      "Access-Control-Allow-Origin": "*"
    }
  });
}

if (pathname === "/api/streams/mass_import") {
  const lines = body.m3u.split("\n");
  const forcedCategory = body.category?.trim();

  let currentname = "unknown stream";
  let currentcategory = forcedCategory || "imported";
  let currentimage = "";

  for (let line of lines) {
    line = line.trim();

    if (line.toLowerCase().startsWith("#extinf:")) {
      const attrs = parseM3uAttributes(line);
      const namematch = line.match(/,(.*)$/);
      if (namematch) currentname = namematch[1].trim();

      currentcategory = forcedCategory || attrs["group-title"] || "imported";
      currentimage = attrs["tvg-logo"] || attrs["logo"] || "";

      const catImg = splitCategoryImage(currentcategory);
      currentcategory = catImg.category || "imported";
      currentimage = currentimage || catImg.image_url || "";
    } else if (line.toLowerCase().startsWith("http")) {
      await db.prepare("INSERT INTO streams (name, url, category, image_url, user_agent, referer, content_type) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(currentname, line, currentcategory, currentimage, "", "", "live").run();

      currentname = "unknown stream";
      currentcategory = forcedCategory || "imported";
      currentimage = "";
    }
  }
  return Response.json({ success: true });
}

if (pathname === "/api/streams/import_url") {
  const url = body.url;

  if (!url || typeof url !== "string") {
    return Response.json({ error: "Missing URL" }, { status: 400 });
  }

  let m3uText;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return Response.json({ error: "Failed to fetch playlist" }, { status: 500 });
    }

    m3uText = await res.text();
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  const lines = m3uText.split("\n");

  const forcedCategory = body.category?.trim();
  let currentname = "unknown stream";
  let currentcategory = forcedCategory || "imported";
  let currentimage = "";

  for (let line of lines) {
    line = line.trim();

    if (line.toLowerCase().startsWith("#extinf:")) {
      const attrs = parseM3uAttributes(line);
      const namematch = line.match(/,(.*)$/);
      if (namematch) currentname = namematch[1].trim();

      currentcategory = forcedCategory || attrs["group-title"] || "imported";
      currentimage = attrs["tvg-logo"] || attrs["logo"] || "";

      const catImg = splitCategoryImage(currentcategory);
      currentcategory = catImg.category || "imported";
      currentimage = currentimage || catImg.image_url || "";

    } else if (line.toLowerCase().startsWith("http")) {
      await db.prepare(
        "INSERT INTO streams (name, url, category, image_url, user_agent, referer, content_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(currentname, line, currentcategory, currentimage, "", "", "live").run();

      currentname = "unknown stream";
      currentcategory = forcedCategory || "imported";
      currentimage = "";
    }
  }

  return Response.json({ success: true });
}

if (pathname === "/api/vod/mass_import") {
  const lines = body.m3u.split("\n");
  const forcedCategory = body.category?.trim();
  let currentname = "unknown vod";
  let currentcategory = forcedCategory || "VOD";
  let currentimage = "";

  for (let line of lines) {
    line = line.trim();
    if (line.toLowerCase().startsWith("#extinf:")) {
      const attrs = parseM3uAttributes(line);
      const namematch = line.match(/,(.*)$/);
      if (namematch) currentname = namematch[1].trim();
      currentcategory = forcedCategory || attrs["group-title"] || "VOD";
      currentimage = attrs["tvg-logo"] || attrs["logo"] || "";
      const catImg = splitCategoryImage(currentcategory);
      currentcategory = catImg.category || "VOD";
      currentimage = currentimage || catImg.image_url || "";
    } else if (line.toLowerCase().startsWith("http")) {
      await db.prepare("INSERT INTO streams (name, url, category, image_url, user_agent, referer, content_type) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(currentname, line, currentcategory, currentimage, "", "", "vod").run();
      currentname = "unknown vod";
      currentcategory = forcedCategory || "VOD";
      currentimage = "";
    }
  }
  return Response.json({ success: true });
}

if (pathname === "/api/vod/import_url") {
  const url = body.url;
  if (!url || typeof url !== "string") {
    return Response.json({ error: "Missing URL" }, { status: 400 });
  }

  let m3uText;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return Response.json({ error: "Failed to fetch VOD playlist" }, { status: 500 });
    }
    m3uText = await res.text();
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }

  const lines = m3uText.split("\n");
  const forcedCategory = body.category?.trim();
  let currentname = "unknown vod";
  let currentcategory = forcedCategory || "VOD";
  let currentimage = "";

  for (let line of lines) {
    line = line.trim();
    if (line.toLowerCase().startsWith("#extinf:")) {
      const attrs = parseM3uAttributes(line);
      const namematch = line.match(/,(.*)$/);
      if (namematch) currentname = namematch[1].trim();
      currentcategory = forcedCategory || attrs["group-title"] || "VOD";
      currentimage = attrs["tvg-logo"] || attrs["logo"] || "";
      const catImg = splitCategoryImage(currentcategory);
      currentcategory = catImg.category || "VOD";
      currentimage = currentimage || catImg.image_url || "";
    } else if (line.toLowerCase().startsWith("http")) {
      await db.prepare("INSERT INTO streams (name, url, category, image_url, user_agent, referer, content_type) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(currentname, line, currentcategory, currentimage, "", "", "vod").run();
      currentname = "unknown vod";
      currentcategory = forcedCategory || "VOD";
      currentimage = "";
    }
  }
  return Response.json({ success: true });
}

      if (pathname === "/api/streams/edit") {
        const catImg = splitCategoryImage(body.category || "Live");
        const imageUrl = body.image_url || catImg.image_url || "";
        await db.prepare("UPDATE streams SET name = ?, url = ?, category = ?, image_url = ?, user_agent = ?, referer = ? WHERE id = ?")
          .bind(body.name, body.url, catImg.category || "Live", imageUrl, body.user_agent || "", body.referer || "", body.id).run();
        return Response.json({ success: true });
      }

      if (pathname === "/api/streams/delete") {
        await db.prepare("DELETE FROM streams WHERE id = ?").bind(body.id).run();
        return Response.json({ success: true });
      }

      if (pathname === "/api/vod/edit") {
        const vod = await buildVodPayload(body);
        await db.prepare("UPDATE streams SET name = ?, url = ?, category = ?, image_url = ?, user_agent = ?, referer = ?, content_type = 'vod', tmdb_id = ?, tmdb_type = ?, tmdb_poster_url = ?, tmdb_backdrop_url = ?, tmdb_overview = ?, tmdb_year = ?, tmdb_rating = ? WHERE id = ?")
          .bind(vod.name, vod.url, vod.category, vod.image_url || vod.tmdb_poster_url || "", vod.user_agent, vod.referer, vod.tmdb_id, vod.tmdb_type, vod.tmdb_poster_url, vod.tmdb_backdrop_url, vod.tmdb_overview, vod.tmdb_year, vod.tmdb_rating, body.id).run();
        return Response.json({ success: true, vod });
      }

      if (pathname === "/api/vod/delete") {
        await db.prepare("DELETE FROM streams WHERE id = ? AND content_type = 'vod'").bind(body.id).run();
        return Response.json({ success: true });
      }

      if (pathname === "/api/streams/mass_delete") {
        if (body.scope === "all") {
          await db.prepare("DELETE FROM streams").run();
        } else if (body.scope === "category" && body.category) {
          await db.prepare("DELETE FROM streams WHERE category = ?").bind(body.category).run();
        }
        return Response.json({ success: true });
      }

      if (pathname === "/api/proxies/add") {
        await db.prepare("INSERT INTO proxies (name, url) VALUES (?, ?)")
          .bind(body.name, body.url).run();
        return Response.json({ success: true });
      }

      if (pathname === "/api/proxies/delete") {
        await db.prepare("DELETE FROM proxies WHERE id = ?").bind(body.id).run();
        return Response.json({ success: true });
      }
    }

    if (pathname === "/api/data") {
      const users = await db.prepare("SELECT * FROM users").all();
      const streams = await db.prepare("SELECT * FROM streams").all();
      const proxies = await db.prepare("SELECT * FROM proxies").all();
      const commentRow = await db.prepare("SELECT content FROM comments WHERE id = 1").first();
      const comment = commentRow?.content || "";
      const mappedUsers = users.results.map((u) => {
        const expired = isAccountExpired(u.exp_date);
        return { ...u, active_connections: 0, is_expired: expired };
      });

const settingsData = await db
  .prepare("SELECT admin_user, admin_pass, tmdb_api_key, dashboard_links FROM settings WHERE id = 1")
  .first();

const liveStreams = streams.results.filter(s => (s.content_type || "live") !== "vod");
const vodStreams = streams.results.filter(s => (s.content_type || "live") === "vod");

return Response.json({
  users: mappedUsers,
  streams: liveStreams,
  vod: vodStreams,
  all_streams: streams.results,
  proxies: proxies.results,
  comment,
  settings: settingsData
});
    }

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<meta charset="UTF-8">
<title>TFMS IPTV Panel</title>
<link rel="stylesheet" href="https://tfms.xyz/firestick/core/css/panel.index.css">
</head>

<body>
<div class="container">
<header style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
<img src="https://tfms.xyz/firestick/core/images/banner.png" alt="TFMS IPTV Panel" style="height:60px; object-fit:contain;"/>
<div style="display:flex; gap:10px;">
<button onclick="toggleTheme()" id="themeBtn">🌙</button>
<button id="aboutBtn" onclick="showAboutModal()" style="display:none; background:#7c3aed;">About</button>
<button id="updatesBtn" onclick="window.open('https://tfms.xyz/firestick/core/tuts/tfms-tv-panel-v1-0-1.TUT.GUIDE.html','_blank')" style="display:none; background:#16a34a;">Updates</button>
<button onclick="window.location='/logout'" style="background:#dc2626;">Logout</button>
</div>
</header>

<div class="tabs">
  <div style="display:flex; gap:10px;">
    <button class="tab-btn active" onclick="switchTab('overviewTab', this)">Dashboard</button>
    <button class="tab-btn" onclick="switchTab('usersTab', this)">Userlines</button>
    <button class="tab-btn" onclick="switchTab('streamsTab', this)">Streams</button>
    <button class="tab-btn" onclick="switchTab('vodTab', this)">VOD</button>
    <button class="tab-btn" onclick="switchTab('proxiesTab', this)">Proxies</button>
    <button class="tab-btn" onclick="switchTab('toolsTab', this)">Tools</button>
    <button class="tab-btn" onclick="switchTab('settingsTab', this)">Settings</button>
    <button class="tab-btn" onclick="switchTab('browserTab', this)">Browser</button>
  </div>
</div>

<datalist id="categoryOptions"></datalist>

<div id="proxiesTab" class="tab-content">

  <div class="card">
    <h2>Add New Proxy Server</h2>
    <hr>
    <div class="settings-grid">

      <div class="settings-box">
        <h3>Proxy Configuration</h3>
        <input type="text" id="proxyName" placeholder="New Proxy Name">
        <input type="text" id="proxyUrl" placeholder="New Proxy Url, Must Include trailing / Can include - /?url= etc">
        <button onclick="addProxy()">Add Proxy Server</button>
      </div>

      <div class="settings-box">
        <h3>Proxy Information</h3>
        <div style=" font-size:14px; line-height:1.8; color:#64748b;">
          <b>Supported Formats</b><br>
          https://domain.com/<br>
          https://domain.com/proxy?url=<br>
          https://domain.com/fetch/<br>
          https://domain.com/play?u={user}&p={pass}&url=<br><br>

          <b>Tips</b><br>
          • Add your proxy here then select it from the dropdown in user lines<br>
          • Always include trailing slash if required<br>
          • Cloudflare Workers work best for M3U routing<br>
          • You can use placeholders like {user} and {pass}<br>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Configured Proxy Servers</h2>
    <hr>
    <div class="proxy-list">
<div style=" display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap;gap:10px;">

        <strong>Saved Proxy Routes</strong>
<input type="text" id="proxySearch" placeholder="Search proxies..." onkeyup="filterProxies()" style=" width:220px; padding:6px 10px; font-size:12px; border-radius:6px; margin:0;">
      </div>

      <div id="proxyContainer"></div>
    </div>
  </div>

<div class="card">
  <h2>Proxy Tools & Resources</h2>
  <hr>
  <div style=" display:grid; grid-template-columns:1fr 1fr; gap:20px; align-items:start;">

    <div class="settings-box" style="padding:0; overflow:hidden;">
<div style="padding:12px 15px; border-bottom:1px solid var(--border); font-weight:700; background:var(--tableHead);">Proxy Creation Tools</div>
<iframe src="https://tfms.xyz/firestick/sites/proxies2.html" style="width:100%; height:800px; border:0; background:white;" loading="lazy"></iframe>
</div>

    <div class="settings-box" style="padding:0; overflow:hidden;">
<div style="padding:12px 15px; border-bottom:1px solid var(--border); font-weight:700; background:var(--tableHead);">Proxy Resources</div>
<iframe src="https://solitary-wind-7787.rzvaldpwgwymnhdshn.workers.dev/" style="width:100%; height:800px; border:0; background:white;" loading="lazy"></iframe>
</div>

<div class="card">
  <h2>Install this <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/smokindope/proxy-with-tokens-and-pass-1-click" target="_blank"><button>PROXY</button></a> 1 Click Cloudflare Deploy</h2>
When created enter the proxy url into the box below (with tokens & user/pass)
  <hr>
  <div class="settings-box">
    <div style="display:flex; gap:0px; margin-bottom:0px;">
<input type="text" id="customIframeUrl" placeholder="https://example.com" style="flex:1;" >
<button onclick="loadCustomIframe()">Load Site</button>
    </div>
<iframe id="customIframe" src="about:blank" style="width:100%; height:800px; border:0; background:white;"></iframe>
</div>
</div>

<div class="card">
  <h2>Install this <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/smokindope/proxy-with-tokens-and-no-pass-1-click" target="_blank"><button>PROXY</button></a> 1 Click Cloudflare Deploy</h2>
When created enter the proxy url into the box below (with tokens & NO pass) 
  <hr>
  <div class="settings-box">
<div style="display:flex; gap:0px; margin-bottom:0px;">
<input type="text" id="customIframeUrl2" placeholder="https://example.com" style="flex:1;">
<button onclick="loadCustomIframe2()">Load Site</button>
</div>
<iframe id="customIframe2" src="about:blank" style="width:100%; height:800px; border:0; background:white;"></iframe>
</div>
</div>
</div>
</div>
</div>
</div>

<div id="browserTab" class="tab-content">
  <div class="card">
    <h2>Custom Headless Browser One Click Huggingface Deploy <a href="https://huggingface.co/spaces/paul9876587/browser2?duplicate=true" target="_blank"><button>Click Here</button></a></h2>
        Click Duplicate Space then paste your proxy url into the box below then click load site<br>Retrieve streams & referers from embed pages
<hr>
    <div style="display:flex; gap:10px; margin-bottom:10px;">
      <input type="text" id="browserIframeUrl" placeholder="https://example.com" style="flex:1;">
      <button onclick="loadBrowserIframe()">Load Site</button>
    </div>
    <iframe
      id="browserIframe"
      src="about:blank"
      style="width:100%; height:900px; border:1px solid var(--border); border-radius:8px; background:white;"
      loading="lazy"
      allow="clipboard-read; clipboard-write; fullscreen"
      allowfullscreen>
    </iframe>
  </div>
</div>

<div id="toolsTab" class="tab-content">

  <div style=" background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; padding: 12px 16px; border-radius: 8px; margin-bottom: 15px; font-size: 14px; font-weight: 600;box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
    📢 Announcement:<br>Note this panel plays the direct links behind proxies, If you are using a 1 connection playlist as your stream source this will not work when you are serving multiple users, Always use streams from a good multi connection playlist
  </div>

  <div class="card">
    <h2>Get FREE Streams</h2>
    <hr>
    <iframe src="https://tfms.xyz/firestick/sites/links.html" style="width:100%; height:600px; border:1px solid var(--border); border-radius:8px; background:white;" loading="lazy"></iframe>
  </div>

<div class="card">
  <h2>Live Media Players</h2>
  <hr>
  <div class="media-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:20px;">

    <div class="settings-box" style="padding:0; overflow:hidden;">
<iframe src="https://tfms.xyz/firestick/sites/jwplayer.html" style="width:100%; height:400px; border:0;" loading="lazy" allow="fullscreen" allowfullscreen></iframe>
</div>

    <div class="settings-box" style="padding:0; overflow:hidden;">
<iframe src="https://tfms.xyz/firestick/sites/clapprplayer.html" style="width:100%; height:400px; border:0;" loading="lazy" allow="fullscreen" allowfullscreen></iframe>
</div>
</div>
</div>

<div class="card">
  <h2>Tools</h2>
  <hr>

  <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;">

    <div class="settings-box" style="padding:0; overflow:hidden;">
      <iframe src="https://tfms.xyz/firestick/sites/linkanalyzer1.html" style="width:100%; height:900px; border:0;" loading="lazy"></iframe>
    </div>

    <div class="settings-box" style="padding:0; overflow:hidden;">
      <iframe src="https://tfms.xyz/firestick/sites/url-formatter1.html" style="width:100%; height:900px; border:0;" loading="lazy"></iframe>
    </div>
  </div>
</div>


</div>


<div id="settingsTab" class="tab-content">

  <div class="card">
    <h2>Admin Settings</h2>
    <hr>
    <div class="settings-grid">

      <div class="settings-box">
        <h3>Change Admin Login</h3>
        <input type="text" id="adminUser"  placeholder="Admin Username">
        <input type="password" id="adminPass" placeholder="Admin Password">
        <button onclick="saveSettings()">Save Admin Settings</button>
      </div>

      <div class="settings-box">
        <h3>Admin Information</h3>
        <div style="font-size:14px; line-height:1.8; color:#64748b;">
          <b>Security Notice</b><br>
          Changing admin credentials will immediately affect login access.<br>
          <b>Session System</b><br>
          Existing login cookies may require browser refresh after updates.<br>
          <b>Best Practice</b><br>
          Use strong passwords and avoid default credentials.
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>TMDB API Settings</h2>
    <hr>
    <div class="settings-grid">

      <div class="settings-box">
        <h3>TMDB Key</h3>
        <input type="password" id="tmdbApiKey" placeholder="TMDB API Key for VOD auto-fill">
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button onclick="saveSettings()">Save TMDB API Key</button>
          <a href="https://www.themoviedb.org/settings/api" target="_blank">
            <button type="button">Setup your own key here</button>
          </a>
        </div>
      </div>

      <div class="settings-box">
        <h3>TMDB Information</h3>
        <div style="font-size:14px; line-height:1.8; color:#64748b;">
          <b>VOD Auto-Fill</b><br>
          This key is used to search TMDB and auto-fill posters, backdrop images, overview, year, and rating for VOD entries.<br>
          <b>Priority</b><br>
          If a Cloudflare environment variable named TMDB_API_KEY exists, it will be used before the saved database key.<br>
          <b>Privacy</b><br>
          Keep your TMDB key private and only save keys you control.
        </div>
      </div>
    </div>
  </div>

<div class="card">
  <h2>D1 SQL Backup Tools</h2>
  <hr>
  <div class="settings-grid">

    <div class="settings-box">
      <h3>Import/Export SQL Backup</h3>
      <div style="font-size:13px; color:#64748b; margin-bottom:10px;">Paste a full SQL backup export below and click import.</div>
      <textarea id="sqlInput" rows="12" placeholder="Paste SQL backup here..." style="width:100%; resize:vertical;"></textarea>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
        <button class="btn-success" onclick="uploadSqlImport()">Import SQL Backup</button>
        <button onclick="downloadSQLBackup()">Export SQL Backup</button>
      </div>
    </div>

    <div class="settings-box">
      <h3>Here You Can Import/Export Your SQL Backup</h3><br>
      <div style="font-size:14px; line-height:1.8; color:#64748b; margin-bottom:15px;">
        Export a full SQL backup containing:<br>
        • Users, Streams, Proxies, Settings<br><br>
        Import a full SQL backup:<br>
       Open Your SQL Backup On Your PC & Copy The Contents & Paste Into The Box<br><br>If This Fails Use Cloudflare Dashboard
      </div>
    </div>
  </div>
</div>

</div>

<div id="overviewTab" class="tab-content active">
  <div class="card">
    <div class="xc-grid">

      <div class="xc-card blue">
        <div class="xc-title">Total Users</div>
        <div class="xc-value" id="totalUsers">0</div>
        <div class="xc-sub">Registered Lines</div>
      </div>

      <div class="xc-card green">
        <div class="xc-title">Total Streams & VOD</div>
        <div class="xc-value" id="totalStreams">0</div>
        <div class="xc-sub">Active Channels</div>
      </div>

      <div class="xc-card purple">
        <div class="xc-title">Proxies</div>
        <div class="xc-value" id="totalProxies">0</div>
        <div class="xc-sub">Routing Nodes</div>
      </div>

      <div class="xc-card orange">
        <div class="xc-title">System Status</div>
        <div class="xc-value">ONLINE</div>
        <div class="xc-sub">All services running</div>
      </div>

<div class="xc-card" style="padding:0; overflow:hidden;">
<div id="worldMap" style="height:400px; width:100%;"></div>
</div>

<div class="xc-card purple" style="height: 400px; display:flex; flex-direction:column;">
<div class="xc-title">Sticky System Notes</div>

<textarea id="adminComments" style="flex:1; width:100%; margin-top:10px; resize:none;"></textarea>
<button style="margin-top:10px;" onclick="saveComments()">Save Comments</button>
</div>

    <div class="xc-card blue" style="height: 400px; display:flex; flex-direction:column; padding:18px;">
    <div class="xc-title">TFMS IPTV Panel v1.0.5</div>
    <div style="margin-top:12px; font-size:13px; line-height:1.6; opacity:0.95;">
    
    <b>What's New in This Release</b>
    <ul style="margin:8px 0 0 18px; padding:0;">
      <li>New VOD section with TMDB</li>
      <li>Categories & Image fields updated</li>
      <li>Built in proxy encodes the urls</li>
      <li>2 new proxy options with tokens</li>
      <li>Choose proxy per userline</li>
      <li>Copy playlist button</li>
      <li>Tinyurl button auto generated</li>
      <li>Headless browser for finding streams</li>
      <li>User-agent & referal options</li>
      <li>Edit Quick Links</li>
    </ul>

    <div style="margin-top:12px;">
      <b>Coming Next</b>
      <div style="margin-top:6px; opacity:0.9;">
        • Big code clean up<br>
        • Anything else i can think of<br>
      </div>
    </div>
  </div>
</div>

<div class="xc-card green" style="height:400px; display:flex; flex-direction:column; gap:10px; padding:18px;">
<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
  <div class="xc-title">Dashboard Quick Links</div>
  <button id="quickLinksEditBtn" class="quick-btn" style="width:auto; padding:6px 10px; font-size:12px;" onclick="toggleQuickLinkEdit()">Edit Links</button>
</div>
<div id="quickLinksContainer" style="display:flex; flex-direction:column; gap:8px; overflow:auto;"></div>
<div id="quickLinksEditor" style="display:none; flex-direction:column; gap:8px; overflow:auto;"></div>
<div id="quickLinksEditorActions" style="display:none; gap:8px; flex-wrap:wrap;">
  <button class="btn-success" style="padding:6px 10px; font-size:12px;" onclick="saveQuickLinks()">Save Links</button>
  <button style="background:#64748b; padding:6px 10px; font-size:12px;" onclick="cancelQuickLinkEdit()">Cancel</button>
  <button class="btn-danger" style="padding:6px 10px; font-size:12px;" onclick="resetQuickLinks()">Reset Defaults</button>
</div>
</div>
    </div>
  </div>
</div>

<div id="usersTab" class="tab-content">

  <div class="card">
    <div class="settings-grid">
      <div class="settings-box">
        <h2>User Line Registry</h2>
        <hr>
        <h3>Create & Edit Account</h3>
        <input type="hidden" id="userId">

        <input type="text" id="username" placeholder="New Account Username">
<input type="text" id="password" placeholder="New Account Password">
<input type="number" id="maxConnections" placeholder="Max Allowed Simultaneous Connections" min="1" value="1">

        <input type="date" id="userExp">
        <select id="userStatus">
          <option value="active">Line Active</option>
          <option value="disabled">Line Deactivated</option>
        </select>

        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button id="userBtn" onclick="saveUser()">Create New User</button>
          <button id="cancelUserBtn" style="display:none; background:#64748b" onclick="resetUserForm()">Cancel</button>
        </div>
      </div>

      <div class="settings-box">
        <h2>Line Information</h2>
        <hr>
        <div style="font-size:14px; line-height:1.8; color:#64748b;">

          <b>Username & Password</b><br>
          Unique account login used for playlist generation<br>
          <b>Max Connections</b><br>Controls simultaneous active streams allowed per account<br>
          <b>Expiration Date</b><br>Accounts automatically stop working after 23:59 on selected date<br>
          <b>Status Types</b><br>Active = User can stream normally<br>Disabled = Account blocked manually<br>
          <b>Playlist Downloads</b><br>Generate playlists using direct streams, built-in proxy, or custom proxies<br>
          <b>Hardcoded EPG</b><br>TV-Guide is hardcoded your iptv app should pick it up<br>
          <b>NOTES</b><br>Only using the built in proxy will hide the real stream url this is to avoid double proxying and helps avoid cloudflares TOS
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Registered User Lines</h2>
    <hr>
    <table>
      <thead>
        <tr>
          <th>Subscriber</th>
          <th style="white-space:nowrap;">
            Conns (Live/Max)
          </th>
          <th>Status</th>
          <th style="width:520px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
              <span>Actions</span>
              <input type="text" id="userSearch" placeholder="Search users..." onkeyup="filterUsers()" style="width:180px; padding:6px 10px; font-size:12px; border-radius:6px; margin:0;">
              <select id="globalProxySelect" title="Global default proxy" style="width:auto; min-width:200px; padding:6px 10px; font-size:12px; border-radius:6px; margin:0;"></select>
            </div>
          </th>
        </tr>
      </thead>
      <tbody id="userTable"></tbody>
    </table>
  </div>
</div>


<div id="vodTab" class="tab-content">
  <div class="card">
    <h2>VOD Library Management</h2>
    <hr>
    <div class="settings-grid">
      <div class="settings-box">
        <h3>Create & Edit VOD Files</h3>
        <input type="hidden" id="vodId">
        <input type="text" id="vodName" placeholder="VOD Name / Movie Title">
        <input type="text" id="vodUrlInput" placeholder="VOD File URL (.mp4, .mkv, .m3u8, etc)">
        <input type="text" id="vodCategory" list="categoryOptions" placeholder="Select a category or type your own">
        <select id="vodTmdbType">
          <option value="movie">TMDB Movie</option>
          <option value="tv">TMDB TV Show</option>
        </select>
        <input type="text" id="vodTmdbPoster" placeholder="TMDB Poster URL auto-filled: https://image.tmdb.org/t/p/w500/...">
        <button type="button" style="background:#0ea5e9;" onclick="lookupVodTmdb()">Auto Fill From TMDB</button>
        <textarea id="vodTmdbOverview" rows="3" placeholder="TMDB overview auto-filled"></textarea>
        <input type="text" id="vodUserAgent" placeholder="Optional User-Agent header for this VOD">
        <input type="text" id="vodReferer" placeholder="Optional Referer header for this VOD">
        <button id="vodBtn" onclick="saveVod()">Add New VOD File</button>
        <button id="cancelVodBtn" style="display:none; background:#64748b" onclick="resetVodForm()">Cancel</button>
      </div>

      <div class="settings-box">
        <h3>VOD Bulk Import</h3>
        <input type="text" id="vodMassImportCategory" list="categoryOptions" placeholder="Optional: select or type a VOD category"/>
        <textarea id="vodMassM3u" rows="8" placeholder="Paste VOD M3U here. group-title will be used unless you force a category."></textarea>
        <button class="btn-success" onclick="vodMassImport()">Mass Import VOD Files</button>
        <hr>
        <h3>OR Import VOD From URL</h3>
        <input type="text" id="remoteVodM3uUrl" placeholder="https://your.site/vod_playlist.m3u"/>
        <input type="text" id="remoteVodCategory" list="categoryOptions" placeholder="Optional: select or type a VOD category"/>
        <button class="btn-success" onclick="importVodFromUrl()">Import VOD From URL</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Registered VOD Files</h2>
    <hr>
    <table>
      <thead>
        <tr>
          <th>VOD Name</th>
          <th>Category</th>
          <th style="width:520px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
              <span>Actions</span>
              <div style="display:flex; gap:8px; align-items:center;">
                <input type="text" id="vodSearch" placeholder="Search VOD..." onkeyup="filterVod()" style="width:200px; padding:6px 10px; font-size:12px; border-radius:6px; margin:0;">
                <button onclick="clearVodSearch()" style="padding:6px 10px; font-size:12px;">Clear</button>
              </div>
            </div>
          </th>
        </tr>
      </thead>
      <tbody id="vodTable"></tbody>
    </table>
    <div id="vodPagination" style="display:flex; justify-content:center; align-items:center; gap:8px; flex-wrap:wrap; margin-top:15px;"></div>
  </div>
</div>

<div id="streamsTab" class="tab-content">


  <div class="card">
    <h2>Streams & VOD Management</h2>
    <hr>
    <div class="settings-grid">

      <div class="settings-box">
        <h3>Create & Edit Streams & VOD</h3>
        <input type="hidden" id="streamId">
        <input type="text" id="streamName" placeholder="Stream Name">
        <input type="text" id="streamUrlInput" placeholder="Stream Source URL">
        <input type="text" id="streamCategory" list="categoryOptions" placeholder="Select a category or type your own">
        <input type="text" id="streamImage" placeholder="Image URL / tvg-logo for this stream">
        <input type="text" id="streamUserAgent" placeholder="Optional User-Agent header for this stream">
        <input type="text" id="streamReferer" placeholder="Optional Referer header for this stream">
        <button id="streamBtn" onclick="saveStream()">Add New Stream</button>
        <button id="cancelStreamBtn" style="display:none; background:#64748b" onclick="resetStreamForm()">Cancel</button>
        <br><br>
        Optional User-Agent and Referer are sent by the built-in proxy and added as VLC options in generated playlists.
      </div>

      <div class="settings-box">
        <h3>M3U Bulk Import (.m3u parsing)</h3>
        <input type="text" id="massImportCategory" list="categoryOptions" placeholder="Optional: select/type a category, or leave empty to use group-title"/>
        <textarea id="massM3u" rows="8" placeholder="Mass Import M3U, If (group-title=) is included the category will be auto selected"></textarea>
        <button class="btn-success" onclick="massImport()">Mass Import Streams</button>
<hr>
<h3>OR Import From URL</h3>
<input type="text" id="remoteM3uUrl" placeholder="https://your.iptv.com/playlist.m3u"/>
<input type="text" id="remoteCategory" list="categoryOptions" placeholder="Optional: select or type a category"/>
<button class="btn-success" onclick="importFromUrl()">Import From URL</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Registered Streams & VOD</h2>
    <hr>
    <table>
      <thead>
        <tr>
          <th>Channel Name</th>
          <th>Group Tag</th>
          <th style="width:520px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">

              <span>Actions</span>
              <div style="display:flex; gap:8px; align-items:center;">
                <input type="text" id="streamSearch" placeholder="Search streams..." onkeyup="filterStreams()" style="width:200px; padding:6px 10px; font-size:12px; border-radius:6px; margin:0;">
                <button onclick="clearStreamSearch()" style="padding:6px 10px; font-size:12px;">Clear</button>
              </div>
            </div>
          </th>
        </tr>
      </thead>
      <tbody id="streamTable"></tbody>
    </table>
    <div id="streamPagination" style="display:flex; justify-content:center; align-items:center; gap:8px; flex-wrap:wrap; margin-top:15px;"></div>
  </div>

  <div class="card">
    <h2>Mass Delete Tools</h2>
    <hr>
    <div class="mass-delete-box">
      <strong style=" color:#991b1b; font-size:14px; white-space:nowrap;">Mass Delete:</strong>
      <select id="massDeleteSelect" style="margin:0; padding:6px; font-size:13px;">
      <option value="all">Wipe All Streams Completely</option></select>
      <button class="btn-danger" style="white-space: nowrap;" onclick="executeMassDelete()">Clear Streams</button>
    </div>
  </div>
</div>

<div id="player" style="width:100%; height:100%;"></div>
<footer style="margin-top:40px; text-align:center; font-size:12px; color:#64748b; padding:20px 0; border-top:1px solid var(--border);">
<a href="https://forum.tfms.xyz" target="_blank"><b>TFMS IPTV Panel v1.0.5</b></a> - 2026
</footer>

<div id="aboutModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,.7); z-index:9999; justify-content:center; align-items:center;">
<div style="background:var(--card); color:var(--text); width:600px; max-width:90%; padding:25px; border-radius:10px;">
<h2>About TFMS IPTV Panel</h2>
<p>Version: <b>1.0.5</b></p>
<p>TFMS IPTV Panel is a lightweight Cloudflare Worker based IPTV management system featuring:</p>

<ul>
<li>User Line Management</li>
<li>Stream Management</li>
<li>Playlist Generation</li>
<li>Proxy Management</li>
<li>Tools M3U Analyzer, Url Formatter</li>
<li>Tools 1 Click Proxy Creation</li>
<li>Section To Get Free Streams</li>
<li>M3U Mass Imports</li>
<li>SQL Backup & Restore</li>
<li>Light/Dark Mode Support</li>
<li>2 Native Media Players</li>
<li>Use The Software Responsibly</li><br>
<li>EPG is hardcoded into the playlists</li>
<li>For stream images use the Image URL / tvg-logo field</li>
<li>VOD posters are stored in TMDB poster fields, not category names</li>
</ul>

<div style="text-align:right;"><button onclick="closeAboutModal()">Close</button></div>
</div>
</div>
</body>
</html>

<script>

const defaultQuickLinks = [
  { name: '🌐 TV Logos Github', url: 'https://github.com/tv-logo/tv-logos/tree/main/countries' },
  { name: '🌐 Live Web-TV', url: 'https://tfms.xyz/firestick/mark/webtv.html' },
  { name: '🌐 TV-Guides', url: 'https://epgshare01.online/' },
  { name: '🌐 Movie Downloader', url: 'https://videodownloader.site/' },
  { name: '🌐 Sports TV Schedule', url: 'https://www.livesoccertv.com' },
  { name: '🌐 Smarters Online', url: 'http://webtv.iptvsmarters.com/' },
  { name: '🌐 Github Goodies', url: 'https://github.com/smokindope?tab=repositories' }
];
let dashboardQuickLinks = defaultQuickLinks.map(link => ({ ...link }));

function sanitizeQuickLinkUrl(url) {
  let cleanUrl = String(url || '').trim();
  if (!cleanUrl) return '';
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }
  return cleanUrl;
}

function normalizeQuickLinks(links) {
  if (!Array.isArray(links) || !links.length) {
    return defaultQuickLinks.map(link => ({ ...link }));
  }

  return links.map((link, index) => ({
    name: String(link?.name || defaultQuickLinks[index]?.name || 'Quick Link').trim() || 'Quick Link',
    url: sanitizeQuickLinkUrl(link?.url || defaultQuickLinks[index]?.url || '')
  }));
}

function getQuickLinks() {
  return normalizeQuickLinks(dashboardQuickLinks);
}

async function setQuickLinks(links) {
  const cleanLinks = normalizeQuickLinks(links);
  const res = await fetch('/api/dashboard_links/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: cleanLinks })
  });

  const result = await res.json().catch(() => ({}));
  if (!res.ok || result.error) {
    throw new Error(result.error || 'Failed to save dashboard links');
  }

  dashboardQuickLinks = normalizeQuickLinks(result.links || cleanLinks);
}

function loadQuickLinksFromSettings(settings) {
  try {
    const saved = JSON.parse(settings?.dashboard_links || '[]');
    dashboardQuickLinks = normalizeQuickLinks(saved);
  } catch (e) {
    dashboardQuickLinks = defaultQuickLinks.map(link => ({ ...link }));
  }
  renderQuickLinks();
}

function renderQuickLinks() {
  const container = document.getElementById('quickLinksContainer');
  if (!container) return;
  container.innerHTML = '';

  getQuickLinks().forEach(link => {
    const btn = document.createElement('button');
    btn.className = 'quick-btn';
    btn.textContent = link.name || 'Quick Link';
    btn.onclick = () => {
      const finalUrl = sanitizeQuickLinkUrl(link.url);
      if (!finalUrl) return alert('This quick link does not have a URL set.');
      window.open(finalUrl, '_blank');
    };
    container.appendChild(btn);
  });
}

function renderQuickLinkEditor() {
  const editor = document.getElementById('quickLinksEditor');
  if (!editor) return;
  editor.innerHTML = '';

  getQuickLinks().forEach((link, index) => {
    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 1.4fr';
    row.style.gap = '6px';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'quick-link-name';
    nameInput.value = link.name || '';
    nameInput.placeholder = 'Link name';
    nameInput.dataset.index = index;
    nameInput.style.margin = '0';
    nameInput.style.padding = '7px';
    nameInput.style.fontSize = '12px';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'quick-link-url';
    urlInput.value = link.url || '';
    urlInput.placeholder = 'https://example.com';
    urlInput.dataset.index = index;
    urlInput.style.margin = '0';
    urlInput.style.padding = '7px';
    urlInput.style.fontSize = '12px';

    row.appendChild(nameInput);
    row.appendChild(urlInput);
    editor.appendChild(row);
  });
}

function toggleQuickLinkEdit() {
  renderQuickLinkEditor();
  document.getElementById('quickLinksContainer').style.display = 'none';
  document.getElementById('quickLinksEditor').style.display = 'flex';
  document.getElementById('quickLinksEditorActions').style.display = 'flex';
  document.getElementById('quickLinksEditBtn').style.display = 'none';
}

function cancelQuickLinkEdit() {
  document.getElementById('quickLinksContainer').style.display = 'flex';
  document.getElementById('quickLinksEditor').style.display = 'none';
  document.getElementById('quickLinksEditorActions').style.display = 'none';
  document.getElementById('quickLinksEditBtn').style.display = 'inline-block';
}

async function saveQuickLinks() {
  const names = Array.from(document.querySelectorAll('.quick-link-name'));
  const urls = Array.from(document.querySelectorAll('.quick-link-url'));

  const links = names.map((nameInput, index) => ({
    name: String(nameInput.value || '').trim() || 'Quick Link',
    url: sanitizeQuickLinkUrl(urls[index]?.value || '')
  }));

  try {
    await setQuickLinks(links);
    renderQuickLinks();
    cancelQuickLinkEdit();
    alert('Dashboard quick links saved for everyone.');
  } catch (e) {
    alert(e.message || 'Failed to save dashboard links');
  }
}

async function resetQuickLinks() {
  try {
    await setQuickLinks(defaultQuickLinks);
    renderQuickLinks();
    cancelQuickLinkEdit();
    alert('Dashboard quick links reset for everyone.');
  } catch (e) {
    alert(e.message || 'Failed to reset dashboard links');
  }
}

function loadCustomIframe() {
  const url = document.getElementById('customIframeUrl').value.trim();

  if (!url) return alert('Enter a URL');

  let finalUrl = url;

  if (!finalUrl.startsWith('http://') &&
      !finalUrl.startsWith('https://')) {
    finalUrl = 'https://' + finalUrl;
  }

  localStorage.setItem('customIframeUrl', finalUrl);
  document.getElementById('customIframe').src = finalUrl;
}

function loadCustomIframe2() {
  let url = document.getElementById('customIframeUrl2').value.trim();
  if (!url) return alert('Enter a URL');

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  localStorage.setItem('customIframeUrl2', url);
  document.getElementById('customIframe2').src = url;
}

window.addEventListener('load', () => {
  const saved2 = localStorage.getItem('customIframeUrl2');
  if (saved2) {
    document.getElementById('customIframeUrl2').value = saved2;
    document.getElementById('customIframe2').src = saved2;
  }
});

window.addEventListener('load', () => {
  const saved = localStorage.getItem('customIframeUrl');

  if (saved) {
    document.getElementById('customIframeUrl').value = saved;
    document.getElementById('customIframe').src = saved;
  }
});
const builtInProxy = { id: 'default', name: 'Built In Proxy', url: '' };
const noProxyOption = { id: 'none', name: 'Direct Url No Proxy', url: '' };
const STREAMS_PER_PAGE = 250;
let currentStreamPage = 1;
const VOD_PER_PAGE = 250;
let currentVodPage = 1;

function getBaseCategoryName(category) {
  return String(category || '').split('|')[0].trim();
}

function renderCategoryDropdowns(data) {
  const list = document.getElementById('categoryOptions');
  if (!list) return;

  const categories = new Set(['Live', 'Sports', 'Movies', 'VOD', 'News', 'Kids', 'Documentary', 'Entertainment']);

  [...(data.streams || []), ...(data.vod || []), ...(data.all_streams || [])].forEach(item => {
    const baseCategory = getBaseCategoryName(item.category);
    if (baseCategory) categories.add(baseCategory);
  });

  list.innerHTML = '';
  Array.from(categories).sort((a, b) => a.localeCompare(b)).forEach(category => {
    const opt = document.createElement('option');
    opt.value = category;
    list.appendChild(opt);
  });
}

function proxyOptionsHtml(allProxies, selected = '') {
return allProxies.map(p => {
const safeId = String(p.id).replace(/"/g, '&quot;');
const safeName = String(p.name).replace(/</g, '&lt;').replace(/>/g, '&gt;');
return '<option value="' + safeId + '" ' + (String(p.id) === String(selected) ? 'selected' : '') + '>' + safeName + '</option>';
}).join('');
}

async function loadData() {
const res = await fetch('/api/data');
if (res.status === 401) return window.location.reload();
const data = await res.json();
renderCategoryDropdowns(data);
document.getElementById('totalUsers').textContent = data.users.length;
document.getElementById('totalStreams').textContent = (data.streams.length + (data.vod?.length || 0));
document.getElementById('totalProxies').textContent = data.proxies.length;
const proxySelect = document.getElementById('globalProxySelect');
document.getElementById('adminComments').value = data.comment || "";

document.getElementById('adminUser').value =
  data.settings?.admin_user || '';

document.getElementById('adminPass').value =
  data.settings?.admin_pass || '';

if (document.getElementById('tmdbApiKey')) {
  document.getElementById('tmdbApiKey').value = data.settings?.tmdb_api_key || '';
}

loadQuickLinksFromSettings(data.settings);

const lastSelected = proxySelect.value || 'none';
proxySelect.innerHTML = '';

const allProxies = [noProxyOption, builtInProxy, ...data.proxies];
allProxies.forEach(p => {
const opt = document.createElement('option');
opt.value = p.id;
opt.textContent = p.name;
proxySelect.appendChild(opt);
});
proxySelect.value = lastSelected;

const proxyContainer = document.getElementById('proxyContainer');
proxyContainer.innerHTML = '';
data.proxies.forEach(p => {
const div = document.createElement('div');
div.className = 'proxy-item';
div.innerHTML = \`
<span><strong>\${p.name}</strong> - <small style="color:#2563eb">\${p.url}</small></span>
<button class="btn-danger" style="padding: 2px 6px; font-size: 11px;" onclick="deleteProxy(\${p.id})">Remove Proxy</button>
\`;
proxyContainer.appendChild(div);
});

const userTable = document.getElementById('userTable');
userTable.innerHTML = '';
data.users.forEach(u => {
let badgeClass = 'badge badge-ok';
let connLabel = \`\${u.active_connections} / \${u.max_connections || 1}\`;
let isExpired = u.is_expired;
if (u.active_connections >= (u.max_connections || 1)) {
badgeClass = 'badge badge-alert';
}
if (isExpired) {
badgeClass = 'badge badge-expired';
connLabel = 'EXPIRED';
}
const tr = document.createElement('tr');
tr.innerHTML = \`
<td style="\${isExpired ? 'color:#94a3b8; text-decoration:line-through;' : ''}">
<b>\${u.username}</b> <br>
<small style="font-size:10px; color:#64748b;">Expires: \${u.exp_date || 'Never'}</small>
</td>
<td><span class="\${badgeClass}">\${connLabel}</span></td>
<td>\${u.status}</td>
<td class="action-btns">
<div class="flex-actions">
<button onclick='editUser(\${u.id}, \${JSON.stringify(u.username)}, \${JSON.stringify(u.password)}, \${JSON.stringify(u.exp_date)}, \${JSON.stringify(u.status)}, \${u.max_connections || 1})'>Edit</button>
<button class="btn-danger" onclick="deleteUser(\${u.id})">Delete</button>
<button class="btn-success" \${isExpired ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} onclick='downloadPlaylist(\${JSON.stringify(u.username)}, \${JSON.stringify(u.password)}, document.getElementById("proxySelect_\${u.id}").value || null, document.getElementById("includeVod_\${u.id}").checked)'>Playlist</button>
<button \${isExpired ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} onclick='copyPlaylistUrl(\${JSON.stringify(u.username)}, \${JSON.stringify(u.password)}, document.getElementById("proxySelect_\${u.id}").value || null, document.getElementById("includeVod_\${u.id}").checked)'>Copy</button>
<button \${isExpired ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : 'style="background:#0ea5e9;"'} onclick='tinyPlaylistUrl(\${JSON.stringify(u.username)}, \${JSON.stringify(u.password)}, document.getElementById("proxySelect_\${u.id}").value || null, document.getElementById("includeVod_\${u.id}").checked)'>TinyURL</button>
<select id="proxySelect_\${u.id}" title="Proxy for this user" style="width:165px; padding:6px 8px; font-size:12px; border-radius:6px; margin:0;">
<option value="">Use Global Proxy Setting</option>
\${proxyOptionsHtml(allProxies)}
</select>
<label title="Include VOD in this playlist" style="display:flex; align-items:center; gap:5px; font-size:12px; white-space:nowrap; margin:0;">
<input type="checkbox" id="includeVod_\${u.id}" checked style="width:auto; margin:0;"> Include VOD
</label>
</div>
</td>
\`;
userTable.appendChild(tr);
});

const streamTable = document.getElementById('streamTable');
const massDeleteSelect = document.getElementById('massDeleteSelect');
streamTable.innerHTML = '';
massDeleteSelect.innerHTML = '<option value="all">Wipe All Streams Completely</option>';
const uniqueCategories = new Set();
data.streams.forEach((s, index) => {
if (s.category) uniqueCategories.add(s.category);
const tr = document.createElement('tr');
tr.dataset.streamIndex = index;
const headerInfo = [
  s.user_agent ? 'UA: ' + s.user_agent : '',
  s.referer ? 'Referer: ' + s.referer : ''
].filter(Boolean).join(' | ');
tr.innerHTML = \`
<td>\${s.name}\${headerInfo ? '<br><small style="color:#64748b;">' + headerInfo + '</small>' : ''}\${s.image_url ? '<br><small style="color:#2563eb;">Image: ' + s.image_url + '</small>' : ''}</td>
<td>\${s.category}</td>
<td class="action-btns">
<button onclick='editStream(\${s.id}, \${JSON.stringify(s.name)}, \${JSON.stringify(s.url)}, \${JSON.stringify(s.category)}, \${JSON.stringify(s.image_url || "")}, \${JSON.stringify(s.user_agent || "")}, \${JSON.stringify(s.referer || "")})'>Edit</button>
<button class="btn-danger" onclick="deleteStream(\${s.id})">Delete</button>
</td>
\`;
streamTable.appendChild(tr);
});
currentStreamPage = 1;
updateStreamPagination();

const vodTable = document.getElementById('vodTable');
if (vodTable) {
  vodTable.innerHTML = '';
  (data.vod || []).forEach((v, index) => {
    const tr = document.createElement('tr');
    tr.dataset.vodIndex = index;
    const headerInfo = [
      v.user_agent ? 'UA: ' + v.user_agent : '',
      v.referer ? 'Referer: ' + v.referer : ''
    ].filter(Boolean).join(' | ');
    tr.innerHTML = \`
<td>\${v.name}\${v.tmdb_year ? ' (' + v.tmdb_year + ')' : ''}\${v.tmdb_rating ? ' ⭐ ' + v.tmdb_rating : ''}\${v.tmdb_overview ? '<br><small style="color:#64748b;">' + v.tmdb_overview.substring(0, 140) + '</small>' : ''}\${headerInfo ? '<br><small style="color:#64748b;">' + headerInfo + '</small>' : ''}</td>
<td>\${v.category}\${v.tmdb_poster_url ? '<br><small style="color:#2563eb;">TMDB poster: ' + v.tmdb_poster_url + '</small>' : ''}</td>
<td class="action-btns">
<button onclick='editVod(\${v.id}, \${JSON.stringify(v.name)}, \${JSON.stringify(v.url)}, \${JSON.stringify(v.category)}, \${JSON.stringify(v.user_agent || "")}, \${JSON.stringify(v.referer || "")}, \${JSON.stringify(v.tmdb_type || "movie")}, \${JSON.stringify(v.tmdb_poster_url || "")}, \${JSON.stringify(v.tmdb_overview || "")})'>Edit</button>
<button class="btn-danger" onclick="deleteVod(\${v.id})">Delete</button>
</td>
\`;
    vodTable.appendChild(tr);
  });
  currentVodPage = 1;
  updateVodPagination();
}
uniqueCategories.forEach(cat => {
const opt = document.createElement('option');
opt.value = \`category:\${cat}\`;
opt.textContent = \`Clear Category: "\${cat}"\`;
massDeleteSelect.appendChild(opt);
});
}

async function postData(url, data) {
const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
if (res.status === 401) return window.location.reload();
loadData();
}

function saveUser() {
const id = document.getElementById('userId').value;
const data = {
username: document.getElementById('username').value,
password: document.getElementById('password').value,
exp_date: document.getElementById('userExp').value || "Never",
status: document.getElementById('userStatus').value,
max_connections: parseInt(document.getElementById('maxConnections').value) || 1
};
if (id) {
postData('/api/users/edit', { id: parseInt(id), ...data });
} else {
postData('/api/users/add', data);
}
resetUserForm();
}

function editUser(id, user, pass, exp, status, maxConn) {
document.getElementById('userId').value = id;
document.getElementById('username').value = user;
document.getElementById('username').disabled = true;
document.getElementById('password').value = pass;
document.getElementById('userExp').value =
  (!exp || exp === 'Never') ? '' : exp.split('T')[0];
document.getElementById('userStatus').value = status;
document.getElementById('maxConnections').value = maxConn;
document.getElementById('userBtn').textContent = "Update Account Parameters";
document.getElementById('cancelUserBtn').style.display = "inline-block";
}

function deleteUser(id) { if(confirm('Delete user line entirely?')) postData('/api/users/delete', { id }); }

function resetUserForm() {
document.getElementById('userId').value = '';
document.getElementById('username').value = '';
document.getElementById('username').disabled = false;
document.getElementById('password').value = '';
document.getElementById('userExp').value = '';
document.getElementById('maxConnections').value = 1;
document.getElementById('userBtn').textContent = "Create New User";
document.getElementById('cancelUserBtn').style.display = "none";
}

function saveStream() {
const id = document.getElementById('streamId').value;
const data = {
name: document.getElementById('streamName').value,
url: document.getElementById('streamUrlInput').value,
category: document.getElementById('streamCategory').value,
image_url: document.getElementById('streamImage').value,
user_agent: document.getElementById('streamUserAgent').value,
referer: document.getElementById('streamReferer').value
};
if (id) {
postData('/api/streams/edit', { id: parseInt(id), ...data });
} else {
postData('/api/streams/add', data);
}
resetStreamForm();
}

function editStream(id, name, url, category, imageUrl = '', userAgent = '', referer = '') {
document.getElementById('streamId').value = id;
document.getElementById('streamName').value = name;
document.getElementById('streamUrlInput').value = url;
document.getElementById('streamCategory').value = category;
document.getElementById('streamImage').value = imageUrl || '';
document.getElementById('streamUserAgent').value = userAgent || '';
document.getElementById('streamReferer').value = referer || '';
document.getElementById('streamBtn').textContent = "Update Stream Entry";
document.getElementById('cancelStreamBtn').style.display = "inline-block";
}

function deleteStream(id) { if(confirm('Delete target broadcast stream?')) postData('/api/streams/delete', { id }); }

function massImport() {
  const m3u = document.getElementById('massM3u').value;
  const category = document.getElementById('massImportCategory').value;

  postData('/api/streams/mass_import', { m3u, category });

  document.getElementById('massM3u').value = '';
  document.getElementById('massImportCategory').value = '';
}

function executeMassDelete() {
const selection = document.getElementById('massDeleteSelect').value;
let confirmationMsg = "Are you absolutely sure you want to delete all streams completely?";
let payload = { scope: "all" };
if (selection.startsWith("category:")) {
const categoryName = selection.substring(9);
confirmationMsg = \`Are you sure you want to delete all streams inside the category: "\${categoryName}"?\`;
payload = { scope: "category", category: categoryName };
}
if (confirm(confirmationMsg)) {
postData('/api/streams/mass_delete', payload);
}
}

function resetStreamForm() {
document.getElementById('streamId').value = '';
document.getElementById('streamName').value = '';
document.getElementById('streamUrlInput').value = '';
document.getElementById('streamCategory').value = '';
document.getElementById('streamImage').value = '';
document.getElementById('streamUserAgent').value = '';
document.getElementById('streamReferer').value = '';
document.getElementById('streamBtn').textContent = "Add New Stream";
document.getElementById('cancelStreamBtn').style.display = "none";
}

async function lookupVodTmdb() {
  const title = document.getElementById('vodName').value.trim();
  if (!title) return alert('Enter a VOD title first');

  const res = await fetch('/api/tmdb/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, tmdb_type: document.getElementById('vodTmdbType').value })
  });
  const data = await res.json();
  if (!data.success) return alert(data.error || 'No TMDB match found');

  const meta = data.meta;
  document.getElementById('vodName').value = meta.name || title;
  document.getElementById('vodTmdbPoster').value = meta.poster || '';
  document.getElementById('vodTmdbOverview').value = meta.overview || '';

  const categoryInput = document.getElementById('vodCategory');
  const baseCategory = (categoryInput.value || 'VOD').split('|')[0] || 'VOD';
  categoryInput.value = baseCategory;
}

function saveVod() {
const id = document.getElementById('vodId').value;
const data = {
name: document.getElementById('vodName').value,
url: document.getElementById('vodUrlInput').value,
category: getBaseCategoryName(document.getElementById('vodCategory').value) || 'VOD',
user_agent: document.getElementById('vodUserAgent').value,
referer: document.getElementById('vodReferer').value,
tmdb_type: document.getElementById('vodTmdbType').value,
tmdb_poster_url: document.getElementById('vodTmdbPoster').value,
tmdb_overview: document.getElementById('vodTmdbOverview').value,
tmdb_autofill: true
};
if (id) {
postData('/api/vod/edit', { id: parseInt(id), ...data });
} else {
postData('/api/vod/add', data);
}
resetVodForm();
}

function editVod(id, name, url, category, userAgent = '', referer = '', tmdbType = 'movie', tmdbPoster = '', tmdbOverview = '') {
document.getElementById('vodId').value = id;
document.getElementById('vodName').value = name;
document.getElementById('vodUrlInput').value = url;
document.getElementById('vodCategory').value = getBaseCategoryName(category);
document.getElementById('vodUserAgent').value = userAgent || '';
document.getElementById('vodReferer').value = referer || '';
document.getElementById('vodTmdbType').value = tmdbType || 'movie';
document.getElementById('vodTmdbPoster').value = tmdbPoster || '';
document.getElementById('vodTmdbOverview').value = tmdbOverview || '';
document.getElementById('vodBtn').textContent = "Update VOD File";
document.getElementById('cancelVodBtn').style.display = "inline-block";
}

function deleteVod(id) { if(confirm('Delete this VOD file?')) postData('/api/vod/delete', { id }); }

function resetVodForm() {
document.getElementById('vodId').value = '';
document.getElementById('vodName').value = '';
document.getElementById('vodUrlInput').value = '';
document.getElementById('vodCategory').value = '';
document.getElementById('vodUserAgent').value = '';
document.getElementById('vodReferer').value = '';
document.getElementById('vodTmdbType').value = 'movie';
document.getElementById('vodTmdbPoster').value = '';
document.getElementById('vodTmdbOverview').value = '';
document.getElementById('vodBtn').textContent = "Add New VOD File";
document.getElementById('cancelVodBtn').style.display = "none";
}

function vodMassImport() {
  const m3u = document.getElementById('vodMassM3u').value;
  const category = document.getElementById('vodMassImportCategory').value;
  postData('/api/vod/mass_import', { m3u, category });
  document.getElementById('vodMassM3u').value = '';
  document.getElementById('vodMassImportCategory').value = '';
}

function importVodFromUrl() {
  const url = document.getElementById('remoteVodM3uUrl').value;
  const category = document.getElementById('remoteVodCategory').value;
  if (!url) return alert("Please enter a VOD playlist URL");
  postData('/api/vod/import_url', { url, category });
  document.getElementById('remoteVodM3uUrl').value = '';
  document.getElementById('remoteVodCategory').value = '';
}

function getFilteredVodRows() {
  const search = document.getElementById('vodSearch').value.toLowerCase();

  return Array.from(document.querySelectorAll('#vodTable tr')).filter(row =>
    row.textContent.toLowerCase().includes(search)
  );
}

function updateVodPagination() {
  const rows = Array.from(document.querySelectorAll('#vodTable tr'));
  const filteredRows = getFilteredVodRows();
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / VOD_PER_PAGE));

  if (currentVodPage > totalPages) currentVodPage = totalPages;
  if (currentVodPage < 1) currentVodPage = 1;

  rows.forEach(row => {
    row.style.display = 'none';
  });

  const start = (currentVodPage - 1) * VOD_PER_PAGE;
  const end = start + VOD_PER_PAGE;

  filteredRows.slice(start, end).forEach(row => {
    row.style.display = '';
  });

  renderVodPagination(filteredRows.length, totalPages);
}

function renderVodPagination(totalItems, totalPages) {
  const container = document.getElementById('vodPagination');
  if (!container) return;

  if (totalItems <= VOD_PER_PAGE) {
    container.innerHTML = totalItems
      ? '<span style="font-size:12px; color:#64748b;">Showing ' + totalItems + ' link' + (totalItems === 1 ? '' : 's') + '</span>'
      : '';
    return;
  }

  const start = (currentVodPage - 1) * VOD_PER_PAGE + 1;
  const end = Math.min(currentVodPage * VOD_PER_PAGE, totalItems);
  const prevDisabled = currentVodPage === 1 ? 'disabled style="opacity:.45; cursor:not-allowed;"' : '';
  const nextDisabled = currentVodPage === totalPages ? 'disabled style="opacity:.45; cursor:not-allowed;"' : '';

  container.innerHTML =
    '<button onclick="changeVodPage(-1)" ' + prevDisabled + '>Prev</button>' +
    '<span style="font-size:12px; color:#64748b;">Showing ' + start + '-' + end + ' of ' + totalItems + ' links · Page ' + currentVodPage + ' of ' + totalPages + '</span>' +
    '<button onclick="changeVodPage(1)" ' + nextDisabled + '>Next</button>';
}

function changeVodPage(direction) {
  currentVodPage += direction;
  updateVodPagination();
}

function filterVod() {
  currentVodPage = 1;
  updateVodPagination();
}

function clearVodSearch() {
  document.getElementById('vodSearch').value = '';
  filterVod();
}

function addProxy() {
const name = document.getElementById('proxyName').value;
const url = document.getElementById('proxyUrl').value;
if(!name || !url) return alert('Fill out proxy parameters.');
postData('/api/proxies/add', { name, url });
document.getElementById('proxyName').value = '';
document.getElementById('proxyUrl').value = '';
}

function deleteProxy(id) { if(confirm('Delete this proxy server reference?')) postData('/api/proxies/delete', { id }); }

function buildPlaylistUrl(user, pass, proxyId = null, includeVod = true) {
const globalSelect = document.getElementById('globalProxySelect');
const finalProxyId = proxyId || globalSelect?.value || 'none';
const vodFlag = includeVod ? '1' : '0';
return \`\${window.location.origin}/get_playlist?user=\${encodeURIComponent(user)}&pass=\${encodeURIComponent(pass)}&proxy=\${encodeURIComponent(finalProxyId)}&include_vod=\${vodFlag}\`;
}

function downloadPlaylist(user, pass, proxyId = null, includeVod = true) {
window.open(buildPlaylistUrl(user, pass, proxyId, includeVod), '_blank');
}

async function copyPlaylistUrl(user, pass, proxyId = null, includeVod = true) {
const playlistUrl = buildPlaylistUrl(user, pass, proxyId, includeVod);

try {
  await navigator.clipboard.writeText(playlistUrl);
  showCopyPopup('Playlist URL copied to clipboard');
} catch (e) {
  const tempInput = document.createElement('input');
  tempInput.value = playlistUrl;
  document.body.appendChild(tempInput);
  tempInput.select();
  document.execCommand('copy');
  tempInput.remove();

  showCopyPopup('Playlist URL copied to clipboard');
}
}

async function tinyPlaylistUrl(user, pass, proxyId = null, includeVod = true) {
const playlistUrl = buildPlaylistUrl(user, pass, proxyId, includeVod);

try {
  const res = await fetch('/api/tinyurl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: playlistUrl })
  });

  const data = await res.json();

  if (!res.ok || !data.tinyUrl) {
    throw new Error(data.error || 'TinyURL conversion failed');
  }

  try {
    await navigator.clipboard.writeText(data.tinyUrl);
    showCopyPopup('TinyURL copied to clipboard');
  } catch (clipError) {
    const tempInput = document.createElement('input');
    tempInput.value = data.tinyUrl;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    tempInput.remove();

    showCopyPopup('TinyURL copied to clipboard');
  }
} catch (e) {
  alert('TinyURL Error: ' + e.message);
}
}

function showCopyPopup(message) {
  const popup = document.createElement('div');

  popup.textContent = message;

  popup.style.position = 'fixed';
  popup.style.bottom = '20px';
  popup.style.right = '20px';
  popup.style.background = '#16a34a';
  popup.style.color = '#fff';
  popup.style.padding = '12px 18px';
  popup.style.borderRadius = '8px';
  popup.style.fontSize = '14px';
  popup.style.zIndex = '99999';
  popup.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
  popup.style.opacity = '1';
  popup.style.transition = 'opacity 0.4s ease';

  document.body.appendChild(popup);

  setTimeout(() => {
    popup.style.opacity = '0';

    setTimeout(() => {
      popup.remove();
    }, 400);

  }, 2000);
}

function switchTab(tabId, button) {

  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  document.getElementById(tabId).classList.add('active');
  button.classList.add('active');

  localStorage.setItem('activeTab', tabId);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const updatesBtn = document.getElementById('updatesBtn');
const aboutBtn = document.getElementById('aboutBtn');

if (tabId === 'settingsTab') {
  updatesBtn.style.display = 'inline-block';
  aboutBtn.style.display = 'inline-block';
} else {
  updatesBtn.style.display = 'none';
  aboutBtn.style.display = 'none';
}
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.body.classList.add('dark');
    document.getElementById('themeBtn').innerHTML = '☀️';
  } else {
    document.body.classList.remove('dark');
    document.getElementById('themeBtn').innerHTML = '🌙';
  }
}

function toggleTheme() {
  const current = localStorage.getItem('theme') || 'light';
  const next = current === 'light' ? 'dark' : 'light';

  localStorage.setItem('theme', next);
  applyTheme(next);
}

applyTheme(localStorage.getItem('theme') || 'light');

setInterval(loadData, 120000);
loadData();
let map;

function initMap() {
  map = L.map('worldMap').setView([20, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
}

setTimeout(initMap, 500);

function downloadSQLBackup() {
fetch('/api/backup/sql')
  .then(res => res.blob())
  .then(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "tfms_backup.sql";
    a.click();
    URL.revokeObjectURL(url);
  });
}

function uploadSqlImport() {
  const sql = document.getElementById('sqlInput').value;
  if (!sql.trim()) return alert("Empty SQL file");

  postData('/api/backup/sql_import', { sql });

  document.getElementById('sqlInput').value = '';
}

function saveComments() {
  const content = document.getElementById('adminComments').value;
  postData('/api/comments/save', { content });
}

function saveSettings() {

  const admin_user =
    document.getElementById('adminUser').value;

  const admin_pass =
    document.getElementById('adminPass').value;

  if (!admin_user || !admin_pass) {
    return alert('Username and password required');
  }

  postData('/api/settings/save', {
    admin_user,
    admin_pass,
    tmdb_api_key: document.getElementById('tmdbApiKey')?.value || ''
  });

  alert('Admin/TMDB settings updated');
}

function showAboutModal() {
  document.getElementById('aboutModal').style.display = 'flex';
}

function closeAboutModal() {
  document.getElementById('aboutModal').style.display = 'none';
}

function getFilteredStreamRows() {
  const search = document
    .getElementById('streamSearch')
    .value
    .toLowerCase();

  return Array.from(document.querySelectorAll('#streamTable tr')).filter(row =>
    row.textContent.toLowerCase().includes(search)
  );
}

function updateStreamPagination() {
  const rows = Array.from(document.querySelectorAll('#streamTable tr'));
  const filteredRows = getFilteredStreamRows();
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / STREAMS_PER_PAGE));

  if (currentStreamPage > totalPages) currentStreamPage = totalPages;
  if (currentStreamPage < 1) currentStreamPage = 1;

  rows.forEach(row => {
    row.style.display = 'none';
  });

  const start = (currentStreamPage - 1) * STREAMS_PER_PAGE;
  const end = start + STREAMS_PER_PAGE;

  filteredRows.slice(start, end).forEach(row => {
    row.style.display = '';
  });

  renderStreamPagination(filteredRows.length, totalPages);
}

function renderStreamPagination(totalItems, totalPages) {
  const container = document.getElementById('streamPagination');
  if (!container) return;

  if (totalItems <= STREAMS_PER_PAGE) {
    container.innerHTML = totalItems
      ? '<span style="font-size:12px; color:#64748b;">Showing ' + totalItems + ' link' + (totalItems === 1 ? '' : 's') + '</span>'
      : '';
    return;
  }

  const start = (currentStreamPage - 1) * STREAMS_PER_PAGE + 1;
  const end = Math.min(currentStreamPage * STREAMS_PER_PAGE, totalItems);
  const prevDisabled = currentStreamPage === 1 ? 'disabled style="opacity:.45; cursor:not-allowed;"' : '';
  const nextDisabled = currentStreamPage === totalPages ? 'disabled style="opacity:.45; cursor:not-allowed;"' : '';

  container.innerHTML =
    '<button onclick="changeStreamPage(-1)" ' + prevDisabled + '>Prev</button>' +
    '<span style="font-size:12px; color:#64748b;">Showing ' + start + '-' + end + ' of ' + totalItems + ' links · Page ' + currentStreamPage + ' of ' + totalPages + '</span>' +
    '<button onclick="changeStreamPage(1)" ' + nextDisabled + '>Next</button>';
}

function changeStreamPage(direction) {
  currentStreamPage += direction;
  updateStreamPagination();
}

function filterStreams() {
  currentStreamPage = 1;
  updateStreamPagination();
}

function filterUsers() {
  const search = document
    .getElementById('userSearch')
    .value
    .toLowerCase();

  const rows = document.querySelectorAll('#userTable tr');

  rows.forEach(row => {
    const text = row.textContent.toLowerCase();

    if (text.includes(search)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
}

function clearUserSearch() {
  document.getElementById('userSearch').value = '';
  filterUsers();
}

function clearStreamSearch() {
  document.getElementById('streamSearch').value = '';
  filterStreams();
}

function filterProxies() {
  const search = document
    .getElementById('proxySearch')
    .value
    .toLowerCase();

  const rows = document.querySelectorAll('.proxy-item');

  rows.forEach(row => {
    const text = row.textContent.toLowerCase();

    if (text.includes(search)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
}

const splitContainer = document.getElementById('splitContainer');
const dragHandle = document.getElementById('dragHandle');

if (splitContainer && dragHandle) {
  const leftPane = splitContainer.querySelector('.left-pane');
  let isDragging = false;

  dragHandle.addEventListener('mousedown', () => {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    document.body.style.cursor = 'default';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging || !leftPane) return;

    const rect = splitContainer.getBoundingClientRect();
    let percent = ((e.clientX - rect.left) / rect.width) * 100;

    if (percent < 20) percent = 20;
    if (percent > 80) percent = 80;

    leftPane.style.width = percent + '%';
  });
}

function importFromUrl() {
  const url = document.getElementById('remoteM3uUrl').value;
  const category = document.getElementById('remoteCategory').value;

  if (!url) return alert("Please enter a URL");

  postData('/api/streams/import_url', {
    url,
    category
  });

  document.getElementById('remoteM3uUrl').value = '';
  document.getElementById('remoteCategory').value = '';
}

if (typeof jwplayer === 'function' && document.getElementById('player')) {
  jwplayer("player").setup({
    file: "YOUR_STREAM_URL",
    width: "100%",
    height: "100%",
    stretching: "uniform",
    autostart: true,
    primary: "html5",
    fullscreen: true
  });
}

if (typeof Clappr !== 'undefined' && Clappr.Player && document.getElementById('player')) {
  var player = new Clappr.Player({
    source: "YOUR_STREAM_URL",
    parentId: "#player",
    width: "100%",
    height: "100%",
    autoPlay: true,
    plugins: [Clappr.FlasHLS, Clappr.MediaControl].filter(Boolean),
    fullscreenEnabled: true
  });
}

window.addEventListener('load', () => {
  const savedTab = localStorage.getItem('activeTab');
  if (savedTab) {
    const tabBtn = Array.from(document.querySelectorAll('.tab-btn'))
      .find(btn => (btn.getAttribute('onclick') || '').includes("'" + savedTab + "'"));
    if (tabBtn && document.getElementById(savedTab)) {
      switchTab(savedTab, tabBtn);
    }
  }

  restoreBrowserIframe();
});

const BROWSER_IFRAME_STORAGE_KEY = 'browserIframeUrl';

function normalizeBrowserIframeUrl(url) {
  let cleanUrl = String(url || '').trim();
  if (!cleanUrl) return '';
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }
  return cleanUrl;
}

function restoreBrowserIframe() {
  const input = document.getElementById('browserIframeUrl');
  const iframe = document.getElementById('browserIframe');
  if (!input || !iframe) return;

  const savedUrl = normalizeBrowserIframeUrl(localStorage.getItem(BROWSER_IFRAME_STORAGE_KEY));
  if (!savedUrl) return;

  input.value = savedUrl;
  iframe.src = savedUrl;
}

function loadBrowserIframe() {
  const input = document.getElementById('browserIframeUrl');
  const iframe = document.getElementById('browserIframe');
  if (!input || !iframe) return;

  const url = normalizeBrowserIframeUrl(input.value);
  if (!url) return;

  input.value = url;
  iframe.src = url;
  localStorage.setItem(BROWSER_IFRAME_STORAGE_KEY, url);
}

</script>
`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  }
};