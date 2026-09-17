# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal, cross-platform (Windows + macOS) CLI tool (`project-cli`) that scaffolds new projects: generate a base project, init git, optionally create a remote repo on GitHub or Gitea, and push. The entire tool is a single file, `index.ts`.

Chosen stack: TypeScript + Node (not Go) — matches the developer's existing strength. Distribution is planned via `npm i -g`, not as a compiled binary.

## Commands

There is no lint or test tooling configured yet — `package.json`'s `test` script is a stub (`exit 1`).

Run the CLI during development via Node's native TypeScript execution (Node 26+, strip-only mode) — this is a deliberate choice, not just "no build step yet":
```
node index.ts [name] [--private]
```
`tsx` is present as a devDependency but is **not** the intended runner — it was dropped in favor of native execution after `tsx`/`esbuild` produced `ERR_PACKAGE_PATH_NOT_EXPORTED` (via execa's `unicorn-magic` dependency) during setup. One fewer dependency, one fewer failure mode.

For the real distribution path (`bin` → `./dist/index.js`, `npm i -g .`), there's now a build script:
```
npm run build
```
This runs `tsc` (outputs to `dist/`, `outDir` in `tsconfig.json`) and then `scripts/copy-templates.mjs`, which copies `templates/` to `dist/templates/` — `scaffold()` resolves the template folder relative to `import.meta.dirname` (the running file's own directory), so templates must live alongside whatever `index.js` actually gets executed, not just at the project root. Verified end-to-end: `npm run build && npm i -g .` then running the installed `project-cli` from an unrelated directory correctly finds and copies templates.

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

Section 2b (`resolveGitHubToken()` / `resolveGiteaCredentials()`) resolves credentials in this order: env var (`GITHUB_TOKEN`, `GITEA_URL`/`GITEA_TOKEN`) → stored value → interactive prompt (via `p.password`/`p.text`), and persists whatever was prompted for next time. The two kinds of stored value use different storage:
- **Secrets** (`github-token`, `gitea-token`) go through `@napi-rs/keyring`'s `Entry` (`getStoredSecret()`/`setStoredSecret()`, service name `"project-cli"`) — the OS-native credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service/libsecret via a prebuilt native binding, no compile step). Verified on Windows: set/get/delete round-trips correctly, and a token entered once is reused silently on the next run without re-prompting.
- **Non-secret config** (`giteaUrl`) stays in `conf` (`new Conf({ projectName: "project-cli" })` — resolves to `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, XDG paths on Linux), a plaintext JSON file — fine since it's not sensitive.

Credentials are always resolved *before* the "Remote wird angelegt" spinner starts — an interactive prompt while a spinner is running would visually collide.

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
- **`initGit()` must call `git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)`, not the argument-less default.** The default checks "is targetDir inside *any* git working tree" (`git rev-parse --is-inside-work-tree`), which is also true when targetDir merely sits inside an unrelated ancestor repo (e.g. running the CLI from inside its own `project-cli` checkout). That skips `git init()` and runs `add`/`commit`/`addRemote` against the wrong (parent) repo — happened for real during manual testing, see commit `47ae16b`.
- **Template path (`path.join(import.meta.dirname, "templates", stack.template)`) resolves relative to the running file, not the project root or `cwd`.** That's why `npm run build` copies `templates/` into `dist/templates/` — without it, the globally-installed CLI would look for templates next to `dist/index.js` and find nothing.
- **`res.json()` is `unknown`** — always cast (e.g. `as { clone_url: string }`); there's no runtime validation yet.
- **A template file literally named `.gitignore` disappears from every `npm pack`/`publish` tarball**, no matter its path — npm strips any file with that exact name by default. Templates that need one (e.g. `templates/esp32`) store it as `gitignore` (no dot); `scaffold()`'s `restoreGitignore()` renames it to `.gitignore` in the freshly copied target directory. Confirmed by reproducing it live: `npm pack` on this repo silently dropped `templates/esp32/.gitignore` before this fix existed.
- **`package.json` needs an explicit `"files": ["dist"]`.** Without it, `npm pack` falls back to the root `.gitignore` for inclusion decisions — which is a generic Node boilerplate list, not a package manifest, and doesn't know about e.g. a stray local test-scaffold directory sitting in the repo. That leaked a whole throwaway project into a real pack output during testing. `scripts/copy-templates.mjs` also wipes `dist/templates` before copying, otherwise stale files from a previous build (e.g. an old `.gitignore` before the rename above) linger alongside the new ones.

## Platform rules

- Always build paths with `path.join()`/`path.resolve()`, never string concatenation with `/`.
- No shell strings: `fs.rm({ recursive: true })` instead of `rm -rf`; `execa` with an argument array instead of a composed command string.
- Use `execa`, not `child_process.spawn` — on Windows, `npx` resolves to `npx.cmd`, which bare `spawn` fails to find (`ENOENT`).
- Subprocesses need `stdio: "inherit"`, otherwise an interactive generator like `create-next-app` prompts into nowhere and the program hangs.

## Known gaps / planned work

- **Push credentials are unsolved.** `clone_url` is a bare HTTPS URL with no credentials; Git then prompts interactively for username/password, which just looks like a hang inside the spinner. Remote handling isn't actually finished. Options under consideration: use `ssh_url` instead of `clone_url` (preferred), embed the token in the URL (ends up in plaintext in `.git/config`), or require a credential helper. (Live-tested manually with real PATs entered via env var — both GitHub and Gitea create+push worked; the interactive-prompt-into-a-hang scenario just hasn't been hit yet.)
- **Ordering with external generators.** `create-next-app` does its own `git init` + first commit. Planned flow instead: run the generator → overlay project files (`.gitattributes`, CI workflow, editor config) → commit → create remote → push.
- Root `tsconfig.json` `include` is `["*.ts"]` (root only). If the tool is split into multiple files, change to `["**/*.ts"]` and add `"exclude": ["node_modules", "dist"]`. (`scripts/copy-templates.mjs` is deliberately plain `.mjs`, not part of this — it's a build helper, not source to typecheck.)

## CI/CD

`.github/workflows/ci.yaml` runs on push to `master` and on PRs: a matrix over `ubuntu-latest`/`windows-latest`/`macos-latest` running `npm ci`, `npx tsc --noEmit`, `npm run build`, then `scripts/ci-smoke-test.mjs` — scaffolds a `ts-lib` and an `esp32` project against the *built* `dist/index.js` (not `index.ts`, to actually exercise the packaging path) and asserts exit code, `{{projectName}}` substitution, git init, and the `gitignore` → `.gitignore` rename. This is the only thing that reliably catches cross-platform breakage and packaging regressions (both the `dist/templates` staleness bug and the `.gitignore`-stripping bug were found by testing this exact path manually before the CI existed).

`.github/workflows/publish.yaml` runs on every GitHub Release (`types: [published]`) and dual-publishes the built package: `project-cli` to npmjs.com (anonymous `npm i -g project-cli`, no auth needed to install; publish auth via repo secret `NPM_TOKEN`, an npm Automation Token) and, in a separate parallel job, `@robin1053/project-cli` to GitHub Packages (auth via the built-in `GITHUB_TOKEN`, needs `permissions: packages: write`) purely so the repo's GitHub sidebar shows a Packages widget — installing from GitHub Packages requires a PAT even for public packages, so npmjs.com stays the actual distribution channel. The GitHub Packages job renames the package via `npm pkg set name="@robin1053/project-cli"` in the runner's checkout only; the committed `package.json` keeps the unscoped `project-cli` name.

## Conventions

- Code comments are written in German.
