// Kopiert templates/ neben dist/index.js, weil scaffold() den Ordner relativ
// zu import.meta.dirname sucht (also dort, wo die laufende Datei liegt).
import fs from "node:fs";

// Erst löschen, sonst bleiben Dateien aus früheren Builds liegen, die es im
// Quellordner nicht mehr gibt (cpSync überschreibt nur, räumt nicht auf).
fs.rmSync("dist/templates", { recursive: true, force: true });
fs.cpSync("templates", "dist/templates", { recursive: true });
