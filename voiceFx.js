/**
 * Character voice effects: pitch, robot (ring modulation) and vibrato.
 * Pitch is applied per clip (pitchShiftBlob); the rest is a Web Audio chain that audioPlayer
 * puts in front of its compressor, so TTS, game clips and recordings all go through it.
 */
class PhonebotVoiceFx {
    static PARAMS = Object.freeze({
        pitch: { label: "Pitch", min: 0.5, max: 2, step: 0.01, default: 1, unit: "×" },
        robot: { label: "Robot", min: 0, max: 1, step: 0.01, default: 0, unit: "" },
        robotFreq: { label: "Robot tone", min: 10, max: 300, step: 1, default: 50, unit: " Hz" },
        vibrato: { label: "Vibrato", min: 0, max: 1, step: 0.01, default: 0, unit: "" },
        vibratoRate: { label: "Vibrato speed", min: 1, max: 20, step: 0.1, default: 5, unit: " Hz" }
    });

    static PRESETS = Object.freeze([
        { id: "robot", label: "Robot", fx: { robot: 1, robotFreq: 100 } },
        { id: "giant", label: "Giant", fx: { pitch: 0.75 } },
        { id: "elf", label: "Elf", fx: { pitch: 1.35 } },
        { id: "ghost", label: "Ghost", fx: { vibrato: 0.5, vibratoRate: 7 } },
        { id: "gravelly", label: "Gravelly", fx: { pitch: 0.8, robot: 0.2, robotFreq: 40 } },
        { id: "nervous", label: "Nervous", fx: { pitch: 1.08, vibrato: 0.25, vibratoRate: 9 } },
        { id: "alien", label: "Alien", fx: { pitch: 1.1, robot: 0.6, robotFreq: 180, vibrato: 0.2, vibratoRate: 7 } }
    ]);

    static _clamp(key, value) {
        const spec = PhonebotVoiceFx.PARAMS[key];
        const n = Number(value);
        if (!Number.isFinite(n)) return spec.default;
        return Math.max(spec.min, Math.min(spec.max, n));
    }

    /**
     * Every setting, clamped; missing ones take their default (no effect).
     * @param {object|null|undefined} raw
     */
    static normalize(raw) {
        const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const fx = {};
        for (const key of Object.keys(PhonebotVoiceFx.PARAMS)) {
            fx[key] = PhonebotVoiceFx._clamp(key, src[key]);
        }
        return fx;
    }

    static isNeutral(fx) {
        const f = PhonebotVoiceFx.normalize(fx);
        return f.pitch === 1 && f.robot === 0 && f.vibrato === 0;
    }

    /** What a character profile stores: null when the settings change nothing. */
    static forProfile(raw) {
        const fx = PhonebotVoiceFx.normalize(raw);
        return PhonebotVoiceFx.isNeutral(fx) ? null : fx;
    }

    static formatValue(key, value) {
        const spec = PhonebotVoiceFx.PARAMS[key];
        const decimals = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : 2;
        return `${Number(value).toFixed(decimals)}${spec.unit}`;
    }

    /**
     * Vibrato sweeps a short delay by up to this many seconds either way. Pitch swings by
     * about 2π × rate × depth, so full vibrato at 5 Hz is roughly ±2 semitones.
     */
    static VIBRATO_MAX_DEPTH_S = 0.004;

    /** @param {BaseAudioContext} ctx */
    static createChain(ctx) {
        return new PhonebotVoiceFxChain(ctx);
    }

    /**
     * The clip resampled so pitch and speed both change by `pitch`, as a mono WAV. Play it at
     * playbackRate 1 / pitch with preservesPitch on and the browser stretches it back to its
     * original length, leaving only the pitch changed.
     * @param {Blob} blob
     * @param {number} pitch
     * @returns {Promise<Blob>}
     */
    static async pitchShiftBlob(blob, pitch) {
        const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (typeof Offline !== "function") throw new Error("OfflineAudioContext unavailable.");
        const decoder = new Offline(1, 1, 44100);
        const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
        const ctx = new Offline(1, Math.max(1, Math.ceil(buffer.length / pitch)), buffer.sampleRate);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = pitch;
        source.connect(ctx.destination);
        source.start();
        const rendered = await ctx.startRendering();
        return PhonebotVoiceFx._wavBlob(rendered.getChannelData(0), rendered.sampleRate);
    }

    /** Mono 16-bit WAV. @param {Float32Array} samples @param {number} sampleRate */
    static _wavBlob(samples, sampleRate) {
        const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
        const writeStr = (offset, s) => {
            for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
        };
        writeStr(0, "RIFF");
        view.setUint32(4, 36 + samples.length * 2, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeStr(36, "data");
        view.setUint32(40, samples.length * 2, true);
        for (let i = 0; i < samples.length; i++) {
            const x = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
        }
        return new Blob([view.buffer], { type: "audio/wav" });
    }
}

/**
 * input → (dry + ring-modulated wet) → vibrato delay → output.
 * Nodes are built once; apply() moves their settings so sliders change audio as it plays.
 */
class PhonebotVoiceFxChain {
    /** @param {BaseAudioContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.input = ctx.createGain();
        this._dry = ctx.createGain();
        this._ring = ctx.createGain();
        this._ring.gain.value = 0;
        this._wet = ctx.createGain();
        this._osc = ctx.createOscillator();
        this._osc.type = "sine";
        this._osc.connect(this._ring.gain);
        this._osc.start();
        this._mix = ctx.createGain();

        // Delay rests one step above the max sweep so it never goes negative.
        const maxDepth = PhonebotVoiceFx.VIBRATO_MAX_DEPTH_S;
        this._vibratoDelay = ctx.createDelay(maxDepth * 3);
        this._vibratoDelay.delayTime.value = maxDepth * 1.25;
        this._vibratoLfo = ctx.createOscillator();
        this._vibratoLfo.type = "sine";
        this._vibratoDepth = ctx.createGain();
        this._vibratoDepth.gain.value = 0;
        this._vibratoLfo.connect(this._vibratoDepth).connect(this._vibratoDelay.delayTime);
        this._vibratoLfo.start();
        this.output = this._vibratoDelay;

        this.input.connect(this._dry).connect(this._mix);
        this.input.connect(this._ring).connect(this._wet).connect(this._mix);
        this._mix.connect(this._vibratoDelay);
        this.apply(null);
    }

    _set(param, value) {
        try {
            param.setTargetAtTime(value, this.ctx.currentTime, 0.02);
        } catch (_) {
            param.value = value;
        }
    }

    /** @param {object|null} raw */
    apply(raw) {
        const fx = PhonebotVoiceFx.normalize(raw);
        this._set(this._dry.gain, 1 - fx.robot);
        this._set(this._wet.gain, fx.robot);
        this._set(this._osc.frequency, fx.robotFreq);

        this._set(this._vibratoDepth.gain, fx.vibrato * PhonebotVoiceFx.VIBRATO_MAX_DEPTH_S);
        this._set(this._vibratoLfo.frequency, fx.vibratoRate);
    }

    destroy() {
        for (const osc of [this._osc, this._vibratoLfo]) {
            try {
                osc.stop();
            } catch (_) {}
        }
        for (const node of [
            this.input,
            this._dry,
            this._ring,
            this._wet,
            this._osc,
            this._mix,
            this._vibratoLfo,
            this._vibratoDepth,
            this._vibratoDelay
        ]) {
            try {
                node.disconnect();
            } catch (_) {}
        }
    }
}

window.PhonebotVoiceFx = PhonebotVoiceFx;
