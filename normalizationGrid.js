/**
 * Decile reference: two-digit labels 11–99 at grid intersections (column 1–9 left→right, row 1–9 top→bottom).
 * Same normalized fromX/fromY as intersection (col/10, row/10) for shift / bbox.
 */
window.PhonebotNormalizationGrid = {
    /**
     * @param {number|string} cell Two-digit code 11–99; tens and ones digits must each be 1–9.
     * @returns {{ fromX: number, fromY: number } | null}
     */
    fromCellToNormXY(cell) {
        const n = Math.round(Number(cell));
        if (!Number.isFinite(n) || n < 11 || n > 99) return null;
        const ones = n % 10;
        const tens = Math.floor(n / 10);
        if (ones < 1 || ones > 9 || tens < 1 || tens > 9) return null;
        return { fromX: ones / 10, fromY: tens / 10 };
    },

    /**
     * Draw intersection labels only (no grid lines): top row 11–19 … bottom row 91–99.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} w canvas width (pixels)
     * @param {number} h canvas height (pixels)
     */
    draw(ctx, w, h) {
        if (!ctx || !(w > 0) || !(h > 0)) return;
        const cw = Math.floor(w);
        const ch = Math.floor(h);
        const fontPx = Math.max(8, Math.min(12, Math.round(Math.min(cw, ch) * 0.022)));

        ctx.save();
        ctx.font = `${fontPx}px Arial, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0, 0, 0, 0.92)";
        ctx.shadowBlur = 5;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
        ctx.lineWidth = 1;

        for (let row = 1; row <= 9; row++) {
            for (let col = 1; col <= 9; col++) {
                const code = row * 10 + col;
                const x = (col / 10) * cw;
                const y = (row / 10) * ch;
                ctx.fillText(String(code), x, y);
            }
        }

        ctx.shadowBlur = 0;
        ctx.restore();
    }
};
