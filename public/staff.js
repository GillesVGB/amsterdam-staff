function getStaffLoginErrorMessage(code) {
  const messages = {
    config: "Staff-login is nog niet volledig geconfigureerd.",
    no_access: "Je hebt geen toegang. Je mist de vereiste staffrol.",
    state: "Login sessie verlopen. Probeer opnieuw.",
    discord: "Discord-login mislukt. Probeer opnieuw.",
    access_denied: "Discord-login is geannuleerd.",
  };
  return messages[code] || "";
}

async function fetchStaffJson(url, options) {
  const response = await fetch(url, Object.assign({ cache: "no-store" }, options || {}));
  if (response.status === 401) {
    window.location.href = "/api/staff/auth/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
    throw new Error("Niet ingelogd.");
  }
  return response.json();
}

async function initStaffAuthStatus() {
  const status = document.querySelector("[data-staff-auth-status]");
  if (!status) return;
  if (window.location.protocol === "file:") {
    status.textContent = "Open deze site via http://127.0.0.1:3000/staff/ zodat Discord-login en API werken.";
    status.classList.add("is-error");
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (error) {
    status.textContent = getStaffLoginErrorMessage(error) || "Er ging iets mis met inloggen.";
    status.classList.add("is-error");
    return;
  }

  try {
    const response = await fetch("/api/staff/auth/me", { cache: "no-store" });
    const data = await response.json();
    if (!data.loggedIn) {
      status.textContent = "Niet ingelogd. Log in met Discord om je staffrol te checken.";
      return;
    }
    status.textContent = "Ingelogd als " + data.user.username + ". Je hebt toegang tot het staffportaal.";
    status.classList.add("is-ok");
  } catch {
    status.textContent = "Loginstatus kon niet geladen worden.";
    status.classList.add("is-error");
  }
}

function normalizeRoleName(name) {
  return String(name || "").toLowerCase().replace(/^@?\|\s*/, "").trim();
}

function displayRoleName(name) {
  return String(name || "").replace(/^@?\|\s*/, "").trim();
}

async function enhanceRoleTags() {
  const tags = Array.from(document.querySelectorAll("[data-role-id], [data-role-name]"));
  if (!tags.length || window.location.protocol === "file:") return;

  const ids = Array.from(new Set(tags.map((tag) => tag.dataset.roleId).filter(Boolean)));
  const endpoint = ids.length ? "/api/staff/roles?ids=" + encodeURIComponent(ids.join(",")) : "/api/staff/roles";

  try {
    const data = await fetchStaffJson(endpoint);
    const roles = data.roles || {};
    const rolesByName = {};
    Object.keys(roles).forEach((id) => {
      rolesByName[normalizeRoleName(roles[id].name)] = roles[id];
    });

    tags.forEach((tag) => {
      const role = roles[tag.dataset.roleId] || rolesByName[normalizeRoleName(tag.dataset.roleName)];
      if (!role) return;
      tag.dataset.roleId = role.id;
      tag.title = "Discord role ID: " + role.id;
      tag.style.setProperty("--role-color", role.color || "#36b8d0");
      tag.classList.remove("staff-role-chip-unknown");

      const nameEl = tag.querySelector(".staff-role-name");
      const idEl = tag.querySelector(".staff-role-id-hint");
      const dotEl = tag.querySelector(".staff-role-dot");
      if (nameEl) nameEl.textContent = "| " + displayRoleName(role.name);
      if (idEl) idEl.textContent = role.id;
      if (dotEl) dotEl.style.background = role.color || "#36b8d0";
    });
  } catch {
    // Tags blijven zichtbaar met de statische AMRP-rolnamen.
  }
}

function bindRoleCopy() {
  document.querySelectorAll(".staff-role-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.roleId;
      if (!id || !navigator.clipboard) return;
      navigator.clipboard.writeText(id).then(() => {
        chip.classList.add("copied");
        setTimeout(() => chip.classList.remove("copied"), 1200);
      });
    });
  });
}

