# Bitrix24 MCP Server

Interni MCP (Model Context Protocol) server koji povezuje Claude Code / Claude s Bitrix24, tako da svaki zaposlenik pristupa Bitrixu pod **svojim vlastitim** identitetom (OAuth po korisniku), ne kroz dijeljeni admin pristup.

Vezano uz Bitrix task **#12765** — "Set up company-wide Bitrix24 MCP Server for Claude Code".

## Arhitektura

- **Node.js + Express** — HTTP server
- **@modelcontextprotocol/sdk** — MCP protokol (Streamable HTTP transport) na `/mcp`
- **oidc-provider** — server je istovremeno i pravi OAuth 2.1 authorization server (dinamička registracija klijenata + PKCE), što mu omogućuje da se doda kao **Claude Custom Connector** na razini cijele organizacije
- **node:sqlite** (ugrađeno u Node, bez kompajlera) — baza za zaposlenike i OAuth sesije
- **Bitrix24 self-hosted** (`crm.sm-it.hr`) — izvor podataka, Local Application registrirana za OAuth

## Dva načina autentikacije

1. **Claude Custom Connector (preporučeno)** — dodano na razini organizacije u Claude Settings → Connectors. Svaki zaposlenik klikne "Connect", prijavi se svojim Bitrix računom, gotovo. Nema ručnih koraka.
2. **Legacy API ključ** — `npm run add-employee -- "Ime Prezime"` generira statični API ključ + osobni OAuth link. Koristi se kao fallback ili za projektne (`.mcp.json`) konekcije izvan Claude Custom Connectora.

## Deployment

