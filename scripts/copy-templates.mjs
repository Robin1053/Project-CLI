// Kopiert templates/ neben dist/index.js, weil scaffold() den Ordner relativ
// zu import.meta.dirname sucht (also dort, wo die laufende Datei liegt).
import fs from "node:fs";

fs.cpSync("templates", "dist/templates", { recursive: true });