function bindFunctieAccordions() {
  document.querySelectorAll(".staff-functie-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = document.getElementById(button.getAttribute("aria-controls"));
      const isOpen = button.classList.toggle("open");
      button.setAttribute("aria-expanded", isOpen ? "true" : "false");
      if (panel) panel.classList.toggle("open", isOpen);
    });
  });
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function textNode(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function makeRoleTag(role, fallbackName) {
  const tag = document.createElement("button");
  tag.type = "button";
  tag.className = "staff-role-chip";
  tag.style.setProperty("--role-color", role?.color || "#36b8d0");
  if (role?.id) tag.dataset.roleId = role.id;
  tag.title = role?.id ? "Discord role ID: " + role.id : fallbackName || "Rol";
  const dot = document.createElement("span");
  dot.className = "staff-role-dot";
  dot.style.background = role?.color || "#36b8d0";
  const text = document.createElement("span");
  text.className = "staff-role-chip-text";
  text.appendChild(textNode("span", "staff-role-name", "| " + displayRoleName(role?.name || fallbackName || "Rol")));
  text.appendChild(textNode("code", "staff-role-id-hint", role?.id || "Discord rol"));
  tag.appendChild(dot);
  tag.appendChild(text);
  return tag;
}

function renderNotice(root, title, message) {
  clearNode(root);
  const panel = document.createElement("div");
  panel.className = "staff-card";
  panel.appendChild(textNode("h3", "", title));
  panel.appendChild(textNode("p", "", message));
  root.appendChild(panel);
}

function setLiveBadge(data) {
  const badge = document.querySelector("[data-live-badge]");
  if (!badge) return;
  if (!data?.updatedAt) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = "Live van Discord - bijgewerkt " + formatDate(data.updatedAt);
}

let staffDossierCache = [];

async function initTeamPage() {
  const root = document.querySelector("[data-team-root]");
  if (!root) return;
  if (window.location.protocol === "file:") {
    renderNotice(root, "Open via lokale server", "Deze pagina kan teamleden alleen laden via de Node-server. Start node server.js en open http://127.0.0.1:3000/staff/team.html.");
    return;
  }

  try {
    const data = await fetchStaffJson("/api/staff/team");
    if (!data.ok) {
      renderNotice(root, "Team kon niet geladen worden", data.message || "Controleer de Discord bot configuratie.");
      return;
    }

    clearNode(root);
    setLiveBadge(data);

    const card = document.createElement("div");
    card.className = "staff-card";
    const title = document.createElement("div");
    title.className = "staff-card-title";
    title.appendChild(textNode("span", "staff-card-icon", "*"));
    title.appendChild(document.createTextNode("Teamoverzicht"));
    card.appendChild(title);

    data.groups.forEach((group) => {
      const block = document.createElement("section");
      block.className = "staff-rank-block";
      const head = document.createElement("div");
      head.className = "staff-rank-head";
      const dot = document.createElement("span");
      dot.className = "staff-rank-dot";
      dot.style.background = group.role?.color || "#36b8d0";
      head.appendChild(dot);
      head.appendChild(textNode("h3", "", group.title));
      head.appendChild(textNode("span", "staff-rank-meta", String(group.members.length) + " leden"));
      block.appendChild(head);

      if (!group.members.length) {
        block.appendChild(textNode("p", "staff-empty", "Nog niemand met deze Discord-rol op de server."));
      } else {
        const list = document.createElement("div");
        list.className = "staff-member-grid";
        group.members.forEach((member) => {
          const memberCard = document.createElement("div");
          memberCard.className = "staff-member";
          const avatar = document.createElement("img");
          avatar.className = "staff-member-avatar";
          avatar.src = member.avatar;
          avatar.alt = "";
          memberCard.appendChild(avatar);
          const copy = document.createElement("div");
          copy.className = "staff-member-text";
          copy.appendChild(document.createTextNode(member.name));
          copy.appendChild(textNode("small", "", member.username ? "@" + member.username : member.id));
          memberCard.appendChild(copy);
          list.appendChild(memberCard);
        });
        block.appendChild(list);
      }

      card.appendChild(block);
    });

    root.appendChild(card);
  } catch (error) {
    renderNotice(root, "Team kon niet geladen worden", error.message || "Probeer opnieuw.");
  }
}

function dossierMeta(text) {
  return textNode("span", "status-badge", text);
}

function appendBadges(root, items, prefix) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return;
  values.forEach((item) => root.appendChild(dossierMeta((prefix || "") + item)));
}

