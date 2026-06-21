const crypto = require("node:crypto");

const DISCORD_API = "https://discord.com/api/v10";
const SESSION_COOKIE = "ar_staff_session";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const states = new Map();
const sessions = new Map();

function splitIds(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host || "127.0.0.1:3000"}`;
}

function getPublicUrl(req) {
  return (process.env.STAFF_PUBLIC_URL || process.env.OVERHEID_PUBLIC_URL || getOrigin(req)).replace(/\/+$/, "");
}

function getConfig(req) {
  return {
    clientId: process.env.STAFF_DISCORD_CLIENT_ID || "",
    clientSecret: process.env.STAFF_DISCORD_CLIENT_SECRET || "",
    guildId: process.env.STAFF_DISCORD_GUILD_ID || "",
    redirectUri: `${getPublicUrl(req)}/api/staff/auth/callback`,
    allowedRoleIds: splitIds(process.env.STAFF_ALLOWED_ROLE_IDS),
    adminRoleIds: splitIds(process.env.STAFF_ADMIN_ROLE_IDS),
  };
}

function hasRequiredConfig(config) {
  return Boolean(config.clientId && config.clientSecret && config.guildId);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function redirect(res, location, statusCode = 302, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader("Location", location);
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end();
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function randomId() {
  return crypto.randomBytes(24).toString("base64url");
}

function cleanup() {
  const now = Date.now();
  for (const [key, value] of states) {
    if (value.expiresAt <= now) states.delete(key);
  }
  for (const [key, value] of sessions) {
    if (value.expiresAt <= now) sessions.delete(key);
  }
}

function getSession(req) {
  cleanup();
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return { id: sessionId, ...session };
}

function avatarUrlFromUser(user) {
  if (!user?.id) return null;
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function hasAccess(roleIds, config) {
  const roles = new Set(roleIds || []);
  if (config.adminRoleIds.some((roleId) => roles.has(roleId))) return true;
  return config.allowedRoleIds.some((roleId) => roles.has(roleId));
}

function isAdminSession(session) {
  if (!session) return false;
  const adminRoleIds = splitIds(process.env.STAFF_ADMIN_ROLE_IDS);
  if (!adminRoleIds.length) return true;
  const roles = new Set(session.roles || []);
  return adminRoleIds.some((roleId) => roles.has(roleId));
}

function hasPermission(session, permission) {
  if (isAdminSession(session)) return true;
  const key = `STAFF_PERMISSION_${String(permission || "").toUpperCase()}_ROLE_IDS`;
  const permissionRoleIds = splitIds(process.env[key]);
  if (!permissionRoleIds.length) return false;
  const roles = new Set(session?.roles || []);
  return permissionRoleIds.some((roleId) => roles.has(roleId));
}

function getPermissions(session) {
  const permissions = ["dossiers", "tickets", "applications", "profiles", "rules", "settings", "logs"];
  return Object.fromEntries(permissions.map((permission) => [permission, hasPermission(session, permission)]));
}

function sanitizeNext(next) {
  if (typeof next === "string" && next.startsWith("/staff/") && !next.startsWith("//")) {
    return next;
  }
  return "/staff/dashboard.html";
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || response.statusText };
  }
}

async function exchangeCode(code, config) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Discord token exchange mislukt");
  }

  return payload;
}

async function fetchDiscordJson(pathname, accessToken) {
  const response = await fetch(`${DISCORD_API}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Discord API aanvraag mislukt");
  }
  return payload;
}

function createSession(res, req, user, member) {
  const sessionId = randomId();
  const secure = getPublicUrl(req).startsWith("https://");
  const session = {
    user: {
      id: user.id,
      username: member.nick || user.global_name || user.username,
      tag: user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username,
      avatar: avatarUrlFromUser(user),
    },
    roles: member.roles || [],
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  sessions.set(sessionId, session);
  res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, sessionId, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure,
  }));
  return session;
}

async function handleLogin(req, res, url) {
  const config = getConfig(req);
  if (!hasRequiredConfig(config) || !config.allowedRoleIds.length) {
    redirect(res, "/staff/?error=config");
    return;
  }

  const session = getSession(req);
  const next = sanitizeNext(url.searchParams.get("next"));
  if (session) {
    redirect(res, next);
    return;
  }

  const state = randomId();
  states.set(state, {
    next,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "identify guilds.members.read",
    state,
  });

  redirect(res, `https://discord.com/oauth2/authorize?${params}`);
}

async function handleCallback(req, res, url) {
  const config = getConfig(req);
  const error = url.searchParams.get("error");
  if (error) {
    redirect(res, `/staff/?error=${encodeURIComponent(error)}`);
    return;
  }

  const code = url.searchParams.get("code");
  const stateId = url.searchParams.get("state");
  const state = stateId ? states.get(stateId) : null;
  if (!code || !state || state.expiresAt <= Date.now()) {
    redirect(res, "/staff/?error=state");
    return;
  }
  states.delete(stateId);

  try {
    const token = await exchangeCode(code, config);
    const [user, member] = await Promise.all([
      fetchDiscordJson("/users/@me", token.access_token),
      fetchDiscordJson(`/users/@me/guilds/${config.guildId}/member`, token.access_token),
    ]);

    if (!hasAccess(member.roles || [], config)) {
      redirect(res, "/staff/?error=no_access");
      return;
    }

    createSession(res, req, user, member);
    redirect(res, state.next);
  } catch (error) {
    redirect(res, `/staff/?error=discord&message=${encodeURIComponent(error.message)}`);
  }
}

function handleMe(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 200, { loggedIn: false });
    return;
  }

  sendJson(res, 200, {
    loggedIn: true,
    user: session.user,
    isAdmin: isAdminSession(session),
    permissions: getPermissions(session),
  });
}

function handleLogout(req, res) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure: getPublicUrl(req).startsWith("https://") }));
  redirect(res, "/staff/?logout=1");
}

async function handle(req, res, url) {
  if (url.pathname === "/api/staff/auth/login") {
    await handleLogin(req, res, url);
    return true;
  }

  if (url.pathname === "/api/staff/auth/callback") {
    await handleCallback(req, res, url);
    return true;
  }

  if (url.pathname === "/api/staff/auth/me") {
    handleMe(req, res);
    return true;
  }

  if (url.pathname === "/api/staff/auth/logout") {
    handleLogout(req, res);
    return true;
  }

  return false;
}

function isPublicStaffPath(pathname) {
  return (
    pathname === "/staff/" ||
    pathname === "/staff/index.html" ||
    pathname === "/staff/style.css" ||
    pathname === "/staff/staff.js" ||
    pathname.startsWith("/staff/assets/")
  );
}

function requireStaffAccess(req, res, url) {
  if (isPublicStaffPath(url.pathname)) return true;

  const session = getSession(req);
  if (!session) {
    const next = encodeURIComponent(url.pathname + url.search);
    redirect(res, `/api/staff/auth/login?next=${next}`);
    return false;
  }

  return true;
}

module.exports = {
  getSession,
  getPermissions,
  handle,
  hasPermission,
  isAdminSession,
  requireStaffAccess,
};
