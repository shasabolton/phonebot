//check network conection to robot

class App {
    constructor() {
        this.robot = null;
        this.robotGuiMount = null;
        this.dashboardMount = null;
        this.robotListEl = null;
        this.robotsData = null;
        this.transmitters = ["none", "wifi", "bluetooth", "serial", "audio", "screen light"];
        this.transmitterListEl = null;
        this.transmitterGuiMount = null;
        this.transmitterInstance = null;
        this.runToggle = null;
        this._runToggleBusy = false;
        this.loopIntervalId = null;
        this.actionTick = 0;
        this._settingsStack = [];
        this._settingsOpen = false;
        this._settingsPages = null;
        this._applyingUrl = false;
        this._refreshDeviceFilterFromUrl();
        this.buildGUI();
    }

    /** Stable query value for a robot name (`talking head` → `talking-head`). */
    robotSlug(name) {
        return String(name || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    }

    findRobotIndexByParam(param) {
        const robots = this.robotsData?.robots;
        if (!robots?.length || param == null) return -1;
        const raw = String(param).trim();
        if (!raw) return -1;
        if (/^\d+$/.test(raw)) {
            const idx = Number(raw);
            return idx >= 0 && idx < robots.length ? idx : -1;
        }
        const wantSlug = this.robotSlug(raw);
        const wantName = raw.toLowerCase();
        for (let i = 0; i < robots.length; i++) {
            const name = String(robots[i]?.name || "");
            if (name.toLowerCase() === wantName) return i;
            if (this.robotSlug(name) === wantSlug) return i;
        }
        return -1;
    }

    readUrlSelection() {
        const params = new URLSearchParams(window.location.search);
        const robot = params.get("robot");
        const mode = params.get("mode");
        const device = params.get("device");
        return {
            robot: robot != null && String(robot).trim() ? String(robot).trim() : null,
            mode: mode != null && String(mode).trim() ? String(mode).trim() : null,
            device: device != null && String(device).trim() ? String(device).trim() : null
        };
    }

    /** Physical robot id from ?device= (robot-XXXXXX), or null for all devices. */
    getDeviceFilter() {
        return this.deviceFilter || null;
    }

    _refreshDeviceFilterFromUrl() {
        const { device } = this.readUrlSelection();
        this.deviceFilter =
            typeof PhonebotDeviceFilter !== "undefined"
                ? PhonebotDeviceFilter.fromParam(device)
                : null;
    }

    _getTransmitterOptions() {
        return { deviceFilter: this.getDeviceFilter() };
    }

    _applyDeviceFilterToTransmitter() {
        const filter = this.getDeviceFilter();
        const tx = this.transmitterInstance;
        if (!tx || typeof tx.setDeviceFilter !== "function") return;
        tx.setDeviceFilter(filter);
    }

    syncUrlParams() {
        if (this._applyingUrl) return;
        const url = new URL(window.location.href);
        if (this.robot?.name) {
            url.searchParams.set("robot", this.robotSlug(this.robot.name));
            if (this.robot.mode) url.searchParams.set("mode", String(this.robot.mode));
            else url.searchParams.delete("mode");
        } else {
            url.searchParams.delete("robot");
            url.searchParams.delete("mode");
        }
        const next = `${url.pathname}${url.search}${url.hash}`;
        const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (next !== cur) {
            history.replaceState(null, "", next);
        }
    }

    applyUrlSelection() {
        if (!this.robotsData?.robots?.length || !this.robotListEl) return;
        if (this._applyingUrl) return;
        this._applyingUrl = true;
        try {
            this._refreshDeviceFilterFromUrl();
            const { robot: robotParam, mode: modeParam } = this.readUrlSelection();
            if (!robotParam) {
                if (this.robotListEl.value !== "") {
                    this.robotListEl.value = "";
                    this.setRobot(null, { skipUrlSync: true });
                }
                return;
            }
            const idx = this.findRobotIndexByParam(robotParam);
            if (idx < 0) {
                console.warn("URL robot not found:", robotParam);
                return;
            }
            const config = this.robotsData.robots[idx];
            const sameRobot =
                this.robot &&
                this.robotSlug(this.robot.name) === this.robotSlug(config?.name);
            if (!sameRobot) {
                this.robotListEl.value = String(idx);
                this.setRobot(config, { mode: modeParam, skipUrlSync: true });
            } else if (modeParam && this.robot && this.robot.mode !== modeParam) {
                this.robot.setMode(modeParam);
            }
            this.syncUrlParams();
            this._applyDeviceFilterToTransmitter();
        } finally {
            this._applyingUrl = false;
        }
    }

    setRobot(robotConfig, options = {}) {
        if (!this.robotGuiMount || !this.dashboardMount) return;
        if (this.robot && typeof this.robot.destroy === 'function') {
            this.robot.destroy();
        }
        this.robotGuiMount.innerHTML = '';
        this.dashboardMount.innerHTML = '';
        if (!robotConfig) {
            this.robot = null;
            this.robotGuiMount.style.display = 'none';
            this._renderEmptyDashboard();
            this.updateStartButtonState();
            this._refreshSettingsMenu();
            if (!options.skipUrlSync) this.syncUrlParams();
            return;
        }
        this.robotGuiMount.style.display = '';
        this.robot = new Robot(this.robotGuiMount, robotConfig, {
            dashboardContainer: this.dashboardMount,
            initialMode: options.mode,
            onModeChange: () => {
                if (!this._applyingUrl) this.syncUrlParams();
            },
            onRequestStart: () => this.requestStartFromFlow(),
            onStartFlowAction: (action, step) => this.handleStartFlowAction(action, step),
            startFlowShouldSkipStep: (step) => this.startFlowShouldSkipStep(step)
        });
        const deferScreenLight = !!robotConfig?.startFlow?.deferScreenLight;
        if (!deferScreenLight) {
            void this.preferScreenLightIfNoWifi();
        }
        this.updateStartButtonState();
        this._refreshSettingsMenu();
        if (!options.skipUrlSync) this.syncUrlParams();
    }

    /** Used by robot start-flow overlays after the user confirms setup steps. */
    async requestStartFromFlow() {
        await this.preferScreenLightIfNoWifi();
        if (this.isRunLoopActive()) return;
        await this.onStart();
    }

    getTransmitterKind() {
        return String(this.transmitterListEl?.value || "").trim();
    }

    isTransmitterReady() {
        const tx = this.transmitterInstance;
        return !!(tx && typeof tx.isReady === "function" && tx.isReady());
    }

    isWifiConnected() {
        return this.getTransmitterKind() === "wifi" && this.isTransmitterReady();
    }

    isBluetoothConnected() {
        return this.getTransmitterKind() === "bluetooth" && this.isTransmitterReady();
    }

    /** True when WiFi or Bluetooth is the active, ready link (skip optical brightness setup). */
    isRadioTransmitterReady() {
        return this.isWifiConnected() || this.isBluetoothConnected();
    }

    startFlowShouldSkipStep(step) {
        const skipWhen = String(step?.skipWhen || "").trim();
        if (skipWhen === "radioReady") {
            return this.isRadioTransmitterReady();
        }
        if (skipWhen === "notRadioReady") {
            return !this.isRadioTransmitterReady();
        }
        return false;
    }

    selectTransmitter(kind) {
        if (!this.transmitterListEl) return;
        const want = String(kind || "").trim();
        if (!want) return;
        if (this.transmitterListEl.value !== want) {
            this.transmitterListEl.value = want;
            this.onTransmitterSelect();
        } else if (!this.transmitterInstance) {
            this.onTransmitterSelect();
        }
    }

    async handleStartFlowAction(action) {
        if (action === "bluetoothPair") {
            return this.pairBluetoothFromStartFlow();
        }
        return true;
    }

    /** Pair via Web Bluetooth picker only — does not open the transmitter settings menu. */
    async pairBluetoothFromStartFlow() {
        if (this.isRadioTransmitterReady()) return true;
        this.selectTransmitter("bluetooth");
        const tx = this.transmitterInstance;
        if (!tx || typeof tx.connect !== "function") return false;
        await tx.connect();
        this.updateStartButtonState();
        return this.isBluetoothConnected();
    }

    /** When a robot is chosen and station WiFi/Bluetooth is not ready, default transmitter to screen light. */
    async preferScreenLightIfNoWifi() {
        if (!this.transmitterListEl) return;
        const robotStillSelected = !!this.robot;
        if (!robotStillSelected) return;

        if (this.transmitterListEl.value === "wifi" && this.transmitterInstance) {
            const wifiTx = this.transmitterInstance;
            if (typeof wifiTx.waitForDetectMode === "function") {
                await wifiTx.waitForDetectMode();
            }
            if (!this.robot) return;
            if (this.transmitterInstance !== wifiTx) return;
            if (typeof wifiTx.isReady === "function" && wifiTx.isReady()) return;
        } else if (this.isWifiConnected()) {
            return;
        } else if (this.isBluetoothConnected()) {
            return;
        }

        if (!this.robot) return;
        if (this.transmitterListEl.value === "screen light") return;
        this.transmitterListEl.value = "screen light";
        this.onTransmitterSelect();
    }

    _renderEmptyDashboard() {
        if (!this.dashboardMount) return;
        this.dashboardMount.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'robot-dashboard robot-dashboard--empty';
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'Choose a robot from the menu to open its dashboard.';
        empty.appendChild(p);
        this.dashboardMount.appendChild(empty);
    }

    async transmitPinSetup() {
        if (!this.transmitterInstance || !this.robot) return { ok: false, body: 'Missing robot or transmitter.' };
        return this.transmitterInstance.transmitPinSetup(this.robot.buildPinSetupMessage());
    }

    startLoop() {
        if (this.loopIntervalId) return;
        this.loopIntervalId = setInterval(() => {
            this.transmitActionsMessage();
        }, 100);
    }

    stopLoop() {
        if (this.loopIntervalId) {
            clearInterval(this.loopIntervalId);
            this.loopIntervalId = null;
        }
    }

    transmitActionsMessage() {
        if (!this.transmitterInstance || !this.robot) return;
        const message = this.robot.buildActionsMessage();
        this.transmitterInstance.transmitAction(message).then((res) => {
            this.actionTick += 1;
            if (!res.ok) {
                console.warn('Action failed:', res.body || 'unknown error');
            }
        });
    }

    setControlStatus(_text, _cls = 'muted') {
        // Status blurb removed from UI; kept as a no-op for call sites.
    }

    isRunLoopActive() {
        return !!this.loopIntervalId;
    }

    syncRunToggle() {
        const toggle = this.runToggle;
        if (!toggle) return;
        const transmitterReady = !!(
            this.transmitterInstance &&
            this.transmitterInstance.isReady &&
            this.transmitterInstance.isReady()
        );
        const hasRobot = !!this.robot;
        const running = this.isRunLoopActive();
        const canStart = transmitterReady && hasRobot;
        toggle.disabled = this._runToggleBusy || (!running && !canStart);
        toggle.setAttribute('aria-checked', running ? 'true' : 'false');
        toggle.classList.toggle('is-on', running);
        toggle.classList.toggle('is-busy', !!this._runToggleBusy);
        toggle.title = running
            ? 'Transmit loop on — tap to stop'
            : canStart
              ? 'Transmit loop off — tap to start'
              : 'Select robot and ready transmitter to start';
    }

    updateStartButtonState() {
        this.syncRunToggle();
    }

    async onStop() {
        this.stopLoop();
        this._runToggleBusy = false;

        let restorePids = null;
        if (this.robot && typeof this.robot.syncActuatorsToHomeForTransmit === 'function') {
            this._runToggleBusy = true;
            this.syncRunToggle();
            const { message, restorePids: restore } = this.robot.syncActuatorsToHomeForTransmit();
            restorePids = restore;
            try {
                if (
                    message &&
                    this.transmitterInstance &&
                    typeof this.transmitterInstance.transmitAction === 'function'
                ) {
                    await this.transmitterInstance.transmitAction(message);
                }
            } catch (err) {
                console.error('onStop home transmit', err);
            } finally {
                if (typeof restorePids === 'function') restorePids();
                this._runToggleBusy = false;
            }
        }

        this.syncRunToggle();
    }

    async onStart() {
        if (this._runToggleBusy || this.isRunLoopActive()) return;
        this.updateStartButtonState();
        const transmitterReady = !!(
            this.transmitterInstance &&
            this.transmitterInstance.isReady &&
            this.transmitterInstance.isReady()
        );
        if (!transmitterReady || !this.robot) return;

        this._runToggleBusy = true;
        this.syncRunToggle();
        try {
            const setupRes = await this.transmitPinSetup();
            if (!setupRes.ok) {
                console.error('Pin setup failed:', setupRes.body || setupRes.status);
                return;
            }
            this.actionTick = 0;
            this.startLoop();
        } catch (err) {
            console.error('Failed to start robot loop', err);
        } finally {
            this._runToggleBusy = false;
            this.syncRunToggle();
        }
    }

    async onRunToggleClick() {
        if (this._runToggleBusy) return;
        if (this.isRunLoopActive()) {
            await this.onStop();
        } else {
            await this.onStart();
        }
    }

    onTransmitterSelect() {
        this.stopLoop();
        if (!this.transmitterGuiMount || !this.transmitterListEl) return;
        if (
            this.transmitterInstance &&
            typeof this.transmitterInstance.destroy === 'function'
        ) {
            this.transmitterInstance.destroy();
        }
        this.transmitterGuiMount.innerHTML = '';
        this.transmitterInstance = null;
        const v = this.transmitterListEl.value;
        if (v === "wifi") {
            this.transmitterInstance = new WifiTransmitter(
                this.transmitterGuiMount,
                this._getTransmitterOptions()
            );
            this.transmitterInstance.setReadyChangeHandler(() => this.updateStartButtonState());
        } else if (v === "screen light") {
            this.transmitterInstance = new ScreenLightTransmitter(this.transmitterGuiMount);
            this.transmitterInstance.setReadyChangeHandler(() => this.updateStartButtonState());
        } else if (v === "bluetooth") {
            this.transmitterInstance = new BluetoothTransmitter(
                this.transmitterGuiMount,
                this._getTransmitterOptions()
            );
            this.transmitterInstance.setReadyChangeHandler(() => this.updateStartButtonState());
        }
        this.updateStartButtonState();
    }

 
    onRobotSelect() {
        this.stopLoop();
        if (!this.robotListEl || !this.robotsData?.robots) return;
        const rawValue = this.robotListEl.value;
        if (rawValue === '') {
            this.setRobot(null);
            return;
        }
        const idx = Number(rawValue);
        const config = this.robotsData.robots[idx];
        if (config) {
            this.setRobot(config);
            this.closeSettings();
        } else {
            this.setRobot(null);
        }
    }

    buildGUI() {
        const root = document.getElementById('robotApp');
        if (!root) return;

        root.innerHTML = '';
        root.className = 'app-shell';

        this._settingsStack = [];
        this._settingsOpen = false;

        const header = document.createElement('header');
        header.className = 'app-header';
        const title = document.createElement('h1');
        title.className = 'app-title';
        title.textContent = 'Phone Robot';

        const headerActions = document.createElement('div');
        headerActions.className = 'app-header-actions';

        const runToggle = document.createElement('button');
        runToggle.type = 'button';
        runToggle.className = 'app-run-toggle';
        runToggle.setAttribute('role', 'switch');
        runToggle.setAttribute('aria-checked', 'false');
        runToggle.setAttribute('aria-label', 'Transmit loop');
        runToggle.disabled = true;
        const runThumb = document.createElement('span');
        runThumb.className = 'app-run-toggle-thumb';
        runThumb.setAttribute('aria-hidden', 'true');
        runToggle.appendChild(runThumb);
        runToggle.addEventListener('click', () => {
            void this.onRunToggleClick();
        });
        this.runToggle = runToggle;

        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'app-menu-btn';
        menuBtn.setAttribute('aria-label', 'Open menu');
        menuBtn.setAttribute('aria-haspopup', 'true');
        menuBtn.textContent = '⋮';
        menuBtn.addEventListener('click', () => this.openSettingsMenu());
        this.menuBtn = menuBtn;

        headerActions.appendChild(runToggle);
        headerActions.appendChild(menuBtn);
        header.appendChild(title);
        header.appendChild(headerActions);

        const main = document.createElement('main');
        main.className = 'app-main';

        const dashboard = document.createElement('div');
        dashboard.id = 'appDashboard';
        dashboard.className = 'app-dashboard';
        this.dashboardMount = dashboard;
        main.appendChild(dashboard);

        const sheet = document.createElement('div');
        sheet.id = 'appSettingsSheet';
        sheet.className = 'app-settings-sheet';
        sheet.hidden = true;
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-label', 'Settings');

        const sheetHeader = document.createElement('div');
        sheetHeader.className = 'app-settings-header';
        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'app-settings-back';
        backBtn.textContent = '←';
        backBtn.setAttribute('aria-label', 'Back');
        backBtn.addEventListener('click', () => this.popSettings());
        this.settingsBackBtn = backBtn;

        const sheetTitle = document.createElement('h2');
        sheetTitle.className = 'app-settings-title';
        sheetTitle.textContent = 'Menu';
        this.settingsTitleEl = sheetTitle;

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'app-settings-close';
        closeBtn.textContent = '✕';
        closeBtn.setAttribute('aria-label', 'Close settings');
        closeBtn.addEventListener('click', () => this.closeSettings());

        sheetHeader.appendChild(backBtn);
        sheetHeader.appendChild(sheetTitle);
        sheetHeader.appendChild(closeBtn);

        const sheetBody = document.createElement('div');
        sheetBody.className = 'app-settings-body';
        this.settingsBodyEl = sheetBody;

        sheet.appendChild(sheetHeader);
        sheet.appendChild(sheetBody);

        // --- Settings page mounts (built once, shown via stack) ---
        const txPage = document.createElement('div');
        txPage.className = 'app-settings-page';
        txPage.dataset.page = 'transmitter';
        const txLabel = document.createElement('label');
        txLabel.htmlFor = 'appTransmitterSelect';
        txLabel.innerHTML = '<b>Transmitter</b>';
        const txSelect = document.createElement('select');
        txSelect.id = 'appTransmitterSelect';
        this.transmitterListEl = txSelect;
        this.transmitters.forEach((name) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            txSelect.appendChild(opt);
        });
        const txMount = document.createElement('div');
        txMount.id = 'transmitterGuiMount';
        txMount.className = 'box';
        txMount.style.marginTop = '10px';
        this.transmitterGuiMount = txMount;
        txPage.appendChild(txLabel);
        txPage.appendChild(txSelect);
        txPage.appendChild(txMount);

        const robotSelectPage = document.createElement('div');
        robotSelectPage.className = 'app-settings-page';
        robotSelectPage.dataset.page = 'robotSelect';
        const robotLabel = document.createElement('label');
        robotLabel.htmlFor = 'appRobotSelect';
        robotLabel.innerHTML = '<b>Robot</b>';
        const select = document.createElement('select');
        select.id = 'appRobotSelect';
        this.robotListEl = select;
        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = 'Select a robot...';
        select.appendChild(placeholderOpt);
        robotSelectPage.appendChild(robotLabel);
        robotSelectPage.appendChild(select);

        const robotPanelPage = document.createElement('div');
        robotPanelPage.className = 'app-settings-page';
        robotPanelPage.dataset.page = 'robotPanel';
        const mount = document.createElement('div');
        mount.id = 'robotGuiMount';
        mount.className = 'box';
        mount.style.marginTop = '0';
        mount.style.display = 'none';
        this.robotGuiMount = mount;
        robotPanelPage.appendChild(mount);

        const menuPage = document.createElement('div');
        menuPage.className = 'app-settings-page';
        menuPage.dataset.page = 'menu';
        this.settingsMenuEl = menuPage;

        this._settingsPages = {
            menu: menuPage,
            transmitter: txPage,
            robotSelect: robotSelectPage,
            robotPanel: robotPanelPage
        };

        const pageHold = document.createElement('div');
        pageHold.className = 'app-settings-page-hold';
        pageHold.hidden = true;
        Object.values(this._settingsPages).forEach((page) => pageHold.appendChild(page));
        sheet.appendChild(pageHold);

        root.appendChild(header);
        root.appendChild(main);
        root.appendChild(sheet);

        this._refreshSettingsMenu();
        this._renderEmptyDashboard();

        txSelect.addEventListener('change', () => this.onTransmitterSelect());
        txSelect.value = 'wifi';
        this.onTransmitterSelect();

        const data = window.ROBOTS_DATA;
        if (!data?.robots?.length) {
            console.error('window.ROBOTS_DATA is missing or empty (load robots.js before app.js).');
            const p = document.createElement('p');
            p.className = 'error';
            p.textContent = 'Could not load robot definitions.';
            dashboard.appendChild(p);
        } else {
            this.robotsData = data;
            data.robots.forEach((robot, i) => {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = robot.name || `Robot ${i}`;
                select.appendChild(opt);
            });
            select.addEventListener('change', () => this.onRobotSelect());
            select.value = '';
            this.updateStartButtonState();
            this.applyUrlSelection();
            window.addEventListener('popstate', () => this.applyUrlSelection());
        }
    }

