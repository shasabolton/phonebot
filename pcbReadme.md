# ESP32-S3 Servo Controller PCB — Agent Handoff

## Goal
Custom PCB: phone controls board over **BLE from a browser (Web Bluetooth)**, ESP32 drives **6–8 hobby servos**. Design in **EasyEDA Pro**, manufacture/assemble at **JLCPCB**.

## MCU
- **ESP32-S3-WROOM-1-N16R2** — LCSC **C2913205**
- 16 MB flash + 2 MB PSRAM, onboard antenna
- Prefer S3 over classic ESP32-WROOM-32E: Web Bluetooth = **BLE only** (no Classic BT needed)
- Arduino: board ESP32S3, flash **16 MB**; PSRAM optional (enable only if used)

## Why not WROOM-32E
Old board used ESP32-WROOM-32E (**no PSRAM**). S3 is fine for in-browser BLE. Classic BT is irrelevant for Web Bluetooth.

## Power architecture
```
USB-C 5V → Schottky → 5V rail
                ├─► servo headers (+ 220µF bulk at headers)
                └─► ME6211 LDO → 3V3 → ESP32 + LED
```
- Servos on **5V**, never on 3V3
- LDO chosen for possible future **3.7 V LiPo** (low dropout). AMS1117 is **not** OK for LiPo.

## Key parts (LCSC / JLCPCB)
| Function | MPN / notes | C-number | Tier |
|----------|-------------|----------|------|
| ESP32-S3 module | ESP32-S3-WROOM-1-N16R2 | C2913205 | check stock |
| USB-C | TYPE-C-31-M-12 | C165948 | Extended |
| USB ESD | USBLC6-2SC6 | C7519 (or equiv.) | Extended |
| VBUS Schottky | 1N5819HW-7-F | C82544 | Extended |
| LDO 5V→3.3V | ME6211C33M5G-N | C82942 | Extended |
| 10µF 25V 0603 | CL10A106MA8NRNC | C96446 | Basic |
| 100nF 50V 0603 | CC0603KRX7R9BB104 | C14663 | Basic |
| 1µF 50V 0603 (EN) | CL10A105KB8NNNC | C15849 | Basic |
| 5.1k 0603 | 0603WAF5101T5E | C23186 | Basic |
| 10k 0603 | 0603WAF1002T5E | C25804 | Basic |
| 330Ω 0603 (servo series) | 0603WAF3300T5E | C23138 | Basic |
| Red LED 0603 | KT-0603R | C2286 | Basic |
| Tactile switch | TS-1187… SMD 5.1×5.1 | e.g. C318884 / similar | Extended |
| Servo header | 2.54 1×3 male **TH** | C49257 | TH (not SMT cluster) |
| Servo bulk | VZH221M1CTT-0607L 220µF 16V SMD Ø6.3 | C7442652 | Extended |

## Circuits (reviewed OK)

### ESP module
- 3V3: **10µF + 100nF** at module
- **EN:** 10k pull-up to 3V3, **1µF** to GND, reset button EN→GND
- **IO0:** boot button IO0→GND only; use **0.1µF max** across button (not 1µF — slows strapping)
- USB: **IO19=D−, IO20=D+**
- Servos: **IO1–IO8** → SERVO1–8 (via 330Ω at ESP)

### USB-C
- CC1 & CC2: **5.1k → GND**
- USBLC6 on D+/D−; VBUS pin on connector VBUS
- 1N5819: VBUS → anode, cathode → **5V** board rail
- 10µF on 5V after Schottky
- Shell/EH pads → GND on PCB

### LDO (ME6211)
- VIN=5V, VOUT=3V3, VSS=GND
- **CE → 5V** (active high), **NC** open
- 10µF+100nF on VIN and VOUT **next to chip**
- Power LED: 3V3 → 5.1k → red LED → GND (dim; 1k if brighter)

### Servos
- 8× **1×3 TH** headers with gaps (not 3×8 SMT cluster)
- Pin order: **GND | 5V | Signal** (silk: `−` `+` `S`)
- At header cluster: **220µF electrolytic + 100nF**
- USB-side 10µF stays at USB; **no second 10µF required** at headers if 220µF is there
- 330Ω series on each signal **at ESP** (optional protection; OK at headers too)

## Design rules / notes
- EasyEDA: use **net labels** for SERVO1…8 etc.; ports only for cross-sheet
- Prefer **explanatory names** (SERVO1) not GPIO#
- JLCPCB: Basic vs Extended only clear on **jlcpcb.com/parts**; Extended ≈ **$3 per unique part type per order**, not per board
- TH headers add ~$3.50/order + ~$0.017/pin — small vs full SMT
- Web Bluetooth: works on **Android Chrome**; **not Safari iOS**
- Antenna keep-out on PCB under module antenna end
- Do not power servos from 3.3V; budget USB current for 6–8 servos

## Avoid / don’t use for GPIO
- GPIO0, 45, 46 (strapping)
- GPIO19/20 if used for USB
- GPIO43/44 if using UART0
- GPIO22–25 don’t exist; GPIO26–34 not on WROOM-1

## Status
- Schematics for ESP, USB, LDO, servos **reviewed and OK** (fix IO0 cap if still 1µF → 0.1µF or none)
- Next: **PCB layout**, silk labels, DRC, Gerber/BOM/CPL for JLCPCB

## Open / optional later
- Battery / charge path for 3.7V LiPo
- Brighter LED resistor
- iOS needs native app (no Web Bluetooth in Safari)