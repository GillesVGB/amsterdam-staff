# Amsterdam Roleplay Staff Portaal

Losstaande versie van het staff portaal.

## Lokaal starten

1. Kopieer `.env.example` naar `.env.local`.
2. Vul Discord OAuth, staff role ID en bot token in.
3. Start met:

```bash
npm start
```

Open daarna `http://127.0.0.1:3000/staff/`.

Discord redirect URI voor lokaal testen:

```text
http://127.0.0.1:3000/api/staff/auth/callback
```

Teamleden worden live uit Discord geladen via `STAFF_DISCORD_BOT_TOKEN`.

## Beheerrechten

`STAFF_ADMIN_ROLE_IDS` mag alles. Voor aparte rechten kun je deze variabelen vullen met Discord rol-ID's:

```text
STAFF_PERMISSION_DOSSIERS_ROLE_IDS=
STAFF_PERMISSION_TICKETS_ROLE_IDS=
STAFF_PERMISSION_APPLICATIONS_ROLE_IDS=
STAFF_PERMISSION_PROFILES_ROLE_IDS=
STAFF_PERMISSION_RULES_ROLE_IDS=
STAFF_PERMISSION_LOGS_ROLE_IDS=
```

Laat je ze leeg, dan vallen ze terug op de adminrol.

## Supabase opslag

1. Open Supabase SQL Editor.
2. Voer `supabase-schema.sql` uit.
3. Zet op Render bij Environment:

```text
SUPABASE_URL=https://jouw-project.supabase.co
SUPABASE_SECRET_KEY=je_server_side_secret_key
SUPABASE_RECORDS_TABLE=portal_records
```

Zet de Supabase secret key nooit in `public/`, nooit in GitHub en nooit in browser-JavaScript.

Zonder Supabase gebruikt de server tijdelijk JSON-bestanden voor lokaal testen.