    _settingsPageMeta(id) {
        const map = {
            menu: { title: 'Menu' },
            transmitter: { title: 'Transmitter' },
            robotSelect: { title: 'Robot Selection' },
            robotPanel: { title: 'Robot Panel' }
        };
        return map[id] || { title: id };
    }

    _refreshSettingsMenu() {
        if (!this.settingsMenuEl) return;
        this.settingsMenuEl.innerHTML = '';
        const list = document.createElement('div');
        list.className = 'app-settings-nav';

        const items = [
            { id: 'transmitter', label: 'Transmitter' },
            { id: 'robotSelect', label: 'Robot Selection' }
        ];
        if (this.robot) {
            items.push({
                id: 'robotPanel',
                label: `Robot Panel (${this.robot.name || 'robot'})`
            });
        }

        for (const item of items) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'app-settings-nav-item';
            btn.textContent = item.label;
            btn.addEventListener('click', () => this.pushSettings(item.id));
            list.appendChild(btn);
        }

        const banner = document.getElementById('appBuildBanner');
        if (banner) {
            banner.hidden = false;
            banner.className = 'app-build-banner muted';
            list.appendChild(banner);
        }

        this.settingsMenuEl.appendChild(list);
    }

    openSettingsMenu() {
        this._settingsStack = ['menu'];
        this._showSettingsStack();
    }

    openSettings(pageId) {
        this._settingsStack = ['menu'];
        if (pageId && pageId !== 'menu') this._settingsStack.push(pageId);
        this._showSettingsStack();
    }

    pushSettings(pageId) {
        if (!pageId) return;
        if (!this._settingsOpen) {
            this.openSettings(pageId);
            return;
        }
        const top = this._settingsStack[this._settingsStack.length - 1];
        if (top === pageId) return;
        this._settingsStack.push(pageId);
        this._showSettingsStack();
    }

    popSettings() {
        if (!this._settingsOpen) return;
        if (this._settingsStack.length <= 1) {
            this.closeSettings();
            return;
        }
        this._settingsStack.pop();
        this._showSettingsStack();
    }

    closeSettings() {
        this._settingsOpen = false;
        this._settingsStack = [];
        const sheet = document.getElementById('appSettingsSheet');
        if (sheet) sheet.hidden = true;
        if (this.settingsBodyEl) this.settingsBodyEl.innerHTML = '';
        if (this.menuBtn) this.menuBtn.setAttribute('aria-expanded', 'false');
        // Park pages so they are not destroyed
        const hold = document.querySelector('.app-settings-page-hold');
        if (hold && this._settingsPages) {
            Object.values(this._settingsPages).forEach((page) => {
                if (page.parentNode !== hold) hold.appendChild(page);
            });
        }
    }

    _showSettingsStack() {
        const sheet = document.getElementById('appSettingsSheet');
        if (!sheet || !this.settingsBodyEl || !this._settingsPages) return;
        this._settingsOpen = true;
        sheet.hidden = false;
        if (this.menuBtn) this.menuBtn.setAttribute('aria-expanded', 'true');

        const hold = document.querySelector('.app-settings-page-hold');
        if (hold) {
            Object.values(this._settingsPages).forEach((page) => {
                if (page.parentNode !== hold) hold.appendChild(page);
            });
        }

        const pageId = this._settingsStack[this._settingsStack.length - 1] || 'menu';
        const page = this._settingsPages[pageId];
        this.settingsBodyEl.innerHTML = '';
        if (page) this.settingsBodyEl.appendChild(page);

        const meta = this._settingsPageMeta(pageId);
        if (this.settingsTitleEl) this.settingsTitleEl.textContent = meta.title;
        if (this.settingsBackBtn) {
            this.settingsBackBtn.hidden = this._settingsStack.length <= 1;
        }
    }
}
