#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { simpleGit, CheckRepoActions } from "simple-git";
import Conf from "conf";
import { Entry } from "@napi-rs/keyring";

// ---------------------------------------------------------------------------
// 1. Stack-Definitionen
//    Ein Stack hat ENTWEDER einen command (fremder Generator wie create-next-app)
//    ODER ein template (eigener Ordner, den wir kopieren). Nie beides.
// ---------------------------------------------------------------------------

type Stack = {
  id: string;
  label: string;
  command?: (name: string) => { file: string; args: string[] };
  template?: string; // Ordnername unter ./templates/
};

const STACKS: Stack[] = [
  {
    id: "next",
    label: "Next.js (TypeScript, App Router)",
    command: (name) => ({
      file: "npx",
      args: ["create-next-app@latest", name, "--ts", "--app", "--yes"],
    }),
  },
  {
    id: "ts-lib",
    label: "TypeScript Package (eigenes Template)",
    template: "ts-lib",
  },
  {
    id: "esp32",
    label: "PlatformIO / ESP32 (Arduino)",
    template: "esp32",
  },
  {
    id: "python",
    label: "Python Package (eigenes Template)",
    template: "python",
  },
  // TODO: hier deine weiteren Stacks eintragen
];

// ---------------------------------------------------------------------------
// 2. Remote-Provider
//    Beide Provider erfüllen dasselbe Interface. Der Rest des Programms
//    weiß nicht, ob es GitHub oder Gitea ist.
//
//    Hinweis: ausgeschriebene Konstruktoren statt "private x: string" im
//    Parameter — Node führt TypeScript nur im Strip-Only-Modus aus und
//    kann Parameter Properties nicht umschreiben.
// ---------------------------------------------------------------------------

interface RemoteProvider {
  createRepo(name: string, isPrivate: boolean): Promise<string>; // gibt Clone-URL zurück
}

class GiteaProvider implements RemoteProvider {
  baseUrl: string;
  token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async createRepo(name: string, isPrivate: boolean): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/v1/user/repos`, {
      method: "POST",
      headers: {
        Authorization: `token ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      // auto_init: false -> leeres Repo, sonst scheitert der Push
      body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
    });

    if (res.status === 409)
      throw new Error(`Repo "${name}" existiert bereits.`);
    if (!res.ok) throw new Error(`Gitea ${res.status}: ${await res.text()}`);

    const repo = (await res.json()) as { clone_url: string };
    return repo.clone_url;
  }
}

class GitHubProvider implements RemoteProvider {
  token: string;

  constructor(token: string) {
    this.token = token;
  }

  async createRepo(name: string, isPrivate: boolean): Promise<string> {
    const res = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
    });

    // GitHub liefert 422 sowohl bei Namenskollision als auch bei Validierungsfehlern
    if (res.status === 422) {
      throw new Error(`Repo "${name}" existiert wohl schon.`);
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);

    const repo = (await res.json()) as { clone_url: string };
    return repo.clone_url;
  }
}

// ---------------------------------------------------------------------------
// 2b. Zugangsdaten
//     Erst ENV-Variable, dann gespeicherter Wert, sonst interaktiv abfragen
//     und für nächstes Mal speichern. Tokens (Secrets) landen im OS-eigenen
//     Schlüsselbund über @napi-rs/keyring (Windows Credential Manager,
//     macOS Keychain, Linux Secret Service/libsecret) statt in einer Datei.
//     Nicht-geheime Werte wie die Gitea-URL bleiben in `conf`
//     (plattformgerechter Pfad, z.B. %APPDATA% unter Windows).
// ---------------------------------------------------------------------------

type StoredConfig = {
  giteaUrl?: string;
};

const config = new Conf<StoredConfig>({ projectName: "project-cli" });

const KEYRING_SERVICE = "project-cli";

function getStoredSecret(account: string): string | undefined {
  return new Entry(KEYRING_SERVICE, account).getPassword() ?? undefined;
}

function setStoredSecret(account: string, value: string): void {
  new Entry(KEYRING_SERVICE, account).setPassword(value);
}

async function ask(message: string): Promise<string> {
  const answer = await p.password({ message });
  if (p.isCancel(answer)) throw new Error("Abgebrochen.");
  return answer;
}

async function askText(message: string): Promise<string> {
  const answer = await p.text({
    message,
    validate: (value) => (value?.trim() ? undefined : "Darf nicht leer sein."),
  });
  if (p.isCancel(answer)) throw new Error("Abgebrochen.");
  return answer;
}

