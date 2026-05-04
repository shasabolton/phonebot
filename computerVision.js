/**
 * Computer vision fusion model:
 * - Internal high-frequency COCO detections for geometry.
 * - Lower-frequency Groq updates for stronger labels.
 * - Optical-flow between informer updates to reduce flicker.
 */
class ComputerVisionAiModel {
    static _cvLoadPromise = null;
    static _tfLoadPromise = null;
    static _cocoModelLoadPromise = null;
    static _cocoModelInstance = null;

    static MIN_FREQUENCY_HZ = 1;
    static MAX_FREQUENCY_HZ = 30;
    static MIN_TICK_INTERVAL_MS = 33;
    static MIN_BOXES = 1;
    static MAX_BOXES = 100;
    static MIN_SCORE = 0.01;
    static MAX_SCORE = 0.99;

    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "computervision";
        this.name = config.name || "Computer vision";
        this.enabled = false;
        this.frequencyHz = Number.isFinite(config.frequencyHz) ? config.frequencyHz : 10;
        this.frequencyHz = Math.max(
            ComputerVisionAiModel.MIN_FREQUENCY_HZ,
            Math.min(ComputerVisionAiModel.MAX_FREQUENCY_HZ, this.frequencyHz)
        );

        this.groqFeedType = String(config.groqFeedType || "groqvision").trim().toLowerCase();
        this.maxNumBoxes = Number.isFinite(config.maxNumBoxes) ? Math.round(config.maxNumBoxes) : 40;
        this.maxNumBoxes = Math.max(ComputerVisionAiModel.MIN_BOXES, Math.min(ComputerVisionAiModel.MAX_BOXES, this.maxNumBoxes));
        this.minScore = Number.isFinite(config.minScore) ? config.minScore : 0.2;
        this.minScore = Math.max(ComputerVisionAiModel.MIN_SCORE, Math.min(ComputerVisionAiModel.MAX_SCORE, this.minScore));
        this.groqRefreshMs = Number.isFinite(config.groqRefreshMs) ? config.groqRefreshMs : 5000;
        this.groqRefreshMs = Math.max(500, Math.min(120000, this.groqRefreshMs));
        this.cocoRefreshMs = Number.isFinite(config.cocoRefreshMs) ? config.cocoRefreshMs : 500;
        this.cocoRefreshMs = Math.max(100, Math.min(120000, this.cocoRefreshMs));

        this.mergeIou = Number.isFinite(config.mergeIou) ? config.mergeIou : 0.25;
        this.mergeIou = Math.max(0.05, Math.min(0.95, this.mergeIou));

        /** Flow-only boxes shrink vs last detector bbox; forget after sustained shrink. */
        this.forgetMinAreaRatio = Number.isFinite(config.forgetMinAreaRatio) ? config.forgetMinAreaRatio : 0.22;
        this.forgetMinAreaRatio = Math.max(0.06, Math.min(0.9, this.forgetMinAreaRatio));
        this.forgetShrinkFrames = Number.isFinite(config.forgetShrinkFrames) ? Math.round(config.forgetShrinkFrames) : 12;
        this.forgetShrinkFrames = Math.max(2, Math.min(180, this.forgetShrinkFrames));
        this.forgetMinFrameAreaFrac = Number.isFinite(config.forgetMinFrameAreaFrac)
            ? config.forgetMinFrameAreaFrac
            : 0.00012;
        this.forgetMinFrameAreaFrac = Math.max(1e-6, Math.min(0.01, this.forgetMinFrameAreaFrac));
        this.forgetEdgeMarginFrac = Number.isFinite(config.forgetEdgeMarginFrac) ? config.forgetEdgeMarginFrac : 0.03;
        this.forgetEdgeMarginFrac = Math.max(0, Math.min(0.2, this.forgetEdgeMarginFrac));
        this.forgetEdgeAreaRatio = Number.isFinite(config.forgetEdgeAreaRatio) ? config.forgetEdgeAreaRatio : 0.45;
        this.forgetEdgeAreaRatio = Math.max(0.05, Math.min(0.95, this.forgetEdgeAreaRatio));
        this.forgetStaleMs = Number.isFinite(config.forgetStaleMs) ? Math.round(config.forgetStaleMs) : 1000;
        this.forgetStaleMs = Math.max(500, Math.min(120000, this.forgetStaleMs));
        this.forgetNoPointFrames = Number.isFinite(config.forgetNoPointFrames) ? Math.round(config.forgetNoPointFrames) : 18;
        this.forgetNoPointFrames = Math.max(2, Math.min(600, this.forgetNoPointFrames));

