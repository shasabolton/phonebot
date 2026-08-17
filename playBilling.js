/**
 * Stripe Checkout play-session client.
 * No secret or payment result is trusted here; the Worker webhook is authoritative.
 */
class PlayBilling {
    static STORAGE_PREFIX = "phonebot.playSession.";

    constructor() {
        const configured =
            window.PHONEBOT_BILLING_API_URL ||
            document.querySelector('meta[name="phonebot-billing-api"]')?.content ||
            "/api";
        this.apiBaseUrl = String(configured).replace(/\/+$/, "");
        this.ownerId = this._queryValue("owner");
        this.machineId = this._queryValue("machine");
        this.returnedSessionId = this._queryValue("play_session");
        this._modal = null;
        this._modalResolve = null;
        this._active = null;
        this._checkoutWindow = null;
        this._pollCancelled = false;
    }

    requiresPayment(modeConfig) {
        if (!modeConfig || modeConfig.free === true) return false;
        return Math.max(0, Number(modeConfig.priceCents) || 0) > 0;
    }

    isArcadeAiMode(modeConfig) {
        return this.requiresPayment(modeConfig) && (Number(modeConfig?.aiBudgetCents) || 0) > 0;
    }

    formatPrice(cents, currency = "aud") {
        return new Intl.NumberFormat("en-AU", {
            style: "currency",
            currency: String(currency || "aud").toUpperCase()
        }).format((Number(cents) || 0) / 100);
    }

    async ensurePlaySession({ modeId, modeConfig, robotSlug, continuation = false }) {
        if (!this.requiresPayment(modeConfig)) {
            this._active = null;
            return true;
        }

        const key = this._storageKey(robotSlug, modeId);
        let sessionId = continuation ? this._readStored(key) : this.returnedSessionId || this._readStored(key);
        if (sessionId) {
            const session = await this._getSession(sessionId).catch(() => null);
            if (
                session &&
                session.modeId === modeId &&
                session.robotSlug === robotSlug &&
                (session.status === "paid" || session.status === "active")
            ) {
                localStorage.setItem(key, session.id);
                this.returnedSessionId = null;
                this._removeReturnParam();
                const started = session.status === "active" ? session : await this._startSession(session.id);
                this._active = started;
                return true;
            }
            if (session?.status === "paused_for_payment") {
                this._active = session;
                continuation = true;
            } else {
                localStorage.removeItem(key);
            }
        }

        const priceCents = continuation
            ? Number(modeConfig.continuePriceCents ?? modeConfig.priceCents) || 0
            : Number(modeConfig.priceCents) || 0;
        const action = continuation ? "continue" : "play";
        const accepted = await this._showPaywall({
            title: continuation ? "AI budget used" : modeConfig.label || modeId,
            message: continuation
                ? "Your game is paused. Payment adds a fresh AI budget and keeps the current game state."
                : "Payment is required before this mode starts.",
            button: `Pay ${this.formatPrice(priceCents, modeConfig.currency)} to ${action}`
        });
        if (!accepted) return false;

        const checkout = await this._request("/checkout", {
            method: "POST",
            body: JSON.stringify({
                modeId,
                robot: robotSlug,
                owner: this.ownerId || undefined,
                machine: this.machineId || undefined,
                continueSessionId: continuation ? this._active?.id || sessionId : undefined,
                returnUrl: window.location.href
            })
        }).catch((error) => {
            try {
                accepted.checkoutWindow?.close();
            } catch (_) {}
            this._setModalError(error.message || "Could not start Checkout.");
            return null;
        });
        if (!checkout?.url) return false;
        localStorage.setItem(key, checkout.playSessionId);
        if (accepted.checkoutWindow) {
            this._checkoutWindow = accepted.checkoutWindow;
            accepted.checkoutWindow.location.replace(checkout.url);
            const paidSession = await this._waitForPaid(checkout.playSessionId);
            if (!paidSession) return false;
            try {
                accepted.checkoutWindow.close();
            } catch (_) {}
            this._checkoutWindow = null;
            this._modal.hidden = true;
            this._active = await this._startSession(paidSession.id);
            return true;
        }
        window.location.assign(checkout.url);
        return false;
    }

    async ensureAiBudget({ modeId, modeConfig, robotSlug }) {
        if (!this.isArcadeAiMode(modeConfig)) return true;
        const key = this._storageKey(robotSlug, modeId);
        const sessionId = this._active?.id || this._readStored(key);
        if (!sessionId) {
            return this.ensurePlaySession({ modeId, modeConfig, robotSlug });
        }
        const session = await this._getSession(sessionId).catch(() => null);
        if (session && (session.status === "paid" || session.status === "active")) {
            this._active = session;
            return true;
        }
        if (session?.status === "paused_for_payment") {
            this._active = session;
            return this.ensurePlaySession({
                modeId,
                modeConfig,
                robotSlug,
                continuation: true
            });
        }
        localStorage.removeItem(key);
        return this.ensurePlaySession({ modeId, modeConfig, robotSlug });
    }

    async onAiBudgetExhausted({ modeId, modeConfig, robotSlug }) {
        if (!this.isArcadeAiMode(modeConfig)) return false;
        return this.ensurePlaySession({ modeId, modeConfig, robotSlug, continuation: true });
    }