async function resolveGitHubToken(): Promise<string> {
  const existing = process.env.GITHUB_TOKEN ?? getStoredSecret("github-token");
  if (existing) return existing;

  const token = await ask("GitHub Personal Access Token (repo-Scope)");
  setStoredSecret("github-token", token);
  return token;
}

async function resolveGiteaCredentials(): Promise<
  [baseUrl: string, token: string]
> {
  // Leerer String zählt als "nicht vorhanden" (z.B. ein früherer Lauf hat
  // versehentlich "" gespeichert) -> nicht nur auf null/undefined prüfen.
  const existingUrl = process.env.GITEA_URL || config.get("giteaUrl") || undefined;
  const baseUrl =
    existingUrl ??
    (await askText("Gitea-URL (z.B. https://gitea.example.com)"));
  if (!existingUrl) config.set("giteaUrl", baseUrl);

  const existingToken =
    process.env.GITEA_TOKEN || getStoredSecret("gitea-token") || undefined;
  const token =
    existingToken ?? (await ask("Gitea Access Token (write:repository-Scope)"));
  if (!existingToken) setStoredSecret("gitea-token", token);

  return [baseUrl, token];
}

// ---------------------------------------------------------------------------
// 3. Die einzelnen Arbeitsschritte
// ---------------------------------------------------------------------------

// Deckt sowohl Gitea (Regel "AlphaDashDot") als auch GitHub ab: nur
// alphanumerische Zeichen, "-", "_" und ".", muss mit alphanumerisch
// beginnen und enden. Leerzeichen wie in "esp 32" fallen damit sofort auf,
// statt erst nach Scaffold + erstem Commit bei der Remote-Erstellung.
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function validateProjectName(name: string | undefined): string | undefined {
  if (!name?.trim()) return "Name darf nicht leer sein";
  if (!PROJECT_NAME_PATTERN.test(name)) {
    return "Name darf nur Buchstaben, Ziffern, '-', '_' und '.' enthalten (muss mit Buchstabe/Ziffer beginnen und enden)";
  }
  return undefined;
}

async function scaffold(stack: Stack, targetDir: string, name: string) {
  if (stack.command) {
    const { file, args } = stack.command(name);
    // cwd = Elternordner, weil der Generator den Zielordner selbst anlegt
    await execa(file, args, { cwd: path.dirname(targetDir), stdio: "inherit" });
    return;
  }

  if (stack.template) {
    const src = path.join(import.meta.dirname, "templates", stack.template);
    await fs.cp(src, targetDir, { recursive: true });
    await restoreGitignore(targetDir);
    // pythonPackageName: Bindestriche/Punkte sind in Projektnamen erlaubt
    // (Gitea/GitHub-Repo-Namen), aber kein gültiger Python-Bezeichner ->
    // eigener, bereinigter Platzhalter fürs Python-Template.
    await replacePlaceholders(targetDir, {
      projectName: name,
      pythonPackageName: name.toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
    });
    return;
  }

  throw new Error(`Stack ${stack.id} hat weder command noch template`);
}

// npm streicht jede Datei, die exakt ".gitignore" heißt, aus jedem Package
// (unabhängig vom Pfad) -> Templates lagern sie ohne Punkt als "gitignore"
// und wir benennen sie hier, nach dem Kopieren ins neue Projekt, zurück um.
async function restoreGitignore(targetDir: string) {
  const from = path.join(targetDir, "gitignore");
  const to = path.join(targetDir, ".gitignore");
  await fs.rename(from, to).catch(() => {});
}

export async function replacePlaceholders(dir: string, vars: Record<string, string>) {
  const entries = await fs.readdir(dir, {
    withFileTypes: true,
    recursive: true,
  });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);

    let content: string;
    try {
      content = await fs.readFile(full, "utf8");
    } catch {
      continue; // Binärdatei o.ä. -> überspringen
    }

    let replaced = content;
    for (const [key, value] of Object.entries(vars)) {
      replaced = replaced.replaceAll(`{{${key}}}`, value);
    }

    if (replaced !== content) await fs.writeFile(full, replaced, "utf8");
  }

  await renamePlaceholderPaths(dir, vars);
}

