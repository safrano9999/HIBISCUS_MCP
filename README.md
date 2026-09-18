# HIBISCUS_MCP

`HIBISCUS_MCP` stellt ausgewählte Hibiscus-Funktionen als kleinen,
Bearer-geschützten MCP-Server bereit. Der Server spricht intern per XML-RPC mit
einem vorhandenen Hibiscus-Server und speichert selbst keine Bankdaten.

Container-Image: `ghcr.io/safrano9999/hibiscus-mcp:latest`

## Zusammenspiel

```text
MCP-Client
    │  Streamable HTTP + Bearer
    ▼
gepatchtes Supergateway :8000/mcp
    │  stdio
    ▼
HIBISCUS_MCP (server.mjs)
    │  HTTPS/XML-RPC
    ▼
Hibiscus-Server :8080/xmlrpc/
```

Das eigenständige Image benötigt deshalb immer einen erreichbaren
Hibiscus-Server. Das Schwesterprojekt
[`HIBISCUS-FEDORA44`](https://github.com/safrano9999/HIBISCUS-FEDORA44)
integriert diesen MCP-Server und Hibiscus in einem gemeinsamen Fedora-Container.

## MCP-Tools

| Tool | Funktion |
| --- | --- |
| `create_transfer` | Legt eine SEPA-Überweisung an, unterstützt `instant=true` und stößt anschließend den Hibiscus-Sync an. |
| `pending_transfers` | Listet offene Überweisungen oder löscht einen noch offenen Auftrag anhand seiner Hibiscus-ID. |
| `get_balance` | Liest die zuletzt in Hibiscus gespeicherten Kontostände, optional gefiltert nach Konto-ID oder IBAN. |

`create_transfer` liest zunächst den Sync-Status. Bei laufender Synchronisierung
oder nicht lesbarem Status wird kein Auftrag erstellt. Anschließend wird genau
ein Auftrag gespeichert, einmal `action=execute` an `/hibiscus/` gesendet und
serverseitig höchstens 30 Sekunden auf den Sync-Abschluss gewartet. Für eine
Echtzeitüberweisung muss der Client ausdrücklich `instant=true` setzen.

Die Rückgabe enthält `stored`, `id`, `instant`, `sync_triggered`, `sync_status`
und eine kurze `message`. `sync_status=completed` bedeutet:
**„Überweisung erstellt und Synchronisierung erfolgreich abgeschlossen.“**
Das ist eine Bestätigung des Sync-Ablaufs, keine Bestätigung einer einzelnen
Bankbuchung. Der Client soll die Nachricht ausgeben und aufhören; er soll weder
`pending_transfers`/`get_balance` pollen noch auf eine gesonderte Bankannahme
warten. Das bisherige Feld `execution_confirmed: false` entfällt.

Fehler werden als `failed`, nicht eindeutig beobachtbare Abschlüsse als `unknown`
gemeldet. Nach dem Speichern bleibt `stored=true` auch bei einem Sync-Fehler.
Eine unterbrochene Speicherantwort ergibt `stored=null`: Der Client darf den
Auftrag nicht automatisch neu anlegen. `sync_triggered=null` heißt, dass der
Start nicht belegt ist, nicht dass sicher kein Sync stattfand. Es gibt keine
automatische Wiederholung von Speicherung oder Sync-POST.

Hibiscus stellt keine öffentliche Sync-Run-ID bereit. Der MCP gleicht deshalb
neue Einträge des bestehenden System-Logs mit dem Stand vor dem Aufruf ab und
verlangt einen frischen Start sowie Abschluss von `ExecuteServiceImpl`. Alte
Erfolgsmeldungen, verlorene Log-Einträge, überlappende Läufe und Fehler ergeben
keinen Erfolg. Der Sync betrifft die gesamte Hibiscus-Warteschlange; sein
Abschluss beweist nicht die Annahme eines einzelnen Auftrags. Gleichzeitige
Aufträge innerhalb derselben MCP-Sitzung werden abgewiesen. Andere Sitzungen,
Scheduler oder manuelle Syncs sind nicht global gesperrt; bei erkennbarer
Mehrdeutigkeit bleibt das Ergebnis `unknown`. Die Hibiscus-Anwendung wird dafür
nicht verändert.

`npm test` prüft Echtzeit-Parameter, Reihenfolge, Abschlusskorrelation, Fehler,
Timeouts und HTTP-Verhalten ausschließlich mit lokalen Stubs, ohne Bankzugriff.

## Authentifizierung

Es gibt genau zwei gemeinsame Variablennamen:

| Variable | Direktes Passthrough | Gateway-Modus |
| --- | --- | --- |
| `HIBISCUS_STORE_PASSWORD` | Wird nicht verwendet | Erforderliches Hibiscus-Passwort für die interne XML-RPC-Verbindung |
| `HIBISCUS_MCP_GATEWAY` | Bleibt leer | Separater Bearer für MCP-Clients |

Zwei Betriebsarten sind möglich:

1. **Direktes Bearer-Passthrough:** `HIBISCUS_MCP_GATEWAY` bleibt leer. Der vom
   MCP-Client gesendete Bearer wird als Hibiscus-Passwort verwendet.
2. **Stealth-Gateway:** `HIBISCUS_MCP_GATEWAY` ist gesetzt. Der Client muss
   diesen Bearer senden; nur der MCP-Prozess erhält zusätzlich
   `HIBISCUS_STORE_PASSWORD` für Hibiscus.

Der Gateway-Modus verhindert, dass ein MCP-Client das eigentliche
Hibiscus-Passwort kennen muss. Wegen des Überweisungs-Tools sollte der MCP-Port
nur in vertrauenswürdigen Netzen erreichbar sein.

## Endpunkte

- MCP: `http://HOST:8000/mcp`
- Health: `http://HOST:8000/healthz` (ohne Authentifizierung)
- Transport: stateful Streamable HTTP
- Sitzungszeit: 60 Minuten

Der interne stdio-Server steht in [`server.mjs`](server.mjs). Die HTTP-Brücke
basiert auf einer fest gepinnten Supergateway-Revision mit den Patches unter
[`patches/`](patches/). Der Bearer wird beim MCP-Initialize an die Sitzung
gebunden; Folgeanfragen derselben Sitzung müssen denselben Bearer senden. Für
den internen, typischerweise selbstsignierten Hibiscus-Endpunkt ist die
TLS-Zertifikatsprüfung bewusst deaktiviert.

## Konfiguration und Deployment

Die Konfiguration wird durch [`config.sh`](config.sh) aus den Vorlagen erzeugt:

| Vorlage | Inhalt |
| --- | --- |
| [`env.example`](env.example) | Passwörter und Bearer |
| [`config.conf_example`](config.conf_example) | Hibiscus-URL und interner MCP-Port |
| [`container.example`](container.example) | Containername, Veröffentlichung und zusätzliche Quadlet-Zeilen |

```bash
./setup.sh
```

`setup.sh` erzeugt die Runtime-Dateien mit Modus `0600` und bereitet beide
Varianten vor:

- **Container:** generiertes `hibiscus-mcp.container` als User-Quadlet verlinken.
- **Bare Metal:** generierte `hibiscus-mcp.service` als User-Service verlinken.

Es darf immer nur eine Variante aktiv sein. Für Bare Metal verwendet das Setup
vorhandenes Node.js ab Version 20 oder installiert Node.js lokal und
checksum-geprüft unter `.runtime/`. Supergateway wird ebenfalls lokal aus der
fest gepinnten Revision gebaut.

Das Container-Deployment benötigt kein Volume und keine eigene Datenbank. Ein
leerer `HIBISCUS_MCP_PUBLISH_PORT` veröffentlicht keinen Hostport; der Dienst
kann dann ausschließlich über ein gemeinsames Podman-Netz erreicht werden.

## Build

Das [`STANDALONE/Containerfile`](STANDALONE/Containerfile) baut zuerst das gepatchte Supergateway und
den MCP-Server, prüft `server.mjs` und erzeugt anschließend ein minimales
Alpine-basiertes Runtime-Image. Veröffentlichung und Smoke-Test erfolgen über
[`container-image.yml`](.github/workflows/container-image.yml).

Lizenz: [MIT](LICENSE)

## Gemeinsames Image und optionaler Standalone-Build

Das produktiv verwendete gemeinsame Image ist
[`safrano9999-hibiscus`](https://github.com/safrano9999/safrano9999-hibiscus).
Sein GitHub-Action-Build lädt dieses Quellrepo und baut MCP und Banking-Server
zusammen. Dafür muss kein `hibiscus-mcp`-Image veröffentlicht werden.

`STANDALONE/Containerfile` bleibt als optionaler separater Build erhalten
(Build-Kontext: Wurzel dieses Repos). Die manuell auslösbare Container-Action
verwendet diese Datei. Bare Metal ist weiterhin über `setup.sh` möglich.
Die bereits eingesetzten Supergateway-Patches für Bearer, Bind-Adresse und
MCP-SDK 1.30.0 sind hier zusammengeführt.
