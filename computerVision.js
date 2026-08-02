/**
 * Computer vision fusion model:
 * - Modes: opencv (COCO + optical flow), coco (COCO only), movenet (pose).
 * - Lower-frequency Groq updates for stronger labels (opencv/coco).
 * - Optical-flow between informer updates to reduce flicker (opencv).
 * - Optional tap-to-track ORB cluster (fixed fingerprint, homography updates).
 */
class ComputerVisionAiModel {
    static _cvLoadPromise = null;
    static _tfLoadPromise = null;
    static _cocoModelLoadPromise = null;
    static _cocoModelInstance = null;
    static _poseDetectionLoadPromise = null;
    static _moveNetLoadPromise = null;
    static _moveNetInstance = null;

    static MIN_FREQUENCY_HZ = 1;
    static MAX_FREQUENCY_HZ = 30;
    static MIN_TICK_INTERVAL_MS = 33;
    static MIN_BOXES = 1;
    static MAX_BOXES = 100;
    static MIN_SCORE = 0.01;
    static MAX_SCORE = 0.99;

    /** @type {readonly string[]} */
    static MODEL_OPTIONS = Object.freeze(["opencv", "coco", "movenet"]);

    /** MoveNet / COCO-17 skeleton edges by keypoint name. */
    static MOVENET_SKELETON = Object.freeze([
        ["nose", "left_eye"],
        ["nose", "right_eye"],
        ["left_eye", "left_ear"],
        ["right_eye", "right_ear"],
        ["left_shoulder", "right_shoulder"],
        ["left_shoulder", "left_elbow"],
        ["left_elbow", "left_wrist"],
        ["right_shoulder", "right_elbow"],
        ["right_elbow", "right_wrist"],
        ["left_shoulder", "left_hip"],
        ["right_shoulder", "right_hip"],
        ["left_hip", "right_hip"],
        ["left_hip", "left_knee"],
        ["left_knee", "left_ankle"],
        ["right_hip", "right_knee"],
        ["right_knee", "right_ankle"]
    ]);

    /** Flow-touch box side length options: % of intrinsic frame width (square). */
    static FLOW_TOUCH_BOX_WIDTH_PCT_OPTIONS = Object.freeze([10, 15, 20, 25, 30]);
    static _FLOW_TOUCH_BOX_WIDTH_PCT_STORAGE_KEY = "phonebot.flowTouchBoxWidthPct";

    /** @param {number} value */
    static normalizeFlowTouchBoxWidthPercent(value) {
        const allowed = ComputerVisionAiModel.FLOW_TOUCH_BOX_WIDTH_PCT_OPTIONS;
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return 10;
        if (allowed.includes(n)) return n;
        return allowed.reduce((best, a) => (Math.abs(a - n) < Math.abs(best - n) ? a : best));
    }

    /** @param {unknown} value */
    static normalizeModel(value) {
        const raw = String(value == null ? "" : value)
            .trim()
            .toLowerCase()
            .replace(/[\s_-]+/g, "");
        if (raw === "movenet" || raw === "pose" || raw === "posenet") return "movenet";
        if (raw === "coco" || raw === "cocossd") return "coco";
        if (raw === "opencv" || raw === "cv" || raw === "flow") return "opencv";
        return "opencv";
    }

    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "computervision";
        this.name = config.name || "Computer vision";
        this.enabled = false;
        this.model = ComputerVisionAiModel.normalizeModel(config.model ?? config.defaultModel ?? "opencv");
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
        this.orbTapBoxFrac = Number.isFinite(config.orbTapBoxFrac) ? config.orbTapBoxFrac : 0.25;
        this.orbTapBoxFrac = Math.max(0.05, Math.min(0.8, this.orbTapBoxFrac));
        this.orbMinMatches = Number.isFinite(config.orbMinMatches) ? Math.round(config.orbMinMatches) : 12;
        this.orbMinMatches = Math.max(4, Math.min(200, this.orbMinMatches));
        this.orbRatioTest = Number.isFinite(config.orbRatioTest) ? config.orbRatioTest : 0.78;
        this.orbRatioTest = Math.max(0.4, Math.min(0.95, this.orbRatioTest));
        this.orbRansacThresholdPx = Number.isFinite(config.orbRansacThresholdPx) ? config.orbRansacThresholdPx : 4;
        this.orbRansacThresholdPx = Math.max(1, Math.min(20, this.orbRansacThresholdPx));
        this.orbMinInlierRatio = Number.isFinite(config.orbMinInlierRatio) ? config.orbMinInlierRatio : 0.45;
        this.orbMinInlierRatio = Math.max(0.1, Math.min(1, this.orbMinInlierRatio));
        this.orbFeatureCount = Number.isFinite(config.orbFeatureCount) ? Math.round(config.orbFeatureCount) : 500;
        this.orbFeatureCount = Math.max(100, Math.min(2000, this.orbFeatureCount));
        this.orbSearchMargin = Number.isFinite(config.orbSearchMargin) ? config.orbSearchMargin : 1.8;
        this.orbSearchMargin = Math.max(1.05, Math.min(4, this.orbSearchMargin));
        this.orbFullFrameAfterMisses = Number.isFinite(config.orbFullFrameAfterMisses)
            ? Math.round(config.orbFullFrameAfterMisses)
            : 10;
        this.orbFullFrameAfterMisses = Math.max(0, Math.min(300, this.orbFullFrameAfterMisses));
        this.orbMaxCenterJumpFrac = Number.isFinite(config.orbMaxCenterJumpFrac) ? config.orbMaxCenterJumpFrac : 0.25;
        this.orbMaxCenterJumpFrac = Math.max(0.02, Math.min(0.9, this.orbMaxCenterJumpFrac));
        this.orbAreaRatioMin = Number.isFinite(config.orbAreaRatioMin) ? config.orbAreaRatioMin : 0.4;
        this.orbAreaRatioMin = Math.max(0.05, Math.min(1, this.orbAreaRatioMin));
        this.orbAreaRatioMax = Number.isFinite(config.orbAreaRatioMax) ? config.orbAreaRatioMax : 2.8;
        this.orbAreaRatioMax = Math.max(1, Math.min(20, this.orbAreaRatioMax));
        this.orbAspectRatioJumpMax = Number.isFinite(config.orbAspectRatioJumpMax) ? config.orbAspectRatioJumpMax : 2.2;
        this.orbAspectRatioJumpMax = Math.max(1.05, Math.min(10, this.orbAspectRatioJumpMax));
        this.orbUpdateTemplateMinInlierRatio = Number.isFinite(config.orbUpdateTemplateMinInlierRatio)
            ? config.orbUpdateTemplateMinInlierRatio
            : 0.78;
        this.orbUpdateTemplateMinInlierRatio = Math.max(0.2, Math.min(0.99, this.orbUpdateTemplateMinInlierRatio));
        this.orbUpdateTemplateMinMatches = Number.isFinite(config.orbUpdateTemplateMinMatches)
            ? Math.round(config.orbUpdateTemplateMinMatches)
            : 28;
        this.orbUpdateTemplateMinMatches = Math.max(6, Math.min(500, this.orbUpdateTemplateMinMatches));

