#!/usr/bin/env node
// Kleine CalVer-Helfer fuer die Release-Actions, ohne Abhaengigkeiten.
// Schema: JJJJ.M.patch (Monat OHNE fuehrende Null, sonst ist es kein
// gueltiges SemVer und npm publish lehnt die Version ab).
//
//   node calver.mjs latest [prefix]        -> hoechste Tag-Version, z.B. 2026.10.2 (Standard-Prefix "V")
//   node calver.mjs next <version> [datum] -> naechste Version fuer heute (oder datum, JJJJ-MM-TT)
//   node calver.mjs gt <a> <b>             -> "true", wenn a > b
//
// Regel fuer "next": Liegt die letzte Version im aktuellen Jahr+Monat, wird
// patch hochgezaehlt, sonst geht es mit JJJJ.M.0 los. Tags, die nicht ins
// Schema major.minor.patch passen (z.B. "1.0.0" ohne Prefix), werden bei
// "latest" ignoriert. Alte SemVer-Tags wie V1.1.4 stoeren nicht, weil sie
// numerisch immer kleiner sind als jede CalVer-Version.

import { execFileSync } from "node:child_process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parse(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`Ungueltige Version: "${version}" (erwartet major.minor.patch ohne fuehrende Nullen)`);
  }
  return match.slice(1).map(Number);
}

function compare(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function latest(prefix) {
  const versions = execFileSync("git", ["tag", "--list", `${prefix}*`], { encoding: "utf8" })
    .split("\n")
    .map((tag) => tag.trim().slice(prefix.length))
    .filter((version) => VERSION_PATTERN.test(version));
  return versions.sort(compare).at(-1) ?? "0.0.0";
}

function today(dateArg) {
  if (dateArg) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(dateArg);
    if (!match) throw new Error(`Ungueltiges Datum: "${dateArg}" (erwartet JJJJ-MM-TT)`);
    return [Number(match[1]), Number(match[2])];
  }
  // Lokale Zeit des Runners; die Action setzt TZ, damit der Monatswechsel
  // nicht um Mitternacht UTC, sondern zur eigenen Zeitzone passiert.
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1];
}

function next(previous, dateArg) {
  const [year, month] = today(dateArg);
  const [prevYear, prevMonth, prevPatch] = parse(previous);
  const candidate =
    prevYear === year && prevMonth === month
      ? `${year}.${month}.${prevPatch + 1}`
      : `${year}.${month}.0`;

  // Schutz gegen Zeitreisen (falsche Uhr, Tag aus der "Zukunft"): niemals
  // eine Version erzeugen, die nicht hoeher ist als die letzte.
  if (compare(candidate, previous) <= 0) {
    throw new Error(`Berechnete Version ${candidate} ist nicht hoeher als der letzte Tag ${previous}.`);
  }
  return candidate;
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "latest":
      console.log(latest(args[0] ?? "V"));
      break;
    case "next":
      console.log(next(args[0], args[1]));
      break;
    case "gt":
      console.log(String(compare(args[0], args[1]) > 0));
      break;
    default:
      throw new Error(`Unbekannter Befehl: "${command}" (latest | next | gt)`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