// Datei-/Ordnernamen mit Platzhaltern umbenennen (z.B. src/{{projectName}}/
// für ein Python-Package). Läuft rekursiv pro Verzeichnisebene von außen
// nach innen und fragt bei jedem Schritt den aktuellen Verzeichnisinhalt
// neu ab -> ein umbenannter Ordner wird mitsamt seinem (noch nicht
// umbenannten) Inhalt an die neue Stelle verschoben, bevor wir tiefer
// absteigen. Eine vorab gesammelte Pfadliste würde hier stale werden,
// sobald ein Vorfahre umbenannt ist.
async function renamePlaceholderPaths(dir: string, vars: Record<string, string>) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    let renamedName = entry.name;
    for (const [key, value] of Object.entries(vars)) {
      renamedName = renamedName.replaceAll(`{{${key}}}`, value);
    }

    const oldPath = path.join(dir, entry.name);
    const newPath = path.join(dir, renamedName);
    if (renamedName !== entry.name) await fs.rename(oldPath, newPath);

    if (entry.isDirectory()) await renamePlaceholderPaths(newPath, vars);
  }
}

async function initGit(targetDir: string) {
  const git = simpleGit(targetDir);

  // IS_REPO_ROOT statt Default: Default prüft nur "irgendwo unter einem Repo",
  // das wäre auch true, wenn targetDir zufällig innerhalb eines fremden
  // Repos liegt -> init() würde übersprungen und add/commit liefen gegen
  // das falsche (übergeordnete) Repo. Hier soll nur erkannt werden, ob
  // targetDir selbst schon ein eigenes .git hat (z.B. von create-next-app).
  const alreadyRepo = await git
    .checkIsRepo(CheckRepoActions.IS_REPO_ROOT)
    .catch(() => false);
  if (!alreadyRepo) await git.init();

  await git.add(".");
  await git.commit("chore: initial scaffold");
}

// ---------------------------------------------------------------------------
// 3b. PlatformIO-Helfer (build/upload/add-board)
//     Ersatz für das commands.sh-Script aus dem esp32-Template-Vorbild:
//     dort Bash + fzf, hier execa + @clack/prompts, damit es auch unter
//     PowerShell/cmd läuft. Arbeiten immer auf der platformio.ini im cwd.
// ---------------------------------------------------------------------------

async function readPioEnvironments(cwd: string): Promise<string[]> {
  const iniPath = path.join(cwd, "platformio.ini");

  let content: string;
  try {
    content = await fs.readFile(iniPath, "utf8");
  } catch {
    throw new Error(`Keine platformio.ini in ${cwd} gefunden.`);
  }

  return [...content.matchAll(/^\[env:([^\]]+)\]/gm)].map((m) => m[1]);
}

async function selectPioEnvironment(
  cwd: string,
  message: string,
): Promise<string> {
  const envs = await readPioEnvironments(cwd);
  if (envs.length === 0)
    throw new Error("Keine [env:...]-Sektionen in platformio.ini gefunden.");
  if (envs.length === 1) return envs[0];

  const choice = await p.select({
    message,
    options: envs.map((e) => ({ value: e, label: e })),
  });
  if (p.isCancel(choice)) throw new Error("Abgebrochen.");
  return choice;
}

type PioBoard = { id: string; name: string };

async function searchEsp32Boards(query: string): Promise<PioBoard[]> {
  const { stdout } = await execa("pio", [
    "boards",
    "espressif32",
    "--json-output",
  ]);
  const boards = JSON.parse(stdout) as PioBoard[];

  if (!query.trim()) return boards;
  const q = query.toLowerCase();
  return boards.filter((b) => `${b.id} ${b.name}`.toLowerCase().includes(q));
}

async function addBoard(cwd: string) {
  const query = await askText(
    'Board suchen (z.B. "esp32-s3", leer = alle anzeigen)',
  );
  const boards = await searchEsp32Boards(query);
  if (boards.length === 0) throw new Error("Keine passenden Boards gefunden.");

  const boardId = await p.select({
    message: "Welches Board?",
    options: boards
      .slice(0, 50)
      .map((b) => ({ value: b.id, label: `${b.name} (${b.id})` })),
  });
  if (p.isCancel(boardId)) throw new Error("Abgebrochen.");

  const envName = await askText(
    'Name der neuen Environment (z.B. "my-esp32-s3")',
  );

  const section = `\n[env:${envName}]\nplatform = espressif32\nboard = ${boardId}\n`;
  await fs.appendFile(path.join(cwd, "platformio.ini"), section, "utf8");
}

// ---------------------------------------------------------------------------
// 4. Der eigentliche Ablauf
// ---------------------------------------------------------------------------

