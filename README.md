# project-cli

[![npm version](https://img.shields.io/npm/v/@robineb/project-cli.svg)](https://www.npmjs.com/package/@robineb/project-cli)

Persönliches CLI-Tool, das neue Projekte anlegt: Grundgerüst erzeugen, Git
initialisieren, optional ein Remote-Repository auf GitHub oder Gitea
anlegen und pushen. Läuft unter Windows und macOS.

## Installation

```
npm i -g @robineb/project-cli
```

(Package auf [npmjs.com](https://www.npmjs.com/package/@robineb/project-cli),
anonym installierbar – kein Account/Token nötig. Scoped, weil der
naheliegende unscoped Name `project-cli` bereits an ein fremdes Paket
vergeben ist. Der aufgerufene Befehl heißt trotzdem schlicht `project-cli`,
das bestimmt der `bin`-Eintrag, nicht der Package-Name. Zusätzlich als
`@robin1053/project-cli` auf GitHub Packages veröffentlicht, rein für die
Sichtbarkeit im Repo; installieren lohnt sich darüber nur, wenn man ohnehin
schon für GitHub Packages authentifiziert ist.)

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
2. gespeicherter Wert
3. interaktive Abfrage (wird danach für nächstes Mal gespeichert)

Tokens landen dabei im OS-eigenen Schlüsselbund über [`@napi-rs/keyring`](https://github.com/napi-rs/keyring-node)
(Windows Credential Manager, macOS Keychain, Linux Secret Service/libsecret) –
nicht in einer Klartextdatei. Die Gitea-URL (kein Geheimnis) bleibt plattformgerecht
in [`conf`](https://github.com/sindresorhus/conf) (`%APPDATA%` unter Windows,
`~/Library/Application Support` unter macOS, XDG-Pfade unter Linux).

Token-Scopes: Gitea braucht `write:repository`. GitHub braucht „Administration"
(Schreibrecht) auf einem Fine-grained PAT, oder `repo`/`public_repo` auf
einem Classic PAT.

## Entwicklung

Typecheck gegen die Root-`tsconfig.json`:

```
npx tsc --noEmit
```

Build für die globale Installation (kompiliert nach `dist/` und kopiert
`templates/` dorthin, siehe `bin` in `package.json`):

```
npm run build
npm i -g .
```

Es gibt noch keine Tests.

### Veröffentlichen

Releases laufen vollautomatisch über PRs auf `master`, versioniert nach
CalVer `JJJJ.M.patch` (Tags `V2026.11.0`, `V2026.11.1`, …; Monat ohne
führende Null, sonst wäre es kein gültiges SemVer für npm):

1. `version-bump.yaml` setzt bei jeder PR die nächste Version in
   `package.json` und pusht den Bump-Commit in den PR-Branch. Gleicher Monat
   wie der letzte Tag → `patch + 1`, neuer Monat → `JJJJ.M.0`.
2. `release-on-merge.yaml` legt nach dem Merge Tag + GitHub Release an und
   ruft `publish.yaml` auf, das die Version zweimal parallel veröffentlicht:

- als `@robineb/project-cli` auf npmjs.com via **Trusted Publishing** (OIDC) –
  kein Secret im Repo, npm tauscht den GitHub-Actions-OIDC-Token automatisch
  gegen einen kurzlebigen Publish-Token. (Klassische Access-Tokens mit
  direktem Publish-Recht werden von npm ab Januar 2027 abgeschafft –
  Trusted Publishing ist der empfohlene Ersatz.)
- als `@robin1053/project-cli` auf GitHub Packages (Auth über das
  eingebaute `GITHUB_TOKEN`, kein Secret nötig)

Trusted Publishing lässt sich laut npm erst einrichten, wenn das Paket
mindestens einmal existiert – deshalb einmaliger manueller Bootstrap, danach
läuft alles Weitere über die CI ohne jedes Secret:

```
npm run build
npm login
npm publish
npm trust github --allow-publish --file publish.yaml
```

PRs mit dem Label `no-release` werden nicht gebumpt und nicht
veröffentlicht. Dependabot-PRs werden ebenfalls nicht gebumpt (Read-only-Token);
ihre Updates landen im nächsten regulären Release.

## Lizenz

[MIT](./LICENSE)