function appendLinkList(root, title, links) {
  const values = Array.isArray(links) ? links.filter(Boolean) : [];
  if (!values.length) return;
  const wrap = document.createElement("div");
  wrap.className = "dossier-link-list";
  wrap.appendChild(textNode("strong", "", title));
  values.forEach((value, index) => {
    const link = document.createElement("a");
    link.href = value;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Bewijs " + (index + 1);
    wrap.appendChild(link);
  });
  root.appendChild(wrap);
}

function appendNoteList(root, notes) {
  const values = Array.isArray(notes) ? notes.filter(Boolean) : [];
  if (!values.length) return;
  const wrap = document.createElement("div");
  wrap.className = "dossier-note-list";
  wrap.appendChild(textNode("strong", "", "Interne notities"));
  values.forEach((value) => wrap.appendChild(textNode("p", "", value)));
  root.appendChild(wrap);
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("nl-BE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function renderDossierCard(dossier) {
  const card = document.createElement("article");
  card.className = "dossier-card";

  const header = document.createElement("header");
  const titleWrap = document.createElement("div");
  titleWrap.appendChild(textNode("h3", "", dossier.playerName));
  const meta = document.createElement("div");
  meta.className = "dossier-meta";
  meta.appendChild(dossierMeta(dossier.category || "Notitie"));
  meta.appendChild(dossierMeta(dossier.severity || "Laag"));
  meta.appendChild(dossierMeta(dossier.status || "Open"));
  if (dossier.subjectType) meta.appendChild(dossierMeta(dossier.subjectType));
  if (dossier.discordId) meta.appendChild(dossierMeta("Discord: " + dossier.discordId));
  if (dossier.assignedTo) meta.appendChild(dossierMeta("Aan: " + dossier.assignedTo));
  appendBadges(meta, dossier.tags, "#");
  titleWrap.appendChild(meta);
  header.appendChild(titleWrap);
  header.appendChild(dossierMeta(formatDate(dossier.createdAt)));
  card.appendChild(header);

  card.appendChild(textNode("p", "", dossier.description || ""));
  appendLinkList(card, "Bewijslinks", dossier.evidenceLinks);
  appendNoteList(card, dossier.notes);
  if (dossier.action) card.appendChild(textNode("p", "", "Actie: " + dossier.action));
  if (dossier.createdBy?.username) card.appendChild(textNode("p", "", "Aangemaakt door: " + dossier.createdBy.username));

  const actions = document.createElement("div");
  actions.className = "dossier-actions";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "mini-button";
  closeButton.textContent = "Markeer gesloten";
  closeButton.addEventListener("click", () => updateDossierStatus(dossier.id, "Gesloten"));
  actions.appendChild(closeButton);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "mini-button danger";
  deleteButton.textContent = "Verwijder";
  deleteButton.addEventListener("click", () => deleteDossier(dossier.id));
  actions.appendChild(deleteButton);
  card.appendChild(actions);

  return card;
}

function getDossierFilters() {
  return {
    search: document.querySelector("[data-dossier-search]")?.value.toLowerCase().trim() || "",
    status: document.querySelector("[data-dossier-status]")?.value || "",
    category: document.querySelector("[data-dossier-category]")?.value || "",
  };
}

function filterDossiers(dossiers) {
  const filters = getDossierFilters();
  return dossiers.filter((dossier) => {
    if (filters.status && dossier.status !== filters.status) return false;
    if (filters.category && dossier.category !== filters.category) return false;
    if (!filters.search) return true;
    const haystack = [
      dossier.playerName,
      dossier.discordId,
      dossier.category,
      dossier.severity,
      dossier.status,
      dossier.subjectType,
      dossier.assignedTo,
      dossier.description,
      dossier.action,
      ...(dossier.tags || []),
      ...(dossier.notes || []),
      ...(dossier.evidenceLinks || []),
    ].join(" ").toLowerCase();
    return haystack.includes(filters.search);
  });
}

function renderDossierList(dossiers) {
  const list = document.querySelector("[data-dossier-list]");
  if (!list) return;
  clearNode(list);
  const filtered = filterDossiers(dossiers);
  if (!filtered.length) {
    renderNotice(list, "Geen dossiers gevonden", "Pas je filters aan of maak een nieuw dossier.");
    return;
  }
  filtered.forEach((dossier) => list.appendChild(renderDossierCard(dossier)));
}

async function loadDossiers() {
  const list = document.querySelector("[data-dossier-list]");
  if (!list) return;
  if (window.location.protocol === "file:") {
    renderNotice(list, "Open via lokale server", "Dossiers werken via de staff API. Start node server.js en open http://127.0.0.1:3000/staff/dossiers.html.");
    return;
  }

  try {
    const data = await fetchStaffJson("/api/staff/dossiers");
    staffDossierCache = data.dossiers || [];
    if (!data.dossiers?.length) {
      clearNode(list);
      renderNotice(list, "Nog geen dossiers", "Maak links het eerste dossier aan.");
      return;
    }
    renderDossierList(staffDossierCache);
  } catch (error) {
    renderNotice(list, "Dossiers konden niet laden", error.message || "Probeer opnieuw.");
  }
}

function initDossierFilters() {
  document.querySelectorAll("[data-dossier-search], [data-dossier-status], [data-dossier-category]").forEach((control) => {
    control.addEventListener("input", () => renderDossierList(staffDossierCache));
    control.addEventListener("change", () => renderDossierList(staffDossierCache));
  });
}

async function updateDossierStatus(id, status) {
  await fetchStaffJson("/api/staff/dossiers/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  await loadDossiers();
}

async function deleteDossier(id) {
  if (!window.confirm("Dossier verwijderen?")) return;
  await fetchStaffJson("/api/staff/dossiers/" + encodeURIComponent(id), { method: "DELETE" });
  await loadDossiers();
}

function initDossierForm() {
  const form = document.querySelector("[data-dossier-form]");
  const feedback = document.querySelector("[data-dossier-feedback]");
  if (!form) return;
  if (window.location.protocol === "file:") {
    if (feedback) feedback.textContent = "Open via http://127.0.0.1:3000/staff/dossiers.html om dossiers op te slaan.";
    Array.from(form.elements).forEach((element) => {
      element.disabled = true;
    });
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (feedback) feedback.textContent = "Opslaan...";
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      const data = await fetchStaffJson("/api/staff/dossiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!data.ok) throw new Error(data.message || "Opslaan mislukt.");
      form.reset();
      if (feedback) feedback.textContent = "Dossier opgeslagen.";
      await loadDossiers();
    } catch (error) {
      if (feedback) feedback.textContent = error.message || "Opslaan mislukt.";
    }
  });
}

const staffAdminCollections = {
  profiles: {
    endpoint: "/api/staff/profiles",
    key: "profiles",
    title: (item) => item.displayName || "Staffprofiel",
    meta: (item) => [item.team, item.functionName, item.activity].concat(item.tags || []).filter(Boolean),
    body: (item) => item.notes || "Geen interne notities.",
    detail: (item) => "profile.html?id=" + encodeURIComponent(item.id),
  },
  tasks: {
    endpoint: "/api/staff/tasks",
    key: "tasks",
    title: (item) => item.title || "Taak",
    meta: (item) => [item.type, item.priority, item.status, item.assignee && "Aan: " + item.assignee, item.dueDate && "Deadline: " + item.dueDate].concat(item.tags || []).filter(Boolean),
    body: (item) => item.description || "Geen beschrijving.",
    closeStatus: "Gesloten",
  },
  tickets: {
    endpoint: "/api/staff/tickets",
    key: "tickets",
    title: (item) => item.title || "Ticket",
    meta: (item) => [item.category, item.priority, item.status, item.assignee && "Aan: " + item.assignee, item.requester && "Van: " + item.requester].filter(Boolean),
    body: (item) => item.description || "Geen beschrijving.",
    closeStatus: "Gesloten",
  },
  applications: {
    endpoint: "/api/staff/applications",
    key: "applications",
    title: (item) => item.applicantName || "Sollicitatie",
    meta: (item) => [item.status, item.reviewer && "Reviewer: " + item.reviewer, item.interviewAt && "Gesprek: " + item.interviewAt].concat(item.training || []).filter(Boolean),
    body: (item) => item.notes || "Geen notities.",
    closeStatus: "Gesloten",
  },
  rules: {
    endpoint: "/api/staff/rules",
    key: "rules",
    title: (item) => item.title || "Regel",
    meta: (item) => [item.section, item.status].concat(item.tags || []).filter(Boolean),
    body: (item) => [item.content, item.sanction && "Sanctie: " + item.sanction].filter(Boolean).join("\n\n") || "Geen inhoud.",
    closeStatus: "Inactief",
  },
  warnings: {
    endpoint: "/api/staff/warnings",
    key: "warnings",
    title: (item) => item.staffName || "Staffwaarschuwing",
    meta: (item) => [item.type, item.severity, item.status, item.issuedBy && "Door: " + item.issuedBy].filter(Boolean),
    body: (item) => [item.reason, (item.notes || []).join("\n"), (item.evidenceLinks || []).length ? "Bewijs: " + item.evidenceLinks.join(", ") : ""].filter(Boolean).join("\n\n") || "Geen inhoud.",
    closeStatus: "Opgelost",
  },
  meetings: {
    endpoint: "/api/staff/meetings",
    key: "meetings",
    title: (item) => item.title || "Meeting",
    meta: (item) => [item.status, item.meetingAt && "Moment: " + item.meetingAt, item.chair && "Voorzitter: " + item.chair].filter(Boolean),
    body: (item) => [item.agenda && "Agenda: " + item.agenda, item.decisions && "Besluiten: " + item.decisions, (item.actionItems || []).length ? "Acties: " + item.actionItems.join(" | ") : "", (item.participants || []).length ? "Aanwezig: " + item.participants.join(", ") : ""].filter(Boolean).join("\n\n") || "Geen notulen.",
    closeStatus: "Afgerond",
  },
};

function filterAdminItems(type, items) {
  if (type !== "tickets") return items;
  const search = document.querySelector("[data-ticket-search]")?.value.toLowerCase().trim() || "";
  const status = document.querySelector("[data-ticket-status]")?.value || "";
  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (!search) return true;
    return [item.title, item.requester, item.discordId, item.category, item.assignee, item.priority, item.status, item.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(search);
  });
}

