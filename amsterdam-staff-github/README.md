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