    async completeActiveSession(reason = "game_finished") {
        const session = this._active;
        this._active = null;
        await this.completeSession(session, reason);
    }

    async completeSession(session, reason = "game_finished") {
        if (!session?.id || !["paid", "active", "paused_for_payment"].includes(session.status)) return;
        try {
            await this._request(`/session/${encodeURIComponent(session.id)}/complete`, {
                method: "POST",
                body: JSON.stringify({ reason })
            });
        } finally {
            localStorage.removeItem(this._storageKey(session.robotSlug, session.modeId));
        }
    }

    getActiveSessionId() {
        return this._active?.id || null;
    }

    getActiveSession() {
        return this._active ? { ...this._active } : null;
    }

    fetchHostedChat(body, signal) {
        if (!this._active?.id) {
            throw new Error("No active arcade play session.");
        }
        return fetch(`${this.apiBaseUrl}/ai/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Play-Session": this._active.id
            },
            body: JSON.stringify(body),
            signal
        });
    }

    async handlePaymentRequired(response, context) {
        if (response?.status !== 402) return false;
        let payload = null;
        try {
            payload = await response.clone().json();
        } catch (_) {}
        if (payload?.session) this._active = payload.session;
        await this.onAiBudgetExhausted(context);
        return true;
    }

    async _startSession(id) {
        const session = await this._request(`/session/${encodeURIComponent(id)}/start`, {
            method: "POST",
            body: "{}"
        });
        this._active = session;
        return session;
    }

    _getSession(id) {
        return this._request(`/session/${encodeURIComponent(id)}`, { method: "GET" });
    }

    async _request(path, options = {}) {
        const headers = new Headers(options.headers || {});
        if (options.body != null && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }
        const response = await fetch(`${this.apiBaseUrl}${path}`, {
            ...options,
            headers,
            cache: "no-store"
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || `Billing HTTP ${response.status}`);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    }

    async _waitForPaid(id) {
        const deadline = Date.now() + 30 * 60 * 1000;
        const message = this._modal?.querySelector(".play-billing-message");
        if (message) message.textContent = "Checkout opened. Waiting for Stripe to confirm payment…";
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            if (this._pollCancelled) return null;
            const session = await this._getSession(id).catch(() => null);
            if (session?.status === "paid" || session?.status === "active") return session;
            if (session && ["consumed", "expired"].includes(session.status)) break;
        }
        this._setModalError("Payment was not confirmed. You can close Checkout and try again.");
        return null;
    }

    _storageKey(robotSlug, modeId) {
        return `${PlayBilling.STORAGE_PREFIX}${robotSlug}.${modeId}`;
    }

    _readStored(key) {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    _queryValue(name) {
        const value = new URLSearchParams(window.location.search).get(name);
        return value != null && String(value).trim() ? String(value).trim() : null;
    }

    _removeReturnParam() {
        const url = new URL(window.location.href);
        url.searchParams.delete("play_session");
        history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }

    _showPaywall({ title, message, button }) {
        if (this._modalResolve) {
            this._modalResolve(false);
            this._modalResolve = null;
        }
        if (!this._modal) this._buildModal();
        this._pollCancelled = false;
        this._modal.querySelector(".play-billing-title").textContent = title;
        this._modal.querySelector(".play-billing-message").textContent = message;
        this._modal.querySelector(".play-billing-pay").textContent = button;
        this._modal.querySelector(".play-billing-error").textContent = "";
        this._modal.hidden = false;
        return new Promise((resolve) => {
            this._modalResolve = resolve;
        });
    }

    _setModalError(message) {
        if (!this._modal) return;
        this._modal.querySelector(".play-billing-error").textContent = message;
        this._modal.querySelector(".play-billing-pay").disabled = false;
    }

    _buildModal() {
        const overlay = document.createElement("div");
        overlay.className = "play-billing-overlay";
        overlay.hidden = true;
        overlay.innerHTML = `
            <section class="play-billing-card" role="dialog" aria-modal="true" aria-labelledby="playBillingTitle">
                <h2 id="playBillingTitle" class="play-billing-title"></h2>
                <p class="play-billing-message"></p>
                <p class="play-billing-wallets">Secure Stripe Checkout · card, Apple Pay or Google Pay when available</p>
                <p class="play-billing-error error" aria-live="polite"></p>
                <button type="button" class="play-billing-pay"></button>
                <button type="button" class="play-billing-cancel secondary">Not now</button>
            </section>`;
        const pay = overlay.querySelector(".play-billing-pay");
        const cancel = overlay.querySelector(".play-billing-cancel");
        pay.addEventListener("click", () => {
            pay.disabled = true;
            const checkoutWindow = window.open("about:blank", "phonebotStripeCheckout");
            const resolve = this._modalResolve;
            this._modalResolve = null;
            if (resolve) resolve({ checkoutWindow });
        });
        cancel.addEventListener("click", () => {
            this._pollCancelled = true;
            try {
                this._checkoutWindow?.close();
            } catch (_) {}
            this._checkoutWindow = null;
            overlay.hidden = true;
            const resolve = this._modalResolve;
            this._modalResolve = null;
            if (resolve) resolve(false);
        });
        document.body.appendChild(overlay);
        this._modal = overlay;
    }
}

window.PlayBilling = PlayBilling;
window.playBilling = new PlayBilling();