function renderRecordCard(type, item) {
  const config = staffAdminCollections[type];
  const card = document.createElement("article");
  card.className = "record-card";

  const header = document.createElement("header");
  header.appendChild(textNode("h3", "", config.title(item)));
  header.appendChild(dossierMeta(formatDate(item.updatedAt || item.createdAt)));
  card.appendChild(header);

  const meta = document.createElement("div");
  meta.className = "dossier-meta";
  config.meta(item).forEach((value) => meta.appendChild(dossierMeta(value)));
  card.appendChild(meta);
  card.appendChild(textNode("p", "", config.body(item)));

  const actions = document.createElement("div");
  actions.className = "record-actions";
  if (config.detail) {
    const detail = document.createElement("a");
    detail.className = "mini-button";
    detail.href = config.detail(item);
    detail.textContent = "Open profiel";
    actions.appendChild(detail);
  }
  if (config.closeStatus && item.status !== config.closeStatus) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mini-button";
    close.textContent = "Sluiten";
    close.addEventListener("click", () => updateAdminRecord(type, item.id, { status: config.closeStatus }));
    actions.appendChild(close);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mini-button danger";
  remove.textContent = "Verwijder";
  remove.addEventListener("click", () => deleteAdminRecord(type, item.id));
  actions.appendChild(remove);
  card.appendChild(actions);

  return card;
}

