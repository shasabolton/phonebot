/**
 * Flash a blank ESP32-S3 or classic ESP32 over USB from the browser.
 * Images are the Arduino build outputs already in espBootstrapEsp32/build/.
 * esptool-js 0.7.1 (Apache-2.0) is loaded from vendor/esptool-js/bundle.js.
 */
const PhonebotUsbFlash = {
  _busy: false,

  boards: {
    s3: {
      label: "ESP32-S3",
      zipName: "phonebot-esp32-s3.zip",
      flashSize: "16MB",
      dir: "espBootstrapEsp32/build/esp32.esp32.esp32s3/",
      readme:
        "Phonebot firmware for the ESP32-S3.\n\n" +
        "Arduino IDE\n" +
        "Open espBootstrapEsp32.ino. Install the ESP32 boards package, then set:\n" +
        "  Board: ESP32S3 Dev Module\n" +
        "  USB CDC On Boot: Enabled\n" +
        "  Flash Size: 16MB\n" +
        "  Partition Scheme: Minimal SPIFFS (1.9MB APP with OTA/128KB SPIFFS), or Custom to use partitions.csv\n" +
        "  PSRAM: Disabled\n" +
        "Upload compiles this sketch. It does not flash the files in build/.\n\n" +
        "esptool\n" +
        "The build folder is a ready-to-flash image. Offsets and flash settings are in build/flash_args.\n",
      parts: [
        { address: 0x0, file: "espBootstrapEsp32.ino.bootloader.bin" },
        { address: 0x8000, file: "espBootstrapEsp32.ino.partitions.bin" },
        { address: 0xe000, file: "boot_app0.bin" },
        { address: 0x10000, file: "espBootstrapEsp32.ino.bin" }
      ]
    },
    classic: {
      label: "ESP32",
      zipName: "phonebot-esp32.zip",
      flashSize: "4MB",
      dir: "espBootstrapEsp32/build/esp32.esp32.esp32/",
      readme:
        "Phonebot firmware for the classic ESP32.\n\n" +
        "Arduino IDE\n" +
        "Open espBootstrapEsp32.ino. Install the ESP32 boards package, then set:\n" +
        "  Board: ESP32 Dev Module\n" +
        "  Flash Size: 4MB\n" +
        "  Partition Scheme: Minimal SPIFFS (1.9MB APP with OTA/128KB SPIFFS), or Custom to use partitions.csv\n" +
        "Upload compiles this sketch. It does not flash the files in build/.\n\n" +
        "esptool\n" +
        "The build folder is a ready-to-flash image. Offsets and flash settings are in build/flash_args.\n",
      parts: [
        { address: 0x1000, file: "espBootstrapEsp32.ino.bootloader.bin" },
        { address: 0x8000, file: "espBootstrapEsp32.ino.partitions.bin" },
        { address: 0xe000, file: "boot_app0.bin" },
        { address: 0x10000, file: "espBootstrapEsp32.ino.bin" }
      ]
    }
  },

  sketchFiles: [
    "espBootstrapEsp32/espBootstrapEsp32.ino",
    "espBootstrapEsp32/phonebotProcess.h",
    "espBootstrapEsp32/partitions.csv"
  ],

  /** @param {string} path */
  async fetchBytes(path) {
    const res = await fetch(new URL(path, window.location.href).href, { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load " + path);
    return new Uint8Array(await res.arrayBuffer());
  },

  /**
   * Sketch plus this board's flash image, as a zip the browser downloads.
   * @param {object} board
   * @returns {Promise<Blob>}
   */
  async firmwareZip(board) {
    if (typeof PhonebotZip === "undefined") throw new Error("Zip support is not loaded.");
    const entries = [];
    for (let i = 0; i < this.sketchFiles.length; i++) {
      const path = this.sketchFiles[i];
      const name = path.slice(path.lastIndexOf("/") + 1);
      entries.push({
        path: "espBootstrapEsp32/" + name,
        data: await this.fetchBytes(path)
      });
    }
    entries.push({ path: "espBootstrapEsp32/README.txt", data: board.readme });
    for (let i = 0; i < board.parts.length; i++) {
      const part = board.parts[i];
      entries.push({
        path: "espBootstrapEsp32/build/" + part.file,
        data: await this.fetchBytes(board.dir + part.file)
      });
    }
    entries.push({
      path: "espBootstrapEsp32/build/flash_args",
      data: await this.fetchBytes(board.dir + "flash_args")
    });
    return PhonebotZip.create(entries);
  },

  /** @param {object} board */
  async download(board) {
    const blob = await this.firmwareZip(board);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = board.zipName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  },

  /** @param {string} description Chip string from ESPLoader.main(). */
  boardForChip(description) {
    const name = String(description || "");
    if (name.includes("ESP32-S3")) return this.boards.s3;
    if (/ESP32-(S2|C2|C3|C5|C6|C61|H2|P4)/.test(name)) return null;
    if (name.includes("ESP8266") || name.includes("ESP8285")) return null;
    if (name.includes("ESP32")) return this.boards.classic;
    return null;
  },

  bundleUrl() {
    const scripts = document.getElementsByTagName("script");
    for (let i = 0; i < scripts.length; i++) {
      const src = scripts[i].src || "";
      if (src.endsWith("/firmwareFlash.js")) {
        return new URL("vendor/esptool-js/bundle.js", src).href;
      }
    }
    return new URL("vendor/esptool-js/bundle.js", window.location.href).href;
  },

  async loadImage(board, part) {
    const url = new URL(board.dir + part.file, window.location.href).href;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Could not load " + part.file + " for " + board.label + ".");
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength < 16) {
      throw new Error(part.file + " for " + board.label + " is empty.");
    }
    return { data, address: part.address };
  },

  async latestVersion() {
    try {
      const res = await fetch(new URL("version.json", window.location.href).href, {
        cache: "no-store"
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json.fwVersion != null ? String(json.fwVersion) : null;
    } catch (e) {
      return null;
    }
  },

  /**
   * @param {(state: { phase: string, text: string, board?: string }) => void} onStatus
   */
  async flash(onStatus) {
    if (this._busy) return;
    if (!window.isSecureContext || !navigator.serial || typeof navigator.serial.requestPort !== "function") {
      throw new Error("USB flashing needs Chrome or Edge on HTTPS or localhost.");
    }
    this._busy = true;
    let transport = null;
    try {
      onStatus({ phase: "searching", text: "Searching…" });
      const port = await navigator.serial.requestPort();
      const tool = await import(this.bundleUrl());
      transport = new tool.Transport(port, false);
      const loader = new tool.ESPLoader({
        transport,
        baudrate: 115200,
        romBaudrate: 115200,
        terminal: {
          clean() {},
          writeLine() {},
          write() {}
        }
      });

      let description;
      try {
        description = await loader.main();
      } catch (e) {
        const detail = e && e.message ? e.message : "Could not connect.";
        throw new Error(
          "Hold down the boot button on the board while you pulse the reset button, then click Done. " +
            detail
        );
      }

      const board = this.boardForChip(description);
      if (!board) {
        throw new Error(
          "Found " +
            (description || "an unsupported chip") +
            ". This page flashes ESP32-S3 and ESP32."
        );
      }
      onStatus({
        phase: "found",
        text: "Found " + board.label,
        board: board.label
      });

      const fileArray = [];
      for (let i = 0; i < board.parts.length; i++) {
        fileArray.push(await this.loadImage(board, board.parts[i]));
      }

      onStatus({ phase: "flashing", text: "Flashing…", board: board.label });
      let lastPercent = -1;
      await loader.writeFlash({
        fileArray,
        flashMode: "dio",
        flashFreq: "80m",
        flashSize: board.flashSize,
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const fileCount = fileArray.length;
          const fraction = total > 0 ? written / total : 0;
          const percent = Math.floor(((fileIndex + fraction) / fileCount) * 100);
          if (percent === lastPercent) return;
          lastPercent = percent;
          onStatus({
            phase: "flashing",
            text: "Flashing… " + percent + "%",
            board: board.label
          });
        }
      });

      try {
        await loader.after("hard_reset");
      } catch (e) {}

      const version = await this.latestVersion();
      onStatus({
        phase: "done",
        text: version ? "Up to date, version " + version : "Up to date",
        board: board.label
      });
    } finally {
      this._busy = false;
      if (transport) {
        try {
          await transport.disconnect();
        } catch (e) {}
      }
    }
  }
};
