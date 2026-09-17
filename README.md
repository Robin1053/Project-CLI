# project-cli

Persönliches CLI-Tool, das neue Projekte anlegt: Grundgerüst erzeugen, Git
initialisieren, optional ein Remote-Repository auf GitHub oder Gitea
anlegen und pushen. Läuft unter Windows und macOS.

## Voraussetzungen

- Node.js 26+ (das Tool nutzt Node's native, Strip-only TypeScript-Ausführung –
  kein Build-Schritt nötig)
- Git
- Für den `esp32`-Stack zusätzlich [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation/index.html) (`pio`)

## Benutzung

```
node index.ts [name] [--private]
```

Ohne Argumente führt `node index.ts` interaktiv durch:

1. Projektname
2. Stack (`next`, `ts-lib`, `esp32`, …)
3. Remote-Repository: keins / GitHub / Gitea
4. Grundgerüst wird erzeugt, Git initialisiert und der erste Commit gemacht
5. Bei Remote-Wahl: Repo wird angelegt und gepusht

`-p, --private` legt ein angelegtes Remote-Repo privat statt öffentlich an.

Bricht ab, wenn der Zielordner bereits existiert.

### Stacks

| Stack | Beschreibung |
|---|---|
| `next` | Next.js (TypeScript, App Router) via `create-next-app` |
| `ts-lib` | Eigenes TypeScript-Package-Template |
| `esp32` | PlatformIO/ESP32-Projekt (Arduino-Framework) |

Neue Stacks werden einfach als Eintrag in `STACKS` in `index.ts` ergänzt –
entweder mit `command` (delegiert an einen externen Generator) oder mit
`template` (kopiert einen Ordner aus `templates/`).

### PlatformIO-Befehle (für `esp32`-Projekte)

Im Projektordner eines gescaffoldeten `esp32`-Projekts ausgeführt:

```
node <pfad-zu-project-cli>/index.ts build [env]
node <pfad-zu-project-cli>/index.ts upload [env]
node <pfad-zu-project-cli>/index.ts add-board
```

- `build` – Firmware bauen (`pio run`)
- `upload` – Firmware bauen und aufs Board flashen (`pio run -t upload`)
- `add-board` – neues ESP32-Board suchen (`pio boards espressif32`) und als
  `[env:...]`-Sektion zur `platformio.ini` hinzufügen

`env` ist optional – ohne Angabe wird interaktiv aus den in `platformio.ini`
definierten `[env:...]`-Sektionen ausgewählt.

### Remote-Repos & Zugangsdaten

GitHub- bzw. Gitea-Token werden in dieser Reihenfolge aufgelöst:

1. Umgebungsvariable (`GITHUB_TOKEN` bzw. `GITEA_URL`/`GITEA_TOKEN`)
2. gespeicherte Config
3. interaktive Abfrage (wird danach für nächstes Mal gespeichert)

Gespeichert wird plattformgerecht über [`conf`](https://github.com/sindresorhus/conf)
(`%APPDATA%` unter Windows, `~/Library/Application Support` unter macOS,
XDG-Pfade unter Linux) – aktuell als Klartext-JSON, nicht im OS-Schlüsselbund.

Token-Scopes: Gitea braucht `write:repository`. GitHub braucht „Administration"
(Schreibrecht) auf einem Fine-grained PAT, oder `repo`/`public_repo` auf
einem Classic PAT.

## Entwicklung

Typecheck gegen die Root-`tsconfig.json`:

```
npx tsc --noEmit
```

Es gibt noch keine Tests und keinen Build-Schritt (`bin` in `package.json`
ist aktuell aspirational).

## Lizenz

[MIT](./LICENSE)
