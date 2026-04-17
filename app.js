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
        this.loopIntervalId = null;
        this.controlStatusEl = null;
        this.actionTick = 0;
        this.buildGUI();
    }

    setRobot(robotConfig) {
        if (!this.robotGuiMount) return;
        this.robotGuiMount.innerHTML = '';
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
        } catch (err) {
            console.error('Failed to start robot loop', err);
            this.startBtn.textContent = 'Start';
            this.setControlStatus(`Start failed: ${err && err.message ? err.message : 'unknown error'}`, 'error');
            this.updateStartButtonState();
        }
    }

    onTransmitterSelect() {
        this.stopLoop();
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
        if (this.startBtn) this.startBtn.textContent = 'Start';
        if (!this.robotListEl || !this.robotsData?.robots) return;
        const idx = Number(this.robotListEl.value);
        const config = this.robotsData.robots[idx];
        if (config) this.setRobot(config);
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

        const mount = document.createElement('div');
        mount.id = 'robotGuiMount';
        mount.className = 'box';
        mount.style.marginTop = '10px';
        this.robotGuiMount = mount;

        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.textContent = 'Start';
        startBtn.disabled = true;
        startBtn.addEventListener('click', () => this.onStart());
        this.startBtn = startBtn;

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
        root.appendChild(controlStatus);
        root.appendChild(mount);

        txSelect.addEventListener('change', () => this.onTransmitterSelect());
        txSelect.value = 'wifi';
        this.onTransmitterSelect();

        fetch('robots.json')
            .then((r) => r.json())
            .then((data) => {
                this.robotsData = data;
                (data.robots || []).forEach((robot, i) => {
                    const opt = document.createElement('option');
                    opt.value = String(i);
                    opt.textContent = robot.name || `Robot ${i}`;
                    select.appendChild(opt);
                });
                select.addEventListener('change', () => this.onRobotSelect());
                this.onRobotSelect();
                this.updateStartButtonState();
            })
            .catch((err) => {
                console.error('Failed to load robots.json', err);
                const p = document.createElement('p');
                p.className = 'error';
                p.textContent = 'Could not load robots.json.';
                root.appendChild(p);
            });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new App();
});