async function loadAdminSummary() {
  const root = document.querySelector("[data-admin-summary]");
  if (!root || window.location.protocol === "file:") return;
  try {
    const data = await fetchStaffJson("/api/staff/admin/summary");
    if (!data.ok) throw new Error(data.message || "Beheerstatus kon niet laden.");
    root.innerHTML = "";
    [
      ["Dossiers", data.counts.dossiers],
      ["Open taken", data.counts.openTasks],
      ["Open tickets", data.counts.openTickets],
      ["Sollicitaties", data.counts.openApplications],
      ["Waarschuwingen", data.counts.openWarnings],
      ["Meetings", data.counts.meetings],
      ["Regels", data.counts.rules],
      ["Meldingen", data.counts.notifications],
    ].forEach(([label, value]) => {
      const block = document.createElement("div");
      block.appendChild(textNode("span", "", label));
      block.appendChild(textNode("strong", "", String(value)));
      root.appendChild(block);
    });
    renderAdminActivity(data.activity || []);
    renderAdminNotifications(data.notifications || []);
    renderAdminLogs(data.latestLogs || []);
  } catch (error) {
    root.innerHTML = '<div><span>Beheer</span><strong>Geen toegang</strong></div>';
  }
}

function initAdminFilters() {
  document.querySelectorAll("[data-ticket-search], [data-ticket-status]").forEach((control) => {
    control.addEventListener("input", () => loadAdminCollection("tickets"));
    control.addEventListener("change", () => loadAdminCollection("tickets"));
  });
}

