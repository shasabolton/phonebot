class Sensor {
    constructor(config) {
        this.type = config?.type || "sensor";
        this.name = config?.name || this.type;
        this.gui = null;
    }

    /**
     * @param {HTMLElement} container
     */
    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "sensor";
        const title = document.createElement("h4");
        title.textContent = this.name;
        wrap.appendChild(title);
        container.appendChild(wrap);
        this.gui = wrap;
    }

    destroy() {}
}