        /** Flow bbox from LK points: percentiles reduce edge/outlier stretch; cap limits growth vs last detector size. */
        this.flowBboxPctLow = Number.isFinite(config.flowBboxPctLow) ? config.flowBboxPctLow : 0.1;
        this.flowBboxPctHigh = Number.isFinite(config.flowBboxPctHigh) ? config.flowBboxPctHigh : 0.9;
        this.flowBboxPctLow = Math.max(0, Math.min(0.45, this.flowBboxPctLow));
        this.flowBboxPctHigh = Math.max(0.55, Math.min(1, this.flowBboxPctHigh));
        if (this.flowBboxPctHigh <= this.flowBboxPctLow) {
            this.flowBboxPctHigh = Math.min(1, this.flowBboxPctLow + 0.5);
        }
        this.flowMaxBBoxGrow = Number.isFinite(config.flowMaxBBoxGrow) ? config.flowMaxBBoxGrow : 1.45;
        this.flowMaxBBoxGrow = Math.max(1, Math.min(2.5, this.flowMaxBBoxGrow));
        this.flowSizeInertia = Number.isFinite(config.flowSizeInertia) ? config.flowSizeInertia : 0.88;
        this.flowSizeInertia = Math.max(0, Math.min(0.98, this.flowSizeInertia));
        this.flowMaxShrinkPerTick = Number.isFinite(config.flowMaxShrinkPerTick) ? config.flowMaxShrinkPerTick : 0.08;
        this.flowMaxShrinkPerTick = Math.max(0, Math.min(0.4, this.flowMaxShrinkPerTick));
        this.flowReinitIntervalFrames = Number.isFinite(config.flowReinitIntervalFrames)
            ? Math.round(config.flowReinitIntervalFrames)
            : 20;
        this.flowReinitIntervalFrames = Math.max(0, Math.min(300, this.flowReinitIntervalFrames));

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
        this._lastCocoReanchorMs = 0;
        this._frameWidth = 0;
        this._frameHeight = 0;
        this._detections = [];

