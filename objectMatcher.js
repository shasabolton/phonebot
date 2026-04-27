/**
 * Tracks Groq-labeled boxes at high rate using OpenCV optical flow between Groq updates.
 * Output matches CocoAiModel: getLatestDetections(), getFrameSize(), getFrequencyHz(), overlay.
 */
class ObjectMatcherAiModel {
    static _cvLoadPromise = null;

    static MIN_FREQUENCY_HZ = 1;
    static MAX_FREQUENCY_HZ = 30;
    static MIN_TICK_INTERVAL_MS = 33;

    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "objectmatcher";
        this.name = config.name || "Object matcher (Groq + flow)";
        this.enabled = false;
        this.frequencyHz = Number.isFinite(config.frequencyHz) ? config.frequencyHz : 10;
        this.frequencyHz = Math.max(
            ObjectMatcherAiModel.MIN_FREQUENCY_HZ,
            Math.min(ObjectMatcherAiModel.MAX_FREQUENCY_HZ, this.frequencyHz)
        );

        this.groqFeedType = String(config.groqFeedType || "groqvision").trim().toLowerCase();
        this.cocoFeedType = String(config.cocoFeedType || "coco").trim().toLowerCase();
        this.groqRefreshMs = Number.isFinite(config.groqRefreshMs) ? config.groqRefreshMs : 5000;
        this.groqRefreshMs = Math.max(500, Math.min(120000, this.groqRefreshMs));
        this.cocoRefreshMs = Number.isFinite(config.cocoRefreshMs) ? config.cocoRefreshMs : 500;
        this.cocoRefreshMs = Math.max(100, Math.min(120000, this.cocoRefreshMs));

        this.mergeIou = Number.isFinite(config.mergeIou) ? config.mergeIou : 0.25;
        this.mergeIou = Math.max(0.05, Math.min(0.95, this.mergeIou));

        this.filterParams = {
            maxCorners: Number.isFinite(config.maxCorners) ? Math.round(config.maxCorners) : 40,
            qualityLevel: Number.isFinite(config.qualityLevel) ? config.qualityLevel : 0.01,
            minDistance: Number.isFinite(config.minDistance) ? config.minDistance : 5,
            blockSize: Number.isFinite(config.blockSize) ? Math.round(config.blockSize) : 5,
            searchMarginFrac: Number.isFinite(config.searchMarginFrac) ? config.searchMarginFrac : 0.2,
            minGoodPoints: Number.isFinite(config.minGoodPoints) ? Math.round(config.minGoodPoints) : 6,
            hsvHueMargin: Number.isFinite(config.hsvHueMargin) ? config.hsvHueMargin : 15,
            hsvSatMin: Number.isFinite(config.hsvSatMin) ? config.hsvSatMin : 40,
            hsvValMin: Number.isFinite(config.hsvValMin) ? config.hsvValMin : 40
        };

        this._timer = null;
        this._busy = false;
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._captureCanvas = null;
        this._captureCtx = null;
        this._prevGray = null;
        this._tracks = [];
        this._nextId = 1;
        this._lastGroqSnapshot = "";
        this._lastGroqReanchorMs = 0;
        this._lastCocoSnapshot = "";
        this._lastCocoReanchorMs = 0;
        this._frameWidth = 0;
        this._frameHeight = 0;
        this._detections = [];

