/**
 * @typedef {object} Character
 * @property {string} id
 * @property {string} name
 * @property {string} bio Prompt sent as a system message on every AI turn while active.
 * @property {string} voice TTS voice id; "" keeps whatever voice is selected.
 * @property {string[]} games Dashboard game ids shown while active: robot mode ids,
 *   `game:<id>` for JSON games in games/index.json, `custom:<id>` for browser-saved games.
 * @property {string} homeGame One of `games` that games go to when they end; "" = no game.
 * @property {Record<string, string>} onGameEnd Per-game override of where it goes when it
 *   ends: another game id, or "none" for no game. Games not listed go to `homeGame`.
 */

/**
 * Robot characters. Repo characters are listed in characters/index.json; edits and uploads
 * live in localStorage and replace a repo character with the same id.
 */
class PhonebotCharacters {
    static INDEX_URL = "characters/index.json";
    static STORAGE_KEY = "phonebot.characters.v1";
    static FORMAT = "phonebot.characterProfile.v1";
    /** Fired on window when the active character or any saved character changes. */
    static CHANGE_EVENT = "phonebot:characterchange";
    static NAME_MAX = 48;
    /** @type {Character[]} */
    static _builtins = [];
    /** @type {Promise<Character[]>|null} */
    static _builtinsPromise = null;

    /**
     * Fetch every character listed in the repo index. Resolves to [] when the index can't be
     * fetched (e.g. opened from file://).
     * @returns {Promise<Character[]>}
     */
    static loadBuiltins() {
        if (!PhonebotCharacters._builtinsPromise) {
            PhonebotCharacters._builtinsPromise = fetch(PhonebotCharacters.INDEX_URL, {
                cache: "no-cache"
            })
                .then((res) => {
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    return res.json();
                })
                .then(async (index) => {
                    const entries = (Array.isArray(index?.characters) ? index.characters : []).filter(
                        (e) => e && e.path
                    );
                    const loaded = await Promise.all(
                        entries.map(async (entry) => {
                            try {
                                const res = await fetch(String(entry.path), { cache: "no-cache" });
                                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                const raw = await res.json();
                                return PhonebotCharacters.normalize({
                                    ...raw,
                                    id: String(entry.id || raw?.id || "")
                                });
                            } catch (err) {
                                console.warn("Character load failed:", entry.path, err);
                                return null;
                            }
                        })
                    );
                    PhonebotCharacters._builtins = loaded.filter(Boolean);
                    PhonebotCharacters._emitChange();
                    return PhonebotCharacters._builtins;
                })
                .catch((err) => {
                    console.warn("Characters index load failed:", err);
                    PhonebotCharacters._builtinsPromise = null;
                    return [];
                });
        }
        return PhonebotCharacters._builtinsPromise;
    }

