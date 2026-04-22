//check network conection to robot

class App {
    constructor() {
        this.robot = null;
        this.robotGuiMount = null;
        this.robotListEl = null;
        this.robotsData = null;
        this.transmitters = ["none", "wifi", "bluetooth", "serial", "audio", "screen light"];
        this.transmitterListEl = null;
        this.transmitterGuiMount = null;
        this.transmitterInstance = null;
        this.startBtn = null;
        this.stopBtn = null;
        this.loopIntervalId = null;
        this.controlStatusEl = null;
        this.actionTick = 0;
        this.buildGUI();
    }

    setRobot(robotConfig) {
        if (!this.robotGuiMount) return;
        if (this.robot && typeof this.robot.destroy === 'function') {
            this.robot.destroy();
        }
        this.robotGuiMount.innerHTML = '';
        if (!robotConfig) {
            this.robot = null;
            this.robotGuiMount.style.display = 'none';
            this.updateStartButtonState();
            return;
        }
        this.robotGuiMount.style.display = '';
        this.robot = new Robot(this.robotGuiMount, robotConfig);
        this.updateStartButtonState();
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
                this.setControlStatus(`Action failed: ${res.body || 'unknown error'}`, 'error');
                return;
            }
            if (this.actionTick % 10 === 0) {
                this.setControlStatus(`Running: sent ${this.actionTick} action updates.`, 'ok');
            }
        });
    }

    setControlStatus(text, cls = 'muted') {
        if (!this.controlStatusEl) return;
        this.controlStatusEl.className = cls;
        this.controlStatusEl.textContent = text;
    }

    updateStartButtonState() {
        if (!this.startBtn) return;
        const transmitterReady = !!(this.transmitterInstance && this.transmitterInstance.isReady && this.transmitterInstance.isReady());
        const hasRobot = !!this.robot;
        this.startBtn.disabled = !(transmitterReady && hasRobot);
        if (this.stopBtn) this.stopBtn.disabled = !this.loopIntervalId;
    }

    onStop() {
        this.stopLoop();
        if (this.startBtn) this.startBtn.textContent = 'Start';
        this.setControlStatus('Stopped. You can switch device/transmitter.', 'muted');
        this.updateStartButtonState();
    }

    async onStart() {
        if (!this.startBtn) return;
        this.updateStartButtonState();
        if (this.startBtn.disabled) return;

        this.startBtn.disabled = true;
        this.startBtn.textContent = 'Starting...';
        this.setControlStatus('Sending pin setup...', 'muted');
        try {
            const setupRes = await this.transmitPinSetup();
            if (!setupRes.ok) {
                this.startBtn.textContent = 'Start';
                this.setControlStatus(`Pin setup failed (${setupRes.status || 'network'}): ${setupRes.body || ''}`, 'error');
                this.updateStartButtonState();
                return;
            }
            this.actionTick = 0;
            this.startLoop();
            this.startBtn.textContent = 'Running';
            this.setControlStatus(`Pin setup complete: ${setupRes.body || 'OK'}`, 'ok');
            this.updateStartButtonState();
        } catch (err) {
            console.error('Failed to start robot loop', err);
            this.startBtn.textContent = 'Start';
            this.setControlStatus(`Start failed: ${err && err.message ? err.message : 'unknown error'}`, 'error');
            this.updateStartButtonState();
        }
    }

    onTransmitterSelect() {
        this.stopLoop();
        if (this.stopBtn) this.stopBtn.disabled = true;
        if (!this.transmitterGuiMount || !this.transmitterListEl) return;
        this.transmitterGuiMount.innerHTML = '';
        this.transmitterInstance = null;
        const v = this.transmitterListEl.value;
        if (v === "wifi") {
            this.transmitterInstance = new WifiTransmitter(this.transmitterGuiMount);
            this.transmitterInstance.setReadyChangeHandler(() => this.updateStartButtonState());
        }
        if (this.startBtn) this.startBtn.textContent = 'Start';
        this.setControlStatus('Select robot and click Start when transmitter is ready.', 'muted');
        this.updateStartButtonState();
    }

 
    onRobotSelect() {
        this.stopLoop();
        if (this.stopBtn) this.stopBtn.disabled = true;
        if (this.startBtn) this.startBtn.textContent = 'Start';
        if (!this.robotListEl || !this.robotsData?.robots) return;
        const rawValue = this.robotListEl.value;
        if (rawValue === '') {
            this.setRobot(null);
            this.setControlStatus('Select a robot to show controls and AI models.', 'muted');
            return;
        }
        const idx = Number(rawValue);
        const config = this.robotsData.robots[idx];
        if (config) {
            this.setRobot(config);
            this.setControlStatus('Robot selected. Start is optional for camera/AI models.', 'muted');
        } else {
            this.setRobot(null);
            this.setControlStatus('Select a valid robot configuration.', 'warn');
        }
    }

    buildGUI() {
        const root = document.getElementById('robotApp');
        if (!root) return;

        root.innerHTML = '';

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

        const mount = document.createElement('div');
        mount.id = 'robotGuiMount';
        mount.className = 'box';
        mount.style.marginTop = '10px';
        mount.style.display = 'none';
        this.robotGuiMount = mount;

        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.textContent = 'Start';
        startBtn.disabled = true;
        startBtn.addEventListener('click', () => this.onStart());
        this.startBtn = startBtn;

        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.textContent = 'Stop';
        stopBtn.disabled = true;
        stopBtn.addEventListener('click', () => this.onStop());
        this.stopBtn = stopBtn;

        const controlStatus = document.createElement('p');
        controlStatus.className = 'muted';
        controlStatus.textContent = 'Select robot and transmitter.';
        this.controlStatusEl = controlStatus;

        root.appendChild(txLabel);
        root.appendChild(txSelect);
        root.appendChild(txMount);
        root.appendChild(robotLabel);
        root.appendChild(select);
        root.appendChild(startBtn);
        root.appendChild(stopBtn);
        root.appendChild(controlStatus);
        root.appendChild(mount);

        txSelect.addEventListener('change', () => this.onTransmitterSelect());
        txSelect.value = 'wifi';
        this.onTransmitterSelect();

        const data = window.ROBOTS_DATA;
        if (!data?.robots?.length) {
            console.error('window.ROBOTS_DATA is missing or empty (load robots.js before app.js).');
            const p = document.createElement('p');
            p.className = 'error';
            p.textContent = 'Could not load robot definitions.';
            root.appendChild(p);
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
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new App();
});