        this._toggleBtn = null;
        this._freqInput = null;
        this._refreshInput = null;
        this._cocoRefreshInput = null;
        this._statusEl = null;
        this._outputEl = null;
    }

    static _loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.querySelectorAll("script")).find((s) => s.src === src);
            if (existing) {
                if (window.cv && window.cv.Mat) {
                    resolve();
                    return;
                }
                existing.addEventListener("load", () => resolve(), { once: true });
                existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
                return;
            }
            const script = document.createElement("script");
            script.src = src;
            script.async = true;
            script.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
            document.head.appendChild(script);
            const timeoutMs = 20000;
            const started = Date.now();
            const waitForCv = () => {
                if (window.cv && window.cv.Mat) {
                    resolve();
                    return;
                }
                if (Date.now() - started > timeoutMs) {
                    reject(new Error("Timed out waiting for OpenCV runtime initialization."));
                    return;
                }
                setTimeout(waitForCv, 50);
            };
            waitForCv();
        });
    }

    static async _loadOpenCv() {
        if (window.cv && window.cv.Mat) return;
        if (!this._cvLoadPromise) {
            this._cvLoadPromise = this._loadScript("https://docs.opencv.org/4.10.0/opencv.js");
        }
        return this._cvLoadPromise;
    }

    _getCameraSensor() {
        return this.robot.sensors.find((sensor) => sensor && sensor.type === "camera");
    }

    _getGroqModel() {
        return this.robot.getAiModelByType(this.groqFeedType) || this.robot.getAiModelByName(this.groqFeedType);
    }

    _getCocoModel() {
        return this.robot.getAiModelByType(this.cocoFeedType) || this.robot.getAiModelByName(this.cocoFeedType);
    }

    _ensureOverlay() {
        if (this._overlayCanvas) return true;
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return false;
        const canvas = document.createElement("canvas");
        canvas.className = "sensor-camera-overlay";
        frameEl.appendChild(canvas);
        this._overlayCanvas = canvas;
        this._overlayCtx = canvas.getContext("2d");
        return true;
    }

    _resizeOverlayToVideo(videoEl) {
        if (!this._overlayCanvas) return;
        const w = videoEl.clientWidth || videoEl.videoWidth || 0;
        const h = videoEl.clientHeight || videoEl.videoHeight || 0;
        if (!w || !h) return;
        if (this._overlayCanvas.width !== w) this._overlayCanvas.width = w;
        if (this._overlayCanvas.height !== h) this._overlayCanvas.height = h;
    }

    _clearOverlay() {
        if (!this._overlayCtx || !this._overlayCanvas) return;
        this._overlayCtx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
    }

    _iou(a, b) {
        const ax2 = a[0] + a[2];
        const ay2 = a[1] + a[3];
        const bx2 = b[0] + b[2];
        const by2 = b[1] + b[3];
        const x1 = Math.max(a[0], b[0]);
        const y1 = Math.max(a[1], b[1]);
        const x2 = Math.min(ax2, bx2);
        const y2 = Math.min(ay2, by2);
        const iw = Math.max(0, x2 - x1);
        const ih = Math.max(0, y2 - y1);
        const inter = iw * ih;
        if (!inter) return 0;
        const ua = a[2] * a[3] + b[2] * b[3] - inter;
        return ua > 0 ? inter / ua : 0;
    }

    _clampBbox(bbox, fw, fh) {
        let [x, y, w, h] = bbox;
        x = Math.max(0, Math.min(fw - 1, x));
        y = Math.max(0, Math.min(fh - 1, y));
        w = Math.max(1, Math.min(fw - x, w));
        h = Math.max(1, Math.min(fh - y, h));
        return [x, y, w, h];
    }

    _snapshotGroqDetections() {
        const groq = this._getGroqModel();
        if (!groq || typeof groq.getLatestDetections !== "function") return "";
        try {
            return JSON.stringify(groq.getLatestDetections());
        } catch (_) {
            return "";
        }
    }

    _scalarChannel(s, i) {
        if (!s) return 0;
        if (s.data64F && Number.isFinite(s.data64F[i])) return s.data64F[i];
        if (s.data32F && Number.isFinite(s.data32F[i])) return s.data32F[i];
        if (typeof s[i] === "number") return s[i];
        return 0;
    }

    /** Mean RGBA inside ROI — used later for re-acquire / segmentation hints. */
    _computeRoiColorStats(rgbaRoi) {
        const cv = window.cv;
        if (!rgbaRoi || rgbaRoi.empty()) return null;
        const s = cv.mean(rgbaRoi);
        return {
            meanR: this._scalarChannel(s, 0),
            meanG: this._scalarChannel(s, 1),
            meanB: this._scalarChannel(s, 2),
            meanA: this._scalarChannel(s, 3)
        };
    }

    _mergeAnchorDetections(detections, source, rgbaFull, fw, fh) {
        const fp = this.filterParams;
        for (const det of detections) {
            const label = String(det.class || "").trim().toLowerCase();
            if (!label) continue;
            const score = Number.isFinite(det.score) ? det.score : 0.5;
            let bbox;
            if (Array.isArray(det.bbox)) {
                bbox = [...det.bbox];
            } else if (det.bbox && Number.isFinite(det.bbox.x) && Number.isFinite(det.bbox.width)) {
                bbox = [det.bbox.x, det.bbox.y, det.bbox.width, det.bbox.height];
            } else {
                bbox = [0, 0, 0, 0];
            }
            bbox = this._clampBbox(bbox, fw, fh);

            let bestIdx = -1;
            let bestIou = 0;
            for (let i = 0; i < this._tracks.length; i++) {
                const t = this._tracks[i];
                if (String(t.class || "").toLowerCase() !== label) continue;
                const iou = this._iou(bbox, t.bbox);
                if (iou > bestIou) {
                    bestIou = iou;
                    bestIdx = i;
                }
            }

            let colorStats = null;
            if (rgbaFull && !rgbaFull.empty()) {
                const [x, y, w, h] = bbox;
                const rect = new window.cv.Rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
                if (rect.x >= 0 && rect.y >= 0 && rect.width > 4 && rect.height > 4) {
                    const roi = rgbaFull.roi(rect);
                    try {
                        colorStats = this._computeRoiColorStats(roi);
                    } finally {
                        roi.delete();
                    }
                }
            }

            if (bestIdx >= 0 && bestIou >= this.mergeIou) {
                const t = this._tracks[bestIdx];
                if (source === "coco" || t.labelSource !== "coco") {
                    t.bbox = bbox;
                }
                if (source === "groq") {
                    t.class = label;
                    t.labelSource = "groq";
                } else if (t.labelSource !== "groq") {
                    t.class = label;
                    t.labelSource = "coco";
                }
                t.score = score;
                t.filterParams = { ...fp, ...t.filterParams, colorStats: colorStats || t.filterParams?.colorStats };
                t.needsReinit = true;
            } else {
                let altIdx = -1;
                let altIou = 0;
                for (let i = 0; i < this._tracks.length; i++) {
                    const iou = this._iou(bbox, this._tracks[i].bbox);
                    if (iou > altIou) {
                        altIou = iou;
                        altIdx = i;
                    }
                }
                if (altIdx >= 0 && altIou >= this.mergeIou * 0.6) {
                    const t = this._tracks[altIdx];
                    if (source === "coco" || t.labelSource !== "coco") {
                        t.bbox = bbox;
                    }
                    if (source === "groq") {
                        t.class = label;
                        t.labelSource = "groq";
                    } else if (t.labelSource !== "groq") {
                        t.class = label;
                        t.labelSource = "coco";
                    }
                    t.score = score;
                    t.filterParams = { ...fp, colorStats };
                    t.needsReinit = true;
                } else {
                    this._tracks.push({
                        id: this._nextId++,
                        class: label,
                        labelSource: source,
                        score,
                        bbox,
                        filterParams: { ...fp, colorStats },
                        needsReinit: true,
                        prevPts: null
                    });
                }
            }
        }
    }

    _releaseTrackMats(track) {
        if (track?.prevPts) {
            try {
                track.prevPts.delete();
            } catch (_) {}
            track.prevPts = null;
        }
    }

    _releaseAllTrackPts() {
        for (const t of this._tracks) this._releaseTrackMats(t);
    }

    _initTrackPoints(track, gray) {
        const cv = window.cv;
        this._releaseTrackMats(track);
        const fp = track.filterParams || this.filterParams;
        const [x0, y0, w, h] = track.bbox;
        const fw = gray.cols;
        const fh = gray.rows;
        let step = 14;
        const coords = [];
        for (let attempt = 0; attempt < 6; attempt++) {
            coords.length = 0;
            for (let y = y0 + step; y < y0 + h - step; y += step) {
                for (let x = x0 + step; x < x0 + w - step; x += step) {
                    if (x >= 1 && y >= 1 && x < fw - 1 && y < fh - 1) {
                        coords.push(x, y);
                    }
                }
            }
            if (coords.length / 2 >= fp.minGoodPoints || step <= 6) break;
            step = Math.max(6, Math.floor(step * 0.65));
        }
        if (coords.length < fp.minGoodPoints * 2) return;
        track.prevPts = cv.matFromArray(coords.length / 2, 1, cv.CV_32FC2, coords);
    }

    _updateTracksWithFlow(prevGray, curGray) {
        const cv = window.cv;
        const fp = this.filterParams;
        const winSize = new cv.Size(21, 21);
        const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 24, 0.03);

        for (const track of this._tracks) {
            if (track.needsReinit) {
                this._initTrackPoints(track, curGray);
                track.needsReinit = false;
            }
            if (!track.prevPts || track.prevPts.rows < fp.minGoodPoints) continue;

            const status = new cv.Mat();
            const err = new cv.Mat();
            const nextPts = track.prevPts.clone();

            try {
                cv.calcOpticalFlowPyrLK(prevGray, curGray, track.prevPts, nextPts, status, err, winSize, 3, criteria, 0, 0.001);
            } catch (_) {
                status.delete();
                err.delete();
                nextPts.delete();
                track.needsReinit = true;
                continue;
            }

            const goodX = [];
            const goodY = [];
            const st = status.data || status.data8U;
            for (let i = 0; i < status.rows; i++) {
                const ok = st ? st[i] : 0;
                if (ok === 1) {
                    goodX.push(nextPts.data32F[i * 2]);
                    goodY.push(nextPts.data32F[i * 2 + 1]);
                }
            }

            track.prevPts.delete();
            track.prevPts = null;
            status.delete();
            err.delete();
            nextPts.delete();

            if (goodX.length >= fp.minGoodPoints) {
                let minX = Math.min(...goodX);
                let maxX = Math.max(...goodX);
                let minY = Math.min(...goodY);
                let maxY = Math.max(...goodY);
                const pad = 4;
                minX -= pad;
                maxX += pad;
                minY -= pad;
                maxY += pad;
                const fw = curGray.cols;
                const fh = curGray.rows;
                minX = Math.max(0, minX);
                minY = Math.max(0, minY);
                maxX = Math.min(fw, maxX);
                maxY = Math.min(fh, maxY);
                const bw = Math.max(8, maxX - minX);
                const bh = Math.max(8, maxY - minY);
                track.bbox = this._clampBbox([minX, minY, bw, bh], fw, fh);

                const flat = [];
                for (let i = 0; i < goodX.length; i++) {
                    flat.push(goodX[i], goodY[i]);
                }
                track.prevPts = cv.matFromArray(flat.length / 2, 1, cv.CV_32FC2, flat);
            } else {
                track.needsReinit = true;
            }
        }
    }

    _getFrameMat(videoEl) {
        const cv = window.cv;
        const frameW = videoEl.videoWidth | 0;
        const frameH = videoEl.videoHeight | 0;
        if (!frameW || !frameH) return null;

        if (!this._captureCanvas) this._captureCanvas = document.createElement("canvas");
        if (!this._captureCtx) {
            this._captureCtx = this._captureCanvas.getContext("2d", { willReadFrequently: true });
        }
        if (!this._captureCtx) return null;

        if (this._captureCanvas.width !== frameW) this._captureCanvas.width = frameW;
        if (this._captureCanvas.height !== frameH) this._captureCanvas.height = frameH;

        this._captureCtx.drawImage(videoEl, 0, 0, frameW, frameH);
        const imageData = this._captureCtx.getImageData(0, 0, frameW, frameH);
        return cv.matFromImageData(imageData);
    }

    _drawDetections(videoEl, list) {
        if (!this._overlayCtx || !this._overlayCanvas) return;
        this._resizeOverlayToVideo(videoEl);
        this._clearOverlay();
        const ctx = this._overlayCtx;
        const widthScale = (videoEl.clientWidth || videoEl.videoWidth) / videoEl.videoWidth;
        const heightScale = (videoEl.clientHeight || videoEl.videoHeight) / videoEl.videoHeight;
        ctx.lineWidth = 2;
        ctx.font = "12px Arial";
        ctx.textBaseline = "top";

        list.forEach((item) => {
            const [x, y, w, h] = item.bbox;
            const bx = x * widthScale;
            const by = y * heightScale;
            const bw = w * widthScale;
            const bh = h * heightScale;
            const label = `${item.class} ${(item.score * 100).toFixed(0)}%`;

            ctx.strokeStyle = "#00ff66";
            ctx.strokeRect(bx, by, bw, bh);
            const labelW = ctx.measureText(label).width + 8;
            const labelH = 16;
            ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
            ctx.fillRect(bx, Math.max(0, by - labelH), labelW, labelH);
            ctx.fillStyle = "#00ff66";
            ctx.fillText(label, bx + 4, Math.max(0, by - labelH + 2));
        });
    }

    _syncDetectionsFromTracks() {
        this._detections = this._tracks.map((t) => ({
            class: t.class,
            score: t.score,
            bbox: [...t.bbox],
            labelSource: t.labelSource || "coco"
        }));
    }

    _renderResponseOutput() {
        if (!this._outputEl) return;
        const response = {
            model: this.type,
            detectedAt: new Date().toISOString(),
            objectCount: this._detections.length,
            groqFeed: this.groqFeedType,
            groqRefreshMs: this.groqRefreshMs,
            cocoFeed: this.cocoFeedType,
            cocoRefreshMs: this.cocoRefreshMs,
            tracks: this._tracks.map((t) => ({
                id: t.id,
                name: t.class,
                labelSource: t.labelSource || "coco",
                score: Number(t.score.toFixed(3)),
                bbox: {
                    x: Number(t.bbox[0].toFixed(1)),
                    y: Number(t.bbox[1].toFixed(1)),
                    width: Number(t.bbox[2].toFixed(1)),
                    height: Number(t.bbox[3].toFixed(1))
                },
                filterParams: t.filterParams
            }))
        };
        this._outputEl.textContent = JSON.stringify(response, null, 2);
    }

    async _tick() {
        if (this._busy || !this.enabled) return;
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight || videoEl.readyState < 2) {
            if (this._statusEl) this._statusEl.textContent = "Waiting for camera stream...";
            return;
        }

        this._busy = true;
        let rgba = null;
        let gray = null;
        try {
            await ObjectMatcherAiModel._loadOpenCv();
            const cv = window.cv;
            this._ensureOverlay();
            this._frameWidth = videoEl.videoWidth || 0;
            this._frameHeight = videoEl.videoHeight || 0;

            rgba = this._getFrameMat(videoEl);
            if (!rgba || rgba.empty()) return;

            gray = new cv.Mat();
            cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);

            const now = Date.now();
            const coco = this._getCocoModel();
            const cocoSnap = coco && typeof coco.getLatestDetections === "function"
                ? JSON.stringify(coco.getLatestDetections())
                : "";
            const cocoChanged = cocoSnap && cocoSnap !== this._lastCocoSnapshot;
            const cocoPeriodic = now - this._lastCocoReanchorMs >= this.cocoRefreshMs;
            if (coco && typeof coco.getLatestDetections === "function" && (cocoChanged || cocoPeriodic)) {
                this._lastCocoReanchorMs = now;
                if (cocoChanged) this._lastCocoSnapshot = cocoSnap;
                const cocoDets = coco.getLatestDetections();
                if (Array.isArray(cocoDets) && cocoDets.length) {
                    this._mergeAnchorDetections(cocoDets, "coco", rgba, gray.cols, gray.rows);
                    this._releaseAllTrackPts();
                    for (const t of this._tracks) t.needsReinit = true;
                }
            }

            const groq = this._getGroqModel();
            const groqSnap = this._snapshotGroqDetections();
            const groqChanged = groqSnap && groqSnap !== this._lastGroqSnapshot;
            const groqPeriodic = now - this._lastGroqReanchorMs >= this.groqRefreshMs;
            if (groq && typeof groq.getLatestDetections === "function" && (groqChanged || groqPeriodic)) {
                this._lastGroqReanchorMs = now;
                if (groqChanged) this._lastGroqSnapshot = groqSnap;
                const groqDets = groq.getLatestDetections();
                if (Array.isArray(groqDets) && groqDets.length) {
                    this._mergeAnchorDetections(groqDets, "groq", rgba, gray.cols, gray.rows);
                    this._releaseAllTrackPts();
                    for (const t of this._tracks) t.needsReinit = true;
                }
            }

            const sameFrameSize =
                this._prevGray &&
                !this._prevGray.empty() &&
                !gray.empty() &&
                this._prevGray.rows === gray.rows &&
                this._prevGray.cols === gray.cols;
            if (sameFrameSize) {
                this._updateTracksWithFlow(this._prevGray, gray);
            } else {
                for (const t of this._tracks) t.needsReinit = true;
            }

            if (this._prevGray) {
                try {
                    this._prevGray.delete();
                } catch (_) {}
                this._prevGray = null;
            }
            this._prevGray = gray.clone();
            try {
                gray.delete();
            } catch (_) {}
            gray = null;

            this._syncDetectionsFromTracks();
            this._drawDetections(videoEl, this._detections);
            this._renderResponseOutput();

            if (this._statusEl) {
                const groqLabels = this._tracks.filter((t) => t.labelSource === "groq").length;
                this._statusEl.textContent = `Tracking ${this._detections.length} object(s) at ${this.frequencyHz} Hz (boxes from ${this.cocoFeedType}, Groq labels: ${groqLabels})`;
                this._statusEl.className = "muted";
            }
        } catch (err) {
            console.error("ObjectMatcher error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = `ObjectMatcher error: ${err?.message || "unknown error"}`;
                this._statusEl.className = "error";
            }
        } finally {
            if (gray) {
                try {
                    gray.delete();
                } catch (_) {}
            }
            if (rgba) {
                try {
                    rgba.delete();
                } catch (_) {}
            }
            this._busy = false;
        }
    }

    _startLoop() {
        this._stopLoop();
        const intervalMs = Math.max(
            ObjectMatcherAiModel.MIN_TICK_INTERVAL_MS,
            Math.round(1000 / this.frequencyHz)
        );
        this._timer = setInterval(() => this._tick(), intervalMs);
        this._tick();
    }

    _stopLoop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async setEnabled(nextEnabled) {
        this.enabled = !!nextEnabled;
        if (this._toggleBtn) this._toggleBtn.textContent = this.enabled ? "On" : "Off";
        if (this.enabled) {
            if (this._statusEl) {
                this._statusEl.textContent = "Loading OpenCV for object matcher...";
                this._statusEl.className = "muted";
            }
            try {
                await ObjectMatcherAiModel._loadOpenCv();
                this._startLoop();
            } catch (err) {
                this.enabled = false;
                if (this._toggleBtn) this._toggleBtn.textContent = "Off";
                if (this._statusEl) {
                    this._statusEl.textContent = `Failed to load OpenCV: ${err?.message || "unknown error"}`;
                    this._statusEl.className = "error";
                }
            }
        } else {
            this._stopLoop();
            if (this._prevGray) {
                try {
                    this._prevGray.delete();
                } catch (_) {}
                this._prevGray = null;
            }
            this._releaseAllTrackPts();
            this._tracks = [];
            this._detections = [];
            this._clearOverlay();
            this._renderResponseOutput();
            if (this._statusEl) {
                this._statusEl.textContent = "Model off.";
                this._statusEl.className = "muted";
            }
        }
    }

    setFrequencyHz(nextHz) {
        const parsed = Number(nextHz);
        if (!Number.isFinite(parsed)) return;
        this.frequencyHz = Math.max(
            ObjectMatcherAiModel.MIN_FREQUENCY_HZ,
            Math.min(ObjectMatcherAiModel.MAX_FREQUENCY_HZ, parsed)
        );
        if (this._freqInput) this._freqInput.value = String(this.frequencyHz);
        if (this.enabled) this._startLoop();
    }

    setGroqRefreshMs(nextMs) {
        const parsed = Number(nextMs);
        if (!Number.isFinite(parsed)) return;
        this.groqRefreshMs = Math.max(500, Math.min(120000, Math.round(parsed)));
        if (this._refreshInput) this._refreshInput.value = String(this.groqRefreshMs);
    }

    setCocoRefreshMs(nextMs) {
        const parsed = Number(nextMs);
        if (!Number.isFinite(parsed)) return;
        this.cocoRefreshMs = Math.max(100, Math.min(120000, Math.round(parsed)));
        if (this._cocoRefreshInput) this._cocoRefreshInput.value = String(this.cocoRefreshMs);
    }

    getFrequencyHz() {
        return this.frequencyHz;
    }

    getLatestDetections() {
        return this._detections.map((item) => ({
            class: item.class,
            score: item.score,
            bbox: Array.isArray(item.bbox) ? [...item.bbox] : [0, 0, 0, 0]
        }));
    }

    getFrameSize() {
        return { width: this._frameWidth, height: this._frameHeight };
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model ai-model-objectmatcher";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const controls = document.createElement("div");
        controls.className = "ai-model-controls";

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "ai-model-toggle-btn";
        toggleBtn.textContent = "Off";
        toggleBtn.addEventListener("click", async () => {
            toggleBtn.disabled = true;
            await this.setEnabled(!this.enabled);
            toggleBtn.disabled = false;
        });

        const freqLabel = document.createElement("label");
        freqLabel.textContent = "Matcher frequency (Hz)";
        const freqInput = document.createElement("input");
        freqInput.type = "number";
        freqInput.min = String(ObjectMatcherAiModel.MIN_FREQUENCY_HZ);
        freqInput.max = String(ObjectMatcherAiModel.MAX_FREQUENCY_HZ);
        freqInput.step = "1";
        freqInput.value = String(this.frequencyHz);
        freqInput.addEventListener("change", () => this.setFrequencyHz(freqInput.value));
        freqInput.addEventListener("blur", () => this.setFrequencyHz(freqInput.value));

        const refreshLabel = document.createElement("label");
        refreshLabel.textContent = "Min ms between Groq label merges";
        const refreshInput = document.createElement("input");
        refreshInput.type = "number";
        refreshInput.min = "500";
        refreshInput.max = "120000";
        refreshInput.step = "500";
        refreshInput.value = String(this.groqRefreshMs);
        refreshInput.addEventListener("change", () => this.setGroqRefreshMs(refreshInput.value));
        refreshInput.addEventListener("blur", () => this.setGroqRefreshMs(refreshInput.value));

        const cocoRefreshLabel = document.createElement("label");
        cocoRefreshLabel.textContent = "Min ms between COCO bbox merges";
        const cocoRefreshInput = document.createElement("input");
        cocoRefreshInput.type = "number";
        cocoRefreshInput.min = "100";
        cocoRefreshInput.max = "120000";
        cocoRefreshInput.step = "100";
        cocoRefreshInput.value = String(this.cocoRefreshMs);
        cocoRefreshInput.addEventListener("change", () => this.setCocoRefreshMs(cocoRefreshInput.value));
        cocoRefreshInput.addEventListener("blur", () => this.setCocoRefreshMs(cocoRefreshInput.value));

        const hint = document.createElement("p");
        hint.className = "muted";
        hint.textContent = `Uses "${this.cocoFeedType}" for bbox geometry and "${this.groqFeedType}" for label updates. Groq can overwrite labels, COCO cannot overwrite Groq labels.`;

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Model off.";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        controls.appendChild(toggleBtn);
        controls.appendChild(freqLabel);
        controls.appendChild(freqInput);
        controls.appendChild(refreshLabel);
        controls.appendChild(refreshInput);
        controls.appendChild(cocoRefreshLabel);
        controls.appendChild(cocoRefreshInput);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(hint);
        wrap.appendChild(status);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._freqInput = freqInput;
        this._refreshInput = refreshInput;
        this._cocoRefreshInput = cocoRefreshInput;
        this._statusEl = status;
        this._outputEl = output;
    }

    destroy() {
        this._stopLoop();
        if (this._prevGray) {
            try {
                this._prevGray.delete();
            } catch (_) {}
            this._prevGray = null;
        }
        this._releaseAllTrackPts();
        this._tracks = [];
        this._clearOverlay();
        if (this._overlayCanvas && this._overlayCanvas.parentNode) {
            this._overlayCanvas.parentNode.removeChild(this._overlayCanvas);
        }
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._captureCanvas = null;
        this._captureCtx = null;
        this._detections = [];
    }
}

window.ObjectMatcherAiModel = ObjectMatcherAiModel;