    /**
     * @param {object} raw
     * @returns {Character|null}
     */
    static normalize(raw) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const name = String(raw.name || "")
            .trim()
            .slice(0, PhonebotCharacters.NAME_MAX);
        if (!name) return null;
        const games = Array.isArray(raw.games)
            ? [...new Set(raw.games.map((g) => String(g || "").trim()).filter(Boolean))]
            : [];
        const homeGame = String(raw.homeGame || "").trim();
        /** @type {Record<string, string>} */
        const onGameEnd = {};
        if (raw.onGameEnd && typeof raw.onGameEnd === "object" && !Array.isArray(raw.onGameEnd)) {
            for (const [id, target] of Object.entries(raw.onGameEnd)) {
                const key = String(id || "").trim();
                const value = String(target || "").trim();
                if (games.includes(key) && (value === "none" || games.includes(value))) {
                    onGameEnd[key] = value;
                }
            }
        }
        return {
            id: String(raw.id || "").trim() || PhonebotCharacters._slug(name),
            name,
            bio: String(raw.bio || "").trim(),
            voice: String(raw.voice || "").trim(),
            games,
            homeGame: games.includes(homeGame) ? homeGame : "",
            onGameEnd
        };
    }

    static _slug(name) {
        const words = String(name || "")
            .trim()
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        if (!words.length) return "character";
        return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
    }

    static _uniqueId(name) {
        const taken = new Set(PhonebotCharacters.list().map((c) => c.id));
        const base = PhonebotCharacters._slug(name);
        if (!taken.has(base)) return base;
        let n = 2;
        while (taken.has(`${base}${n}`)) n += 1;
        return `${base}${n}`;
    }

    /** @returns {{ activeId: string|null, characters: Character[] }} */
    static _loadStore() {
        try {
            const parsed = JSON.parse(localStorage.getItem(PhonebotCharacters.STORAGE_KEY) || "null");
            if (parsed && typeof parsed === "object") {
                return {
                    activeId: parsed.activeId ? String(parsed.activeId) : null,
                    characters: Array.isArray(parsed.characters)
                        ? parsed.characters.map((c) => PhonebotCharacters.normalize(c)).filter(Boolean)
                        : []
                };
            }
        } catch (err) {
            console.warn("Characters store read failed:", err);
        }
        return { activeId: null, characters: [] };
    }

    static _saveStore(store) {
        try {
            localStorage.setItem(PhonebotCharacters.STORAGE_KEY, JSON.stringify(store));
        } catch (err) {
            console.warn("Characters store write failed:", err);
        }
        PhonebotCharacters._emitChange();
    }

    static _emitChange() {
        try {
            window.dispatchEvent(new CustomEvent(PhonebotCharacters.CHANGE_EVENT));
        } catch (_) {}
    }

    /**
     * Repo characters (in index order), then characters that only exist locally.
     * `builtin` marks repo characters; `edited` marks a repo character with a local copy.
     * @returns {(Character & { builtin: boolean, edited: boolean })[]}
     */
    static list() {
        const local = PhonebotCharacters._loadStore().characters;
        const localById = new Map(local.map((c) => [c.id, c]));
        const builtinIds = new Set(PhonebotCharacters._builtins.map((c) => c.id));
        return [
            ...PhonebotCharacters._builtins.map((c) =>
                localById.has(c.id)
                    ? { ...localById.get(c.id), builtin: true, edited: true }
                    : { ...c, builtin: true, edited: false }
            ),
            ...local
                .filter((c) => !builtinIds.has(c.id))
                .map((c) => ({ ...c, builtin: false, edited: false }))
        ];
    }

    static get(id) {
        const want = String(id || "");
        if (!want) return null;
        return PhonebotCharacters.list().find((c) => c.id === want) || null;
    }

    static activeId() {
        return PhonebotCharacters._loadStore().activeId;
    }

    /** Null while no character is chosen (or its repo file hasn't loaded yet). */
    static activeCharacter() {
        return PhonebotCharacters.get(PhonebotCharacters.activeId());
    }

    /** @param {string|null} id null clears the character so every game shows. */
    static setActive(id) {
        const store = PhonebotCharacters._loadStore();
        store.activeId = id && PhonebotCharacters.get(id) ? String(id) : null;
        PhonebotCharacters._saveStore(store);
    }

    /**
     * Create or update a local character. A missing id gets a new unique one.
     * @param {Partial<Character>} character
     * @returns {Character|null}
     */
    static save(character) {
        const id =
            String(character?.id || "").trim() || PhonebotCharacters._uniqueId(character?.name);
        const normalized = PhonebotCharacters.normalize({ ...character, id });
        if (!normalized) return null;
        const store = PhonebotCharacters._loadStore();
        const idx = store.characters.findIndex((c) => c.id === normalized.id);
        if (idx >= 0) store.characters[idx] = normalized;
        else store.characters.push(normalized);
        PhonebotCharacters._saveStore(store);
        return normalized;
    }

    /**
     * Drop the local copy. Repo characters fall back to their repo version.
     * @returns {boolean}
     */
    static remove(id) {
        const store = PhonebotCharacters._loadStore();
        const before = store.characters.length;
        store.characters = store.characters.filter((c) => c.id !== id);
        if (store.characters.length === before) return false;
        const isBuiltin = PhonebotCharacters._builtins.some((c) => c.id === id);
        if (store.activeId === id && !isBuiltin) store.activeId = null;
        PhonebotCharacters._saveStore(store);
        return true;
    }

    /**
     * Parse an uploaded character file. Rejects game backups (they carry `messages`).
     * @param {object} payload
     * @returns {Character|null}
     */
    static fromJson(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
        const format = String(payload.format || "").trim();
        if (format && format !== PhonebotCharacters.FORMAT) return null;
        if (Array.isArray(payload.messages)) return null;
        return PhonebotCharacters.normalize(payload);
    }

    /** Uploading a file whose id already exists replaces that character. */
    static importJson(payload) {
        const character = PhonebotCharacters.fromJson(payload);
        return character ? PhonebotCharacters.save(character) : null;
    }

    /** @param {Character} character */
    static toJson(character) {
        return {
            format: PhonebotCharacters.FORMAT,
            id: character.id,
            name: character.name,
            bio: character.bio,
            voice: character.voice,
            games: [...character.games],
            homeGame: character.homeGame || "",
            onGameEnd: { ...(character.onGameEnd || {}) }
        };
    }

    /** Download as `<id>.json`, ready to drop into the characters folder. */
    static download(character) {
        const safeName =
            String(character?.id || "character")
                .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
                .slice(0, 64) || "character";
        const blob = new Blob([JSON.stringify(PhonebotCharacters.toJson(character), null, 2)], {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    /** @returns {{ id: string, label: string }[]} "" = keep the currently selected voice. */
    static voiceOptions() {
        const voices =
            typeof window.GroqTts?.pickerVoices === "function" ? window.GroqTts.pickerVoices() : [];
        return [
            { id: "", label: "Keep current voice" },
            ...voices.map((v) => ({ id: String(v.id), label: String(v.label || v.id) }))
        ];
    }
}

/**
 * Characters dialog opened from the robot panel: pick, create, edit and upload characters.
 */
class CharactersPanel {
    /**
     * @param {object} robot needs `getCharacterGameOptions()` and `gamesIndexReady`
     */
    constructor(robot) {
        this.robot = robot;
        this._overlay = null;
        this._listEl = null;
        this._editorOverlay = null;
        this._onChange = () => this._renderList();
    }

    open() {
        this.close();
        this._mount();
        window.addEventListener(PhonebotCharacters.CHANGE_EVENT, this._onChange);
        void PhonebotCharacters.loadBuiltins();
    }

    close() {
        window.removeEventListener(PhonebotCharacters.CHANGE_EVENT, this._onChange);
        this._closeEditor();
        this._overlay?.remove();
        this._overlay = null;
        this._listEl = null;
    }

    _closeEditor() {
        this._editorOverlay?.remove();
        this._editorOverlay = null;
    }

    /** @returns {Promise<object|null>} */
    _pickJsonFile() {
        return new Promise((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".json,application/json";
            input.hidden = true;
            input.addEventListener("change", async () => {
                const file = input.files && input.files[0];
                input.remove();
                if (!file) return resolve(null);
                try {
                    resolve(JSON.parse(await file.text()));
                } catch (err) {
                    console.warn("Character file read failed:", err);
                    window.alert?.("Could not read that character file.");
                    resolve(null);
                }
            });
            document.body.appendChild(input);
            input.click();
            // Remove if the user cancels the picker (change never fires).
            setTimeout(() => {
                if (input.parentElement && !input.files?.length) input.remove();
            }, 60_000);
        });
    }

    async _onUpload() {
        const payload = await this._pickJsonFile();
        if (!payload) return;
        if (!PhonebotCharacters.importJson(payload)) {
            window.alert?.("That file is not a valid character.");
        }
    }

    _onRemove(character) {
        const question = character.builtin
            ? `Reset “${character.name}” to the built-in version? Your edits will be lost.`
            : `Delete “${character.name}”? This cannot be undone.`;
        const ok = typeof window.confirm === "function" ? window.confirm(question) : true;
        if (ok) PhonebotCharacters.remove(character.id);
    }

    _mount() {
        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay characters-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Characters");

        const card = document.createElement("div");
        card.className = "custom-messages-card custom-messages-actions-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = "Characters";
        card.appendChild(title);

        const hint = document.createElement("p");
        hint.className = "custom-messages-hint muted";
        hint.textContent =
            "Tap a name to play as that character. With no character, every game shows on the dashboard.";
        card.appendChild(hint);

        const list = document.createElement("div");
        list.className = "custom-messages-tiles";
        list.setAttribute("role", "list");
        card.appendChild(list);

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const newBtn = document.createElement("button");
        newBtn.type = "button";
        newBtn.className = "custom-messages-add";
        newBtn.textContent = "New";
        newBtn.addEventListener("click", () => void this._openEditor(null));

        const uploadBtn = document.createElement("button");
        uploadBtn.type = "button";
        uploadBtn.className = "secondary";
        uploadBtn.textContent = "Upload";
        uploadBtn.title = "Load a character from a JSON file";
        uploadBtn.addEventListener("click", () => void this._onUpload());

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "secondary";
        closeBtn.textContent = "Close";
        closeBtn.addEventListener("click", () => this.close());

        actions.appendChild(newBtn);
        actions.appendChild(uploadBtn);
        actions.appendChild(closeBtn);
        card.appendChild(actions);

        overlay.appendChild(card);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this.close();
        });
        document.body.appendChild(overlay);
        this._overlay = overlay;
        this._listEl = list;
        this._renderList();
    }

    _renderList() {
        const list = this._listEl;
        if (!list) return;
        list.innerHTML = "";
        const activeId = PhonebotCharacters.activeCharacter()?.id || null;

        list.appendChild(
            this._buildRow("No character (all games)", {
                active: !activeId,
                onSelect: () => PhonebotCharacters.setActive(null)
            })
        );
        for (const character of PhonebotCharacters.list()) {
            const canRemove = !character.builtin || character.edited;
            list.appendChild(
                this._buildRow(character.name, {
                    active: character.id === activeId,
                    onSelect: () => PhonebotCharacters.setActive(character.id),
                    onEdit: () => void this._openEditor(character),
                    removeLabel: character.builtin ? "Reset" : "Delete",
                    onRemove: canRemove ? () => this._onRemove(character) : null
                })
            );
        }
    }

    /**
     * @param {string} name
     * @param {{ active: boolean, onSelect: () => void, onEdit?: () => void, removeLabel?: string, onRemove?: (() => void)|null }} handlers
     */
    _buildRow(name, { active, onSelect, onEdit = null, removeLabel = "", onRemove = null }) {
        const tile = document.createElement("div");
        tile.className = "custom-messages-tile custom-messages-game-row characters-row";
        tile.classList.toggle("is-active", active);
        tile.setAttribute("role", "listitem");

        const nameBtn = document.createElement("button");
        nameBtn.type = "button";
        nameBtn.className = "custom-messages-game-row-name";
        nameBtn.textContent = active ? `✓ ${name}` : name;
        nameBtn.setAttribute("aria-pressed", active ? "true" : "false");
        nameBtn.addEventListener("click", onSelect);
        tile.appendChild(nameBtn);

        if (onEdit) {
            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "custom-messages-tile-edit";
            editBtn.textContent = "Edit";
            editBtn.setAttribute("aria-label", `Edit ${name}`);
            editBtn.addEventListener("click", onEdit);
            tile.appendChild(editBtn);
        }
        if (onRemove) {
            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "custom-messages-tile-edit custom-messages-game-delete";
            removeBtn.textContent = removeLabel;
            removeBtn.setAttribute("aria-label", `${removeLabel} ${name}`);
            removeBtn.addEventListener("click", onRemove);
            tile.appendChild(removeBtn);
        }
        return tile;
    }

    /** @param {Character|null} character null creates a new character. */
    async _openEditor(character) {
        this._closeEditor();
        await this.robot?.gamesIndexReady;
        if (!this._overlay) return;
        const gameOptions =
            typeof this.robot?.getCharacterGameOptions === "function"
                ? this.robot.getCharacterGameOptions()
                : [];
        const knownGameIds = new Set(gameOptions.map((g) => g.id));
        const gameLabels = new Map(gameOptions.map((g) => [g.id, g.label]));
        /** Games that can finish on their own, so they get a "when it ends" choice. */
        const canEnd = new Set();
        if (typeof this.robot?.gameCanEnd === "function") {
            await Promise.all(
                gameOptions.map(async (g) => {
                    if (await this.robot.gameCanEnd(g.id)) canEnd.add(g.id);
                })
            );
            if (!this._overlay) return;
        }

        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-editor-overlay characters-editor-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", character ? "Edit character" : "New character");

        const card = document.createElement("div");
        card.className = "custom-messages-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = character ? "Edit character" : "New character";
        card.appendChild(title);

        const nameLabel = document.createElement("label");
        nameLabel.className = "custom-messages-game-meta-label";
        nameLabel.textContent = "Name";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "custom-messages-game-meta-name-input";
        nameInput.placeholder = "e.g. Captain Barnacle";
        nameInput.autocomplete = "off";
        nameInput.maxLength = PhonebotCharacters.NAME_MAX;
        nameLabel.appendChild(nameInput);

        const bioLabel = document.createElement("label");
        bioLabel.className = "custom-messages-game-meta-label";
        bioLabel.textContent = "Bio prompt";
        const bioInput = document.createElement("textarea");
        bioInput.className = "custom-messages-text characters-bio";
        bioInput.placeholder =
            "Who is this character? How do they talk? Sent to the AI before every game.";
        bioLabel.appendChild(bioInput);

        const voiceLabel = document.createElement("label");
        voiceLabel.className = "custom-messages-game-meta-label";
        voiceLabel.textContent = "Voice";
        const voiceSelect = document.createElement("select");
        voiceSelect.className = "custom-messages-game-meta-name-input";
        for (const v of PhonebotCharacters.voiceOptions()) {
            const opt = document.createElement("option");
            opt.value = v.id;
            opt.textContent = v.label;
            voiceSelect.appendChild(opt);
        }
        voiceLabel.appendChild(voiceSelect);

        const gamesHeading = document.createElement("p");
        gamesHeading.className = "custom-messages-game-meta-label";
        gamesHeading.textContent = "Games they play";
        const gamesHint = document.createElement("p");
        gamesHint.className = "muted characters-games-hint";
        gamesHint.textContent = "Menu is always available.";
        const gamesWrap = document.createElement("div");
        /** @type {Map<string, HTMLInputElement>} */
        const gameChecks = new Map();
        /** @type {Map<string, HTMLDivElement>} */
        const groupGrids = new Map();
        for (const game of gameOptions) {
            const group = String(game.group || "");
            if (!groupGrids.has(group)) {
                if (group) {
                    const groupHeading = document.createElement("p");
                    groupHeading.className = "custom-messages-constraints-heading";
                    groupHeading.textContent = group;
                    gamesWrap.appendChild(groupHeading);
                }
                const grid = document.createElement("div");
                grid.className = "characters-games";
                gamesWrap.appendChild(grid);
                groupGrids.set(group, grid);
            }
            const label = document.createElement("label");
            label.className = "custom-messages-camera-label";
            const check = document.createElement("input");
            check.type = "checkbox";
            check.value = game.id;
            check.addEventListener("change", () => renderGameChoices());
            label.appendChild(check);
            label.appendChild(document.createTextNode(game.label));
            groupGrids.get(group).appendChild(label);
            gameChecks.set(game.id, check);
        }
        if (!gameOptions.length) {
            const none = document.createElement("p");
            none.className = "muted";
            none.textContent = "This robot has no games to choose from.";
            gamesWrap.appendChild(none);
        }

        const homeLabel = document.createElement("label");
        homeLabel.className = "custom-messages-game-meta-label";
        homeLabel.textContent = "Home game";
        const homeSelect = document.createElement("select");
        homeSelect.className = "custom-messages-game-meta-name-input";
        homeSelect.addEventListener("change", () => {
            homeGame = homeSelect.value;
            renderEnds();
        });
        homeLabel.appendChild(homeSelect);
        const homeHint = document.createElement("p");
        homeHint.className = "muted characters-games-hint";
        homeHint.textContent = "Where their games go when they end, unless changed below.";

        const endsSection = document.createElement("div");
        const endsHeading = document.createElement("p");
        endsHeading.className = "custom-messages-game-meta-label";
        endsHeading.textContent = "When a game ends";
        const endsHint = document.createElement("p");
        endsHint.className = "muted characters-games-hint";
        endsHint.textContent = "Only games that can finish on their own are listed.";
        const endsList = document.createElement("div");
        endsList.className = "characters-game-ends";
        endsSection.appendChild(endsHeading);
        endsSection.appendChild(endsHint);
        endsSection.appendChild(endsList);

        const meta = document.createElement("div");
        meta.className = "custom-messages-game-meta";
        meta.appendChild(nameLabel);
        meta.appendChild(bioLabel);
        meta.appendChild(voiceLabel);
        const gamesSection = document.createElement("div");
        gamesSection.appendChild(gamesHeading);
        gamesSection.appendChild(gamesHint);
        gamesSection.appendChild(gamesWrap);
        meta.appendChild(gamesSection);
        const homeSection = document.createElement("div");
        homeSection.appendChild(homeLabel);
        homeSection.appendChild(homeHint);
        meta.appendChild(homeSection);
        meta.appendChild(endsSection);
        card.appendChild(meta);

        /** Games from other robots are kept even though they have no checkbox here. */
        let otherGames = [];
        /** Kept while its game is unchecked, so re-checking it restores the choice. */
        let homeGame = "";
        /** @type {Record<string, string>} */
        let onGameEnd = {};
        const checkedGames = () =>
            [...gameChecks].filter(([, check]) => check.checked).map(([id]) => id);
        const labelOf = (id) => gameLabels.get(id) || id;
        const addOption = (select, value, text) => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = text;
            select.appendChild(opt);
        };
        const renderHome = () => {
            const games = checkedGames();
            homeSelect.replaceChildren();
            addOption(homeSelect, "", "None");
            for (const id of games) addOption(homeSelect, id, labelOf(id));
            homeSelect.value = games.includes(homeGame) ? homeGame : "";
        };
        const renderEnds = () => {
            const games = checkedGames();
            const home = games.includes(homeGame) ? homeGame : "";
            const endable = games.filter((id) => canEnd.has(id));
            endsList.replaceChildren();
            endsSection.hidden = !endable.length;
            for (const id of endable) {
                const row = document.createElement("label");
                row.className = "custom-messages-game-meta-label";
                row.textContent = labelOf(id);
                const select = document.createElement("select");
                select.className = "custom-messages-game-meta-name-input";
                addOption(select, "", home ? `Home game (${labelOf(home)})` : "Home game (none set)");
                addOption(select, "none", "No game");
                for (const other of games) {
                    if (other !== id) addOption(select, other, labelOf(other));
                }
                const rule = onGameEnd[id] || "";
                select.value = [...select.options].some((o) => o.value === rule) ? rule : "";
                select.addEventListener("change", () => {
                    if (select.value) onGameEnd[id] = select.value;
                    else delete onGameEnd[id];
                });
                row.appendChild(select);
                endsList.appendChild(row);
            }
        };
        const renderGameChoices = () => {
            renderHome();
            renderEnds();
        };

        const fill = (source) => {
            nameInput.value = source?.name || "";
            bioInput.value = source?.bio || "";
            const voice = String(source?.voice || "");
            if (voice && ![...voiceSelect.options].some((o) => o.value === voice)) {
                const opt = document.createElement("option");
                opt.value = voice;
                opt.textContent = voice;
                voiceSelect.appendChild(opt);
            }
            voiceSelect.value = voice;
            const games = new Set(source?.games || []);
            for (const [id, check] of gameChecks) check.checked = games.has(id);
            otherGames = [...games].filter((id) => !knownGameIds.has(id));
            homeGame = String(source?.homeGame || "");
            onGameEnd = { ...(source?.onGameEnd || {}) };
            renderGameChoices();
            syncSave();
        };

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "custom-messages-submit";
        saveBtn.textContent = "Save";
        saveBtn.title = "Save and download as JSON";
        const syncSave = () => {
            saveBtn.disabled = !nameInput.value.trim();
        };
        nameInput.addEventListener("input", syncSave);
        saveBtn.addEventListener("click", () => {
            const checked = checkedGames();
            // normalize() also drops unchecked games and targets they no longer play.
            const endings = Object.entries(onGameEnd).filter(
                ([id, target]) => otherGames.includes(id) || (canEnd.has(id) && target !== id)
            );
            const saved = PhonebotCharacters.save({
                id: character?.id || "",
                name: nameInput.value,
                bio: bioInput.value,
                voice: voiceSelect.value,
                games: [...checked, ...otherGames],
                homeGame,
                onGameEnd: Object.fromEntries(endings)
            });
            if (!saved) return;
            PhonebotCharacters.download(saved);
            this._closeEditor();
        });

        const uploadBtn = document.createElement("button");
        uploadBtn.type = "button";
        uploadBtn.className = "secondary";
        uploadBtn.textContent = "Upload";
        uploadBtn.title = "Fill this form from a character JSON file";
        uploadBtn.addEventListener("click", async () => {
            const payload = await this._pickJsonFile();
            if (!payload) return;
            const loaded = PhonebotCharacters.fromJson(payload);
            if (!loaded) {
                window.alert?.("That file is not a valid character.");
                return;
            }
            fill(loaded);
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "secondary";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => this._closeEditor());

        actions.appendChild(saveBtn);
        actions.appendChild(uploadBtn);
        actions.appendChild(cancelBtn);
        card.appendChild(actions);

        overlay.appendChild(card);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this._closeEditor();
        });
        document.body.appendChild(overlay);
        this._editorOverlay = overlay;
        fill(character);
        setTimeout(() => nameInput.focus(), 0);
    }
}

window.PhonebotCharacters = PhonebotCharacters;
window.CharactersPanel = CharactersPanel;
void PhonebotCharacters.loadBuiltins();
