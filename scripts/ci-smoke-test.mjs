// Scaffoldet je ein ts-lib- und ein esp32-Projekt gegen das gebaute
// dist/index.js (nicht index.ts!) und prüft grundlegende Invarianten:
// Exit-Code, {{projectName}}-Ersetzung, Git-Init, und die
// gitignore->.gitignore-Umbenennung aus scaffold(). Läuft in CI über alle
// drei Plattformen; lokal per `node scripts/ci-smoke-test.mjs` nach
// `npm run build`.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, "dist", "index.js");

const DOWN = "\x1B[B";
const ENTER = "\r";

function waitFor(getOutput, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (pattern.test(getOutput())) return resolve();
      if (Date.now() - start > timeoutMs) {
        reject(
          new Error(
            `Timeout beim Warten auf ${pattern}\n--- Output bisher ---\n${getOutput()}`,
          ),
        );
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function runScaffold({ name, stackDownPresses, cwd }) {
  const child = spawn("node", [cliEntry, name], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));
  const getOutput = () => out;

  await waitFor(getOutput, /Welcher Stack\?/);
  for (let i = 0; i < stackDownPresses; i++) child.stdin.write(DOWN);
  child.stdin.write(ENTER);

  await waitFor(getOutput, /Remote-Repository anlegen\?/);
  child.stdin.write(ENTER); // "Nein, nur lokal" ist die Default-Auswahl

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  if (exitCode !== 0) {
    throw new Error(`Scaffold für "${name}" fehlgeschlagen (Exit ${exitCode}):\n${out}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`FEHLGESCHLAGEN: ${message}`);
}

async function fileExists(p) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function main() {
  if (!(await fileExists(cliEntry))) {
    throw new Error(`${cliEntry} fehlt — vorher "npm run build" laufen lassen.`);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-cli-smoke-"));

  // ts-lib: next(0) -> ts-lib(1), 1x runter
  await runScaffold({ name: "smoke-ts-lib", stackDownPresses: 1, cwd: workDir });
  const tsLibDir = path.join(workDir, "smoke-ts-lib");
  const pkgJson = await fs.readFile(path.join(tsLibDir, "package.json"), "utf8");
  assert(pkgJson.includes("smoke-ts-lib"), "ts-lib: {{projectName}} wurde nicht ersetzt");
  assert(!pkgJson.includes("{{projectName}}"), "ts-lib: Platzhalter übrig geblieben");
  assert(await fileExists(path.join(tsLibDir, ".git")), "ts-lib: kein eigenes .git angelegt");

  // esp32: next(0) -> ts-lib(1) -> esp32(2), 2x runter
  await runScaffold({ name: "smoke-esp32", stackDownPresses: 2, cwd: workDir });
  const esp32Dir = path.join(workDir, "smoke-esp32");
  const ini = await fs.readFile(path.join(esp32Dir, "platformio.ini"), "utf8");
  assert(ini.includes("smoke-esp32"), "esp32: {{projectName}} wurde nicht ersetzt");
  assert(
    await fileExists(path.join(esp32Dir, ".gitignore")),
    "esp32: .gitignore (mit Punkt) fehlt",
  );
  assert(
    !(await fileExists(path.join(esp32Dir, "gitignore"))),
    "esp32: 'gitignore' (ohne Punkt) wurde nicht zu .gitignore umbenannt",
  );

  await fs.rm(workDir, { recursive: true, force: true });
  console.log("Smoke-Test OK: ts-lib und esp32 scaffolden korrekt.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
