const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const staffAuth = require("./staff-auth.js");

const DISCORD_API = "https://discord.com/api/v10";
const DATA_DIR = path.resolve(__dirname, "..", "data");
const DOSSIER_FILE = path.join(DATA_DIR, "staff-dossiers.json");
const BODY_LIMIT = 1024 * 1024;
const CACHE_TTL_MS = 2 * 60 * 1000;

let rolesCache = { expiresAt: 0, value: null };
let membersCache = { expiresAt: 0, value: null };

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function splitIds(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanToken(token) {
  return String(token || "").replace(/^Bot\s+/i, "").trim();
}

function getConfig() {
  return {
    botToken: cleanToken(process.env.STAFF_DISCORD_BOT_TOKEN),
    guildId: process.env.STAFF_DISCORD_GUILD_ID || "",
    teamGroups: [
      { key: "staff", title: "Staff Team", roleId: process.env.STAFF_TEAM_ROLE_STAFF || "1518271385921917178" },
      { key: "hogerop", title: "Hogerop Team", roleId: process.env.STAFF_TEAM_ROLE_HOGEROP || "1502448648930459792" },
      { key: "bestuur", title: "Bestuur Team", roleId: process.env.STAFF_TEAM_ROLE_BESTUUR || "1502448643041661088" },
      { key: "beheer", title: "Beheer Team", roleId: process.env.STAFF_TEAM_ROLE_BEHEER || "1502448635709751457" },
      { key: "eigenaar", title: "Eigenaar", roleId: process.env.STAFF_TEAM_ROLE_EIGENAAR || "1502448623252930601" },
    ],
  };
}

function requireSession(req, res) {
  const session = staffAuth.getSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, message: "Niet ingelogd." });
    return null;
  }
  return session;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text || response.statusText };
  }
}

async function discordGet(pathname, config) {
  const response = await fetch(`${DISCORD_API}${pathname}`, {
    headers: { Authorization: `Bot ${config.botToken}` },
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Discord API fout ${response.status}`);
  }
  return payload;
}

function roleColor(role) {
  if (!role || !role.color) return "#5865f2";
  return `#${Number(role.color).toString(16).padStart(6, "0")}`;
}

async function getGuildRoles(config) {
  if (rolesCache.value && rolesCache.expiresAt > Date.now()) return rolesCache.value;

  const roles = await discordGet(`/guilds/${config.guildId}/roles`, config);
  const mapped = {};
  for (const role of Array.isArray(roles) ? roles : []) {
    mapped[role.id] = {
      id: role.id,
      name: role.name,
      color: roleColor(role),
      position: role.position || 0,
    };
  }

  rolesCache = { value: mapped, expiresAt: Date.now() + CACHE_TTL_MS };
  return mapped;
}

async function getGuildMembers(config) {
  if (membersCache.value && membersCache.expiresAt > Date.now()) return membersCache.value;

  const members = [];
  let after = "0";
  for (let page = 0; page < 20; page += 1) {
    const batch = await discordGet(`/guilds/${config.guildId}/members?limit=1000&after=${after}`, config);
    if (!Array.isArray(batch) || !batch.length) break;
    members.push(...batch);
    after = batch[batch.length - 1]?.user?.id;
    if (batch.length < 1000 || !after) break;
  }

  membersCache = { value: members, expiresAt: Date.now() + CACHE_TTL_MS };
  return members;
}

function avatarUrl(member) {
  const user = member.user || {};
  if (member.avatar && user.id) {
    return `https://cdn.discordapp.com/guilds/${process.env.STAFF_DISCORD_GUILD_ID}/users/${user.id}/avatars/${member.avatar}.png?size=128`;
  }
  if (user.avatar && user.id) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }
  if (!user.id) return "https://cdn.discordapp.com/embed/avatars/0.png";
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function memberName(member) {
  const user = member.user || {};
  return member.nick || user.global_name || user.username || "Onbekende gebruiker";
}

function publicMember(member) {
  const user = member.user || {};
  return {
    id: user.id,
    name: memberName(member),
    username: user.username || "",
    avatar: avatarUrl(member),
    roles: member.roles || [],
    joinedAt: member.joined_at || null,
  };
}

function emptyTeamGroups(config, roles = {}) {
  return config.teamGroups.map((group) => ({
    ...group,
    role: roles[group.roleId] || { id: group.roleId, name: group.title, color: "#5865f2" },
    members: [],
  }));
}

async function handleRoles(req, res, url) {
  const session = requireSession(req, res);
  if (!session) return true;

  const config = getConfig();
  const ids = new Set(splitIds(url.searchParams.get("ids")));
  if (!config.botToken || !config.guildId) {
    sendJson(res, 200, { ok: false, roles: {}, message: "Discord bot token ontbreekt." });
    return true;
  }

  try {
    const roles = await getGuildRoles(config);
    const filtered = {};
    for (const [id, role] of Object.entries(roles)) {
      if (!ids.size || ids.has(id)) filtered[id] = role;
    }
    sendJson(res, 200, { ok: true, roles: filtered });
  } catch (error) {
    sendJson(res, 200, { ok: false, roles: {}, message: error.message });
  }
  return true;
}

async function handleTeam(req, res) {
  const session = requireSession(req, res);
  if (!session) return true;

  const config = getConfig();
  if (!config.botToken || !config.guildId) {
    sendJson(res, 200, {
      ok: false,
      needsBotToken: true,
      message: "Vul STAFF_DISCORD_BOT_TOKEN in om teamleden uit Discord te laden.",
      groups: emptyTeamGroups(config),
    });
    return true;
  }

  try {
    const [roles, members] = await Promise.all([
      getGuildRoles(config),
      getGuildMembers(config),
    ]);
    const groups = config.teamGroups.map((group) => {
      const groupMembers = members
        .filter((member) => (member.roles || []).includes(group.roleId))
        .map(publicMember)
        .sort((a, b) => a.name.localeCompare(b.name, "nl"));

      return {
        ...group,
        role: roles[group.roleId] || { id: group.roleId, name: group.title, color: "#5865f2" },
        members: groupMembers,
      };
    });

    sendJson(res, 200, { ok: true, groups, updatedAt: new Date().toISOString(), cachedUntil: membersCache.expiresAt });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      needsBotToken: false,
      message: `${error.message}. Controleer of de bot in de server zit en Server Members Intent aan staat.`,
      groups: emptyTeamGroups(config),
    });
  }
  return true;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        reject(new Error("Body is te groot."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Ongeldige JSON."));
      }
    });
    req.on("error", reject);
  });
}