        this._toggleBtn = null;
        this._freqInput = null;
        this._minScoreInput = null;
        this._refreshInput = null;
        this._cocoRefreshInput = null;
        this._forgetStaleInput = null;
        this._makeCenterBtn = null;
        this._statusEl = null;
        this._outputEl = null;
    }

    static _loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.querySelectorAll("script")).find((s) => s.src === src);
            if (existing) {
                if (existing.dataset.loaded === "true") {
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
            script.addEventListener("load", () => {
                script.dataset.loaded = "true";
                resolve();
            }, { once: true });
            script.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
            document.head.appendChild(script);
        });
    }

    static async _loadTfJs() {
        if (window.tf) return;
        if (!this._tfLoadPromise) {
            this._tfLoadPromise = this._loadScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
        }
        return this._tfLoadPromise;
    }

    static async _loadCocoModel() {
        if (this._cocoModelInstance) return this._cocoModelInstance;
        await this._loadTfJs();
        if (!this._cocoModelLoadPromise) {
            this._cocoModelLoadPromise = (async () => {
                if (!window.cocoSsd) {
                    await this._loadScript("https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js");
                }
                this._cocoModelInstance = await window.cocoSsd.load();
                return this._cocoModelInstance;
            })();
        }
        return this._cocoModelLoadPromise;
    }

    static async _loadOpenCv() {
        if (window.cv && window.cv.Mat) return;
        if (!this._cvLoadPromise) {
            this._cvLoadPromise = (async () => {
                await this._loadScript("https://docs.opencv.org/4.10.0/opencv.js");
                const timeoutMs = 20000;
                const started = Date.now();
                while (!(window.cv && window.cv.Mat)) {
                    if (Date.now() - started > timeoutMs) {
                        throw new Error("Timed out waiting for OpenCV runtime initialization.");
                    }
                    await new Promise((r) => setTimeout(r, 50));
                }
            })();
        }
        return this._cvLoadPromise;
    }

    _getCameraSensor() {
        return this.robot.sensors.find((sensor) => sensor && sensor.type === "camera");
    }

    _getGroqModel() {
        return this.robot.getAiModelByType(this.groqFeedType) || this.robot.getAiModelByName(this.groqFeedType);
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

    /** Pixel bbox [x,y,w,h] → normalized [nx,ny,nw,nh] (x,w vs frame width; y,h vs frame height). */
    _bboxPixelsToNormalized(bbox, fw, fh) {
        if (!fw || !fh) return [0, 0, 0, 0];
        const [x, y, w, h] = bbox;
        return [x / fw, y / fh, w / fw, h / fh];
    }

    /** Normalized bbox from Groq (0–1 per axis) → pixel bbox for internal tracking / IOU. */
    _bboxNormalizedToPixels(bbox, fw, fh) {
        if (!fw || !fh) return [0, 0, 0, 0];
        const [nx, ny, nw, nh] = bbox;
        return [nx * fw, ny * fh, nw * fw, nh * fh];
    }

    _bboxArea(bbox) {
        const w = bbox[2];
        const h = bbox[3];
        return Math.max(1, w * h);
    }

    _percentileLinear(values, p) {
        if (!values || !values.length) return 0;
        const a = [...values].sort((u, v) => u - v);
        const n = a.length;
        const pp = Math.max(0, Math.min(1, p));
        const idx = pp * (n - 1);
        const i0 = Math.floor(idx);
        const i1 = Math.min(n - 1, Math.ceil(idx));
        const t = idx - i0;
        return i0 === i1 ? a[i0] : a[i0] * (1 - t) + a[i1] * t;
    }

    _median(values) {
        if (!values || !values.length) return 0;
        const a = [...values].sort((u, v) => u - v);
        const mid = Math.floor(a.length / 2);
        return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) * 0.5;
    }

    _setTrackAnchorFromBbox(track, bbox) {
        track.anchorArea = this._bboxArea(bbox);
        track.anchorW = Math.max(1, bbox[2]);
        track.anchorH = Math.max(1, bbox[3]);
    }

    _isFeedLockedTrack(track) {
        return !!track?.lockFromFeeds;
    }

    /** Clamp flow-proposed size so it cannot balloon past last detector box (partial off-screen + bad LK). */
    _capFlowBboxToAnchor(minX, minY, bw, bh, track, fw, fh) {
        const aw = track.anchorW && track.anchorW > 0 ? track.anchorW : bw;
        const ah = track.anchorH && track.anchorH > 0 ? track.anchorH : bh;
        let w = bw;
        let h = bh;
        let x = minX;
        let y = minY;
        const maxW = Math.max(8, aw * this.flowMaxBBoxGrow);
        const maxH = Math.max(8, ah * this.flowMaxBBoxGrow);
        if (w > maxW) {
            const cx = x + w * 0.5;
            w = maxW;
            x = cx - w * 0.5;
        }
        if (h > maxH) {
            const cy = y + h * 0.5;
            h = maxH;
            y = cy - h * 0.5;
        }
        return this._clampBbox([x, y, w, h], fw, fh);
    }

    /** Drop tracks whose flow box has collapsed vs last merged detector area, or is trivially tiny. */
    _pruneForgottenTracks(fw, fh, nowMs = Date.now()) {
        const frameArea = Math.max(1, fw * fh);
        const absFloor = Math.max(900, frameArea * this.forgetMinFrameAreaFrac);
        const kept = [];
        for (const t of this._tracks) {
            const area = this._bboxArea(t.bbox);
            if (!t.anchorArea || t.anchorArea < 1) {
                this._setTrackAnchorFromBbox(t, t.bbox);
            }
            const [x, y, w, h] = t.bbox;
            if (t?.manualId === "lastCenter") {
                const touchesEdge = x <= 0 || y <= 0 || x + w >= fw || y + h >= fh;
                if (touchesEdge) {
                    this._releaseTrackMats(t);
                    continue;
                }
            }
            const marginX = fw * this.forgetEdgeMarginFrac;
            const marginY = fh * this.forgetEdgeMarginFrac;
            const nearEdge =
                x <= marginX ||
                y <= marginY ||
                x + w >= fw - marginX ||
                y + h >= fh - marginY;

            if (area < absFloor) {
                this._releaseTrackMats(t);
                continue;
            }

            const ratio = area / t.anchorArea;
            if (!t?.manualId) {
                const staleMs = nowMs - (Number.isFinite(t.lastAnchorUpdateMs) ? t.lastAnchorUpdateMs : 0);
                if (staleMs > this.forgetStaleMs) {
                    this._releaseTrackMats(t);
                    continue;
                }
                if ((t.noPointStreak || 0) >= this.forgetNoPointFrames) {
                    this._releaseTrackMats(t);
                    continue;
                }
            }
            if (!t?.manualId && nearEdge && ratio < this.forgetEdgeAreaRatio) {
                this._releaseTrackMats(t);
                continue;
            }
            if (ratio < this.forgetMinAreaRatio) {
                t._forgetShrinkStreak = (t._forgetShrinkStreak || 0) + 1;
            } else {
                t._forgetShrinkStreak = 0;
            }

            if (t._forgetShrinkStreak >= this.forgetShrinkFrames) {
                this._releaseTrackMats(t);
                continue;
            }
            kept.push(t);
        }
        this._tracks = kept;
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
            if (source === "groq") {
                bbox = this._bboxNormalizedToPixels(bbox, fw, fh);
            }
            bbox = this._clampBbox(bbox, fw, fh);

            let bestIdx = -1;
            let bestIou = 0;
            for (let i = 0; i < this._tracks.length; i++) {
                const t = this._tracks[i];
                if (this._isFeedLockedTrack(t)) continue;
                if (String(t.class || "").toLowerCase() !== label) continue;
                const iou = this._iou(bbox, t.bbox);
                if (iou > bestIou) {
                    bestIou = iou;
                    bestIdx = i;
                }
            }

            if (bestIdx >= 0 && bestIou >= this.mergeIou) {
                const t = this._tracks[bestIdx];
                if (source === "coco" || t.labelSource !== "coco") {
                    t.bbox = bbox;
                    this._setTrackAnchorFromBbox(t, bbox);
                    t._forgetShrinkStreak = 0;
                    t.flowTicks = 0;
                    t.lastAnchorUpdateMs = Date.now();
                    t.noPointStreak = 0;
                }
                if (source === "groq") {
                    t.class = label;
                    t.labelSource = "groq";
                } else if (t.labelSource !== "groq") {
                    t.class = label;
                    t.labelSource = "coco";
                }
                t.score = score;
                t.filterParams = { ...fp, ...t.filterParams };
                t.needsReinit = true;
            } else {
                let altIdx = -1;
                let altIou = 0;
                for (let i = 0; i < this._tracks.length; i++) {
                    if (this._isFeedLockedTrack(this._tracks[i])) continue;
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
                        this._setTrackAnchorFromBbox(t, bbox);
                        t._forgetShrinkStreak = 0;
                        t.flowTicks = 0;
                        t.lastAnchorUpdateMs = Date.now();
                        t.noPointStreak = 0;
                    }
                    if (source === "groq") {
                        t.class = label;
                        t.labelSource = "groq";
                    } else if (t.labelSource !== "groq") {
                        t.class = label;
                        t.labelSource = "coco";
                    }
                    t.score = score;
                    t.filterParams = { ...fp };
                    t.needsReinit = true;
                } else {
                    this._tracks.push({
                        id: this._nextId++,
                        class: label,
                        labelSource: source,
                        score,
                        bbox,
                        anchorArea: this._bboxArea(bbox),
                        anchorW: Math.max(1, bbox[2]),
                        anchorH: Math.max(1, bbox[3]),
                        _forgetShrinkStreak: 0,
                        flowTicks: 0,
                        noPointStreak: 0,
                        lastAnchorUpdateMs: Date.now(),
                        filterParams: { ...fp },
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
            const tickCount = Number.isFinite(track.flowTicks) ? track.flowTicks : 0;
            if (this.flowReinitIntervalFrames > 0 && tickCount > 0 && tickCount % this.flowReinitIntervalFrames === 0) {
                track.needsReinit = true;
            }
            if (track.needsReinit) {
                this._initTrackPoints(track, curGray);
                const okPts = track.prevPts && track.prevPts.rows >= fp.minGoodPoints;
                track.needsReinit = !okPts;
                if (!okPts) {
                    track.noPointStreak = (track.noPointStreak || 0) + 1;
                }
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
            const goodDx = [];
            const goodDy = [];
            const st = status.data || status.data8U;
            for (let i = 0; i < status.rows; i++) {
                const ok = st ? st[i] : 0;
                if (ok === 1) {
                    const nx = nextPts.data32F[i * 2];
                    const ny = nextPts.data32F[i * 2 + 1];
                    const px = track.prevPts.data32F[i * 2];
                    const py = track.prevPts.data32F[i * 2 + 1];
                    goodX.push(nx);
                    goodY.push(ny);
                    goodDx.push(nx - px);
                    goodDy.push(ny - py);
                }
            }

            track.prevPts.delete();
            track.prevPts = null;
            status.delete();
            err.delete();
            nextPts.delete();

            if (goodX.length >= fp.minGoodPoints) {
                const lo = this.flowBboxPctLow;
                const hi = this.flowBboxPctHigh;
                let minX = this._percentileLinear(goodX, lo);
                let maxX = this._percentileLinear(goodX, hi);
                let minY = this._percentileLinear(goodY, lo);
                let maxY = this._percentileLinear(goodY, hi);
                if (maxX <= minX) {
                    minX = Math.min(...goodX);
                    maxX = Math.max(...goodX);
                }
                if (maxY <= minY) {
                    minY = Math.min(...goodY);
                    maxY = Math.max(...goodY);
                }
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
                const prevW = Math.max(8, track.bbox[2]);
                const prevH = Math.max(8, track.bbox[3]);
                const prevCx = track.bbox[0] + prevW * 0.5;
                const prevCy = track.bbox[1] + prevH * 0.5;
                const medDx = this._median(goodDx);
                const medDy = this._median(goodDy);
                const cx = prevCx + medDx;
                const cy = prevCy + medDy;
                const minW = prevW * (1 - this.flowMaxShrinkPerTick);
                const minH = prevH * (1 - this.flowMaxShrinkPerTick);
                const measuredW = Math.max(bw, minW);
                const measuredH = Math.max(bh, minH);
                const inertia = this.flowSizeInertia;
                const smoothW = prevW * inertia + measuredW * (1 - inertia);
                const smoothH = prevH * inertia + measuredH * (1 - inertia);
                const nextMinX = cx - smoothW * 0.5;
                const nextMinY = cy - smoothH * 0.5;
                track.bbox = this._capFlowBboxToAnchor(nextMinX, nextMinY, smoothW, smoothH, track, fw, fh);
                track.flowTicks = tickCount + 1;
                track.noPointStreak = 0;

                const flat = [];
                for (let i = 0; i < goodX.length; i++) {
                    flat.push(goodX[i], goodY[i]);
                }
                track.prevPts = cv.matFromArray(flat.length / 2, 1, cv.CV_32FC2, flat);
            } else {
                track.needsReinit = true;
                track.noPointStreak = (track.noPointStreak || 0) + 1;
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

            ctx.strokeStyle = "#ff3333";
            ctx.strokeRect(bx, by, bw, bh);
            const labelW = ctx.measureText(label).width + 8;
            const labelH = 16;
            ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
            ctx.fillRect(bx, Math.max(0, by - labelH), labelW, labelH);
            ctx.fillStyle = "#ff3333";
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
            cocoFeed: "internal",
            cocoRefreshMs: this.cocoRefreshMs,
            tracks: this._tracks.map((t) => {
                const fw = this._frameWidth || 1;
                const fh = this._frameHeight || 1;
                const [nx, ny, nw, nh] = this._bboxPixelsToNormalized(t.bbox, fw, fh);
                return {
                    id: t.id,
                    name: t.class,
                    labelSource: t.labelSource || "coco",
                    score: Number(t.score.toFixed(3)),
                    bbox: {
                        x: Number(nx.toFixed(4)),
                        y: Number(ny.toFixed(4)),
                        width: Number(nw.toFixed(4)),
                        height: Number(nh.toFixed(4))
                    },
                    bboxUnit: "normalized01"
                };
            })
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
            await ComputerVisionAiModel._loadOpenCv();
            const cocoModel = await ComputerVisionAiModel._loadCocoModel();
            const cv = window.cv;
            this._ensureOverlay();
            this._frameWidth = videoEl.videoWidth || 0;
            this._frameHeight = videoEl.videoHeight || 0;

            rgba = this._getFrameMat(videoEl);
            if (!rgba || rgba.empty()) return;

            gray = new cv.Mat();
            cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);

            const now = Date.now();
            const cocoPeriodic = now - this._lastCocoReanchorMs >= this.cocoRefreshMs;
            if (cocoPeriodic) {
                this._lastCocoReanchorMs = now;
                const rawCocoDets = await cocoModel.detect(videoEl, this.maxNumBoxes, this.minScore);
                const cocoDets = Array.isArray(rawCocoDets)
                    ? rawCocoDets.map((d) => ({
                        class: String(d?.class || "").trim().toLowerCase(),
                        score: Number.isFinite(d?.score) ? d.score : 0,
                        bbox: Array.isArray(d?.bbox) ? [...d.bbox] : [0, 0, 0, 0]
                    }))
                    : [];
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

            this._pruneForgottenTracks(gray.cols, gray.rows, now);

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
                this._statusEl.textContent = `Tracking ${this._detections.length} object(s) at ${this.frequencyHz} Hz (COCO geometry + Groq labels: ${groqLabels})`;
                this._statusEl.className = "muted";
            }
        } catch (err) {
            console.error("ComputerVision error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = `ComputerVision error: ${err?.message || "unknown error"}`;
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
            ComputerVisionAiModel.MIN_TICK_INTERVAL_MS,
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
                this._statusEl.textContent = "Loading computer vision runtime...";
                this._statusEl.className = "muted";
            }
            try {
                await ComputerVisionAiModel._loadOpenCv();
                await ComputerVisionAiModel._loadCocoModel();
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
            ComputerVisionAiModel.MIN_FREQUENCY_HZ,
            Math.min(ComputerVisionAiModel.MAX_FREQUENCY_HZ, parsed)
        );
        if (this._freqInput) this._freqInput.value = String(this.frequencyHz);
        if (this.enabled) this._startLoop();
    }

    setMinScore(nextValue) {
        const parsed = Number(nextValue);
        if (!Number.isFinite(parsed)) return;
        this.minScore = Math.max(
            ComputerVisionAiModel.MIN_SCORE,
            Math.min(ComputerVisionAiModel.MAX_SCORE, parsed)
        );
        if (this._minScoreInput) this._minScoreInput.value = String(Number(this.minScore.toFixed(3)));
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

    setForgetStaleMs(nextMs) {
        const parsed = Number(nextMs);
        if (!Number.isFinite(parsed)) return;
        this.forgetStaleMs = Math.max(500, Math.min(120000, Math.round(parsed)));
        if (this._forgetStaleInput) this._forgetStaleInput.value = String(this.forgetStaleMs);
    }

    makeCenterObject() {
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        const fw = (videoEl?.videoWidth | 0) || (this._frameWidth | 0);
        const fh = (videoEl?.videoHeight | 0) || (this._frameHeight | 0);
        if (!fw || !fh) {
            if (this._statusEl) {
                this._statusEl.textContent = "Cannot create center object: camera frame unavailable.";
                this._statusEl.className = "error";
            }
            return false;
        }

        const kept = [];
        for (const t of this._tracks) {
            if (t?.manualId === "lastCenter") {
                this._releaseTrackMats(t);
                continue;
            }
            kept.push(t);
        }
        this._tracks = kept;

        const w = Math.max(8, fw * 0.2);
        const h = Math.max(8, fh * 0.2);
        const x = (fw - w) * 0.5;
        const y = (fh - h) * 0.5;
        const bbox = this._clampBbox([x, y, w, h], fw, fh);

        this._tracks.push({
            id: this._nextId++,
            manualId: "lastCenter",
            class: "lastCenter",
            labelSource: "manual",
            score: 1,
            bbox,
            anchorArea: this._bboxArea(bbox),
            anchorW: Math.max(1, bbox[2]),
            anchorH: Math.max(1, bbox[3]),
            lockFromFeeds: true,
            _forgetShrinkStreak: 0,
            flowTicks: 0,
            noPointStreak: 0,
            lastAnchorUpdateMs: Date.now(),
            filterParams: { ...this.filterParams },
            needsReinit: true,
            prevPts: null
        });

        this._syncDetectionsFromTracks();
        if (videoEl) this._drawDetections(videoEl, this._detections);
        this._renderResponseOutput();
        if (this._statusEl) {
            this._statusEl.textContent = "Created center object (label/id: lastCenter).";
            this._statusEl.className = "muted";
        }
        return true;
    }

    getFrequencyHz() {
        return this.frequencyHz;
    }

    getLatestDetections() {
        const fw = this._frameWidth || 1;
        const fh = this._frameHeight || 1;
        return this._detections.map((item) => ({
            class: item.class,
            score: item.score,
            bbox: Array.isArray(item.bbox)
                ? this._bboxPixelsToNormalized(item.bbox, fw, fh)
                : [0, 0, 0, 0],
            bboxUnit: "normalized01"
        }));
    }

    /**
     * Tracks as normalized boxes: bbox is [x,y,w,h] with x,w relative to frame width and y,h to height (0–1).
     * Readable via `robot.stateMachine` paths.
     */
    get results() {
        const fw = this._frameWidth || 1;
        const fh = this._frameHeight || 1;
        return this._tracks.map((t) => ({
            id: t.id,
            class: t.class,
            score: Number(t.score),
            bbox: Array.isArray(t.bbox) ? this._bboxPixelsToNormalized(t.bbox, fw, fh) : [0, 0, 0, 0],
            bboxUnit: "normalized01",
            labelSource: t.labelSource || "coco"
        }));
    }

    getFrameSize() {
        return { width: this._frameWidth, height: this._frameHeight };
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model ai-model-computervision";

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
        freqLabel.textContent = "Computer vision frequency (Hz)";
        const freqInput = document.createElement("input");
        freqInput.type = "number";
        freqInput.min = String(ComputerVisionAiModel.MIN_FREQUENCY_HZ);
        freqInput.max = String(ComputerVisionAiModel.MAX_FREQUENCY_HZ);
        freqInput.step = "1";
        freqInput.value = String(this.frequencyHz);
        freqInput.addEventListener("change", () => this.setFrequencyHz(freqInput.value));
        freqInput.addEventListener("blur", () => this.setFrequencyHz(freqInput.value));

        const minScoreLabel = document.createElement("label");
        minScoreLabel.textContent = "COCO min score (detection sensitivity)";
        const minScoreInput = document.createElement("input");
        minScoreInput.type = "number";
        minScoreInput.min = String(ComputerVisionAiModel.MIN_SCORE);
        minScoreInput.max = String(ComputerVisionAiModel.MAX_SCORE);
        minScoreInput.step = "0.01";
        minScoreInput.value = String(Number(this.minScore.toFixed(3)));
        minScoreInput.addEventListener("change", () => this.setMinScore(minScoreInput.value));
        minScoreInput.addEventListener("blur", () => this.setMinScore(minScoreInput.value));

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
        cocoRefreshLabel.textContent = "Min ms between internal COCO detections";
        const cocoRefreshInput = document.createElement("input");
        cocoRefreshInput.type = "number";
        cocoRefreshInput.min = "100";
        cocoRefreshInput.max = "120000";
        cocoRefreshInput.step = "100";
        cocoRefreshInput.value = String(this.cocoRefreshMs);
        cocoRefreshInput.addEventListener("change", () => this.setCocoRefreshMs(cocoRefreshInput.value));
        cocoRefreshInput.addEventListener("blur", () => this.setCocoRefreshMs(cocoRefreshInput.value));

        const forgetStaleLabel = document.createElement("label");
        forgetStaleLabel.textContent = "Max ms since last COCO/Groq anchor before dropping track";
        const forgetStaleInput = document.createElement("input");
        forgetStaleInput.type = "number";
        forgetStaleInput.min = "500";
        forgetStaleInput.max = "120000";
        forgetStaleInput.step = "100";
        forgetStaleInput.value = String(this.forgetStaleMs);
        forgetStaleInput.addEventListener("change", () => this.setForgetStaleMs(forgetStaleInput.value));
        forgetStaleInput.addEventListener("blur", () => this.setForgetStaleMs(forgetStaleInput.value));

        const makeCenterBtn = document.createElement("button");
        makeCenterBtn.type = "button";
        makeCenterBtn.textContent = "Make Center Object";
        makeCenterBtn.addEventListener("click", () => this.makeCenterObject());

        const hint = document.createElement("p");
        hint.className = "muted";
        hint.textContent = `Uses internal COCO for bbox geometry (pixels) and "${this.groqFeedType}" for label updates; exported detections/results use bbox 0–1 (x,w vs width, y,h vs height). Groq can overwrite labels, COCO cannot overwrite Groq labels.`;

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Model off.";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        controls.appendChild(toggleBtn);
        controls.appendChild(freqLabel);
        controls.appendChild(freqInput);
        controls.appendChild(minScoreLabel);
        controls.appendChild(minScoreInput);
        controls.appendChild(refreshLabel);
        controls.appendChild(refreshInput);
        controls.appendChild(cocoRefreshLabel);
        controls.appendChild(cocoRefreshInput);
        controls.appendChild(forgetStaleLabel);
        controls.appendChild(forgetStaleInput);
        controls.appendChild(makeCenterBtn);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(hint);
        wrap.appendChild(status);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._freqInput = freqInput;
        this._minScoreInput = minScoreInput;
        this._refreshInput = refreshInput;
        this._cocoRefreshInput = cocoRefreshInput;
        this._forgetStaleInput = forgetStaleInput;
        this._makeCenterBtn = makeCenterBtn;
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

window.ComputerVisionAiModel = ComputerVisionAiModel;
