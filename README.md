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
| `bitrix_search_tasks` | Pretraga taskova svih korisnika (koje trenutni korisnik smije vidjeti) po riječima u naslovu, odgovornoj osobi, kreatoru, grupi i statusu |
| `bitrix_create_task` | Kreiranje novog zadatka (default odgovorna osoba: trenutni korisnik) |
| `bitrix_update_task` | Izmjena taska: naslov, opis, rok, odgovorna osoba, dodavanje promatrača; traži `edit` pravo na tasku |
| `bitrix_attach_file_to_task` | Upload datoteke na Bitrix Disk + kačenje na task (`tasks.task.files.attach`) |
| `bitrix_get_task` | Puni detalji jednog taska: opis, komentari, prilozi (imena + download linkovi) i task chat (`chatMessages`; noviji taskovi raspravu drže u chatu, ne u komentarima) |
| `bitrix_read_attachment` | Preuzimanje i čitanje sadržaja Disk datoteke: tekst, Excel/Word/PDF kao izvučeni tekst, slika kao slika, ostalo base64 |
| `bitrix_add_task_comment` | Dodavanje komentara na task pod imenom trenutnog korisnika (`task.commentitem.add`) |
| `bitrix_search_tickets` | Pretraga tiketa (CRM dealova) po ključnim riječima u naslovu, tekstu e-maila (Source information), komentaru i rješenju (Rješenje); vidi [Pretraga tiketa](#pretraga-tiketa-bitrix_search_tickets) |
| `bitrix_get_deal` | Svi popunjeni podaci jednog deala/tiketa: šifra polja (npr. `UF_CRM_...`), naziv kakav se vidi u Bitrixu, tip i vrijednost (vrijednosti iz lista prevedene u tekst) |
| `bitrix_find_leads` | Pretraga CRM leadova |
| `bitrix_get_lead` | Dohvat CRM leada po ID-u |
| `bitrix_create_workgroup` | Kreiranje Bitrix24 workgroup/projekta (`sonet_group.create`) |
| `bitrix_list_my_workgroups` | Grupe/projekti kojih je trenutni korisnik stvarno član, s ulogom (A vlasnik, E moderator, K član) |
| `bitrix_list_visible_workgroups` | Sve grupe/projekti koje trenutni korisnik smije vidjeti (često 100+, ne nužno član) |
| `bitrix_find_employee` | Pretraga zaposlenika po imenu/emailu: Bitrix ID, pozicija, odjeli (`user.search`) |
| `bitrix_find_chat` | Pretraga grupnih chatova (i chatova projekata) po imenu, vraća chat ID |
| `bitrix_read_chat_messages` | Zadnje poruke chata u kojem je korisnik, najnovije prve, s autorima i prilozima |
| `bitrix_send_chat_message` | Chat poruka pod imenom trenutnog korisnika, privatno kolegi (`userId`) ili u grupni chat (`chatId`) (`im.message.add`); Claude mora prije slanja potvrditi primatelja i tekst |
| `bitrix_like_chat_message` | Lajk na chat poruku pod imenom trenutnog korisnika (nikad ga ne uklanja); vidljivo svima u chatu |

## Pretraga tiketa (`bitrix_search_tickets`)

Bitrix task **#13485**. Omogućuje pretragu tiketa po sadržaju, ne samo po naslovu, npr. "nađi tikete gdje se kupac žali na krivi rabat i pokaži kako su riješeni".

**Gdje su tiketi.** Tiketi nisu taskovi nego **CRM dealovi** u pipelineu `CATEGORY_ID = 0` (tip `SALE`), nastali iz e-maila (`ORIGINATOR_ID = email-tracker`). Utvrđeno na dealovima 100287 i 100526 alatom `bitrix_get_deal`. Polja:

| Polje | Šifra | Napomena |
|---|---|---|
| Naslov | `TITLE` | predmet e-maila |
| Source information | `SOURCE_DESCRIPTION` | tekst e-maila kupca |
| Komentar | `COMMENTS` | često kopija naslova; sadrži HTML entitete (`&quot;`) |
| Rješenje | `UF_CRM_1601893231` | odgovor podrške, string |
| Klasifikacija | `UF_CRM_5F55F24F6F61E` | npr. "Podrška/Podpora" (trenutno se ne filtrira) |
| Faza | `STAGE_ID` | `WON` = uspješno zatvoren, `NEW` = novi |

Tekstovi su na hrvatskom i slovenskom. Odgovor kupca na zatvoreni tiket otvara **novi** deal s naslovom "RE: ... Upit - <ID originala> - ..." (npr. 100526 → 100287).

**Kako radi** (`src/ticketSearch.js`):

1. Upit se rastavi na riječi (najviše 6, svaka barem 2 znaka).
2. Za svaku riječ i svako od 4 polja šalje se jedan `crm.deal.list` s filterom `%POLJE` (SQL `LIKE '%riječ%'`) i `CATEGORY_ID = 0`, sve u **jednom** `batch` pozivu (najviše 48 od dopuštenih 50 naredbi). Poziv ide pod tokenom korisnika, pa svatko vidi samo tikete koje smije vidjeti u Bitrixu.
3. Node spoji rezultate i zadrži samo tikete koji sadrže **sve** riječi (u bilo kojem polju), ignorirajući velika/mala slova i dijakritike.
4. Rangiranje: pogodak u naslovu ili rješenju vrijedi 3, u tekstu e-maila ili komentaru 1; pri istom broju bodova noviji tiket ide prvi.
5. Za svaki tiket vraća se isječak (~160 znakova) oko pogotka iz originalnog teksta, link na deal, faza, odgovorna osoba (ID) i datum.

**Ograničenja:**

- Svaki pod-upit vraća samo prvu stranicu (50 najnovijih tiketa). Ako je **svaka** riječ imala više od 50 pogodaka u nekom polju, starijih tiketa može nedostajati; alat to javi (`notes`, `truncated`) i treba dodati rjeđu riječ. Ako je bar jedna riječ dohvaćena u cijelosti, rezultat je potpun (svaki pogodak mora sadržavati tu riječ).
- "dj" i "đ" se ne smatraju istim slovom: "odredjenom" ne nalazi "određenom" i obrnuto.
- Pretražuje se cijeli pipeline 0. Je li u njemu još nešto osim tiketa podrške (i treba li filtrirati po Klasifikaciji) još nije potvrđeno.
- Odgovorna osoba vraća se kao ID; ime se dobiva preko `bitrix_find_employee`.

**Nalazi testa uživo (13.10.2026, 13 upita):**

- Bitrixov `LIKE` na `crm.sm-it.hr` ignorira velika/mala slova i č/ć/š/ž u sva 4 polja (npr. "racun" i "račun" daju iste brojeve pogodaka), ali **ne** i đ ("đđ" i "dd" daju različite brojeve). Zato se riječ s đ šalje u dva oblika (s đ i s d), a ostale riječi samo jednom.
- Najveći mogući upit (6 riječi s đ, 48 pod-upita) i riječ od 2 slova ("je", 46.547 pogodaka) rade bez greške.
- Riječi koje postoje samo u rješenju ("identu") ili samo u tekstu e-maila ("veleprodajnu") uredno se nalaze, uključujući tikete iz 2020.

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
- **Novi alati nisu odmah vidljivi** — Claude drži listu alata po konekciji; nakon dodavanja alata treba redeploy pa na claude.ai **Disconnect/Connect** konektora (Settings → Connectors) i tek onda nova Claude Code sesija. `/mcp` reconnect i nova sesija bez toga **nisu dovoljni** (provjereno 12. i 13.10.2026). Promjena samo unutarnje logike postojećeg alata ne traži reconnect.
- **CRM `batch`** — najviše 50 naredbi po pozivu; svaka naredba je `metoda?parametri` u PHP query-string obliku (`filter[%TITLE]=x&select[0]=ID`, vidi `toQueryString()` u `ticketSearch.js`). S `halt: 0` ostale naredbe se izvrše i kad Bitrix odbije jednu; greške dolaze u `result_error`, ukupni broj pogodaka u `result_total`. PHP prazne mape vraća kao `[]`, ne `{}`.
- **Custom polja dealova** (`UF_CRM_<broj>`) — `crm.deal.get` vraća samo šifre; naziv iz Bitrix sučelja je u `crm.deal.fields` (`formLabel`/`listLabel`), a vrijednosti listi (enumeration) su ID-evi koje treba prevesti preko `items`. Vidi `src/crmFields.js`.
- **`bitrix_search_tasks`** odbija `status: "all"` kao jedini kriterij ("Give at least one search criterion"), iako poruka navodi status kao kriterij — treba dodati bar još jedan (npr. `query`).
- **Alati koji pišu** (`bitrix_add_task_comment`, `bitrix_send_chat_message`, `bitrix_attach_file_to_task`) djeluju pod identitetom prijavljenog korisnika i podliježu njegovim Bitrix pravima (npr. `edit: false` na tasku u ograničenoj grupi blokira prilaganje). Chat poruke su stvarne poruke stvarnim ljudima — preporuka je u Claudeu birati "Allow once", ne "Always allow", za `bitrix_send_chat_message`.
- **Paralelni razvoj:** drugi developer dodaje "Integration Hub" (OIDC klijent s JWT tokenima i workgroup claimovima) u `oidcProvider.js`/`config.js`; prije pusha uvijek `git pull --rebase`.

## Mogući budući dodaci

Task/CRM: complete/delete task, create/update lead, izmjena dealova, contacts, companies. Pretraga tiketa: filter po Klasifikaciji, imena odgovornih osoba u rezultatu, "dj" kao "đ", dohvat starijih stranica kad su sve riječi česte. Kalendar: eventi. Disk: pretraga datoteka. Messenger: grupni chatovi i čitanje poruka.