async function ensureDossierFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DOSSIER_FILE);
  } catch {
    await fs.writeFile(DOSSIER_FILE, "[]\n", "utf8");
  }
}

async function readDossiers() {
  await ensureDossierFile();
  const content = await fs.readFile(DOSSIER_FILE, "utf8");
  try {
    const dossiers = JSON.parse(content);
    return Array.isArray(dossiers) ? dossiers : [];
  } catch {
    return [];
  }
}

async function writeDossiers(dossiers) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DOSSIER_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(dossiers, null, 2)}\n`, "utf8");
  await fs.rename(tmp, DOSSIER_FILE);
}

function cleanField(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizeDossier(body, session) {
  const playerName = cleanField(body.playerName, 120);
  const description = cleanField(body.description, 2200);
  if (!playerName || !description) {
    throw new Error("Naam en beschrijving zijn verplicht.");
  }

  return {
    id: crypto.randomUUID(),
    playerName,
    discordId: cleanField(body.discordId, 40),
    category: cleanField(body.category, 80) || "Notitie",
    severity: cleanField(body.severity, 40) || "Laag",
    status: cleanField(body.status, 40) || "Open",
    action: cleanField(body.action, 1000),
    description,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: session.user,
  };
}

async function handleDossiers(req, res, url) {
  const session = requireSession(req, res);
  if (!session) return true;

  if (url.pathname === "/api/staff/dossiers" && req.method === "GET") {
    const dossiers = await readDossiers();
    dossiers.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    sendJson(res, 200, { ok: true, dossiers });
    return true;
  }

  if (url.pathname === "/api/staff/dossiers" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const dossiers = await readDossiers();
      const dossier = normalizeDossier(body, session);
      dossiers.push(dossier);
      await writeDossiers(dossiers);
      sendJson(res, 201, { ok: true, dossier });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
    }
    return true;
  }

  const match = url.pathname.match(/^\/api\/staff\/dossiers\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    try {
      const body = await readBody(req);
      const dossiers = await readDossiers();
      const dossier = dossiers.find((item) => item.id === match[1]);
      if (!dossier) {
        sendJson(res, 404, { ok: false, message: "Dossier niet gevonden." });
        return true;
      }
      for (const key of ["status", "severity", "action", "description", "category"]) {
        if (body[key] !== undefined) dossier[key] = cleanField(body[key], key === "description" ? 2200 : 1000);
      }
      dossier.updatedAt = new Date().toISOString();
      await writeDossiers(dossiers);
      sendJson(res, 200, { ok: true, dossier });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
    }
    return true;
  }

  if (match && req.method === "DELETE") {
    const dossiers = await readDossiers();
    const next = dossiers.filter((item) => item.id !== match[1]);
    if (next.length === dossiers.length) {
      sendJson(res, 404, { ok: false, message: "Dossier niet gevonden." });
      return true;
    }
    await writeDossiers(next);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function handle(req, res, url) {
  if (url.pathname === "/api/staff/team" && req.method === "GET") return handleTeam(req, res);
  if (url.pathname === "/api/staff/roles" && req.method === "GET") return handleRoles(req, res, url);
  if (url.pathname.startsWith("/api/staff/dossiers")) return handleDossiers(req, res, url);

  sendJson(res, 404, { ok: false, message: "Staff API route niet gevonden." });
  return true;
}

module.exports = {
  handle,
};
