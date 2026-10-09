/** Posts microphone samples to the page in ~40 ms batches instead of one message per 128-sample block. */
class PcmCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.batch = new Float32Array(2048);
        this.filled = 0;
        this.port.onmessage = () => {
            this.port.postMessage({ flushed: this.batch.slice(0, this.filled) });
            this.filled = 0;
        };
    }

    process(inputs) {
        const channel = inputs[0]?.[0];
        if (!channel) return true;
        let offset = 0;
        while (offset < channel.length) {
            const count = Math.min(channel.length - offset, this.batch.length - this.filled);
            this.batch.set(channel.subarray(offset, offset + count), this.filled);
            this.filled += count;
            offset += count;
            if (this.filled === this.batch.length) {
                this.port.postMessage(this.batch.slice(0));
                this.filled = 0;
            }
        }
        return true;
    }
}

registerProcessor("pcm-capture", PcmCapture);
