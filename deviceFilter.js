/**
 * Normalize ?device= URL values to physical robot ids (robot-XXXXXX / Robot-XXXXXX).
 * Shared by WiFi and Bluetooth transmitters.
 */
const PhonebotDeviceFilter = {
  /** @param {string|null|undefined} raw */
  fromParam(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const m =
      s.match(/^(?:robot-?|Robot-?)([0-9a-fA-F]{6})$/i) ||
      s.match(/^([0-9a-fA-F]{6})$/);
    if (!m) return null;
    const chipId = m[1].toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(chipId)) return null;
    return {
      chipId,
      bleName: "robot-" + chipId.toLowerCase(),
      apSsid: "Robot-" + chipId,
      hostname: "robot-" + chipId.toLowerCase()
    };
  },

  /** @param {object|null|undefined} robot @param {object|null|undefined} filter */
  matchesRobot(robot, filter) {
    if (!filter) return true;
    if (!robot || typeof robot !== "object") return false;
    const chip = String(robot.chipId || "").toUpperCase();
    if (chip && chip === filter.chipId) return true;
    const host = String(robot.hostname || "").toLowerCase();
    if (host && host === filter.hostname) return true;
    const ap = String(robot.apSsid || "");
    if (ap && ap.toUpperCase() === filter.apSsid.toUpperCase()) return true;
    return false;
  },

  /** @param {string} ssid @param {object|null|undefined} filter */
  matchesApSsid(ssid, filter) {
    if (!filter) return true;
    return String(ssid || "").toUpperCase() === filter.apSsid.toUpperCase();
  },

  /** @param {object|null|undefined} filter @param {string} serviceUuid */
  buildBluetoothRequestOptions(filter, serviceUuid) {
    const uuid = String(serviceUuid || "").trim();
    const optionalServices = uuid ? [uuid] : [];
    if (!filter) {
      return {
        filters: uuid ? [{ services: [uuid] }] : [],
        optionalServices
      };
    }
    const filterEntry = { name: filter.bleName };
    if (uuid) filterEntry.services = [uuid];
    return {
      filters: [filterEntry],
      optionalServices
    };
  }
};