async function loadAdminCollection(type) {
  const config = staffAdminCollections[type];
  const root = document.querySelector('[data-admin-list="' + type + '"]');
  if (!config || !root) return;
  if (window.location.protocol === "file:") {
    renderNotice(root, "Open via server", "Deze beheerdata werkt via de staff API op Render.");
    return;
  }
  try {
    const data = await fetchStaffJson(config.endpoint);
    const items = filterAdminItems(type, data[config.key] || []);
    clearNode(root);
    if (!items.length) {
      root.appendChild(textNode("p", "staff-empty", "Nog geen items."));
      return;
    }
    items.forEach((item) => root.appendChild(renderRecordCard(type, item)));
  } catch (error) {
    renderNotice(root, "Kon niet laden", error.message || "Probeer opnieuw.");
  }
}

async function updateAdminRecord(type, id, payload) {
  const config = staffAdminCollections[type];
  await fetchStaffJson(config.endpoint + "/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await loadAdminCollection(type);
  await loadAdminSummary();
}

async function deleteAdminRecord(type, id) {
  if (!window.confirm("Item verwijderen?")) return;
  const config = staffAdminCollections[type];
  await fetchStaffJson(config.endpoint + "/" + encodeURIComponent(id), { method: "DELETE" });
  await loadAdminCollection(type);
  await loadAdminSummary();
}

function initAdminForms() {
  document.querySelectorAll("[data-admin-form]").forEach((form) => {
    const type = form.dataset.adminForm;
    const config = staffAdminCollections[type];
    const feedback = document.querySelector('[data-admin-feedback="' + type + '"]');
    if (!config) return;

    if (window.location.protocol === "file:") {
      if (feedback) feedback.textContent = "Open via de server om op te slaan.";
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (feedback) feedback.textContent = "Opslaan...";
      try {
        const payload = Object.fromEntries(new FormData(form).entries());
        const data = await fetchStaffJson(config.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!data.ok) throw new Error(data.message || "Opslaan mislukt.");
        form.reset();
        if (feedback) feedback.textContent = "Opgeslagen.";
        await loadAdminCollection(type);
        await loadAdminSummary();
      } catch (error) {
        if (feedback) feedback.textContent = error.message || "Opslaan mislukt.";
      }
    });
  });
}

