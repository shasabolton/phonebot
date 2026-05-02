class RobotStrategies {
    constructor(robot) {
        this.robot = robot;
    }

    _resolveDirectionSign(direction) {
        const raw = String(direction || "").trim().toLowerCase();
        if (raw === "left" || raw === "-1") return -1;
        if (raw === "right" || raw === "1") return 1;
        return null;
    }

    _getMainObjectFilter() {
        return this.robot.getObjectFilterByName("mainObjectFilter") || this.robot.objectFilters?.[0] || null;
    }

    _getYawPid() {
        return (
            this.robot.pidControllers?.find((p) => String(p?.name || "").trim().toLowerCase() === "yaw object tracker pid") ||
            this.robot.pidControllers?.[0] ||
            null
        );
    }

    _getComputerVisionModel() {
        return this.robot.getAiModelByType("computervision") || this.robot.getAiModelByName("computervision");
    }

    _pickCenterCandidate(results, frameWidth, thresholdPx) {
        let best = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        const centerX = frameWidth / 2;
        for (const item of results || []) {
            if (!item || !Array.isArray(item.bbox) || item.bbox.length < 4) continue;
            const [x, , w] = item.bbox;
            const distance = Math.abs((x + w / 2) - centerX);
            if (distance <= thresholdPx && distance < bestDistance) {
                bestDistance = distance;
                best = item;
            }
        }
        return best;
    }

    /**
     * Pan by approximately half a screen by choosing a target near center,
     * or synthesizing one when no good center candidate exists.
     * @param {"left"|"right"|number|string} direction
     * @returns {{ok:boolean, reason:string, filter?:string, goal?:number}}
     */
    panHalfScreen(direction) {
        const sign = this._resolveDirectionSign(direction);
        if (!sign) {
            return { ok: false, reason: 'direction must be "left" or "right"' };
        }

        const objectFilter = this._getMainObjectFilter();
        const yawPid = this._getYawPid();
        if (!objectFilter) return { ok: false, reason: "no object filter available" };
        if (!yawPid) return { ok: false, reason: "no yaw PID available" };

        const cv = this._getComputerVisionModel();
        const frameWidth = Number(cv?.getFrameSize?.()?.width) || 640;
        const thresholdPx = Math.max(24, frameWidth * 0.15);
        const centerCandidate = this._pickCenterCandidate(cv?.results || [], frameWidth, thresholdPx);

        let filterLabel = "lastCenter";
        if (centerCandidate && centerCandidate.class) {
            filterLabel = String(centerCandidate.class).trim().toLowerCase() || "lastCenter";
        } else {
            const created = cv && typeof cv.makeCenterObject === "function" ? cv.makeCenterObject() : false;
            if (!created) return { ok: false, reason: "cannot create synthetic center object" };
        }

        objectFilter.setFiltersFromString(filterLabel);
        yawPid.goal = sign;
        return { ok: true, reason: "pan configured", filter: filterLabel, goal: sign };
    }
}

window.RobotStrategies = RobotStrategies;
