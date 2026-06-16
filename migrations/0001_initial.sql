CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  admin_user TEXT DEFAULT 'admin',
  admin_pass TEXT DEFAULT 'SecretPassword123',
  tmdb_api_key TEXT DEFAULT '',
  dashboard_links TEXT DEFAULT ''
);

INSERT OR IGNORE INTO settings (id, admin_user, admin_pass, tmdb_api_key, dashboard_links)
VALUES (1, 'admin', 'SecretPassword123', '', '');

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  exp_date TEXT DEFAULT 'Never',
  max_connections INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS streams (
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
);

CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  content TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);

INSERT OR IGNORE INTO comments (id, content, updated_at) VALUES (1, '', '');
