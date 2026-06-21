const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const staffAuth = require("./staff-auth.js");
const store = require("./portal-store.js");

const DISCORD_API = "https://discord.com/api/v10";
const DATA_DIR = process.env.STAFF_DATA_DIR
  ? path.resolve(process.env.STAFF_DATA_DIR)
  : path.resolve(__dirname, "..", "data");
const DOSSIER_FILE = path.join(DATA_DIR, "staff-dossiers.json");
const PROFILE_FILE = path.join(DATA_DIR, "staff-profiles.json");
const TASK_FILE = path.join(DATA_DIR, "staff-tasks.json");
const TICKET_FILE = path.join(DATA_DIR, "staff-tickets.json");
const APPLICATION_FILE = path.join(DATA_DIR, "staff-applications.json");
const RULE_FILE = path.join(DATA_DIR, "staff-rules.json");
const NOTIFICATION_FILE = path.join(DATA_DIR, "staff-notifications.json");
const LOG_FILE = path.join(DATA_DIR, "staff-logs.json");
const SETTINGS_FILE = path.join(DATA_DIR, "staff-settings.json");
const BODY_LIMIT = 1024 * 1024;
const CACHE_TTL_MS = 2 * 60 * 1000;
const APP_NAME = "staff";

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
  if (store.isConfigured()) return store.readCollection(APP_NAME, "dossiers");
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
  if (store.isConfigured()) {
    await store.writeCollection(APP_NAME, "dossiers", dossiers);
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DOSSIER_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(dossiers, null, 2)}\n`, "utf8");
  await fs.rename(tmp, DOSSIER_FILE);
}

async function ensureJsonFile(file, fallback) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  }
}

async function readJsonFile(file, fallback) {
  if (store.isConfigured()) return store.readCollection(APP_NAME, collectionTypeForFile(file));
  await ensureJsonFile(file, fallback);
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(fallback) ? (Array.isArray(parsed) ? parsed : fallback) : (parsed && typeof parsed === "object" ? parsed : fallback);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  if (store.isConfigured()) {
    await store.writeCollection(APP_NAME, collectionTypeForFile(file), value);
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function collectionTypeForFile(file) {
  if (file === PROFILE_FILE) return "profiles";
  if (file === TASK_FILE) return "tasks";
  if (file === TICKET_FILE) return "tickets";
  if (file === APPLICATION_FILE) return "applications";
  if (file === RULE_FILE) return "rules";
  if (file === NOTIFICATION_FILE) return "notifications";
  if (file === LOG_FILE) return "logs";
  if (file === SETTINGS_FILE) return "settings";
  return path.basename(file, ".json");
}

function cleanField(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function splitList(value, maxItems = 16, maxLength = 180) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanField(item, maxLength)).filter(Boolean).slice(0, maxItems);
  }
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => cleanField(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function objectDiff(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (["updatedAt", "updatedBy"].includes(key)) continue;
    const oldValue = before?.[key];
    const newValue = after?.[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[key] = { old: oldValue ?? null, new: newValue ?? null };
    }
  }
  return changes;
}

async function addLog(session, action, target, detail = "", changes = null) {
  const logs = await readJsonFile(LOG_FILE, []);
  logs.push({
    id: crypto.randomUUID(),
    action: cleanField(action, 120),
    target: cleanField(target, 160),
    detail: typeof detail === "string" ? cleanField(detail, 700) : cleanField(JSON.stringify(detail || ""), 700),
    changes: changes && Object.keys(changes).length ? changes : null,
    createdAt: new Date().toISOString(),
    createdBy: session?.user || null,
  });
  await writeJsonFile(LOG_FILE, logs.slice(-300));
}

async function addNotification(session, title, message, type = "info", target = "") {
  const notifications = await readJsonFile(NOTIFICATION_FILE, []);
  notifications.push({
    id: crypto.randomUUID(),
    title: cleanField(title, 160),
    message: cleanField(message, 700),
    type: cleanField(type, 60) || "info",
    target: cleanField(target, 160),
    read: false,
    createdAt: new Date().toISOString(),
    createdBy: session?.user || null,
  });
  await writeJsonFile(NOTIFICATION_FILE, notifications.slice(-100));
}

function sortNewest(items) {
  return items.sort((a, b) => String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || "")));
}

function requireAdmin(req, res) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (!staffAuth.isAdminSession(session)) {
    sendJson(res, 403, { ok: false, message: "Geen beheerrechten. Zet STAFF_ADMIN_ROLE_IDS juist in Render." });
    return null;
  }
  return session;
}

function requirePermission(req, res, permission) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (!staffAuth.hasPermission(session, permission)) {
    sendJson(res, 403, { ok: false, message: `Geen rechten voor ${permission}.` });
    return null;
  }
  return session;
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
    subjectType: cleanField(body.subjectType, 40) || "Speler",
    assignedTo: cleanField(body.assignedTo, 120),
    tags: splitList(body.tags, 12, 80),
    evidenceLinks: splitList(body.evidenceLinks || body.evidence, 10, 260),
    notes: splitList(body.notes, 20, 500),
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
      if (!staffAuth.hasPermission(session, "dossiers")) {
        sendJson(res, 403, { ok: false, message: "Geen rechten om dossiers toe te voegen." });
        return true;
      }
      const body = await readBody(req);
      const dossiers = await readDossiers();
      const dossier = normalizeDossier(body, session);
      dossiers.push(dossier);
      await writeDossiers(dossiers);
      await addLog(session, "Dossier toegevoegd", dossier.playerName, dossier.category);
      sendJson(res, 201, { ok: true, dossier });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
    }
    return true;
  }

  const match = url.pathname.match(/^\/api\/staff\/dossiers\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    try {
      if (!staffAuth.hasPermission(session, "dossiers")) {
        sendJson(res, 403, { ok: false, message: "Geen rechten om dossiers te wijzigen." });
        return true;
      }
      const body = await readBody(req);
      const dossiers = await readDossiers();
      const dossier = dossiers.find((item) => item.id === match[1]);
      if (!dossier) {
        sendJson(res, 404, { ok: false, message: "Dossier niet gevonden." });
        return true;
      }
      for (const key of ["status", "severity", "action", "description", "category", "subjectType", "assignedTo"]) {
        if (body[key] !== undefined) dossier[key] = cleanField(body[key], key === "description" ? 2200 : 1000);
      }
      for (const key of ["tags", "evidenceLinks", "notes"]) {
        if (body[key] !== undefined) dossier[key] = splitList(body[key], key === "notes" ? 20 : 12, key === "evidenceLinks" ? 260 : 500);
      }
      dossier.updatedAt = new Date().toISOString();
      await writeDossiers(dossiers);
      await addLog(session, "Dossier bijgewerkt", dossier.playerName, dossier.status);
      sendJson(res, 200, { ok: true, dossier });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
    }
    return true;
  }

  if (match && req.method === "DELETE") {
    if (!staffAuth.hasPermission(session, "dossiers")) {
      sendJson(res, 403, { ok: false, message: "Geen rechten om dossiers te verwijderen." });
      return true;
    }
    const dossiers = await readDossiers();
    const next = dossiers.filter((item) => item.id !== match[1]);
    if (next.length === dossiers.length) {
      sendJson(res, 404, { ok: false, message: "Dossier niet gevonden." });
      return true;
    }
    await writeDossiers(next);
    await addLog(session, "Dossier verwijderd", match[1]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

function normalizeProfile(body, session, existing = {}) {
  const displayName = cleanField(body.displayName || body.name, 120);
  if (!displayName) throw new Error("Naam is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    displayName,
    discordId: cleanField(body.discordId, 40),
    team: cleanField(body.team, 80) || "Staff Team",
    functionName: cleanField(body.functionName || body.role, 120),
    activity: cleanField(body.activity, 80) || "Actief",
    tags: splitList(body.tags, 10, 80),
    notes: cleanField(body.notes, 1800),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeTask(body, session, existing = {}) {
  const title = cleanField(body.title, 160);
  if (!title) throw new Error("Titel is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    type: cleanField(body.type, 80) || "Support",
    assignee: cleanField(body.assignee, 120),
    priority: cleanField(body.priority, 40) || "Normaal",
    status: cleanField(body.status, 40) || "Open",
    dueDate: cleanField(body.dueDate, 40),
    description: cleanField(body.description, 1800),
    tags: splitList(body.tags, 10, 80),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeTicket(body, session, existing = {}) {
  const title = cleanField(body.title, 160);
  if (!title) throw new Error("Titel is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    title,
    requester: cleanField(body.requester, 120),
    discordId: cleanField(body.discordId, 40),
    category: cleanField(body.category, 80) || "Support",
    assignee: cleanField(body.assignee, 120),
    priority: cleanField(body.priority, 40) || "Normaal",
    status: cleanField(body.status, 40) || "Open",
    evidenceLinks: splitList(body.evidenceLinks || body.evidence, 10, 260),
    description: cleanField(body.description, 1800),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeApplication(body, session, existing = {}) {
  const applicantName = cleanField(body.applicantName || body.name, 120);
  if (!applicantName) throw new Error("Naam kandidaat is verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    applicantName,
    discordId: cleanField(body.discordId, 40),
    status: cleanField(body.status, 60) || "Nieuw",
    reviewer: cleanField(body.reviewer, 120),
    interviewAt: cleanField(body.interviewAt, 80),
    training: splitList(body.training, 12, 120),
    notes: cleanField(body.notes, 1800),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

function normalizeRule(body, session, existing = {}) {
  const title = cleanField(body.title, 160);
  const content = cleanField(body.content, 2400);
  if (!title || !content) throw new Error("Titel en inhoud zijn verplicht.");
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    section: cleanField(body.section, 120) || "Algemeen",
    title,
    content,
    sanction: cleanField(body.sanction, 800),
    status: cleanField(body.status, 40) || "Actief",
    tags: splitList(body.tags, 10, 80),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || session.user,
    updatedBy: session.user,
  };
}

async function handleCollection(req, res, url, options) {
  const session = options.permission ? requirePermission(req, res, options.permission) : requireAdmin(req, res);
  if (!session) return true;

  if (url.pathname === options.path && req.method === "GET") {
    sendJson(res, 200, { ok: true, [options.key]: sortNewest(await readJsonFile(options.file, [])) });
    return true;
  }

  if (url.pathname === options.path && req.method === "POST") {
    try {
      const body = await readBody(req);
      const items = await readJsonFile(options.file, []);
      const item = options.normalize(body, session);
      items.push(item);
      await writeJsonFile(options.file, items);
      await addLog(session, `${options.label} toegevoegd`, options.title(item), item.status || item.type || "");
      if (options.notify) await addNotification(session, `${options.label} toegevoegd`, options.title(item), options.notify, item.id);
      sendJson(res, 201, { ok: true, item });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
    }
    return true;
  }

  const match = url.pathname.match(new RegExp(`^${options.path.replace(/\//g, "\\/")}\\/([^/]+)$`));
  if (!match) return false;

  if (req.method === "PATCH") {
    try {
      const body = await readBody(req);
      const items = await readJsonFile(options.file, []);
      const index = items.findIndex((item) => item.id === match[1]);
      if (index === -1) {
        sendJson(res, 404, { ok: false, message: `${options.label} niet gevonden.` });
        return true;
      }
      const before = items[index];
      items[index] = options.normalize({ ...items[index], ...body }, session, items[index]);
      await writeJsonFile(options.file, items);
      await addLog(session, `${options.label} bijgewerkt`, options.title(items[index]), items[index].status || "", objectDiff(before, items[index]));
      sendJson(res, 200, { ok: true, item: items[index] });
    } catch (error) {
      sendJson(res, 400, { ok: false, message: error.message });
    }
    return true;
  }

  if (req.method === "DELETE") {
    const items = await readJsonFile(options.file, []);
    const target = items.find((item) => item.id === match[1]);
    const next = items.filter((item) => item.id !== match[1]);
    if (next.length === items.length) {
      sendJson(res, 404, { ok: false, message: `${options.label} niet gevonden.` });
      return true;
    }
    await writeJsonFile(options.file, next);
    await addLog(session, `${options.label} verwijderd`, target ? options.title(target) : match[1]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleAdminSummary(req, res) {
  const session = requirePermission(req, res, "logs");
  if (!session) return true;

  const [dossiers, profiles, tasks, tickets, applications, rules, notifications, logs] = await Promise.all([
    readDossiers(),
    readJsonFile(PROFILE_FILE, []),
    readJsonFile(TASK_FILE, []),
    readJsonFile(TICKET_FILE, []),
    readJsonFile(APPLICATION_FILE, []),
    readJsonFile(RULE_FILE, []),
    readJsonFile(NOTIFICATION_FILE, []),
    readJsonFile(LOG_FILE, []),
  ]);

  sendJson(res, 200, {
    ok: true,
    storage: process.env.STAFF_DATA_DIR ? "server-data-dir" : "repo-data-map",
    counts: {
      dossiers: dossiers.length,
      profiles: profiles.length,
      tasks: tasks.length,
      openTasks: tasks.filter((task) => task.status !== "Gesloten").length,
      tickets: tickets.length,
      openTickets: tickets.filter((ticket) => ticket.status !== "Gesloten").length,
      applications: applications.length,
      openApplications: applications.filter((item) => !["Afgekeurd", "Aangenomen", "Gesloten"].includes(item.status)).length,
      rules: rules.length,
      notifications: notifications.filter((item) => !item.read).length,
    },
    permissions: staffAuth.getPermissions(session),
    activity: buildActivity({ dossiers, tasks, tickets, applications, logs }),
    notifications: sortNewest(notifications).slice(0, 10),
    latestLogs: sortNewest(logs).slice(0, 12),
  });
  return true;
}

function buildActivity({ dossiers, tasks, tickets, applications, logs }) {
  const byUser = {};
  for (const item of [...dossiers, ...tasks, ...tickets, ...applications, ...logs]) {
    const name = item.createdBy?.username || item.updatedBy?.username;
    if (!name) continue;
    byUser[name] ||= { name, actions: 0, dossiers: 0, tickets: 0, tasks: 0, applications: 0, lastActive: item.updatedAt || item.createdAt };
    byUser[name].actions += 1;
    if (dossiers.includes(item)) byUser[name].dossiers += 1;
    if (tickets.includes(item)) byUser[name].tickets += 1;
    if (tasks.includes(item)) byUser[name].tasks += 1;
    if (applications.includes(item)) byUser[name].applications += 1;
    if (String(item.updatedAt || item.createdAt || "") > String(byUser[name].lastActive || "")) byUser[name].lastActive = item.updatedAt || item.createdAt;
  }
  return Object.values(byUser).sort((a, b) => String(b.lastActive).localeCompare(String(a.lastActive))).slice(0, 12);
}

async function handleLogs(req, res) {
  const session = requirePermission(req, res, "logs");
  if (!session) return true;
  sendJson(res, 200, { ok: true, logs: sortNewest(await readJsonFile(LOG_FILE, [])).slice(0, 120) });
  return true;
}

async function handleNotifications(req, res, url) {
  const session = requireSession(req, res);
  if (!session) return true;
  if (url.pathname === "/api/staff/notifications" && req.method === "GET") {
    sendJson(res, 200, { ok: true, notifications: sortNewest(await readJsonFile(NOTIFICATION_FILE, [])).slice(0, 50) });
    return true;
  }
  const match = url.pathname.match(/^\/api\/staff\/notifications\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const notifications = await readJsonFile(NOTIFICATION_FILE, []);
    const item = notifications.find((notification) => notification.id === match[1]);
    if (!item) {
      sendJson(res, 404, { ok: false, message: "Melding niet gevonden." });
      return true;
    }
    item.read = true;
    item.updatedAt = new Date().toISOString();
    await writeJsonFile(NOTIFICATION_FILE, notifications);
    sendJson(res, 200, { ok: true, item });
    return true;
  }
  return false;
}

async function handle(req, res, url) {
  if (url.pathname === "/api/staff/admin/summary" && req.method === "GET") return handleAdminSummary(req, res);
  if (url.pathname === "/api/staff/logs" && req.method === "GET") return handleLogs(req, res);
  if (url.pathname.startsWith("/api/staff/notifications")) return handleNotifications(req, res, url);
  if (url.pathname.startsWith("/api/staff/profiles")) return handleCollection(req, res, url, {
    path: "/api/staff/profiles",
    file: PROFILE_FILE,
    key: "profiles",
    label: "Profiel",
    title: (item) => item.displayName,
    normalize: normalizeProfile,
    permission: "profiles",
  });
  if (url.pathname.startsWith("/api/staff/tasks")) return handleCollection(req, res, url, {
    path: "/api/staff/tasks",
    file: TASK_FILE,
    key: "tasks",
    label: "Taak",
    title: (item) => item.title,
    normalize: normalizeTask,
    permission: "tickets",
    notify: "task",
  });
  if (url.pathname.startsWith("/api/staff/tickets")) return handleCollection(req, res, url, {
    path: "/api/staff/tickets",
    file: TICKET_FILE,
    key: "tickets",
    label: "Ticket",
    title: (item) => item.title,
    normalize: normalizeTicket,
    permission: "tickets",
    notify: "ticket",
  });
  if (url.pathname.startsWith("/api/staff/applications")) return handleCollection(req, res, url, {
    path: "/api/staff/applications",
    file: APPLICATION_FILE,
    key: "applications",
    label: "Sollicitatie",
    title: (item) => item.applicantName,
    normalize: normalizeApplication,
    permission: "applications",
    notify: "application",
  });
  if (url.pathname.startsWith("/api/staff/rules")) return handleCollection(req, res, url, {
    path: "/api/staff/rules",
    file: RULE_FILE,
    key: "rules",
    label: "Regel",
    title: (item) => item.title,
    normalize: normalizeRule,
    permission: "rules",
  });
  if (url.pathname === "/api/staff/team" && req.method === "GET") return handleTeam(req, res);
  if (url.pathname === "/api/staff/roles" && req.method === "GET") return handleRoles(req, res, url);
  if (url.pathname.startsWith("/api/staff/dossiers")) return handleDossiers(req, res, url);

  sendJson(res, 404, { ok: false, message: "Staff API route niet gevonden." });
  return true;
}

module.exports = {
  handle,
};
