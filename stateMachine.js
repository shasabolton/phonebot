class StateMachine {
    /**
     * @param {Robot} robot
     * @param {Array<{ name?: string, path?: string, description?: string }>} config
     */
    constructor(robot, config) {
        this.robot = robot;
        this.config = Array.isArray(config) ? config : [];
    }

    /**
     * @returns {string} Pretty-printed JSON array of { name, description, value }.
     */
    getStateAsJson() {
        const rows = [];
        for (const item of this.config) {
            if (!item || typeof item !== "object") continue;
            const name = String(item.name || "").trim() || "(unnamed)";
            const description = String(item.description || "").trim();
            const path = String(item.path || "").trim();
            const raw = path ? this.robot.readStatePath(path) : undefined;
            const value = raw === undefined ? null : raw;
            rows.push({ name, description, value });
        }
        try {
            return JSON.stringify(rows, null, 2);
        } catch (_) {
            return JSON.stringify(
                rows.map((r) => ({
                    name: r.name,
                    description: r.description,
                    value: r.value != null && typeof r.value === "object" ? "[unserializable]" : r.value
                })),
                null,
                2
            );
        }
    }
}

window.StateMachine = StateMachine;