async function run(nameArg: string | undefined, opts: { private?: boolean }) {
  p.intro("Projekt-Setup");

  const name =
    nameArg ??
    (await p.text({
      message: "Wie soll das Projekt heißen?",
      validate: (v) => validateProjectName(v),
    }));

  if (p.isCancel(name)) return p.cancel("Abgebrochen.");

  // nameArg kommt am Prompt vorbei (CLI-Argument statt p.text) -> hier
  // nochmal prüfen. Sonst scheitert erst die Remote-Erstellung nach
  // Scaffold + erstem Commit (Gitea/GitHub lehnen z.B. Leerzeichen im
  // Namen mit "AlphaDashDot" bzw. 422 ab), und die lokale Arbeit ist
  // bereits passiert, ohne dass ein Remote konfiguriert wurde.
  const nameError = validateProjectName(name);
  if (nameError) {
    p.cancel(nameError);
    return;
  }

  const stackId = await p.select({
    message: "Welcher Stack?",
    options: STACKS.map((s) => ({ value: s.id, label: s.label })),
  });

  if (p.isCancel(stackId)) return p.cancel("Abgebrochen.");

  const remoteChoice = await p.select({
    message: "Remote-Repository anlegen?",
    options: [
      { value: "none", label: "Nein, nur lokal" },
      { value: "github", label: "GitHub" },
      { value: "gitea", label: "Gitea" },
    ],
  });

  if (p.isCancel(remoteChoice)) return p.cancel("Abgebrochen.");

  const stack = STACKS.find((s) => s.id === stackId)!;
  const targetDir = path.resolve(process.cwd(), name);

  // Nicht in einen vorhandenen Ordner schreiben
  const exists = await fs.stat(targetDir).then(
    () => true,
    () => false,
  );
  if (exists) {
    p.cancel(`Ordner "${name}" existiert bereits.`);
    return;
  }

  const s = p.spinner();

  s.start("Grundgerüst wird angelegt");
  await scaffold(stack, targetDir, name);
  s.stop("Grundgerüst steht");

  s.start("Git wird initialisiert");
  await initGit(targetDir);
  s.stop("Erster Commit ist da");

  if (remoteChoice !== "none") {
    // Zugangsdaten zuerst einsammeln (interaktiv, falls nötig) — danach erst
    // den Spinner starten, sonst überlagern sich Prompt und Spinner.
    const provider: RemoteProvider =
      remoteChoice === "gitea"
        ? new GiteaProvider(...(await resolveGiteaCredentials()))
        : new GitHubProvider(await resolveGitHubToken());

    s.start("Remote wird angelegt");
    const cloneUrl = await provider.createRepo(name, opts.private ?? false);

    const git = simpleGit(targetDir);
    await git.addRemote("origin", cloneUrl);
    await git.push(["-u", "origin", "HEAD"]);

    s.stop(`Gepusht nach ${cloneUrl}`);
  }

  p.outro(`Fertig. cd ${name}`);
}

// ---------------------------------------------------------------------------
// 5. Einstiegspunkt
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("myinit")
  .description("Legt neue Projekte inkl. Repo an")
  .argument("[name]", "Projektname")
  .option("-p, --private", "Remote-Repo privat anlegen")
  .action(run);

// Die folgenden Befehle arbeiten auf einem bestehenden PlatformIO-Projekt
// im aktuellen Arbeitsverzeichnis (nicht auf dem Scaffold-Flow oben).
program
  .command("build [env]")
  .description("PlatformIO-Firmware bauen (pio run)")
  .action(async (env?: string) => {
    const cwd = process.cwd();
    const selected =
      env ?? (await selectPioEnvironment(cwd, "Welche Environment bauen?"));
    await execa("pio", ["run", "-e", selected], { cwd, stdio: "inherit" });
  });

program
  .command("upload [env]")
  .description("Firmware bauen und aufs Board flashen (pio run -t upload)")
  .action(async (env?: string) => {
    const cwd = process.cwd();
    const selected =
      env ?? (await selectPioEnvironment(cwd, "Welche Environment flashen?"));
    await execa("pio", ["run", "-e", selected, "-t", "upload"], {
      cwd,
      stdio: "inherit",
    });
  });

program
  .command("add-board")
  .description("Neues ESP32-Board zur platformio.ini hinzufügen")
  .action(async () => {
    await addBoard(process.cwd());
  });

// Guard, damit ein Import dieser Datei (z.B. aus Tests) nicht sofort die
// interaktive CLI anwirft — nur wenn die Datei direkt ausgeführt wird.
// pathToFileURL() statt string-Vergleich mit process.argv[1], weil das auf
// Windows sonst an Backslashes/URL-Encoding scheitert.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  program.parseAsync().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
