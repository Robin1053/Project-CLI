import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateProjectName, replacePlaceholders } from "./index.ts";

test("validateProjectName", async (t) => {
  await t.test("lehnt leeren Namen ab", () => {
    assert.ok(validateProjectName(""));
    assert.ok(validateProjectName(undefined));
    assert.ok(validateProjectName("   "));
  });

  await t.test("lehnt Leerzeichen ab (Gitea AlphaDashDot / GitHub 422)", () => {
    assert.ok(validateProjectName("esp 32"));
  });

  await t.test("lehnt führende/abschließende Sonderzeichen ab", () => {
    assert.ok(validateProjectName("-esp32"));
    assert.ok(validateProjectName("esp32-"));
    assert.ok(validateProjectName(".esp32"));
  });

  await t.test("akzeptiert gültige Namen", () => {
    assert.equal(validateProjectName("esp32"), undefined);
    assert.equal(validateProjectName("my-python-app"), undefined);
    assert.equal(validateProjectName("a.b_c"), undefined);
  });
});

test("replacePlaceholders", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-cli-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Nachbau des Python-Templates: Ordnername trägt selbst einen Platzhalter
  // ({{pythonPackageName}}), wie templates/python/src/{{pythonPackageName}}/.
  await fs.mkdir(path.join(dir, "src", "{{pythonPackageName}}"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src", "{{pythonPackageName}}", "__init__.py"),
    'print("{{projectName}} läuft")\n',
  );
  await fs.writeFile(path.join(dir, "README.md"), "# {{projectName}}\n");

  await replacePlaceholders(dir, {
    projectName: "my-app",
    pythonPackageName: "my_app",
  });

  await t.test("ersetzt Platzhalter in Datei-Inhalten", async () => {
    const readme = await fs.readFile(path.join(dir, "README.md"), "utf8");
    assert.equal(readme, "# my-app\n");
  });

  await t.test("benennt Ordner mit Platzhalter im Namen um", async () => {
    const initContent = await fs.readFile(
      path.join(dir, "src", "my_app", "__init__.py"),
      "utf8",
    );
    assert.equal(initContent, 'print("my-app läuft")\n');

    await assert.rejects(fs.access(path.join(dir, "src", "{{pythonPackageName}}")));
  });
});
