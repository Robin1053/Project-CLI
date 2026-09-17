# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal, cross-platform (Windows + macOS) CLI tool (`project-cli`) that scaffolds new projects: generate a base project, init git, optionally create a remote repo on GitHub or Gitea, and push. The entire tool is a single file, `index.ts`.

Chosen stack: TypeScript + Node (not Go) — matches the developer's existing strength. Distribution is planned via `npm i -g`, not as a compiled binary.

## Commands

There is no build, lint, or test tooling configured yet:
- `package.json`'s `test` script is a stub (`exit 1`) — there are no tests in this repo.
- There is no `build`/`dev` script even though `bin` points to `./dist/index.js`; that entry is aspirational until a `tsc` build step is added.

Run the CLI during development via Node's native TypeScript execution (Node 26+, strip-only mode) — this is a deliberate choice, not just "no build step yet":
```
node index.ts [name] [--private]
```
`tsx` is present as a devDependency but is **not** the intended runner — it was dropped in favor of native execution after `tsx`/`esbuild` produced `ERR_PACKAGE_PATH_NOT_EXPORTED` (via execa's `unicorn-magic` dependency) during setup. One fewer dependency, one fewer failure mode.

To compile against the root `tsconfig.json` (`outDir: dist`):
```
npx tsc
```

## Architecture

Everything lives in `index.ts`, organized top-to-bottom into five numbered sections (kept as comment headers in the file — preserve this structure when editing):

1. **Stack definitions** (`STACKS`) — each `Stack` has *either* a `command` (delegates scaffolding to an external generator, e.g. `create-next-app`) *or* a `template` (a folder under `templates/` that gets copied). Never both — `scaffold()` branches on which is set. New stacks are just a new entry in this array, not a code change.
2. **Remote providers** (`RemoteProvider` interface) — `GiteaProvider` and `GitHubProvider` both implement `createRepo(name, isPrivate): Promise<string>` (returns the clone URL). The rest of the program is provider-agnostic.
3. **Work steps** — `scaffold()` (copy template or run external generator), `replacePlaceholders()` (recursively replaces `{{key}}` tokens in every text file of a freshly scaffolded project — binary files are silently skipped via the read failing), `initGit()` (git init only if not already a repo, then add + commit).
   - **3b. PlatformIO helpers** — `readPioEnvironments()`/`selectPioEnvironment()` (parse `[env:...]` sections out of a `platformio.ini` in `cwd`, prompt if there's more than one), `searchEsp32Boards()`/`addBoard()` (`pio boards espressif32 --json-output`, filter, prompt, append a new `[env:...]` section). These operate on an *existing* PlatformIO project in the current directory, not on the scaffold flow — replacement for the upstream esp32 template's Bash+`fzf` `commands.sh`, ported to `execa`+`@clack/prompts` so it also runs under PowerShell/cmd.
4. **Main flow** (`run()`) — the interactive prompt sequence (via `@clack/prompts`): project name → stack → remote choice (none/github/gitea) → scaffold → git init → optional remote create + push. Bails out if the target directory already exists.
5. **Entry point** — a `commander` program: the root command (`myinit`) with a `[name]` argument and `-p, --private` flag runs the scaffold flow (`run()`); alongside it, three subcommands (`build [env]`, `upload [env]`, `add-board`) call into the PlatformIO helpers (3b) for an existing project in `cwd`.

### Templates

`templates/<stack-id>/` folders are copied verbatim into the new project, then every file has `{{projectName}}` substituted via `replacePlaceholders()`. When adding a template-based stack, follow the existing `templates/ts-lib` example and use `{{projectName}}` wherever the project name should be interpolated (see its `package.json` and `README.md`).

`templates/esp32` is a trimmed-down vendor of [madskjeldgaard/platformio-arduino-template](https://github.com/madskjeldgaard/platformio-arduino-template): ESP32-only `platformio.ini` environments (dropped the Pico/Teensy/ESP8266 ones), no `LICENSE` (license choice is left to the generated project, matching `ts-lib`), no `.scripts/commands.sh` or `.vscode/tasks.json` (superseded by the `build`/`upload`/`add-board` subcommands, see 3b above).

Every template should include a `.gitattributes` with `* text=auto`.

### Remote repo creation & credentials

Section 2b (`resolveGitHubToken()` / `resolveGiteaCredentials()`) resolves credentials in this order: env var (`GITHUB_TOKEN`, `GITEA_URL`/`GITEA_TOKEN`) → stored config → interactive prompt (via `p.password`/`p.text`), and persists whatever was prompted for next time. Storage is a platform-appropriate config file via `conf` (`new Conf({ projectName: "project-cli" })` — resolves to `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, XDG paths on Linux), not raw env vars anymore. Credentials are always resolved *before* the "Remote wird angelegt" spinner starts — an interactive prompt while a spinner is running would visually collide.

Both providers are nearly identical but differ in three ways:

| | Gitea | GitHub |
|---|---|---|
| Endpoint | `POST {baseUrl}/api/v1/user/repos` | `POST https://api.github.com/user/repos` |
| Auth header | `Authorization: token <PAT>` | `Authorization: Bearer <token>` |
| Extra headers | — | `X-GitHub-Api-Version`, `Accept: application/vnd.github+json` |
| "name taken" status | `409` | `422` (also used for other validation errors) |

Token scopes: Gitea needs `write:repository`. GitHub needs "Administration" (write) on a fine-grained PAT, or `repo`/`public_repo` on a classic PAT.

## Hard requirements (not style choices — the program breaks without these)

- **`"type": "module"` in `package.json`**, not `"types"` (a different field, silently ignored — this exact typo has cost real time before). Without it, `import.meta.dirname` in `scaffold()` fails to build (`TS1470`). Matching tsconfig: `"module": "nodenext"`, `"moduleResolution": "nodenext"`.
- **No TS parameter properties, `enum`, or `namespace`.** Node's strip-only TS execution can't erase these (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Write out constructor fields and assign them explicitly instead of `constructor(private x: string)`.
- **`auto_init: false` on both providers' `createRepo`.** With `true` the remote creates its own initial commit, so the local repo's history doesn't match and the push fails "non-fast-forward". The remote must be created empty.
- **Template path (`path.join(import.meta.dirname, "templates", stack.template)`) assumes execution from the project root.** Once a build to `dist/` exists, either adjust this path or make sure `templates/` is copied alongside the build output.
- **`res.json()` is `unknown`** — always cast (e.g. `as { clone_url: string }`); there's no runtime validation yet.

## Platform rules

- Always build paths with `path.join()`/`path.resolve()`, never string concatenation with `/`.
- No shell strings: `fs.rm({ recursive: true })` instead of `rm -rf`; `execa` with an argument array instead of a composed command string.
- Use `execa`, not `child_process.spawn` — on Windows, `npx` resolves to `npx.cmd`, which bare `spawn` fails to find (`ENOENT`).
- Subprocesses need `stdio: "inherit"`, otherwise an interactive generator like `create-next-app` prompts into nowhere and the program hangs.

## Known gaps / planned work

- **Push credentials are unsolved.** `clone_url` is a bare HTTPS URL with no credentials; Git then prompts interactively for username/password, which just looks like a hang inside the spinner. Remote handling isn't actually finished. Options under consideration: use `ssh_url` instead of `clone_url` (preferred), embed the token in the URL (ends up in plaintext in `.git/config`), or require a credential helper.
- **Token storage** now goes through `conf` (see "Remote repo creation & credentials" above) instead of raw `process.env`. Tokens are still stored in a plaintext JSON config file, not the OS keychain — moving to `keytar` is still open if that matters.
- **Ordering with external generators.** `create-next-app` does its own `git init` + first commit. Planned flow instead: run the generator → overlay project files (`.gitattributes`, CI workflow, editor config) → commit → create remote → push.
- **`.gitignore` in templates can go missing** — npm renames it on publish and some copy tools filter it out. If it disappears unexplainably: name it `gitignore` (no dot) in the template and rename it back after copying in `scaffold()`.
- Root `tsconfig.json` `include` is `["*.ts"]` (root only). If the tool is split into multiple files, change to `["**/*.ts"]` and add `"exclude": ["node_modules", "dist"]`.
- Root `package.json`'s `"main"` still points at `index.ts`; once a build step exists it should point at `dist/index.js`, matching `bin`.

## CI/CD

Deliberately not set up yet — single developer, breakage surfaces immediately on next run, and the project structure still changes daily.

The one thing worth adding once the providers stabilize and the tool is in real use: a matrix over `ubuntu-latest` / `windows-latest` / `macos-latest` running `npm ci`, `npx tsc --noEmit`, and a scaffold run — the only guarantee (cross-platform behavior) that can't be checked locally. Publishing to npm (CD) only matters once the package is meant to be installed globally rather than run from the folder.

## Conventions

- Code comments are written in German.