- **Hetzner Cloud VPS** (`smit-prod-01`, 128.140.44.96), upravljano preko **Coolify** (Docker + Traefik reverse proxy)
- Domena: `https://mcp.sm-it.hr` (DNS preko A1 cPanel)
- GitHub repo: [SMITLuka/mcp-server-bitrix24](https://github.com/SMITLuka/mcp-server-bitrix24) — auto-deploy na push u `main`
- `Dockerfile` — `node:22-alpine`, standardni `npm ci` + `node src/server.js`

## Bitrix24 konfiguracija

- **Local Application** u Bitrixu: `client_id = local.6aa7ba3ebdbb78.10266223`, redirect URI `https://mcp.sm-it.hr/oauth/callback`, scope: `task`, `crm`
- **Važno:** token exchange ide na **centralizirani** `https://oauth.bitrix.info/oauth/token/`, ne na `crm.sm-it.hr/oauth/token/` — self-hosted portal obrađuje samo `/oauth/authorize/` (login korak), token izdaje Bitrixov centralni server čak i za self-hosted instalacije. Ovo je bio glavni izvor grešaka pri postavljanju.

## Dostupni MCP alati

| Alat | Opis |
|---|---|
| `bitrix_list_my_tasks` | Zadaci trenutnog korisnika, najnoviji prvi, sve stranice (filtrirano po `RESPONSIBLE_ID`, default status `pending`) |
| `bitrix_create_task` | Kreiranje novog zadatka (default odgovorna osoba: trenutni korisnik) |
| `bitrix_attach_file_to_task` | Upload datoteke na Bitrix Disk + kačenje na task (`tasks.task.files.attach`) |
| `bitrix_get_task` | Puni detalji jednog taska: opis, komentari, prilozi (imena + download linkovi) |
| `bitrix_read_attachment` | Preuzimanje i čitanje sadržaja priložene datoteke (tekst/slika/base64) |
| `bitrix_find_leads` | Pretraga CRM leadova |
| `bitrix_get_lead` | Dohvat CRM leada po ID-u |
| `bitrix_create_workgroup` | Kreiranje Bitrix24 workgroup/projekta (`sonet_group.create`) |
| `bitrix_list_my_workgroups` | Workgroups/projekti trenutnog korisnika (skraćen izlaz, sve stranice) |
| `bitrix_find_employee` | Pretraga zaposlenika po imenu/emailu: Bitrix ID, pozicija, odjeli (`user.search`) |
| `bitrix_add_task_comment` | Dodavanje komentara na task pod imenom trenutnog korisnika (`task.commentitem.add`) |
| `bitrix_send_chat_message` | Privatna Bitrix chat poruka kolegi pod imenom trenutnog korisnika (`im.message.add`); Claude mora prije slanja potvrditi primatelja i tekst |

## Onboarding novog zaposlenika

**Custom Connector:** Claude → Settings → Connectors → "Bitrix24 MCP (interni)" → Connect → prijava Bitrix računom.

**Legacy (ako treba):**
```bash
docker exec -it <container_id> node scripts/add-employee.js "Ime Prezime"
```

## Poznati problemi i rješenja (za buduću referencu)

- **Middleware redoslijed:** `provider.callback()` (oidc-provider, Koa aplikacija) mora biti **zadnji** u Express stacku — inače presreće i 404-ira sve rute registrirane nakon njega.
- **`resource` parametar (RFC 8707):** MCP klijenti šalju `resource` u OAuth zahtjevu — treba `features.resourceIndicators` konfiguraciju u `oidc-provider`, inače `invalid_target` greška.
- **Cookie path mismatch:** `oidc-provider`-ov `_interaction` kolačić je vezan uz `/interaction/<uid>` putanju, pa ne stiže do `/oauth/callback` (fiksni Bitrix redirect URI) — rješenje: ručno duplicirati kolačić s `path: /oauth/callback`.
- **Consent prompt:** nakon login koraka, `oidc-provider` traži i "consent" — ako se ne obradi, nastaje redirect petlja (korisnik se vraća na Bitrix login iznova i iznova). Rješenje: auto-odobravanje consenta (interni alat, jedan connector).
- **`tasks.task.list`** bez eksplicitnog `RESPONSIBLE_ID` filtera vraća sve zadatke vidljive prema razini prava korisnika (širi opseg za admine), ne striktno njihove.
- **`UF_TASK_WEBDAV_FILES`** (upis) ne radi za datoteke uploadane preko Disk API-ja (ni Disk ID ni `FILE_ID`) — koristiti `tasks.task.files.attach` s Disk objekt ID-om.
- **`UF_TASK_WEBDAV_FILES`** (čitanje) sadrži `disk.attachedObject` ID (isti broj koji `tasks.task.files.attach` vrati kao `attachmentId`), ne pravi Disk file ID — treba prvo `disk.attachedObject.get` (polje `OBJECT_ID`) pa tek onda `disk.file.get`.
- **Bitrix REST paginacija** (`tasks.task.list`, `crm.lead.list`, `sonet_group.get`...) staje na 50 rezultata bez eksplicitnog praćenja `next` kursora — vidi `callBitrixAllPages()` u `bitrixClient.js`.
- **Prazan `error` string** — Bitrix ponekad vrati `{"error":"","error_description":"..."}` (npr. `sonet_group.create` kod grešaka s pravima); `""` je falsy u JS-u, pa provjera mora gledati postoji li ključ, ne je li vrijednost istinita.
- **Content-type detekcija za tekst/binarne datoteke** mora biti usidrena regexom (`^text\/` itd.) — neusidren `xml`/`json` pogađa i binarne OOXML formate (`application/vnd.openxmlformats-officedocument...`) jer sadrže "xml" kao podstring imena vendora, ne pravi XML.
- **`tasks.task.files.attach`** povremeno vraća prolazni "Access denied" odmah nakon `disk.folder.uploadfile` (ACL/indeks za novi Disk objekt još nije propagiran) — riješeno retry-jem s kratkim backoffom.
- **Dijeljena Claude licenca unutar odjela** (jedna prijava za više ljudi) kvari cijeli attribution model — OAuth token/identitet se veže uz Claude prijavu, ne uz fizičku osobu, pa akcije svih dijele identitet prve osobe koja se prijavila. Nema tehničkog rješenja unutar MCP servera; treba zasebna Claude sjedala po osobi.
- **"Access denied" na `tasks.task.files.attach` nije uvijek prolazna greška** — može biti i trajno, namjerno ograničenje prava na razini konkretne grupe/projekta (`GROUP_ID`) kojem task pripada. Potvrđeno uživo: korisnik je bio **responsible** na tasku, a Bitrix je ipak vratio `edit: false` u `action` objektu (dopuštao je `complete`/`pause`/`delegate`, ali ne `edit`/`attach`) — grupa je vjerojatno podešena da samo kreator/moderator smije uređivati taskove. `bitrix_get_task` sad vraća `groupId`, `createdBy` i `allowedActions` (Bitrixov `action` objekt) baš za ovu dijagnozu — kad se opet pojavi "Access denied" na attach/edit, prvo provjeriti `allowedActions.edit` za taj task prije nego se pretpostavi bug u kodu.
- **Novi alati nisu odmah vidljivi** — Claude drži listu alata po konekciji; nakon dodavanja alata treba redeploy pa disconnect/Connect konektora (ili nova sesija). Promjena samo unutarnje logike postojećeg alata ne traži reconnect.
- **Alati koji pišu** (`bitrix_add_task_comment`, `bitrix_send_chat_message`, `bitrix_attach_file_to_task`) djeluju pod identitetom prijavljenog korisnika i podliježu njegovim Bitrix pravima (npr. `edit: false` na tasku u ograničenoj grupi blokira prilaganje). Chat poruke su stvarne poruke stvarnim ljudima — preporuka je u Claudeu birati "Allow once", ne "Always allow", za `bitrix_send_chat_message`.
- **Paralelni razvoj:** drugi developer dodaje "Integration Hub" (OIDC klijent s JWT tokenima i workgroup claimovima) u `oidcProvider.js`/`config.js`; prije pusha uvijek `git pull --rebase`.

## Mogući budući dodaci

Task/CRM: update/complete/delete task, create/update lead, deals, contacts, companies. Kalendar: eventi. Disk: pretraga datoteka. Messenger: grupni chatovi i čitanje poruka.