        let flowTouchPct = Number.isFinite(config.flowTouchBoxWidthPercent) ? config.flowTouchBoxWidthPercent : 10;
        try {
            if (typeof localStorage !== "undefined") {
                const s = localStorage.getItem(ComputerVisionAiModel._FLOW_TOUCH_BOX_WIDTH_PCT_STORAGE_KEY);
                if (s != null && s !== "") {
                    const parsed = Number(s);
                    if (Number.isFinite(parsed)) flowTouchPct = parsed;
                }
            }
        } catch (_) {}
        this.flowTouchBoxWidthPercent = ComputerVisionAiModel.normalizeFlowTouchBoxWidthPercent(flowTouchPct);

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
        this._poses = [];

        this._toggleBtn = null;
        this._modelSelect = null;
        this._freqInput = null;
        this._minScoreInput = null;
        this._refreshInput = null;
        this._cocoRefreshInput = null;
        this._forgetStaleInput = null;
        this._flowBboxPctLowInput = null;
        this._makeCenterBtn = null;
        this._makeCenterOrbBtn = null;
        this._hintEl = null;
        this._statusEl = null;
        this._outputEl = null;
        this._statusHoldUntilMs = 0;
        this._framePointerTarget = null;
        this._onFramePointerDown = (ev) => this._handleFramePointerDown(ev);
        this._lastTapMarker = null;
    }

    getFlowTouchBoxWidthPercent() {
        return this.flowTouchBoxWidthPercent;
    }

    /**
     * @param {number} pct one of {@link ComputerVisionAiModel.FLOW_TOUCH_BOX_WIDTH_PCT_OPTIONS}
     * @returns {number} normalized stored value
     */
    setFlowTouchBoxWidthPercent(pct) {
        this.flowTouchBoxWidthPercent = ComputerVisionAiModel.normalizeFlowTouchBoxWidthPercent(pct);
        try {
            if (typeof localStorage !== "undefined") {
                localStorage.setItem(
                    ComputerVisionAiModel._FLOW_TOUCH_BOX_WIDTH_PCT_STORAGE_KEY,
                    String(this.flowTouchBoxWidthPercent)
                );
            }
        } catch (_) {}
        return this.flowTouchBoxWidthPercent;
    }

    _flowTouchCellPx(fw) {
        return Math.max(8, fw * (this.flowTouchBoxWidthPercent / 100));
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

    static async _loadPoseDetection() {
        if (window.poseDetection) return;
        await this._loadTfJs();
        if (!this._poseDetectionLoadPromise) {
            this._poseDetectionLoadPromise = this._loadScript(
                "https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js"
            );
        }
        await this._poseDetectionLoadPromise;
        if (!window.poseDetection) {
            throw new Error("pose-detection loaded but window.poseDetection is missing.");
        }
    }

    static async _loadMoveNet() {
        if (this._moveNetInstance) return this._moveNetInstance;
        await this._loadPoseDetection();
        if (!this._moveNetLoadPromise) {
            this._moveNetLoadPromise = (async () => {
                const poseDetection = window.poseDetection;
                const modelType =
                    poseDetection.movenet?.modelType?.SINGLEPOSE_LIGHTNING || "SinglePose.Lightning";
                this._moveNetInstance = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
                    modelType
                });
                return this._moveNetInstance;
            })();
        }
        return this._moveNetLoadPromise;
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
        return this.robot.getProcessingByType(this.groqFeedType) || this.robot.getProcessingByName(this.groqFeedType);
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

    /**
     * How intrinsic video pixels map into the HTMLVideoElement layout box when the element
     * uses object-fit: contain (uniform scale + letterboxing). Same mapping as drawImage(video,0,0,W,H)
     * when W:H matches the frame aspect.
     * @param {HTMLVideoElement} videoEl
     * @returns {{ vw: number, vh: number, cw: number, ch: number, scale: number, offsetX: number, offsetY: number } | null}
     */
    static objectFitContainVideoTransform(videoEl) {
        if (!videoEl) return null;
        const vw = videoEl.videoWidth | 0;
        const vh = videoEl.videoHeight | 0;
        const cw = videoEl.clientWidth || vw || 0;
        const ch = videoEl.clientHeight || vh || 0;
        if (!vw || !vh || !cw || !ch) return null;
        const scale = Math.min(cw / vw, ch / vh);
        const offsetX = (cw - vw * scale) * 0.5;
        const offsetY = (ch - vh * scale) * 0.5;
        return { vw, vh, cw, ch, scale, offsetX, offsetY };
    }

    /** Intrinsic pixel bbox [x,y,w,h] → rectangle in video element local CSS pixels (overlay canvas space). */
    static intrinsicBboxToVideoElementLocalRect(bbox, t) {
        if (!t || !bbox) return { x: 0, y: 0, w: 0, h: 0 };
        const [x, y, w, h] = bbox;
        return {
            x: t.offsetX + x * t.scale,
            y: t.offsetY + y * t.scale,
            w: w * t.scale,
            h: h * t.scale
        };
    }

    /**
     * Pointer position in video element local pixels (0..clientWidth) → intrinsic frame pixels.
     * @returns {{ vx: number, vy: number } | null} null if outside the painted video area (letterbox).
     */
    static videoElementLocalToIntrinsicPx(videoEl, localX, localY) {
        const t = ComputerVisionAiModel.objectFitContainVideoTransform(videoEl);
        if (!t) return null;
        const u = localX - t.offsetX;
        const v = localY - t.offsetY;
        const dw = t.vw * t.scale;
        const dh = t.vh * t.scale;
        if (u < 0 || v < 0 || u > dw || v > dh) return null;
        return { vx: u / t.scale, vy: v / t.scale };
    }

    static clampBbox(bbox, fw, fh) {
        let [x, y, w, h] = bbox;
        x = Math.max(0, Math.min(fw - 1, x));
        y = Math.max(0, Math.min(fh - 1, y));
        w = Math.max(1, Math.min(fw - x, w));
        h = Math.max(1, Math.min(fh - y, h));
        return [x, y, w, h];
    }

    _clampBbox(bbox, fw, fh) {
        return ComputerVisionAiModel.clampBbox(bbox, fw, fh);
    }

    /**
     * Pixel center of the fixed flow-touch cell that {@link #createFlowObjectAt} would create
     * after edge clamping (same as the red overlay box center).
     * @param {number} fromX
     * @param {number} fromY
     * @param {number} fw
     * @param {number} fh
     * @param {number} [boxWidthPercent] % of frame width (defaults to 10; should match {@link #flowTouchBoxWidthPercent} when mirroring UI).
     * @returns {{ cx: number, cy: number } | null}
     */
    static flowTouchCenterPxForAgentNorm(fromX, fromY, fw, fh, boxWidthPercent) {
        if (!fw || !fh) return null;
        const nx = Math.min(1, Math.max(0, Number(fromX)));
        const ny = Math.min(1, Math.max(0, Number(fromY)));
        const frameX = nx * fw;
        const frameY = ny * fh;
        const pct = ComputerVisionAiModel.normalizeFlowTouchBoxWidthPercent(
            boxWidthPercent != null ? boxWidthPercent : 10
        );
        const cell = Math.max(8, fw * (pct / 100));
        const [x, y, w, h] = ComputerVisionAiModel.clampBbox(
            [frameX - cell * 0.5, frameY - cell * 0.5, cell, cell],
            fw,
            fh
        );
        return { cx: x + w * 0.5, cy: y + h * 0.5 };
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
            if (t?.trackerType === "orb") {
                kept.push(t);
                continue;
            }
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
        if (track?.orbTemplateDesc) {
            try {
                track.orbTemplateDesc.delete();
            } catch (_) {}
            track.orbTemplateDesc = null;
        }
        if (track?.orbAdaptiveDesc) {
            try {
                track.orbAdaptiveDesc.delete();
            } catch (_) {}
            track.orbAdaptiveDesc = null;
        }
    }

    _releaseAllTrackPts(releaseOrbTemplate = false) {
        for (const t of this._tracks) {
            if (t?.prevPts) {
                try {
                    t.prevPts.delete();
                } catch (_) {}
                t.prevPts = null;
            }
            if (releaseOrbTemplate && t?.orbTemplateDesc) {
                try {
                    t.orbTemplateDesc.delete();
                } catch (_) {}
                t.orbTemplateDesc = null;
            }
        }
    }

    _setStatus(text, className = "muted", holdMs = 0) {
        if (!this._statusEl) return;
        this._statusEl.textContent = String(text || "");
        this._statusEl.className = className;
        this._statusHoldUntilMs = holdMs > 0 ? Date.now() + holdMs : 0;
    }

    _canAutoUpdateStatus() {
        return !this._statusHoldUntilMs || Date.now() >= this._statusHoldUntilMs;
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
            if (track?.trackerType === "orb") {
                continue;
            }
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
                if (track?.manualId === "flowTouch" || track?.manualId === "flowDice4") {
                    // Fixed-size manual box(es): translate with median LK motion only.
                    const nextMinX = cx - prevW * 0.5;
                    const nextMinY = cy - prevH * 0.5;
                    track.bbox = this._clampBbox([nextMinX, nextMinY, prevW, prevH], fw, fh);
                    track.flowTicks = tickCount + 1;
                    track.noPointStreak = 0;

                    const flat = [];
                    for (let i = 0; i < goodX.length; i++) {
                        flat.push(goodX[i], goodY[i]);
                    }
                    track.prevPts = cv.matFromArray(flat.length / 2, 1, cv.CV_32FC2, flat);
                    continue;
                }
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

    _createOrbDetector() {
        const cv = window.cv;
        const scoreTypeHarris =
            Number.isFinite(cv?.ORB_HARRIS_SCORE) ? cv.ORB_HARRIS_SCORE : 0;
        if (cv?.ORB?.create && typeof cv.ORB.create === "function") {
            try {
                return cv.ORB.create(
                    this.orbFeatureCount,
                    1.2,
                    8,
                    31,
                    0,
                    2,
                    scoreTypeHarris,
                    31,
                    20
                );
            } catch (_) {
                // Some OpenCV.js builds fail when ScoreType bindings are unavailable.
                return cv.ORB.create(this.orbFeatureCount);
            }
        }
        try {
            return new cv.ORB(
                this.orbFeatureCount,
                1.2,
                8,
                31,
                0,
                2,
                scoreTypeHarris,
                31,
                20
            );
        } catch (_) {
            return new cv.ORB(this.orbFeatureCount);
        }
    }

    _createOrbMatcher() {
        const cv = window.cv;
        if (cv?.BFMatcher?.create && typeof cv.BFMatcher.create === "function") {
            return cv.BFMatcher.create(cv.NORM_HAMMING, false);
        }
        return new cv.BFMatcher(cv.NORM_HAMMING, false);
    }

    _attachFramePointerHandler() {
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return;
        if (this._framePointerTarget === frameEl) return;
        this._detachFramePointerHandler();
        frameEl.addEventListener("pointerdown", this._onFramePointerDown);
        this._framePointerTarget = frameEl;
    }

    _detachFramePointerHandler() {
        if (!this._framePointerTarget) return;
        this._framePointerTarget.removeEventListener("pointerdown", this._onFramePointerDown);
        this._framePointerTarget = null;
    }

    async _handleFramePointerDown(ev) {
        if (!this.enabled) return;
        if (this.model !== "opencv") return;
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return;
        const rect = videoEl.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = Number(ev.clientX);
        const py = Number(ev.clientY);
        if (!Number.isFinite(px) || !Number.isFinite(py)) return;
        if (px < rect.left || py < rect.top || px > rect.right || py > rect.bottom) return;
        const localX = px - rect.left;
        const localY = py - rect.top;
        const mapped = ComputerVisionAiModel.videoElementLocalToIntrinsicPx(videoEl, localX, localY);
        if (!mapped) return;
        const vx = mapped.vx;
        const vy = mapped.vy;
        this._lastTapMarker = { x: vx, y: vy, untilMs: Date.now() + 1000 };
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        await this.createFlowObjectAt(vx, vy);
    }

    async createFlowObjectAt(frameX, frameY) {
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        const fw = (videoEl?.videoWidth | 0) || (this._frameWidth | 0);
        const fh = (videoEl?.videoHeight | 0) || (this._frameHeight | 0);
        if (!fw || !fh) {
            this._setStatus("Cannot create flow object: camera frame unavailable.", "error", 3500);
            return false;
        }

        const cell = this._flowTouchCellPx(fw);
        const bbox = this._clampBbox([frameX - cell * 0.5, frameY - cell * 0.5, cell, cell], fw, fh);

        const kept = [];
        for (const t of this._tracks) {
            if (t?.manualId === "flowTouch" || t?.manualId === "flowDice4") {
                this._releaseTrackMats(t);
                continue;
            }
            kept.push(t);
        }
        this._tracks = kept;

        this._tracks.push({
            id: this._nextId++,
            manualId: "flowTouch",
            class: "flow",
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
        this._setStatus(
            `Created fixed flow box (${this.flowTouchBoxWidthPercent}% frame width) at touch.`,
            "muted",
            2200
        );
        return true;
    }

    /** Remove tap- or agent-placed flow tracks (same classes cleared when placing a new flow box). */
    clearManualFlowTracks() {
        const kept = [];
        for (const t of this._tracks) {
            if (t?.manualId === "flowTouch" || t?.manualId === "flowDice4") {
                this._releaseTrackMats(t);
                continue;
            }
            kept.push(t);
        }
        this._tracks = kept;
        this._syncDetectionsFromTracks();
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (videoEl) this._drawDetections(videoEl, this._detections);
        this._renderResponseOutput();
        this._setStatus("Removed manual flow box.", "muted", 2200);
    }

    async createOrbObjectAt(frameX, frameY) {
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) {
            this._setStatus("Cannot create ORB object: camera frame unavailable.", "error", 3500);
            return false;
        }
        try {
            await ComputerVisionAiModel._loadOpenCv();
            const cv = window.cv;
            let rgba = null;
            let gray = null;
            let roi = null;
            let mask = null;
            let orb = null;
            let keypoints = null;
            let desc = null;
            try {
                rgba = this._getFrameMat(videoEl);
                if (!rgba || rgba.empty()) throw new Error("Frame capture failed.");
                gray = new cv.Mat();
                cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
                const fw = gray.cols;
                const fh = gray.rows;
                const boxSize = Math.max(16, fw * this.orbTapBoxFrac);
                const bbox = this._clampBbox([frameX - boxSize * 0.5, frameY - boxSize * 0.5, boxSize, boxSize], fw, fh);
                const rx = Math.max(0, Math.floor(bbox[0]));
                const ry = Math.max(0, Math.floor(bbox[1]));
                const rw = Math.max(8, Math.min(fw - rx, Math.floor(bbox[2])));
                const rh = Math.max(8, Math.min(fh - ry, Math.floor(bbox[3])));
                const rect = new cv.Rect(rx, ry, rw, rh);
                roi = gray.roi(rect);
                mask = new cv.Mat();
                orb = this._createOrbDetector();
                keypoints = new cv.KeyPointVector();
                desc = new cv.Mat();
                orb.detectAndCompute(roi, mask, keypoints, desc, false);
                if (desc.empty() || keypoints.size() < this.orbMinMatches) {
                    throw new Error(`Not enough ORB features in touch box (${keypoints.size()}).`);
                }
                const templatePts = [];
                for (let i = 0; i < keypoints.size(); i++) {
                    const kp = keypoints.get(i);
                    templatePts.push([kp.pt.x, kp.pt.y]);
                }

                const kept = [];
                for (const t of this._tracks) {
                    if (t?.manualId === "orbTouch") {
                        this._releaseTrackMats(t);
                        continue;
                    }
                    kept.push(t);
                }
                this._tracks = kept;
                this._tracks.push({
                    id: this._nextId++,
                    manualId: "orbTouch",
                    class: "orb",
                    labelSource: "manual",
                    score: 1,
                    bbox: [rx, ry, rw, rh],
                    anchorArea: this._bboxArea([rx, ry, rw, rh]),
                    anchorW: Math.max(1, rw),
                    anchorH: Math.max(1, rh),
                    lockFromFeeds: true,
                    trackerType: "orb",
                    _forgetShrinkStreak: 0,
                    flowTicks: 0,
                    noPointStreak: 0,
                    lastAnchorUpdateMs: Date.now(),
                    filterParams: { ...this.filterParams },
                    needsReinit: false,
                    prevPts: null,
                    orbTemplateSize: { width: rw, height: rh },
                    orbTemplatePts: templatePts,
                    orbTemplateDesc: desc.clone()
                });
                this._syncDetectionsFromTracks();
                this._drawDetections(videoEl, this._detections);
                this._renderResponseOutput();
                this._setStatus(`Created ORB object at touch (${templatePts.length} keypoints).`, "muted", 2200);
                return true;
            } finally {
                if (keypoints) keypoints.delete();
                if (desc) desc.delete();
                if (orb) orb.delete();
                if (mask) mask.delete();
                if (roi) roi.delete();
                if (gray) gray.delete();
                if (rgba) rgba.delete();
            }
        } catch (err) {
            console.error("ORB create failed:", err);
            this._setStatus(`ORB create failed: ${err?.message || "unknown error"}`, "error", 5000);
            return false;
        }
    }

    _updateOrbTracks(gray) {
        const cv = window.cv;
        const orbTracks = this._tracks.filter((t) => t?.trackerType === "orb" && t?.orbTemplateDesc && t?.orbTemplatePts);
        if (!orbTracks.length) return;
        const orb = this._createOrbDetector();
        const matcher = this._createOrbMatcher();
        try {
            for (const track of orbTracks) {
                const prevBox = track.bbox;
                const prevCx = prevBox[0] + prevBox[2] * 0.5;
                const prevCy = prevBox[1] + prevBox[3] * 0.5;
                const prevArea = Math.max(1, prevBox[2] * prevBox[3]);
                const prevAspect = Math.max(1e-3, prevBox[2] / Math.max(1e-3, prevBox[3]));

                const misses = Number.isFinite(track.orbMissStreak) ? track.orbMissStreak : 0;
                const useFullFrame =
                    this.orbFullFrameAfterMisses > 0 && misses >= this.orbFullFrameAfterMisses;
                const margin = Math.max(1.05, this.orbSearchMargin);

                const searchW = useFullFrame ? gray.cols : Math.max(32, prevBox[2] * margin);
                const searchH = useFullFrame ? gray.rows : Math.max(32, prevBox[3] * margin);
                const searchX = useFullFrame ? 0 : prevCx - searchW * 0.5;
                const searchY = useFullFrame ? 0 : prevCy - searchH * 0.5;
                const searchBox = this._clampBbox([searchX, searchY, searchW, searchH], gray.cols, gray.rows);

                const rx = Math.max(0, Math.floor(searchBox[0]));
                const ry = Math.max(0, Math.floor(searchBox[1]));
                const rw = Math.max(8, Math.min(gray.cols - rx, Math.floor(searchBox[2])));
                const rh = Math.max(8, Math.min(gray.rows - ry, Math.floor(searchBox[3])));

                let roi = null;
                let roiMask = null;
                const sceneKps = new cv.KeyPointVector();
                const sceneDesc = new cv.Mat();
                try {
                    roi = useFullFrame ? gray : gray.roi(new cv.Rect(rx, ry, rw, rh));
                    roiMask = new cv.Mat();
                    orb.detectAndCompute(roi, roiMask, sceneKps, sceneDesc, false);
                    if (sceneDesc.empty() || sceneKps.size() < this.orbMinMatches) {
                        track.orbMissStreak = misses + 1;
                        track.noPointStreak = (track.noPointStreak || 0) + 1;
                        continue;
                    }

                    const templates = [];
                    if (track.orbTemplateDesc && !track.orbTemplateDesc.empty() && Array.isArray(track.orbTemplatePts)) {
                        templates.push({
                            kind: "fixed",
                            desc: track.orbTemplateDesc,
                            pts: track.orbTemplatePts,
                            size: track.orbTemplateSize || { width: prevBox[2], height: prevBox[3] }
                        });
                    }
                    if (track.orbAdaptiveDesc && !track.orbAdaptiveDesc.empty() && Array.isArray(track.orbAdaptivePts)) {
                        templates.push({
                            kind: "adaptive",
                            desc: track.orbAdaptiveDesc,
                            pts: track.orbAdaptivePts,
                            size: track.orbAdaptiveSize || track.orbTemplateSize || { width: prevBox[2], height: prevBox[3] }
                        });
                    }
                    if (!templates.length) {
                        track.orbMissStreak = misses + 1;
                        track.noPointStreak = (track.noPointStreak || 0) + 1;
                        continue;
                    }

                    let best = null;
                    for (const tpl of templates) {
                        const knn = new cv.DMatchVectorVector();
                        try {
                            matcher.knnMatch(tpl.desc, sceneDesc, knn, 2);
                            const srcFlat = [];
                            const dstFlat = [];
                            let goodMatchCount = 0;
                            for (let i = 0; i < knn.size(); i++) {
                                const pair = knn.get(i);
                                if (pair.size() < 2) {
                                    if (pair && typeof pair.delete === "function") pair.delete();
                                    continue;
                                }
                                const m0 = pair.get(0);
                                const m1 = pair.get(1);
                                const ratioOk = m0.distance < this.orbRatioTest * m1.distance;
                                if (ratioOk) {
                                    const qIdx = m0.queryIdx;
                                    const tIdx = m0.trainIdx;
                                    if (qIdx >= 0 && qIdx < tpl.pts.length && tIdx >= 0 && tIdx < sceneKps.size()) {
                                        const spt = tpl.pts[qIdx];
                                        const dkp = sceneKps.get(tIdx);
                                        const dx = dkp.pt.x + (useFullFrame ? 0 : rx);
                                        const dy = dkp.pt.y + (useFullFrame ? 0 : ry);
                                        srcFlat.push(spt[0], spt[1]);
                                        dstFlat.push(dx, dy);
                                        goodMatchCount++;
                                    }
                                }
                                if (m0 && typeof m0.delete === "function") m0.delete();
                                if (m1 && typeof m1.delete === "function") m1.delete();
                                if (pair && typeof pair.delete === "function") pair.delete();
                            }
                            if (goodMatchCount < this.orbMinMatches) continue;

                            const srcMat = cv.matFromArray(goodMatchCount, 1, cv.CV_32FC2, srcFlat);
                            const dstMat = cv.matFromArray(goodMatchCount, 1, cv.CV_32FC2, dstFlat);
                            const inlierMask = new cv.Mat();
                            let H = null;
                            let corners = null;
                            let proj = null;
                            try {
                                H = cv.findHomography(srcMat, dstMat, cv.RANSAC, this.orbRansacThresholdPx, inlierMask);
                                if (!H || H.empty()) continue;
                                const inliers = inlierMask.data ? inlierMask.data.reduce((acc, v) => acc + (v ? 1 : 0), 0) : 0;
                                const inlierRatio = goodMatchCount > 0 ? inliers / goodMatchCount : 0;
                                if (inliers < this.orbMinMatches || inlierRatio < this.orbMinInlierRatio) continue;

                                const tw = Math.max(1, tpl.size?.width || track.anchorW || 1);
                                const th = Math.max(1, tpl.size?.height || track.anchorH || 1);
                                corners = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, tw, 0, tw, th, 0, th]);
                                proj = new cv.Mat();
                                cv.perspectiveTransform(corners, proj, H);
                                const pts = proj.data32F;
                                if (!pts || pts.length < 8) continue;
                                const xs = [pts[0], pts[2], pts[4], pts[6]];
                                const ys = [pts[1], pts[3], pts[5], pts[7]];
                                const minX = Math.min(...xs);
                                const maxX = Math.max(...xs);
                                const minY = Math.min(...ys);
                                const maxY = Math.max(...ys);
                                const prop = this._clampBbox(
                                    [minX, minY, Math.max(8, maxX - minX), Math.max(8, maxY - minY)],
                                    gray.cols,
                                    gray.rows
                                );

                                const propCx = prop[0] + prop[2] * 0.5;
                                const propCy = prop[1] + prop[3] * 0.5;
                                const ddx = propCx - prevCx;
                                const ddy = propCy - prevCy;
                                const maxJump = Math.max(gray.cols, gray.rows) * this.orbMaxCenterJumpFrac;
                                const propArea = Math.max(1, prop[2] * prop[3]);
                                const areaRatio = propArea / prevArea;
                                const propAspect = Math.max(1e-3, prop[2] / Math.max(1e-3, prop[3]));
                                const aspectJump = propAspect > prevAspect ? propAspect / prevAspect : prevAspect / propAspect;
                                const saneJump = ddx * ddx + ddy * ddy <= maxJump * maxJump;
                                const saneArea = areaRatio >= this.orbAreaRatioMin && areaRatio <= this.orbAreaRatioMax;
                                const saneAspect = aspectJump <= this.orbAspectRatioJumpMax;
                                if (!saneJump || !saneArea || !saneAspect) continue;

                                const rank = inliers * inlierRatio;
                                if (!best || rank > best.rank) {
                                    best = {
                                        kind: tpl.kind,
                                        bbox: prop,
                                        inliers,
                                        goodMatchCount,
                                        inlierRatio,
                                        rank
                                    };
                                }
                            } finally {
                                if (proj) proj.delete();
                                if (corners) corners.delete();
                                if (H) H.delete();
                                inlierMask.delete();
                                srcMat.delete();
                                dstMat.delete();
                            }
                        } finally {
                            knn.delete();
                        }
                    }

                    if (!best) {
                        track.orbMissStreak = misses + 1;
                        track.noPointStreak = (track.noPointStreak || 0) + 1;
                        continue;
                    }

                    // Smooth bbox update based on confidence.
                    const conf = Math.max(0, Math.min(1, best.inlierRatio));
                    const alpha = Math.max(
                        0.15,
                        Math.min(0.8, (conf - this.orbMinInlierRatio) / Math.max(1e-6, 1 - this.orbMinInlierRatio))
                    );
                    const pb = best.bbox;
                    const nb = [
                        prevBox[0] * (1 - alpha) + pb[0] * alpha,
                        prevBox[1] * (1 - alpha) + pb[1] * alpha,
                        prevBox[2] * (1 - alpha) + pb[2] * alpha,
                        prevBox[3] * (1 - alpha) + pb[3] * alpha
                    ];
                    track.bbox = this._clampBbox(nb, gray.cols, gray.rows);
                    track.score = Math.max(0, Math.min(1, conf));
                    track.noPointStreak = 0;
                    track.orbMissStreak = 0;
                    track.lastAnchorUpdateMs = Date.now();

                    // Adaptive template update (only under very strong matches).
                    if (best.inlierRatio >= this.orbUpdateTemplateMinInlierRatio && best.goodMatchCount >= this.orbUpdateTemplateMinMatches) {
                        const bx = Math.max(0, Math.floor(track.bbox[0]));
                        const by = Math.max(0, Math.floor(track.bbox[1]));
                        const bw = Math.max(8, Math.min(gray.cols - bx, Math.floor(track.bbox[2])));
                        const bh = Math.max(8, Math.min(gray.rows - by, Math.floor(track.bbox[3])));
                        let boxRoi = null;
                        let boxMask = null;
                        const boxKps = new cv.KeyPointVector();
                        const boxDesc = new cv.Mat();
                        try {
                            boxRoi = gray.roi(new cv.Rect(bx, by, bw, bh));
                            boxMask = new cv.Mat();
                            orb.detectAndCompute(boxRoi, boxMask, boxKps, boxDesc, false);
                            if (!boxDesc.empty() && boxKps.size() >= this.orbMinMatches) {
                                const pts = [];
                                for (let i = 0; i < boxKps.size(); i++) {
                                    const kp = boxKps.get(i);
                                    pts.push([kp.pt.x, kp.pt.y]);
                                }
                                if (track.orbAdaptiveDesc) {
                                    try {
                                        track.orbAdaptiveDesc.delete();
                                    } catch (_) {}
                                }
                                track.orbAdaptiveDesc = boxDesc.clone();
                                track.orbAdaptivePts = pts;
                                track.orbAdaptiveSize = { width: bw, height: bh };
                            }
                        } finally {
                            if (boxMask) boxMask.delete();
                            if (boxRoi) boxRoi.delete();
                            boxKps.delete();
                            boxDesc.delete();
                        }
                    }
                } finally {
                    sceneKps.delete();
                    sceneDesc.delete();
                    if (roiMask) roiMask.delete();
                    if (!useFullFrame && roi) {
                        try {
                            roi.delete();
                        } catch (_) {}
                    }
                }
            }
        } finally {
            matcher.delete();
            orb.delete();
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
        const ow = this._overlayCanvas.width | 0;
        const oh = this._overlayCanvas.height | 0;
        if (typeof PhonebotNormalizationGrid !== "undefined" && PhonebotNormalizationGrid.draw) {
            PhonebotNormalizationGrid.draw(ctx, ow, oh);
        }
        const t = ComputerVisionAiModel.objectFitContainVideoTransform(videoEl);
        if (!t) return;
        ctx.lineWidth = 2;
        ctx.font = "12px Arial";
        ctx.textBaseline = "top";

        if (this.model === "movenet") {
            this._drawPoses(ctx, t, this._poses);
        } else {
            list.forEach((item) => {
                const [x, y, w, h] = item.bbox;
                const r = ComputerVisionAiModel.intrinsicBboxToVideoElementLocalRect([x, y, w, h], t);
                const bx = r.x;
                const by = r.y;
                const bw = r.w;
                const bh = r.h;
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

        const marker = this._lastTapMarker;
        if (marker && marker.untilMs > Date.now()) {
            const mx = t.offsetX + marker.x * t.scale;
            const my = t.offsetY + marker.y * t.scale;
            ctx.strokeStyle = "#33ccff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(mx - 10, my);
            ctx.lineTo(mx + 10, my);
            ctx.moveTo(mx, my - 10);
            ctx.lineTo(mx, my + 10);
            ctx.stroke();
        } else if (marker) {
            this._lastTapMarker = null;
        }
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {{ scale: number, offsetX: number, offsetY: number }} t
     * @param {Array<{ score: number, keypoints: Array<{ name: string, x: number, y: number, score: number }> }>} poses
     */
    _drawPoses(ctx, t, poses) {
        const minKp = Math.max(0.1, this.minScore * 0.5);
        for (const pose of poses || []) {
            const byName = new Map();
            for (const kp of pose.keypoints || []) {
                const name = String(kp?.name || "").trim().toLowerCase();
                if (!name) continue;
                byName.set(name, kp);
            }

            ctx.strokeStyle = "#33ff99";
            ctx.lineWidth = 2;
            for (const [aName, bName] of ComputerVisionAiModel.MOVENET_SKELETON) {
                const a = byName.get(aName);
                const b = byName.get(bName);
                if (!a || !b) continue;
                if ((a.score || 0) < minKp || (b.score || 0) < minKp) continue;
                ctx.beginPath();
                ctx.moveTo(t.offsetX + a.x * t.scale, t.offsetY + a.y * t.scale);
                ctx.lineTo(t.offsetX + b.x * t.scale, t.offsetY + b.y * t.scale);
                ctx.stroke();
            }

            for (const kp of pose.keypoints || []) {
                if ((kp.score || 0) < minKp) continue;
                const px = t.offsetX + kp.x * t.scale;
                const py = t.offsetY + kp.y * t.scale;
                ctx.fillStyle = "#ffcc33";
                ctx.beginPath();
                ctx.arc(px, py, 4, 0, Math.PI * 2);
                ctx.fill();
            }

            const nose = byName.get("nose");
            if (nose && (nose.score || 0) >= minKp) {
                const label = `pose ${(pose.score * 100).toFixed(0)}%`;
                const lx = t.offsetX + nose.x * t.scale;
                const ly = t.offsetY + nose.y * t.scale;
                ctx.font = "12px Arial";
                ctx.textBaseline = "bottom";
                const labelW = ctx.measureText(label).width + 8;
                ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
                ctx.fillRect(lx - 4, ly - 18, labelW, 16);
                ctx.fillStyle = "#33ff99";
                ctx.fillText(label, lx, ly - 4);
            }
        }
    }

    _syncDetectionsFromTracks() {
        this._detections = this._tracks.map((t) => ({
            class: t.class,
            score: t.score,
            bbox: [...t.bbox],
            labelSource: t.labelSource || "coco"
        }));
    }

    _normalizePosesForOutput(poses, fw, fh) {
        const width = Math.max(1, fw || 1);
        const height = Math.max(1, fh || 1);
        return (poses || []).map((pose, index) => ({
            id: pose.id != null ? pose.id : index + 1,
            score: Number((pose.score || 0).toFixed(3)),
            keypoints: (pose.keypoints || []).map((kp) => ({
                name: String(kp.name || ""),
                score: Number((kp.score || 0).toFixed(3)),
                x: Number((kp.x / width).toFixed(4)),
                y: Number((kp.y / height).toFixed(4))
            })),
            bbox: Array.isArray(pose.bbox)
                ? (() => {
                      const [nx, ny, nw, nh] = this._bboxPixelsToNormalized(pose.bbox, width, height);
                      return {
                          x: Number(nx.toFixed(4)),
                          y: Number(ny.toFixed(4)),
                          width: Number(nw.toFixed(4)),
                          height: Number(nh.toFixed(4))
                      };
                  })()
                : null,
            bboxUnit: "normalized01"
        }));
    }

    _poseToPersonDetection(pose, fw, fh) {
        const minKp = Math.max(0.1, this.minScore * 0.5);
        const pts = (pose.keypoints || []).filter((kp) => (kp.score || 0) >= minKp);
        if (!pts.length) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const kp of pts) {
            minX = Math.min(minX, kp.x);
            minY = Math.min(minY, kp.y);
            maxX = Math.max(maxX, kp.x);
            maxY = Math.max(maxY, kp.y);
        }
        const padX = Math.max(4, (maxX - minX) * 0.08);
        const padY = Math.max(4, (maxY - minY) * 0.08);
        const bbox = this._clampBbox(
            [minX - padX, minY - padY, maxX - minX + padX * 2, maxY - minY + padY * 2],
            fw,
            fh
        );
        return {
            class: "person",
            score: pose.score || 0,
            bbox,
            labelSource: "movenet"
        };
    }

    _renderResponseOutput() {
        if (!this._outputEl) return;
        const fw = this._frameWidth || 1;
        const fh = this._frameHeight || 1;
        const response = {
            model: this.type,
            visionModel: this.model,
            detectedAt: new Date().toISOString(),
            objectCount: this._detections.length,
            poseCount: this._poses.length,
            groqFeed: this.groqFeedType,
            groqRefreshMs: this.groqRefreshMs,
            cocoFeed: "internal",
            cocoRefreshMs: this.cocoRefreshMs,
            tracks: this._tracks.map((t) => {
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
            }),
            poses: this._normalizePosesForOutput(this._poses, fw, fh)
        };
        this._outputEl.textContent = JSON.stringify(response, null, 2);
    }

    async _ensureRuntimeForModel() {
        if (this.model === "movenet") {
            await ComputerVisionAiModel._loadMoveNet();
            return;
        }
        if (this.model === "coco") {
            await ComputerVisionAiModel._loadCocoModel();
            return;
        }
        await ComputerVisionAiModel._loadOpenCv();
        await ComputerVisionAiModel._loadCocoModel();
    }

    _resetTrackingState() {
        if (this._prevGray) {
            try {
                this._prevGray.delete();
            } catch (_) {}
            this._prevGray = null;
        }
        this._releaseAllTrackPts(true);
        this._tracks = [];
        this._detections = [];
        this._poses = [];
        this._clearOverlay();
    }

    async _tickMoveNet(videoEl) {
        const detector = await ComputerVisionAiModel._loadMoveNet();
        this._ensureOverlay();
        this._frameWidth = videoEl.videoWidth || 0;
        this._frameHeight = videoEl.videoHeight || 0;
        const fw = this._frameWidth;
        const fh = this._frameHeight;

        const rawPoses = await detector.estimatePoses(videoEl, { flipHorizontal: false });
        const poses = [];
        const detections = [];
        for (let i = 0; i < (rawPoses || []).length; i++) {
            const pose = rawPoses[i];
            const keypoints = (pose.keypoints || []).map((kp) => ({
                name: String(kp.name || "").trim().toLowerCase(),
                x: Number(kp.x) || 0,
                y: Number(kp.y) || 0,
                score: Number.isFinite(kp.score) ? kp.score : 0
            }));
            const score = Number.isFinite(pose.score)
                ? pose.score
                : keypoints.reduce((s, kp) => s + (kp.score || 0), 0) / Math.max(1, keypoints.length);
            const entry = { id: i + 1, score, keypoints };
            const det = this._poseToPersonDetection(entry, fw, fh);
            if (det) {
                entry.bbox = [...det.bbox];
                detections.push(det);
            }
            poses.push(entry);
        }

        this._poses = poses;
        this._detections = detections;
        this._tracks = detections.map((d, i) => ({
            id: i + 1,
            class: d.class,
            score: d.score,
            bbox: [...d.bbox],
            labelSource: "movenet"
        }));
        this._drawDetections(videoEl, this._detections);
        this._renderResponseOutput();
        if (this._statusEl && this._canAutoUpdateStatus()) {
            this._setStatus(`MoveNet: ${poses.length} pose(s) at ${this.frequencyHz} Hz`, "muted");
        }
    }

    async _tickCoco(videoEl) {
        const cocoModel = await ComputerVisionAiModel._loadCocoModel();
        this._ensureOverlay();
        this._frameWidth = videoEl.videoWidth || 0;
        this._frameHeight = videoEl.videoHeight || 0;

        const now = Date.now();
        const shouldDetect = now - this._lastCocoReanchorMs >= this.cocoRefreshMs || !this._detections.length;
        if (shouldDetect) {
            this._lastCocoReanchorMs = now;
            const rawCocoDets = await cocoModel.detect(videoEl, this.maxNumBoxes, this.minScore);
            this._detections = Array.isArray(rawCocoDets)
                ? rawCocoDets.map((d) => ({
                      class: String(d?.class || "").trim().toLowerCase(),
                      score: Number.isFinite(d?.score) ? d.score : 0,
                      bbox: Array.isArray(d?.bbox) ? [...d.bbox] : [0, 0, 0, 0],
                      labelSource: "coco"
                  }))
                : [];
            this._tracks = this._detections.map((d, i) => ({
                id: i + 1,
                class: d.class,
                score: d.score,
                bbox: [...d.bbox],
                labelSource: "coco"
            }));
            this._poses = [];
        }

        this._drawDetections(videoEl, this._detections);
        this._renderResponseOutput();
        if (this._statusEl && this._canAutoUpdateStatus()) {
            this._setStatus(`COCO: ${this._detections.length} object(s) at ${this.frequencyHz} Hz`, "muted");
        }
    }

    async _tickOpenCv(videoEl) {
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
            this._updateOrbTracks(gray);

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

            this._poses = [];
            this._syncDetectionsFromTracks();
            this._drawDetections(videoEl, this._detections);
            this._renderResponseOutput();

            if (this._statusEl && this._canAutoUpdateStatus()) {
                const groqLabels = this._tracks.filter((t) => t.labelSource === "groq").length;
                this._setStatus(
                    `OpenCV tracking ${this._detections.length} object(s) at ${this.frequencyHz} Hz (COCO geometry + Groq labels: ${groqLabels})`,
                    "muted"
                );
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
        }
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
        try {
            if (this.model === "movenet") {
                await this._tickMoveNet(videoEl);
            } else if (this.model === "coco") {
                await this._tickCoco(videoEl);
            } else {
                await this._tickOpenCv(videoEl);
            }
        } catch (err) {
            console.error("ComputerVision error:", err);
            if (this._statusEl) {
                this._setStatus(`ComputerVision error: ${err?.message || "unknown error"}`, "error", 4000);
            }
        } finally {
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
                this._statusEl.textContent = `Loading ${this.model} runtime...`;
                this._statusEl.className = "muted";
            }
            try {
                await this._ensureRuntimeForModel();
                this._attachFramePointerHandler();
                this._startLoop();
            } catch (err) {
                this.enabled = false;
                if (this._toggleBtn) this._toggleBtn.textContent = "Off";
                if (this._statusEl) {
                    this._statusEl.textContent = `Failed to load ${this.model}: ${err?.message || "unknown error"}`;
                    this._statusEl.className = "error";
                }
            }
        } else {
            this._stopLoop();
            this._detachFramePointerHandler();
            this._resetTrackingState();
            this._renderResponseOutput();
            if (this._statusEl) {
                this._statusEl.textContent = "Model off.";
                this._statusEl.className = "muted";
            }
        }
    }

    async setModel(nextModel) {
        const normalized = ComputerVisionAiModel.normalizeModel(nextModel);
        if (normalized === this.model) {
            if (this._modelSelect) this._modelSelect.value = this.model;
            return;
        }
        const wasEnabled = this.enabled;
        if (wasEnabled) await this.setEnabled(false);
        this.model = normalized;
        if (this._modelSelect) this._modelSelect.value = this.model;
        if (this._hintEl) this._hintEl.textContent = this._modelHintText();
        if (wasEnabled) await this.setEnabled(true);
    }

    _modelHintText() {
        if (this.model === "movenet") {
            return "MoveNet pose model: draws keypoints + skeleton. Exported poses use normalized 0–1 keypoints; person bbox is derived for filters.";
        }
        if (this.model === "coco") {
            return "COCO-SSD only: object boxes without OpenCV optical flow. Exported detections/results use bbox 0–1.";
        }
        return `OpenCV mode: internal COCO for bbox geometry + optical flow; "${this.groqFeedType}" for label updates. Exported detections/results use bbox 0–1.`;
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

    setFlowBboxPctLow(nextValue) {
        const parsed = Number(nextValue);
        if (!Number.isFinite(parsed)) return;
        this.flowBboxPctLow = Math.max(0, Math.min(0.45, parsed));
        if (this.flowBboxPctHigh <= this.flowBboxPctLow) {
            this.flowBboxPctHigh = Math.min(1, this.flowBboxPctLow + 0.5);
        }
        if (this._flowBboxPctLowInput) this._flowBboxPctLowInput.value = String(Number(this.flowBboxPctLow.toFixed(3)));
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

    async makeCenterOrbObject() {
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        const fw = (videoEl?.videoWidth | 0) || (this._frameWidth | 0);
        const fh = (videoEl?.videoHeight | 0) || (this._frameHeight | 0);
        if (!fw || !fh) {
            if (this._statusEl) {
                this._statusEl.textContent = "Cannot create center ORB: camera frame unavailable.";
                this._statusEl.className = "error";
            }
            return false;
        }
        return this.createOrbObjectAt(fw * 0.5, fh * 0.5);
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

    /** Normalized MoveNet poses (keypoints 0–1). Empty unless vision model is movenet. */
    get poses() {
        return this._normalizePosesForOutput(this._poses, this._frameWidth || 1, this._frameHeight || 1);
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

        const modelLabel = document.createElement("label");
        modelLabel.textContent = "Vision model";
        const modelSelect = document.createElement("select");
        const modelLabels = {
            opencv: "OpenCV (COCO + flow)",
            coco: "COCO-SSD",
            movenet: "MoveNet (pose)"
        };
        for (const value of ComputerVisionAiModel.MODEL_OPTIONS) {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = modelLabels[value] || value;
            modelSelect.appendChild(opt);
        }
        modelSelect.value = this.model;
        modelSelect.addEventListener("change", async () => {
            modelSelect.disabled = true;
            await this.setModel(modelSelect.value);
            modelSelect.disabled = false;
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

        const flowBboxPctLowLabel = document.createElement("label");
        flowBboxPctLowLabel.textContent = "Flow bbox percentile low (shrink vs outliers; 0–0.45)";
        const flowBboxPctLowInput = document.createElement("input");
        flowBboxPctLowInput.type = "number";
        flowBboxPctLowInput.min = "0";
        flowBboxPctLowInput.max = "0.45";
        flowBboxPctLowInput.step = "0.01";
        flowBboxPctLowInput.value = String(Number(this.flowBboxPctLow.toFixed(3)));
        flowBboxPctLowInput.addEventListener("change", () => this.setFlowBboxPctLow(flowBboxPctLowInput.value));
        flowBboxPctLowInput.addEventListener("blur", () => this.setFlowBboxPctLow(flowBboxPctLowInput.value));

        const makeCenterBtn = document.createElement("button");
        makeCenterBtn.type = "button";
        makeCenterBtn.textContent = "Make Center Object";
        makeCenterBtn.addEventListener("click", () => this.makeCenterObject());

        const makeCenterOrbBtn = document.createElement("button");
        makeCenterOrbBtn.type = "button";
        makeCenterOrbBtn.textContent = "Make Center Flow";
        makeCenterOrbBtn.addEventListener("click", async () => {
            makeCenterOrbBtn.disabled = true;
            const camera = this._getCameraSensor();
            const videoEl = camera?.getVideoElement?.();
            const fw = (videoEl?.videoWidth | 0) || (this._frameWidth | 0);
            const fh = (videoEl?.videoHeight | 0) || (this._frameHeight | 0);
            if (fw && fh) await this.createFlowObjectAt(fw * 0.5, fh * 0.5);
            makeCenterOrbBtn.disabled = false;
        });

        const hint = document.createElement("p");
        hint.className = "muted";
        hint.textContent = this._modelHintText();

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Model off.";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        controls.appendChild(toggleBtn);
        controls.appendChild(modelLabel);
        controls.appendChild(modelSelect);
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
        controls.appendChild(flowBboxPctLowLabel);
        controls.appendChild(flowBboxPctLowInput);
        controls.appendChild(makeCenterBtn);
        controls.appendChild(makeCenterOrbBtn);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(hint);
        wrap.appendChild(status);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._modelSelect = modelSelect;
        this._freqInput = freqInput;
        this._minScoreInput = minScoreInput;
        this._refreshInput = refreshInput;
        this._cocoRefreshInput = cocoRefreshInput;
        this._forgetStaleInput = forgetStaleInput;
        this._flowBboxPctLowInput = flowBboxPctLowInput;
        this._makeCenterBtn = makeCenterBtn;
        this._makeCenterOrbBtn = makeCenterOrbBtn;
        this._hintEl = hint;
        this._statusEl = status;
        this._outputEl = output;
    }

    destroy() {
        this._stopLoop();
        this._detachFramePointerHandler();
        this._resetTrackingState();
        if (this._overlayCanvas && this._overlayCanvas.parentNode) {
            this._overlayCanvas.parentNode.removeChild(this._overlayCanvas);
        }
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._captureCanvas = null;
        this._captureCtx = null;
        this._detections = [];
        this._poses = [];
    }
}

window.ComputerVisionAiModel = ComputerVisionAiModel;