function renderAdminLogs(logs) {
  const root = document.querySelector("[data-admin-logs]");
  if (!root) return;
  clearNode(root);
  if (!logs.length) {
    root.appendChild(textNode("p", "staff-empty", "Nog geen logs."));
    return;
  }
  logs.forEach((log) => {
    const card = document.createElement("article");
    card.className = "record-card";
    card.appendChild(textNode("h3", "", log.action || "Log"));
    const meta = document.createElement("div");
    meta.className = "dossier-meta";
    if (log.target) meta.appendChild(dossierMeta(log.target));
    if (log.createdBy?.username) meta.appendChild(dossierMeta(log.createdBy.username));
    meta.appendChild(dossierMeta(formatDate(log.createdAt)));
    card.appendChild(meta);
    if (log.detail) card.appendChild(textNode("p", "", log.detail));
    root.appendChild(card);
  });
}

function renderAdminActivity(items) {
  const root = document.querySelector("[data-admin-activity]");
  if (!root) return;
  clearNode(root);
  if (!items.length) {
    root.appendChild(textNode("p", "staff-empty", "Nog geen activiteit."));
    return;
  }
  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "record-card";
    card.appendChild(textNode("h3", "", item.name));
    const meta = document.createElement("div");
    meta.className = "dossier-meta";
    meta.appendChild(dossierMeta(String(item.actions) + " acties"));
    meta.appendChild(dossierMeta(String(item.dossiers) + " dossiers"));
    meta.appendChild(dossierMeta(String(item.tickets) + " tickets"));
    meta.appendChild(dossierMeta("Laatst: " + formatDate(item.lastActive)));
    card.appendChild(meta);
    root.appendChild(card);
  });
}

function renderAdminNotifications(items) {
  const root = document.querySelector("[data-admin-notifications]");
  if (!root) return;
  clearNode(root);
  if (!items.length) {
    root.appendChild(textNode("p", "staff-empty", "Geen meldingen."));
    return;
  }
  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "record-card";
    card.appendChild(textNode("h3", "", item.title || "Melding"));
    const meta = document.createElement("div");
    meta.className = "dossier-meta";
    meta.appendChild(dossierMeta(item.read ? "Gelezen" : "Nieuw"));
    meta.appendChild(dossierMeta(formatDate(item.createdAt)));
    card.appendChild(meta);
    if (item.message) card.appendChild(textNode("p", "", item.message));
    if (!item.read) {
      const actions = document.createElement("div");
      actions.className = "record-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mini-button";
      button.textContent = "Markeer gelezen";
      button.addEventListener("click", () => markNotificationRead(item.id));
      actions.appendChild(button);
      card.appendChild(actions);
    }
    root.appendChild(card);
  });
}

async function markNotificationRead(id) {
  await fetchStaffJson("/api/staff/notifications/" + encodeURIComponent(id), { method: "PATCH" });
  await loadAdminSummary();
}

async function initAdminPanel() {
  if (!document.querySelector("[data-admin-summary], [data-admin-form]")) return;
  initAdminForms();
  initAdminFilters();
  await Promise.all(Object.keys(staffAdminCollections).map(loadAdminCollection));
  await loadAdminSummary();
}

