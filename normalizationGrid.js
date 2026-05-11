/**
 * Normalized 0.1–0.9 guide: 9 vertical + 9 horizontal lines; labels on top and left.
 * Coordinates match normalized fractions of full width/height (same as bbox / shift fromX,fromY).
 */
window.PhonebotNormalizationGrid = {
    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} w canvas width (pixels)
     * @param {number} h canvas height (pixels)
     */
    draw(ctx, w, h) {
        if (!ctx || !(w > 0) || !(h > 0)) return;
        const cw = Math.floor(w);
        const ch = Math.floor(h);
        const fontPx = Math.max(9, Math.min(13, Math.round(Math.min(cw, ch) * 0.026)));

        ctx.save();

        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
        ctx.setLineDash([]);

        for (let i = 1; i <= 9; i++) {
            const x = (i / 10) * cw;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, ch);
            ctx.stroke();
        }
        for (let j = 1; j <= 9; j++) {
            const y = (j / 10) * ch;
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(cw, y + 0.5);
            ctx.stroke();
        }

        ctx.font = `${fontPx}px Arial, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
        ctx.lineWidth = 1;

        const topY = Math.max(fontPx * 0.55, 8);
        ctx.textAlign = "center";
        for (let i = 1; i <= 9; i++) {
            const x = (i / 10) * cw;
            ctx.fillText((i / 10).toFixed(1), x, topY);
        }

        const leftPad = Math.min(28, Math.max(18, Math.round(fontPx * 2.1)));
        ctx.textAlign = "right";
        for (let j = 1; j <= 9; j++) {
            const y = (j / 10) * ch;
            ctx.fillText((j / 10).toFixed(1), leftPad - 2, y);
        }

        ctx.shadowBlur = 0;
        ctx.restore();
    }
};
