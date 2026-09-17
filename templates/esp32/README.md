# {{projectName}}

PlatformIO-Projekt für ESP32 (Arduino-Framework).

## Setup

1. [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation/index.html) installieren.
2. Board per USB anschließen.

## Bauen & Flashen

Über project-cli (im Projektordner ausgeführt):

    node <pfad-zu-project-cli>/index.ts build [env]
    node <pfad-zu-project-cli>/index.ts upload [env]
    node <pfad-zu-project-cli>/index.ts add-board

`env` ist optional — ohne Angabe wird interaktiv aus den in `platformio.ini`
definierten `[env:...]`-Sektionen ausgewählt.

Oder direkt über PlatformIO:

    pio run -e esp32dev
    pio run -e esp32dev -t upload
    pio device monitor

## Boards

Vordefiniert: `esp32dev`, `featheresp32`, `adafruit_feather_esp32s2`.
Weitere über `add-board` oder manuell in `platformio.ini` ergänzen.