async function initProfilePage() {
  const root = document.querySelector("[data-profile-detail]");
  if (!root) return;
  if (window.location.protocol === "file:") {
    renderNotice(root, "Open via server", "Profielen laden via de staff API op Render.");
    return;
  }
  const id = new URLSearchParams(window.location.search).get("id");
  try {
    const [profilesData, dossiersData, tasksData, ticketsData, warningsData] = await Promise.all([
      fetchStaffJson("/api/staff/profiles"),
      fetchStaffJson("/api/staff/dossiers"),
      fetchStaffJson("/api/staff/tasks"),
      fetchStaffJson("/api/staff/tickets"),
      fetchStaffJson("/api/staff/warnings"),
    ]);
    const profile = (profilesData.profiles || []).find((item) => item.id === id);
    if (!profile) {
      renderNotice(root, "Profiel niet gevonden", "Open een profiel vanuit de beheerpagina.");
      return;
    }

    clearNode(root);
    const card = document.createElement("article");
    card.className = "staff-card profile-hero";
    card.appendChild(textNode("p", "eyebrow", profile.team || "Staff"));
    card.appendChild(textNode("h1", "", profile.displayName));
    const meta = document.createElement("div");
    meta.className = "dossier-meta";
    [profile.functionName, profile.activity, profile.discordId && "Discord: " + profile.discordId].concat(profile.tags || []).filter(Boolean).forEach((value) => meta.appendChild(dossierMeta(value)));
    card.appendChild(meta);
    if (profile.notes) card.appendChild(textNode("p", "", profile.notes));
    root.appendChild(card);

    const related = document.createElement("div");
    related.className = "profile-grid";
    const needles = [profile.displayName, profile.discordId].filter(Boolean).map((value) => value.toLowerCase());
    const matchRecord = (item) => needles.some((needle) => JSON.stringify(item).toLowerCase().includes(needle));
    [
      ["Dossiers", (dossiersData.dossiers || []).filter(matchRecord).map(renderDossierCard)],
      ["Taken", (tasksData.tasks || []).filter(matchRecord).map((item) => renderRecordCard("tasks", item))],
      ["Tickets", (ticketsData.tickets || []).filter(matchRecord).map((item) => renderRecordCard("tickets", item))],
      ["Waarschuwingen", (warningsData.warnings || []).filter(matchRecord).map((item) => renderRecordCard("warnings", item))],
    ].forEach(([title, cards]) => {
      const section = document.createElement("section");
      section.className = "staff-card";
      section.appendChild(textNode("h2", "", title));
      if (!cards.length) section.appendChild(textNode("p", "staff-empty", "Geen gekoppelde items."));
      cards.forEach((cardNode) => section.appendChild(cardNode));
      related.appendChild(section);
    });
    root.appendChild(related);
  } catch (error) {
    renderNotice(root, "Profiel kon niet laden", error.message || "Probeer opnieuw.");
  }
}

async function loadManagedRules() {
  const root = document.querySelector("[data-managed-rules]");
  if (!root || window.location.protocol === "file:") return;
  try {
    const data = await fetchStaffJson("/api/staff/rules");
    const rules = data.rules || [];
    clearNode(root);
    if (!rules.length) {
      root.appendChild(textNode("p", "staff-empty", "Nog geen extra beheerregels toegevoegd."));
      return;
    }
    rules.forEach((rule) => root.appendChild(renderRecordCard("rules", rule)));
  } catch {
    root.appendChild(textNode("p", "staff-empty", "Extra beheerregels zijn alleen zichtbaar met rechten."));
  }
}

initStaffAuthStatus();
bindRoleCopy();
bindFunctieAccordions();
enhanceRoleTags();
initTeamPage();
initDossierForm();
initDossierFilters();
loadDossiers();
initAdminPanel();
initProfilePage();
loadManagedRules();
