/**
 * Stripe Checkout play-session client.
 * No secret or payment result is trusted here; the Worker webhook is authoritative.
 * Credit bar reads a local cache so free/menu use does not hit the Worker.
 */
class PlayBilling {
    static STORAGE_PREFIX = "phonebot.playSession.";
    static LAST_AMOUNT_KEY = "phonebot.playAmountCents";
    static CREDIT_CACHE_KEY = "phonebot.arcadeCreditCache";
    static MIN_PRICE_CENTS = 100;
    static MAX_PRICE_CENTS = 1000;
    static PRICE_STEP_CENTS = 100;
    static DEFAULT_PRICE_CENTS = 200;
    static CREDIT_MODE_ID = "aiCredit";
    static DEFAULT_ROBOT_SLUG = "talking-head";
    static AI_CREDIT_PAYWALL_MESSAGE =
        "Choose how much to pay. That full amount becomes hosted AI credit — switch games freely until it runs out. Credit lasts 7 days without use.";
    static AI_CREDIT_NEEDED_MESSAGE =
        "You're out of hosted AI credit. Top up to continue, or enter your own Groq API key. Credit lasts 7 days without use.";

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
        this._amountCents = PlayBilling.DEFAULT_PRICE_CENTS;
        this._amountCurrency = "aud";
        this._amountAction = "play";
        this._lastRobotSlug = null;
        this._creditPromise = null;
        this._dock = null;
        this._ensureDock();
        this._syncCreditBar();
        if (this.returnedSessionId) {
            void this._resumeReturnedCheckout();
        }
    }

    formatPrice(cents, currency = "aud") {
        return new Intl.NumberFormat("en-AU", {
            style: "currency",
            currency: String(currency || "aud").toUpperCase()
        }).format((Number(cents) || 0) / 100);
    }

    async _resumeReturnedCheckout() {
        const id = this.returnedSessionId;
        if (!id) return;
        try {
            const session = await this._getSession(id).catch(() => null);
            if (!session || !["paid", "active"].includes(session.status)) return;
            const robotSlug = session.robotSlug || PlayBilling.DEFAULT_ROBOT_SLUG;
            this._lastRobotSlug = robotSlug;
            localStorage.setItem(this._storageKey(robotSlug, null), session.id);
            if (session.status === "paid") {
                await this._startSession(session.id);
            } else {
                this._setActive(session);
            }
        } finally {
            this.returnedSessionId = null;
            this._removeReturnParam();
        }
    }

    /**
     * Gate for hosted AI requests: resolves true once an active session has credit left,
     * otherwise shows the top-up popup. Concurrent callers share one popup.
     */
    ensureAiCredit(options = {}) {
        if (!this._creditPromise) {
            this._creditPromise = this._ensureAiCredit(options).finally(() => {
                this._creditPromise = null;
            });
        }
        return this._creditPromise;
    }

    async _ensureAiCredit({ robotSlug } = {}) {
        const slug = this._resolveRobotSlug(robotSlug);
        this._lastRobotSlug = slug;
        const active = this._active;
        if (
            active?.status === "active" &&
            active.robotSlug === slug &&
            this._sessionRemainingCents(active) > 0
        ) {
            return true;
        }

        const key = this._storageKey(slug, null);
        const sessionId =
            active?.id ||
            this._readStored(key) ||
            this._findLegacyModeSessionId(slug) ||
            this._readCreditCache()?.sessionId;
        if (sessionId) {
            const session = await this._getSession(sessionId).catch(() => null);
            const usable =
                session &&
                session.robotSlug === slug &&
                ["paid", "active"].includes(session.status) &&
                this._sessionRemainingCents(session) > 0;
            if (usable) {
                localStorage.setItem(key, session.id);
                this._clearLegacyModeSessionKeys(slug);
                this._setActive(await this._startSession(session.id));
                return true;
            }
        }

        return this.topUpCredit({
            robotSlug: slug,
            title: "AI credit needed",
            message: PlayBilling.AI_CREDIT_NEEDED_MESSAGE
        });
    }

    /** Worker clamps credit so balance never exceeds $10. */
    async topUpCredit(options = {}) {
        const robotSlug = this._resolveRobotSlug(options.robotSlug);
        this._lastRobotSlug = robotSlug;
        const key = this._storageKey(robotSlug, null);
        const sessionId =
            this._active?.id || this._readStored(key) || this._readCreditCache()?.sessionId || null;

        let continuation = false;
        if (sessionId) {
            const session = await this._getSession(sessionId).catch(() => null);
            if (
                session &&
                session.robotSlug === robotSlug &&
                this._sessionHasAiCredit(session) &&
                ["paid", "active", "paused_for_payment"].includes(session.status)
            ) {
                this._setActive(session);
                continuation = true;
            }
        }

        const accepted = await this._showPaywall({
            title: options.title || "Top up",
            message: options.message || PlayBilling.AI_CREDIT_PAYWALL_MESSAGE,
            currency: "aud",
            defaultPriceCents: PlayBilling.DEFAULT_PRICE_CENTS,
            action: continuation ? "continue" : "play"
        });
        if (!accepted) return false;

        return this._runCheckout({
            robotSlug,
            key,
            continuation,
            sessionId: this._active?.id || sessionId,
            accepted
        });
    }

    _resolveRobotSlug(robotSlug) {
        return (
            robotSlug ||
            this._lastRobotSlug ||
            this._readCreditCache()?.robotSlug ||
            PlayBilling.DEFAULT_ROBOT_SLUG
        );
    }

    async _runCheckout({ robotSlug, key, continuation, sessionId, accepted }) {
        const priceCents = this._clampPriceCents(accepted.priceCents ?? PlayBilling.DEFAULT_PRICE_CENTS);
        this._rememberAmountCents(priceCents);

        const checkout = await this._request("/checkout", {
            method: "POST",
            body: JSON.stringify({
                modeId: PlayBilling.CREDIT_MODE_ID,
                robot: robotSlug,
                owner: this.ownerId || undefined,
                machine: this.machineId || undefined,
                priceCents,
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
        this._writeCreditCache({
            remainingCents: this._cachedRemainingCents(),
            currency: "aud",
            sessionId: checkout.playSessionId,
            robotSlug
        });
        const checkoutWindow = this._usableCheckoutWindow(accepted.checkoutWindow);
        if (checkoutWindow) {
            this._checkoutWindow = checkoutWindow;
            try {
                checkoutWindow.location.replace(checkout.url);
            } catch (_) {
                try {
                    checkoutWindow.close();
                } catch (_) {}
                this._checkoutWindow = null;
                window.location.assign(checkout.url);
                return false;
            }
            const paidSession = await this._waitForPaid(checkout.playSessionId);
            if (!paidSession) return false;
            try {
                checkoutWindow.close();
            } catch (_) {}
            this._checkoutWindow = null;
            this._modal.hidden = true;
            this._setActive(await this._startSession(paidSession.id));
            return true;
        }
        window.location.assign(checkout.url);
        return false;
    }

    _preferSameTabCheckout() {
        try {
            if (window.matchMedia("(pointer: coarse)").matches) return true;
            if (window.matchMedia("(max-width: 900px)").matches) return true;
        } catch (_) {}
        const ua = String(navigator.userAgent || "");
        return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    }

    _usableCheckoutWindow(win) {
        if (!win || win.closed) return null;
        try {
            void win.location.href;
            return win;
        } catch (_) {
            try {
                win.close();
            } catch (_) {}
            return null;
        }
    }

    getActiveSessionId() {
        return this._active?.id || null;
    }

    getActiveSession() {
        return this._active ? { ...this._active } : null;
    }

    async fetchHostedChat(body, signal) {
        if (!this._active?.id) {
            throw new Error("No active arcade play session.");
        }
        const response = await fetch(`${this.apiBaseUrl}/ai/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Play-Session": this._active.id
            },
            body: JSON.stringify(body),
            signal
        });
        this._applyAiChargeResponse(response);
        return response;
    }

    async fetchHostedTranscribe(formData) {
        if (!this._active?.id) {
            throw new Error("No active arcade play session.");
        }
        const response = await fetch(`${this.apiBaseUrl}/ai/transcribe`, {
            method: "POST",
            headers: {
                "X-Play-Session": this._active.id
            },
            body: formData
        });
        this._applyAiChargeResponse(response);
        return response;
    }

    async fetchHostedSpeech(body) {
        if (!this._active?.id) {
            throw new Error("No active arcade play session.");
        }
        const response = await fetch(`${this.apiBaseUrl}/ai/speech`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Play-Session": this._active.id
            },
            body: JSON.stringify(body)
        });
        this._applyAiChargeResponse(response);
        return response;
    }

    fetchHostedVoiceTurn(formData, signal) {
        if (!this._active?.id) {
            throw new Error("No active arcade play session.");
        }
        return fetch(`${this.apiBaseUrl}/ai/voice-turn`, {
            method: "POST",
            headers: {
                "X-Play-Session": this._active.id
            },
            body: formData,
            signal
        });
    }

    async handlePaymentRequired(response, context = {}) {
        if (response?.status !== 402) return false;
        let payload = null;
        try {
            payload = await response.clone().json();
        } catch (_) {}
        if (payload?.session) this._setActive(payload.session);
        else this._writeCreditCache({ remainingCents: 0 });
        await this.topUpCredit({
            robotSlug: context.robotSlug,
            title: "AI credit used",
            message: PlayBilling.AI_CREDIT_NEEDED_MESSAGE
        });
        return true;
    }

    async _startSession(id) {
        const session = await this._request(`/session/${encodeURIComponent(id)}/start`, {
            method: "POST",
            body: "{}"
        });
        this._setActive(session);
        return session;
    }

    recordAiCharge(cents) {
        const charge = Math.max(0, Number(cents) || 0);
        if (!charge || !this._active) return;
        const budget = Math.max(0, Number(this._active.aiBudgetCents) || 0);
        const spent = Math.min(budget, Math.max(0, Number(this._active.aiSpentCents) || 0) + charge);
        this._setActive({
            ...this._active,
            aiSpentCents: spent,
            status: budget > 0 && spent >= budget ? "paused_for_payment" : this._active.status
        });
    }

    _applyAiChargeResponse(response) {
        if (!response?.ok) return;
        this.recordAiCharge(response.headers.get("X-Phonebot-AI-Charge-Cents"));
    }

    _setActive(session) {
        this._active = session || null;
        if (session) {
            this._writeCreditCacheFromSession(session);
            if (session.robotSlug) this._lastRobotSlug = session.robotSlug;
        }
        this._syncCreditBar();
        window.dispatchEvent(
            new CustomEvent("phonebot:ai-budget", {
                detail: this.getActiveSession()
            })
        );
    }

    _sessionRemainingCents(session) {
        if (!session) return 0;
        const budget = Math.max(0, Number(session.aiBudgetCents) || 0);
        const spent = Math.min(budget, Math.max(0, Number(session.aiSpentCents) || 0));
        return Math.max(0, budget - spent);
    }

    _cachedRemainingCents() {
        if (this._active) return this._sessionRemainingCents(this._active);
        return Math.max(0, Number(this._readCreditCache()?.remainingCents) || 0);
    }

    _readCreditCache() {
        try {
            const raw = localStorage.getItem(PlayBilling.CREDIT_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return null;
            return parsed;
        } catch (_) {
            return null;
        }
    }

    _writeCreditCache( partial = {}) {
        const prev = this._readCreditCache() || {};
        const next = {
            remainingCents: Math.max(
                0,
                Number(partial.remainingCents != null ? partial.remainingCents : prev.remainingCents) || 0
            ),
            currency: partial.currency || prev.currency || "aud",
            sessionId:
                partial.sessionId !== undefined ? partial.sessionId : prev.sessionId || null,
            robotSlug: partial.robotSlug || prev.robotSlug || this._lastRobotSlug || null,
            updatedAt: Date.now()
        };
        try {
            localStorage.setItem(PlayBilling.CREDIT_CACHE_KEY, JSON.stringify(next));
        } catch (_) {}
        return next;
    }

    _writeCreditCacheFromSession(session) {
        if (!session) return;
        this._writeCreditCache({
            remainingCents: this._sessionRemainingCents(session),
            currency: session.currency || "aud",
            sessionId: session.id,
            robotSlug: session.robotSlug
        });
    }

    _ensureDock() {
        if (this._dock || typeof document === "undefined" || !document.body) return;
        const dock = document.createElement("div");
        dock.className = "play-credit-dock";
        dock.innerHTML = `
            <button type="button" class="play-credit-bar" data-action="top-up" aria-live="polite" aria-label="Top up AI credit">
                <span class="play-credit-bar-fill" aria-hidden="true"></span>
                <span class="play-credit-bar-label"></span>
            </button>`;
        dock.querySelector('[data-action="top-up"]').addEventListener("click", () => {
            void this.topUpCredit().catch((err) => {
                console.error("Top up failed:", err);
            });
        });
        document.body.appendChild(dock);
        document.body.classList.add("play-credit-dock-visible");
        this._dock = dock;
        this._creditBar = dock.querySelector(".play-credit-bar");
    }

    _syncCreditBar() {
        this._ensureDock();
        if (!this._creditBar) return;
        const remaining = this._cachedRemainingCents();
        const currency = this._active?.currency || this._readCreditCache()?.currency || "aud";
        const percent = Math.max(
            0,
            Math.min(100, (remaining / PlayBilling.MAX_PRICE_CENTS) * 100)
        );
        const fill = this._creditBar.querySelector(".play-credit-bar-fill");
        const label = this._creditBar.querySelector(".play-credit-bar-label");
        if (fill) fill.style.width = `${percent}%`;
        if (label) {
            label.textContent = `${this.formatPrice(remaining, currency)} AI credit`;
        }
        this._creditBar.hidden = false;
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

    _sessionHasAiCredit(session) {
        return (Number(session?.aiBudgetCents) || 0) > 0;
    }

    _storageKey(robotSlug, modeId) {
        const robot = String(robotSlug || "robot");
        if (!modeId) return `${PlayBilling.STORAGE_PREFIX}${robot}.arcade`;
        return `${PlayBilling.STORAGE_PREFIX}${robot}.${modeId}`;
    }

    _legacyModeStorageKeys(robotSlug) {
        const prefix = `${PlayBilling.STORAGE_PREFIX}${robotSlug}.`;
        const keys = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key || !key.startsWith(prefix) || key.endsWith(".arcade")) continue;
                keys.push(key);
            }
        } catch (_) {}
        return keys;
    }

    _findLegacyModeSessionId(robotSlug) {
        for (const key of this._legacyModeStorageKeys(robotSlug)) {
            try {
                const id = localStorage.getItem(key);
                if (id) return id;
            } catch (_) {}
        }
        return null;
    }

    _clearLegacyModeSessionKeys(robotSlug) {
        for (const key of this._legacyModeStorageKeys(robotSlug)) {
            try {
                localStorage.removeItem(key);
            } catch (_) {}
        }
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

    _showPaywall({
        title,
        message,
        currency = "aud",
        defaultPriceCents,
        action = "play"
    }) {
        if (this._modalResolve) {
            this._modalResolve(false);
            this._modalResolve = null;
        }
        if (!this._modal) this._buildModal();
        this._pollCancelled = false;
        this._amountCurrency = currency;
        this._amountAction = action;
        this._amountCents = this._clampPriceCents(
            this._readRememberedAmountCents() ?? defaultPriceCents ?? PlayBilling.DEFAULT_PRICE_CENTS
        );
        this._modal.querySelector(".play-billing-title").textContent = title;
        this._modal.querySelector(".play-billing-message").textContent = message;
        this._modal.querySelector(".play-billing-error").textContent = "";
        const amountLabel = this._modal.querySelector(".play-billing-amount-label");
        if (amountLabel) amountLabel.textContent = "Amount (AUD)";
        const cancel = this._modal.querySelector(".play-billing-cancel");
        if (cancel) cancel.hidden = false;
        this._modal.dataset.infoOnly = "";
        this._syncAmountUi();
        this._modal.querySelector(".play-billing-pay").disabled = false;
        this._modal.hidden = false;
        return new Promise((resolve) => {
            this._modalResolve = resolve;
        });
    }

    _clampPriceCents(cents) {
        let value = Math.round(Number(cents) || 0);
        value = Math.round(value / PlayBilling.PRICE_STEP_CENTS) * PlayBilling.PRICE_STEP_CENTS;
        return Math.min(
            PlayBilling.MAX_PRICE_CENTS,
            Math.max(PlayBilling.MIN_PRICE_CENTS, value)
        );
    }

    _readRememberedAmountCents() {
        try {
            const raw = localStorage.getItem(PlayBilling.LAST_AMOUNT_KEY);
            if (raw == null || raw === "") return null;
            const cents = Number(raw);
            return Number.isFinite(cents) ? cents : null;
        } catch (_) {
            return null;
        }
    }

    _rememberAmountCents(cents) {
        try {
            localStorage.setItem(PlayBilling.LAST_AMOUNT_KEY, String(this._clampPriceCents(cents)));
        } catch (_) {}
    }

    _readAmountInputCents() {
        const input = this._modal?.querySelector(".play-billing-amount-input");
        if (!input) return this._amountCents;
        const dollars = Number(String(input.value || "").trim());
        if (!Number.isFinite(dollars)) return this._amountCents;
        return this._clampPriceCents(Math.round(dollars) * 100);
    }

    _syncAmountUi() {
        if (!this._modal) return;
        const input = this._modal.querySelector(".play-billing-amount-input");
        const credit = this._modal.querySelector(".play-billing-credit");
        const pay = this._modal.querySelector(".play-billing-pay");
        const down = this._modal.querySelector(".play-billing-amount-down");
        const up = this._modal.querySelector(".play-billing-amount-up");
        if (input) input.value = String(Math.round(this._amountCents / 100));
        if (credit) {
            credit.textContent = `Hosted AI credit: ${this.formatPrice(this._amountCents, this._amountCurrency)}`;
        }
        if (pay) {
            pay.textContent = `Pay ${this.formatPrice(this._amountCents, this._amountCurrency)} to ${this._amountAction}`;
            pay.disabled = false;
        }
        if (down) down.disabled = this._amountCents <= PlayBilling.MIN_PRICE_CENTS;
        if (up) up.disabled = this._amountCents >= PlayBilling.MAX_PRICE_CENTS;
    }

    _nudgeAmount(deltaSteps) {
        this._amountCents = this._clampPriceCents(
            this._amountCents + deltaSteps * PlayBilling.PRICE_STEP_CENTS
        );
        this._syncAmountUi();
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
                <div class="play-billing-amount">
                    <label class="play-billing-amount-label" for="playBillingAmount">Amount (AUD)</label>
                    <div class="play-billing-amount-row">
                        <button type="button" class="play-billing-amount-down secondary" aria-label="Decrease by one dollar">−</button>
                        <input id="playBillingAmount" class="play-billing-amount-input" type="number" inputmode="numeric" min="1" max="10" step="1" />
                        <button type="button" class="play-billing-amount-up secondary" aria-label="Increase by one dollar">+</button>
                    </div>
                    <p class="play-billing-credit" aria-live="polite"></p>
                </div>
                <p class="play-billing-wallets">Secure Stripe Checkout · card, Apple Pay or Google Pay when available</p>
                <p class="play-billing-error error" aria-live="polite"></p>
                <button type="button" class="play-billing-pay"></button>
                <button type="button" class="play-billing-cancel secondary">Not now</button>
            </section>`;
        const pay = overlay.querySelector(".play-billing-pay");
        const cancel = overlay.querySelector(".play-billing-cancel");
        const input = overlay.querySelector(".play-billing-amount-input");
        const down = overlay.querySelector(".play-billing-amount-down");
        const up = overlay.querySelector(".play-billing-amount-up");
        down.addEventListener("click", () => this._nudgeAmount(-1));
        up.addEventListener("click", () => this._nudgeAmount(1));
        input.addEventListener("change", () => {
            this._amountCents = this._readAmountInputCents();
            this._syncAmountUi();
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                pay.click();
            }
        });
        pay.addEventListener("click", () => {
            this._amountCents = this._readAmountInputCents();
            this._syncAmountUi();
            pay.disabled = true;
            let checkoutWindow = null;
            if (!this._preferSameTabCheckout()) {
                checkoutWindow = window.open("about:blank", "phonebotStripeCheckout");
                if (!checkoutWindow || checkoutWindow.closed) {
                    checkoutWindow = null;
                }
            }
            const resolve = this._modalResolve;
            this._modalResolve = null;
            if (resolve) resolve({ checkoutWindow, priceCents: this._amountCents });
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
