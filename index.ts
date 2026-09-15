#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs/promises";
import { Command } from "commander";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { simpleGit } from "simple-git";

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
  // TODO: hier deine weiteren Stacks eintragen (python, esp32, ...)
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
// 3. Die einzelnen Arbeitsschritte
// ---------------------------------------------------------------------------

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
    await replacePlaceholders(targetDir, { projectName: name });
    return;
  }

  throw new Error(`Stack ${stack.id} hat weder command noch template`);
}

async function replacePlaceholders(dir: string, vars: Record<string, string>) {
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
}

async function initGit(targetDir: string) {
  const git = simpleGit(targetDir);

  // Manche Generatoren (create-next-app) haben schon initialisiert
  const alreadyRepo = await git.checkIsRepo().catch(() => false);
  if (!alreadyRepo) await git.init();

  await git.add(".");
  await git.commit("chore: initial scaffold");
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
      validate: (v) => (v?.trim() ? undefined : "Name darf nicht leer sein"),
    }));

  if (p.isCancel(name)) return p.cancel("Abgebrochen.");

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
    s.start("Remote wird angelegt");

    // TODO: Token aus Config/Keychain laden statt aus der Umgebung
    const provider: RemoteProvider =
      remoteChoice === "gitea"
        ? new GiteaProvider(process.env.GITEA_URL!, process.env.GITEA_TOKEN!)
        : new GitHubProvider(process.env.GITHUB_TOKEN!);

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

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
