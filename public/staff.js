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
      tag.style.setProperty("--role-color", role.color || "#5865f2");
      tag.classList.remove("staff-role-chip-unknown");

      const nameEl = tag.querySelector(".staff-role-name");
      const idEl = tag.querySelector(".staff-role-id-hint");
      const dotEl = tag.querySelector(".staff-role-dot");
      if (nameEl) nameEl.textContent = "| " + displayRoleName(role.name);
      if (idEl) idEl.textContent = role.id;
      if (dotEl) dotEl.style.background = role.color || "#5865f2";
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
  tag.style.setProperty("--role-color", role?.color || "#5865f2");
  if (role?.id) tag.dataset.roleId = role.id;
  tag.title = role?.id ? "Discord role ID: " + role.id : fallbackName || "Rol";
  const dot = document.createElement("span");
  dot.className = "staff-role-dot";
  dot.style.background = role?.color || "#5865f2";
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
    title.appendChild(textNode("span", "staff-card-icon", "♟"));
    title.appendChild(document.createTextNode("Teamoverzicht"));
    card.appendChild(title);

    data.groups.forEach((group) => {
      const block = document.createElement("section");
      block.className = "staff-rank-block";
      const head = document.createElement("div");
      head.className = "staff-rank-head";
      const dot = document.createElement("span");
      dot.className = "staff-rank-dot";
      dot.style.background = group.role?.color || "#8b5cf6";
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
  if (dossier.discordId) meta.appendChild(dossierMeta("Discord: " + dossier.discordId));
  titleWrap.appendChild(meta);
  header.appendChild(titleWrap);
  header.appendChild(dossierMeta(formatDate(dossier.createdAt)));
  card.appendChild(header);

  card.appendChild(textNode("p", "", dossier.description || ""));
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

async function loadDossiers() {
  const list = document.querySelector("[data-dossier-list]");
  if (!list) return;
  if (window.location.protocol === "file:") {
    renderNotice(list, "Open via lokale server", "Dossiers werken via de staff API. Start node server.js en open http://127.0.0.1:3000/staff/dossiers.html.");
    return;
  }

  try {
    const data = await fetchStaffJson("/api/staff/dossiers");
    clearNode(list);
    if (!data.dossiers?.length) {
      renderNotice(list, "Nog geen dossiers", "Maak links het eerste dossier aan.");
      return;
    }
    data.dossiers.forEach((dossier) => list.appendChild(renderDossierCard(dossier)));
  } catch (error) {
    renderNotice(list, "Dossiers konden niet laden", error.message || "Probeer opnieuw.");
  }
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

initStaffAuthStatus();
bindRoleCopy();
bindFunctieAccordions();
enhanceRoleTags();
initTeamPage();
initDossierForm();
loadDossiers();
