/**
 * @typedef {object} CharacterGame
 * @property {string} id Folder name in the character's games/ folder; `game:<id>` in the dashboard.
 * @property {string} name
 * @property {string} [path] App-relative path of the game JSON; set on repo characters' games.
 */

/**
 * @typedef {object} Character
 * @property {string} id Also the character's folder name.
 * @property {string} name
 * @property {string} bio Prompt sent as a system message on every AI turn while active.
 * @property {string} voice TTS voice id; "" keeps whatever voice is selected.
 * @property {CharacterGame[]} games The character's own games, in dashboard order.
 * @property {string[]} builtInGames Code games (robot mode ids such as "parrot") they also play.
 * @property {string} homeGame A playable id (`game:<id>` or a built-in game) that built-in games
 *   and actions whose On end is "End game, go to home game" go to when they end; "" = no game.
 */

/**
 * @typedef {object} CharacterGameEntry
 * @property {string} id
 * @property {string} name
 * @property {string} savedId This browser's copy in the game store ("" = none yet).
 * @property {string} repoPath The repo version's JSON path ("" = the game only exists locally).
 */

/**
 * Robot characters. Each is a folder: `characters/<id>/<id>.json` plus `games/<game>/<game>.json`
 * (and any `audio/`) for every game it owns. Repo characters are listed in characters/index.json;
 * edits and uploads live in this browser and replace a repo character with the same id. Games run
 * from a local copy in the game store, made from the repo file the first time they're needed.
 */
class PhonebotCharacters {
    static INDEX_URL = "characters/index.json";
    static STORAGE_KEY = "phonebot.characters.v2";
    static STORAGE_KEY_V1 = "phonebot.characters.v1";
    static FORMAT = "phonebot.characterProfile.v2";
    static FORMAT_V1 = "phonebot.characterProfile.v1";
    static GAME_PREFIX = "game:";
    /** Old shared-game ids whose folder got a new name when games moved into characters. */
    static LEGACY_GAME_IDS = Object.freeze({ escapeTheWallJson: "escapeTheWall" });
    /** Fired on window when the active character or any saved character changes. */
    static CHANGE_EVENT = "phonebot:characterchange";
    static NAME_MAX = 48;
    /** @type {Character[]} */
    static _builtins = [];
    /** @type {Promise<Character[]>|null} */
    static _builtinsPromise = null;
    /** @type {Map<string, Promise<object>>} Repo game files by path. */
    static _repoGameFiles = new Map();
    /** @type {Map<string, Promise<string>>} In-flight local copies by `characterId/slug`. */
    static _copying = new Map();
    static _migrating = false;

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
                    const entries = (Array.isArray(index?.characters) ? index.characters : [])
                        .map((e) => (typeof e === "string" ? { id: e } : e))
                        .filter((e) => e && e.id);
                    const loaded = await Promise.all(
                        entries.map(async (entry) => {
                            const id = String(entry.id);
                            const path = String(entry.path || `characters/${id}/${id}.json`);
                            try {
                                const res = await fetch(path, { cache: "no-cache" });
                                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                const raw = await res.json();
                                return PhonebotCharacters.normalize({ ...raw, id }, { basePath: path });
                            } catch (err) {
                                console.warn("Character load failed:", path, err);
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

    /** Old `game:<id>` references, renamed where the game's folder changed. */
    static _legacyGameRef(ref) {
        const value = String(ref || "").trim();
        if (!value.startsWith(PhonebotCharacters.GAME_PREFIX)) return value;
        const id = value.slice(PhonebotCharacters.GAME_PREFIX.length);
        return PhonebotCharacters.GAME_PREFIX + (PhonebotCharacters.LEGACY_GAME_IDS[id] || id);
    }

    /**
     * v1 profiles list every game as one id string; v2 profiles split them into own games and
     * built-in games. `basePath` (the character JSON's path) gives each game its repo path.
     * @param {object} raw
     * @param {{ basePath?: string }} [options]
     * @returns {Character|null}
     */
    static normalize(raw, { basePath = "" } = {}) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const name = String(raw.name || "")
            .trim()
            .slice(0, PhonebotCharacters.NAME_MAX);
        if (!name) return null;
        const prefix = PhonebotCharacters.GAME_PREFIX;
        const folder = basePath ? basePath.slice(0, basePath.lastIndexOf("/") + 1) : "";
        /** @type {CharacterGame[]} */
        const games = [];
        const builtInGames = [];
        const add = (id, gameName) => {
            if (!/^[A-Za-z0-9_-]+$/.test(id) || games.some((g) => g.id === id)) return;
            games.push({
                id,
                name: String(gameName || "").trim(),
                ...(basePath ? { path: `${folder}games/${id}/${id}.json` } : {})
            });
        };
        for (const entry of Array.isArray(raw.games) ? raw.games : []) {
            if (entry && typeof entry === "object") {
                add(String(entry.id || "").trim(), entry.name);
                continue;
            }
            const ref = PhonebotCharacters._legacyGameRef(entry);
            if (ref.startsWith(prefix)) add(ref.slice(prefix.length), "");
            else if (ref && !ref.includes(":")) builtInGames.push(ref);
        }
        for (const id of Array.isArray(raw.builtInGames) ? raw.builtInGames : []) {
            const value = String(id || "").trim();
            if (value && !value.includes(":")) builtInGames.push(value);
        }
        const playable = new Set([...games.map((g) => prefix + g.id), ...builtInGames]);
        const homeGame = PhonebotCharacters._legacyGameRef(raw.homeGame);
        return {
            id: String(raw.id || "").trim() || PhonebotCharacters._slug(name),
            name,
            bio: String(raw.bio || "").trim(),
            voice: String(raw.voice || "").trim(),
            games,
            builtInGames: [...new Set(builtInGames)],
            homeGame: playable.has(homeGame) ? homeGame : ""
        };
    }

    /** Dashboard ids of everything the character plays: `game:<id>` plus built-in games. */
    static playableIds(character) {
        if (!character) return new Set();
        return new Set([
            ...PhonebotCharacters.characterGames(character).map(
                (g) => PhonebotCharacters.GAME_PREFIX + g.id
            ),
            ...character.builtInGames
        ]);
    }

    static _slug(name, fallback = "character") {
        const words = String(name || "")
            .trim()
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        if (!words.length) return fallback;
        return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
    }

    /** @param {string} base @param {Set<string>} taken */
    static _unique(base, taken) {
        let id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
        return id;
    }

    static _uniqueId(name) {
        const taken = new Set(PhonebotCharacters.list().map((c) => c.id));
        return PhonebotCharacters._unique(PhonebotCharacters._slug(name), taken);
    }

    /** A folder name for a new game that no game of this character (or its repo version) uses. */
    static _uniqueGameSlug(character, name) {
        const repo = PhonebotCharacters._builtins.find((c) => c.id === character?.id);
        const taken = new Set([
            ...(character?.games || []).map((g) => g.id),
            ...(repo?.games || []).map((g) => g.id)
        ]);
        return PhonebotCharacters._unique(PhonebotCharacters._slug(name, "game"), taken);
    }

    /** @returns {{ activeId: string|null, characters: Character[] }} */
    static _loadStore() {
        if (PhonebotCharacters._migrating) return { activeId: null, characters: [] };
        try {
            const raw = localStorage.getItem(PhonebotCharacters.STORAGE_KEY);
            if (raw == null) {
                const migrated = PhonebotCharacters._migrateFromV1();
                PhonebotCharacters._saveStore(migrated);
                return migrated;
            }
            const parsed = JSON.parse(raw);
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

    /**
     * One-time move to characters that own their games. v1 characters take the saved games they
     * listed; other games players made go to a new "My Character", and leftover copies of the old
     * shared games are dropped (those games now live in the repo characters).
     * @returns {{ activeId: string|null, characters: Character[] }}
     */
    static _migrateFromV1() {
        PhonebotCharacters._migrating = true;
        try {
            let v1 = null;
            try {
                v1 = JSON.parse(localStorage.getItem(PhonebotCharacters.STORAGE_KEY_V1) || "null");
            } catch (_) {}
            const store = { activeId: v1?.activeId ? String(v1.activeId) : null, characters: [] };
            const Game = window.CustomMessagesGame;
            if (typeof Game !== "function") return store;
            const saved = Game.listGames();
            const claimed = new Set(saved.filter((g) => g.characterId).map((g) => g.id));
            const prefix = PhonebotCharacters.GAME_PREFIX;
            for (const raw of Array.isArray(v1?.characters) ? v1.characters : []) {
                const id = String(raw?.id || "").trim();
                if (!id) continue;
                const games = [];
                const taken = new Set();
                /** @type {Record<string, string>} */
                const renamed = {};
                for (const ref of Array.isArray(raw.games) ? raw.games.map(String) : []) {
                    if (ref.startsWith("custom:")) {
                        const game = saved.find((g) => g.id === ref.slice(7) && !claimed.has(g.id));
                        if (!game) continue;
                        const slug = PhonebotCharacters._unique(
                            PhonebotCharacters._slug(game.name, "game"),
                            taken
                        );
                        taken.add(slug);
                        claimed.add(game.id);
                        Game.assignGame(game.id, { characterId: id, slug });
                        games.push({ id: slug, name: game.name });
                        renamed[ref] = prefix + slug;
                    } else if (ref.startsWith(prefix)) {
                        const oldId = ref.slice(prefix.length);
                        const slug = PhonebotCharacters.LEGACY_GAME_IDS[oldId] || oldId;
                        if (taken.has(slug)) continue;
                        taken.add(slug);
                        const copy = saved.find((g) => g.builtinId === oldId && !claimed.has(g.id));
                        if (copy) {
                            claimed.add(copy.id);
                            Game.assignGame(copy.id, { characterId: id, slug });
                        }
                        games.push({ id: slug, name: copy?.name || "" });
                        renamed[ref] = prefix + slug;
                    } else {
                        games.push(ref);
                    }
                }
                const mapRef = (ref) => renamed[ref] ?? ref;
                const character = PhonebotCharacters.normalize({
                    ...raw,
                    games,
                    homeGame: mapRef(raw.homeGame)
                });
                if (character) store.characters.push(character);
            }
            const leftovers = Game.listGames().filter((g) => !g.characterId);
            const own = leftovers.filter((g) => !g.builtinId);
            if (own.length) {
                const id = PhonebotCharacters._unique(
                    "myCharacter",
                    new Set(store.characters.map((c) => c.id))
                );
                const taken = new Set();
                const games = own.map((game) => {
                    const slug = PhonebotCharacters._unique(
                        PhonebotCharacters._slug(game.name, "game"),
                        taken
                    );
                    taken.add(slug);
                    Game.assignGame(game.id, { characterId: id, slug });
                    return { id: slug, name: game.name };
                });
                store.characters.push(
                    PhonebotCharacters.normalize({ id, name: "My Character", games })
                );
            }
            for (const game of leftovers) {
                if (game.builtinId) Game.deleteGame(game.id);
            }
            return store;
        } finally {
            PhonebotCharacters._migrating = false;
        }
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

    /** @param {string|null} id null clears the character so only built-in games show. */
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
     * Drop the local copy and its games. Repo characters fall back to their repo version.
     * @returns {boolean}
     */
    static remove(id) {
        const store = PhonebotCharacters._loadStore();
        const before = store.characters.length;
        store.characters = store.characters.filter((c) => c.id !== id);
        const isBuiltin = PhonebotCharacters._builtins.some((c) => c.id === id);
        if (store.characters.length === before && !isBuiltin) return false;
        window.CustomMessagesGame?.deleteCharacterGames?.(id);
        if (store.activeId === id && !isBuiltin) store.activeId = null;
        PhonebotCharacters._saveStore(store);
        return true;
    }

    // —— Games ——————————————————————————————————————————————————————

    /**
     * The character's games that can be played: each has a local copy, a repo file, or both.
     * @param {Character} character
     * @returns {CharacterGameEntry[]}
     */
    static characterGames(character) {
        if (!character) return [];
        const Game = window.CustomMessagesGame;
        const repo = PhonebotCharacters._builtins.find((c) => c.id === character.id);
        const out = [];
        for (const game of character.games || []) {
            const saved = Game?.findCharacterGame?.(character.id, game.id) || null;
            const repoGame = repo?.games.find((g) => g.id === game.id) || null;
            if (!saved && !repoGame?.path) continue;
            out.push({
                id: game.id,
                name: saved?.name || repoGame?.name || game.name || game.id,
                savedId: saved?.id || "",
                repoPath: repoGame?.path || ""
            });
        }
        return out;
    }

    /** @param {string} path @returns {Promise<object>} */
    static _fetchRepoGame(path) {
        if (!PhonebotCharacters._repoGameFiles.has(path)) {
            const pending = fetch(path, { cache: "no-cache" })
                .then((res) => {
                    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${path}`);
                    return res.json();
                })
                .catch((err) => {
                    PhonebotCharacters._repoGameFiles.delete(path);
                    throw err;
                });
            PhonebotCharacters._repoGameFiles.set(path, pending);
        }
        return PhonebotCharacters._repoGameFiles.get(path);
    }

    /**
     * Store id of the local copy that runs and is edited, copied from the repo if needed.
     * Resolves to "" when the character has no such game.
     * @returns {Promise<string>}
     */
    static ensureGameCopy(characterId, slug) {
        const Game = window.CustomMessagesGame;
        const existing = Game.findCharacterGame(characterId, slug);
        if (existing) return Promise.resolve(existing.id);
        const key = `${characterId}/${slug}`;
        if (!PhonebotCharacters._copying.has(key)) {
            const pending = (async () => {
                const character = PhonebotCharacters.get(characterId);
                const game = PhonebotCharacters.characterGames(character).find((g) => g.id === slug);
                if (!game?.repoPath) return "";
                const payload = await PhonebotCharacters._fetchRepoGame(game.repoPath);
                const saved = await Game.importGameFromExport(payload, {
                    characterId,
                    slug,
                    basePath: game.repoPath
                });
                return saved?.id || "";
            })().finally(() => PhonebotCharacters._copying.delete(key));
            PhonebotCharacters._copying.set(key, pending);
        }
        return PhonebotCharacters._copying.get(key);
    }

    /** @param {Character} character @param {CharacterGame[]} games */
    static _saveGames(character, games) {
        return PhonebotCharacters.save({ ...PhonebotCharacters.toJson(character), games });
    }

    /**
     * Add an empty game to a character.
     * @returns {{ slug: string, savedId: string }|null}
     */
    static addGame(characterId, name) {
        const character = PhonebotCharacters.get(characterId);
        const label = String(name || "").trim();
        if (!character || !label) return null;
        const slug = PhonebotCharacters._uniqueGameSlug(character, label);
        const saved = window.CustomMessagesGame.createNamedGame(label, { characterId, slug });
        if (!saved) return null;
        PhonebotCharacters._saveGames(character, [...character.games, { id: slug, name: label }]);
        return { slug, savedId: saved.id };
    }

    /**
     * Add a game from a single game file (e.g. a `.phonebot-game.json` backup).
     * @returns {Promise<{ slug: string, savedId: string }|null>}
     */
    static async importGameFile(characterId, payload) {
        const character = PhonebotCharacters.get(characterId);
        if (!character || !payload || Array.isArray(payload) || !Array.isArray(payload.messages)) {
            return null;
        }
        const slug = PhonebotCharacters._uniqueGameSlug(character, payload.name);
        const saved = await window.CustomMessagesGame.importGameFromExport(payload, {
            characterId,
            slug
        });
        if (!saved) return null;
        const fresh = PhonebotCharacters.get(characterId) || character;
        PhonebotCharacters._saveGames(fresh, [...fresh.games, { id: slug, name: saved.name }]);
        return { slug, savedId: saved.id };
    }

    /** Drop a game's local copy so its repo version plays again. */
    static resetGame(characterId, slug) {
        const saved = window.CustomMessagesGame.findCharacterGame(characterId, slug);
        if (saved) window.CustomMessagesGame.deleteGame(saved.id);
    }

    /** Remove a game from a character, with its local copy. */
    static deleteGame(characterId, slug) {
        PhonebotCharacters.resetGame(characterId, slug);
        const character = PhonebotCharacters.get(characterId);
        if (!character) return;
        PhonebotCharacters._saveGames(
            character,
            character.games.filter((g) => g.id !== slug)
        );
    }

    // —— Files ——————————————————————————————————————————————————————

    static _isCharacterPayload(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
        if (Array.isArray(payload.messages)) return false;
        const format = String(payload.format || "").trim();
        return (
            !format || format === PhonebotCharacters.FORMAT || format === PhonebotCharacters.FORMAT_V1
        );
    }

    /**
     * Parse a character JSON file. Rejects game files (they carry `messages`).
     * @param {object} payload
     * @returns {Character|null}
     */
    static fromJson(payload) {
        return PhonebotCharacters._isCharacterPayload(payload)
            ? PhonebotCharacters.normalize(payload)
            : null;
    }

    /** A character JSON file on its own: its games come from the repo character with that id. */
    static importJson(payload) {
        const character = PhonebotCharacters.fromJson(payload);
        return character ? PhonebotCharacters.save(character) : null;
    }

    /**
     * Upload a character zip: `<id>/<id>.json` plus `<id>/games/<game>/…`. Replaces the character
     * (and its games) if that id already exists.
     * @param {Blob} file
     * @returns {Promise<Character|null>}
     */
    static async importZip(file) {
        const Game = window.CustomMessagesGame;
        const files = await PhonebotZip.read(file);
        const jsonPaths = [...files.keys()]
            .filter((p) => p.toLowerCase().endsWith(".json"))
            .sort((a, b) => a.split("/").length - b.split("/").length);
        let found = null;
        for (const path of jsonPaths) {
            try {
                const payload = JSON.parse(await files.get(path).text());
                const character = PhonebotCharacters.fromJson(payload);
                if (character) {
                    found = { path, character };
                    break;
                }
            } catch (_) {}
        }
        if (!found) return null;
        const { character } = found;
        const root = found.path.slice(0, found.path.lastIndexOf("/") + 1);
        const games = [];
        for (const game of character.games) {
            const folder = `${root}games/${game.id}/`;
            const json = files.get(`${folder}${game.id}.json`);
            if (!json) {
                console.warn("Character zip is missing a game:", folder);
                continue;
            }
            let payload;
            try {
                payload = JSON.parse(await json.text());
            } catch (err) {
                console.warn("Character zip game unreadable:", folder, err);
                continue;
            }
            const gameFiles = new Map();
            for (const [path, blob] of files) {
                if (path.startsWith(folder)) gameFiles.set(path.slice(folder.length), blob);
            }
            const saved = await Game.importGameFromExport(payload, {
                characterId: character.id,
                slug: game.id,
                files: gameFiles
            });
            if (saved) games.push({ id: game.id, name: saved.name });
        }
        const kept = new Set(games.map((g) => g.id));
        for (const old of Game.listGames()) {
            if (old.characterId === character.id && !kept.has(old.slug)) Game.deleteGame(old.id);
        }
        return PhonebotCharacters.save({ ...character, games });
    }

    /** @param {Character} character */
    static toJson(character) {
        return {
            format: PhonebotCharacters.FORMAT,
            id: character.id,
            name: character.name,
            bio: character.bio,
            voice: character.voice,
            games: (character.games || []).map((g) => ({ id: g.id, name: g.name })),
            builtInGames: [...(character.builtInGames || [])],
            homeGame: character.homeGame || ""
        };
    }

    /**
     * The character folder as a zip, ready to unzip into the repo's characters folder.
     * @param {Character} character
     * @returns {Promise<Blob>}
     */
    static async buildZip(character) {
        const Game = window.CustomMessagesGame;
        const root = character.id;
        const games = PhonebotCharacters.characterGames(character);
        const entries = [];
        for (const game of games) {
            const folder = game.savedId
                ? await Game.exportGameFolder({ savedId: game.savedId })
                : await Game.exportGameFolder({
                      payload: await PhonebotCharacters._fetchRepoGame(game.repoPath),
                      basePath: game.repoPath
                  });
            if (!folder) continue;
            const dir = `${root}/games/${game.id}/`;
            entries.push({
                path: `${dir}${game.id}.json`,
                data: `${JSON.stringify(folder.json, null, 2)}\n`
            });
            for (const file of folder.files) entries.push({ path: dir + file.path, data: file.data });
        }
        const profile = PhonebotCharacters.toJson({
            ...character,
            games: games.map((g) => ({ id: g.id, name: g.name }))
        });
        entries.unshift({ path: `${root}/${root}.json`, data: `${JSON.stringify(profile, null, 2)}\n` });
        return PhonebotZip.create(entries);
    }

    /** Download as `<id>.zip`. */
    static async download(character) {
        PhonebotZip.download(await PhonebotCharacters.buildZip(character), `${character.id}.zip`);
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
 * Characters dialog opened from the robot panel: pick, create, edit, upload and download
 * characters, and manage each character's games.
 */
class CharactersPanel {
    /**
     * @param {object} robot needs `getCharacterGameOptions()`, `editCustomGame()` and
     *   `gamesIndexReady`
     */
    constructor(robot) {
        this.robot = robot;
        this._overlay = null;
        this._listEl = null;
        this._editorOverlay = null;
        this._nameOverlay = null;
        /** @type {(() => void)|null} Removes the open editor's listeners. */
        this._editorCleanup = null;
        this._onChange = () => this._renderList();
    }

    open() {
        this.close();
        this._mount();
        window.addEventListener(PhonebotCharacters.CHANGE_EVENT, this._onChange);
        void PhonebotCharacters.loadBuiltins();
        void window.CustomMessagesGame?.sweepOrphanAudio?.();
    }

    close() {
        window.removeEventListener(PhonebotCharacters.CHANGE_EVENT, this._onChange);
        this._closeEditor();
        this._overlay?.remove();
        this._overlay = null;
        this._listEl = null;
    }

    _closeEditor() {
        this._closeNamePrompt();
        this._editorCleanup?.();
        this._editorCleanup = null;
        this._editorOverlay?.remove();
        this._editorOverlay = null;
    }

    _closeNamePrompt() {
        this._nameOverlay?.remove();
        this._nameOverlay = null;
    }

    /**
     * @param {string} accept
     * @returns {Promise<File|null>}
     */
    _pickFile(accept) {
        return new Promise((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = accept;
            input.hidden = true;
            input.addEventListener("change", () => {
                const file = input.files && input.files[0];
                input.remove();
                resolve(file || null);
            });
            document.body.appendChild(input);
            input.click();
            // Remove if the user cancels the picker (change never fires).
            setTimeout(() => {
                if (input.parentElement && !input.files?.length) input.remove();
            }, 60_000);
        });
    }

    /** @param {File} file @returns {Promise<object|null>} */
    async _readJson(file) {
        try {
            return JSON.parse(await file.text());
        } catch (err) {
            console.warn("JSON file read failed:", err);
            return null;
        }
    }

    async _onUpload() {
        const file = await this._pickFile(".zip,application/zip,.json,application/json");
        if (!file) return;
        let character = null;
        try {
            if (/\.zip$/i.test(file.name)) {
                character = await PhonebotCharacters.importZip(file);
            } else {
                const payload = await this._readJson(file);
                character = payload ? PhonebotCharacters.importJson(payload) : null;
            }
        } catch (err) {
            console.warn("Character upload failed:", err);
        }
        if (!character) window.alert?.("That file is not a valid character.");
    }

    _onRemove(character) {
        const question = character.builtin
            ? `Reset “${character.name}” to the built-in version? Your edits and game changes will be lost.`
            : `Delete “${character.name}” and all its games? This cannot be undone.`;
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
            "Tap a name to play as that character. Edit a character to change its games. Upload restores a character zip.";
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
        uploadBtn.title = "Load a character from a zip file";
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
            this._buildRow("No character", {
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
     * @param {{ active?: boolean, onSelect: () => void, onEdit?: (() => void)|null, removeLabel?: string, onRemove?: (() => void)|null }} handlers
     */
    _buildRow(name, { active = false, onSelect, onEdit = null, removeLabel = "", onRemove = null }) {
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

    /** Ask for a new game's name. @param {(name: string) => void} onCreate */
    _promptGameName(onCreate) {
        this._closeNamePrompt();
        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-name-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "New game");

        const card = document.createElement("div");
        card.className = "custom-messages-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = "New game";
        card.appendChild(title);

        const label = document.createElement("label");
        label.className = "custom-messages-game-name-label";
        label.textContent = "Game name";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "custom-messages-game-name";
        input.placeholder = "e.g. Pirate quiz";
        input.autocomplete = "off";
        input.maxLength = 48;
        label.appendChild(input);
        card.appendChild(label);

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const createBtn = document.createElement("button");
        createBtn.type = "button";
        createBtn.className = "custom-messages-submit";
        createBtn.textContent = "Create";
        const sync = () => {
            createBtn.disabled = !input.value.trim();
        };
        sync();
        input.addEventListener("input", sync);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                createBtn.click();
            }
        });
        createBtn.addEventListener("click", () => {
            const name = input.value.trim();
            if (!name) return;
            this._closeNamePrompt();
            onCreate(name);
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "custom-messages-cancel secondary";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => this._closeNamePrompt());

        actions.appendChild(createBtn);
        actions.appendChild(cancelBtn);
        card.appendChild(actions);
        overlay.appendChild(card);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this._closeNamePrompt();
        });
        document.body.appendChild(overlay);
        this._nameOverlay = overlay;
        setTimeout(() => input.focus(), 0);
    }

    /** @param {Character|null} character null creates a new character. */
    async _openEditor(character) {
        this._closeEditor();
        await this.robot?.gamesIndexReady;
        if (!this._overlay) return;
        const prefix = PhonebotCharacters.GAME_PREFIX;
        const builtInOptions =
            typeof this.robot?.getCharacterGameOptions === "function"
                ? this.robot.getCharacterGameOptions()
                : [];
        const builtInIds = new Set(builtInOptions.map((g) => g.id));
        const builtInLabels = new Map(builtInOptions.map((g) => [g.id, g.label]));

        /** "" until a new character is first saved. */
        let characterId = character?.id || "";
        /** @type {CharacterGameEntry[]} */
        let ownGames = [];
        /** Built-in games from other robots are kept even though they have no checkbox here. */
        let otherBuiltIns = [];
        /** Kept while its game is unplayable, so re-adding it restores the choice. */
        let homeGame = "";

        const overlay = document.createElement("div");
        overlay.className =
            "custom-messages-overlay custom-messages-editor-overlay characters-editor-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", character ? "Edit character" : "New character");

        const card = document.createElement("div");
        card.className = "custom-messages-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = character ? "Edit character" : "New character";
        card.appendChild(title);

        const label = (text) => {
            const el = document.createElement("label");
            el.className = "custom-messages-game-meta-label";
            el.textContent = text;
            return el;
        };
        const heading = (text) => {
            const el = document.createElement("p");
            el.className = "custom-messages-game-meta-label";
            el.textContent = text;
            return el;
        };
        const hint = (text) => {
            const el = document.createElement("p");
            el.className = "muted characters-games-hint";
            el.textContent = text;
            return el;
        };
        const button = (text, className, onClick) => {
            const el = document.createElement("button");
            el.type = "button";
            el.className = className;
            el.textContent = text;
            el.addEventListener("click", onClick);
            return el;
        };

        const nameLabel = label("Name");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "custom-messages-game-meta-name-input";
        nameInput.placeholder = "e.g. Captain Barnacle";
        nameInput.autocomplete = "off";
        nameInput.maxLength = PhonebotCharacters.NAME_MAX;
        nameLabel.appendChild(nameInput);

        const bioLabel = label("Bio prompt");
        const bioInput = document.createElement("textarea");
        bioInput.className = "custom-messages-text characters-bio";
        bioInput.placeholder =
            "Who is this character? How do they talk? Sent to the AI before every game.";
        bioLabel.appendChild(bioInput);

        const voiceLabel = label("Voice");
        const voiceSelect = document.createElement("select");
        voiceSelect.className = "custom-messages-game-meta-name-input";
        for (const v of PhonebotCharacters.voiceOptions()) {
            const opt = document.createElement("option");
            opt.value = v.id;
            opt.textContent = v.label;
            voiceSelect.appendChild(opt);
        }
        voiceLabel.appendChild(voiceSelect);

        const gamesSection = document.createElement("div");
        const gamesList = document.createElement("div");
        gamesList.className = "custom-messages-tiles characters-own-games";
        gamesList.setAttribute("role", "list");
        const gamesActions = document.createElement("div");
        gamesActions.className = "custom-messages-actions";
        gamesSection.appendChild(heading("Games"));
        gamesSection.appendChild(
            hint("Games save in this browser as you edit them. Save downloads the character and its games as a zip.")
        );
        gamesSection.appendChild(gamesList);
        gamesSection.appendChild(gamesActions);

        const builtInSection = document.createElement("div");
        const builtInGrid = document.createElement("div");
        builtInGrid.className = "characters-games";
        builtInSection.appendChild(heading("Built-in games"));
        builtInSection.appendChild(hint("Games built into the app that this character also plays."));
        builtInSection.appendChild(builtInGrid);
        builtInSection.hidden = !builtInOptions.length;
        /** @type {Map<string, HTMLInputElement>} */
        const builtInChecks = new Map();
        for (const game of builtInOptions) {
            const row = document.createElement("label");
            row.className = "custom-messages-camera-label";
            const check = document.createElement("input");
            check.type = "checkbox";
            check.value = game.id;
            check.addEventListener("change", () => renderHome());
            row.appendChild(check);
            row.appendChild(document.createTextNode(game.label));
            builtInGrid.appendChild(row);
            builtInChecks.set(game.id, check);
        }

        const homeSection = document.createElement("div");
        const homeLabel = label("Home game");
        const homeSelect = document.createElement("select");
        homeSelect.className = "custom-messages-game-meta-name-input";
        homeSelect.addEventListener("change", () => {
            homeGame = homeSelect.value;
        });
        homeLabel.appendChild(homeSelect);
        homeSection.appendChild(homeLabel);
        homeSection.appendChild(
            hint("Where built-in games go when they end, and actions set to \"End game, go to home game\".")
        );

        const meta = document.createElement("div");
        meta.className = "custom-messages-game-meta";
        meta.appendChild(nameLabel);
        meta.appendChild(bioLabel);
        meta.appendChild(voiceLabel);
        meta.appendChild(gamesSection);
        meta.appendChild(builtInSection);
        meta.appendChild(homeSection);
        card.appendChild(meta);

        const checkedBuiltIns = () =>
            [...builtInChecks].filter(([, check]) => check.checked).map(([id]) => id);
        /** Dashboard ids this character plays, own games first. */
        const playable = () => [...ownGames.map((g) => prefix + g.id), ...checkedBuiltIns()];
        const labelOf = (id) =>
            id.startsWith(prefix)
                ? ownGames.find((g) => prefix + g.id === id)?.name || id
                : builtInLabels.get(id) || id;
        const addOption = (select, value, text) => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = text;
            select.appendChild(opt);
        };
        const renderHome = () => {
            const games = playable();
            homeSelect.replaceChildren();
            addOption(homeSelect, "", "None");
            for (const id of games) addOption(homeSelect, id, labelOf(id));
            homeSelect.value = games.includes(homeGame) ? homeGame : "";
        };

        /** Save the form as it stands. @returns {Character|null} */
        const commit = () => {
            const current = characterId ? PhonebotCharacters.get(characterId) : null;
            const saved = PhonebotCharacters.save({
                id: characterId,
                name: nameInput.value,
                bio: bioInput.value,
                voice: voiceSelect.value,
                games: current ? current.games : [],
                builtInGames: [...checkedBuiltIns(), ...otherBuiltIns],
                homeGame
            });
            if (saved) characterId = saved.id;
            return saved;
        };
        /** Games belong to a saved character, so a new one is saved before its first game. */
        const ensureSaved = () => {
            if (characterId) return true;
            if (commit()) {
                title.textContent = "Edit character";
                return true;
            }
            window.alert?.("Give the character a name first.");
            nameInput.focus();
            return false;
        };
        const editGame = async (slug) => {
            let savedId = "";
            try {
                savedId = await PhonebotCharacters.ensureGameCopy(characterId, slug);
            } catch (err) {
                console.warn("Game load failed:", err);
            }
            if (!savedId) {
                window.alert?.("Could not load that game.");
                return;
            }
            this.robot?.editCustomGame?.(savedId);
        };
        const removeGame = (game) => {
            const reset = !!(game.repoPath && game.savedId);
            const question = reset
                ? `Reset “${game.name}” to the built-in version? Your edits will be lost.`
                : `Delete “${game.name}” from this character? This cannot be undone.`;
            const ok = typeof window.confirm === "function" ? window.confirm(question) : true;
            if (!ok) return;
            if (reset) PhonebotCharacters.resetGame(characterId, game.id);
            else PhonebotCharacters.deleteGame(characterId, game.id);
        };
        const renderGames = () => {
            const current = characterId ? PhonebotCharacters.get(characterId) : null;
            ownGames = current ? PhonebotCharacters.characterGames(current) : [];
            gamesList.replaceChildren();
            if (!ownGames.length) {
                const empty = document.createElement("p");
                empty.className = "custom-messages-hint muted";
                empty.textContent = "No games yet. Tap New game to make one.";
                gamesList.appendChild(empty);
            }
            for (const game of ownGames) {
                gamesList.appendChild(
                    this._buildRow(game.name, {
                        onSelect: () => void editGame(game.id),
                        onEdit: () => void editGame(game.id),
                        removeLabel: game.repoPath && game.savedId ? "Reset" : "Delete",
                        onRemove: () => removeGame(game)
                    })
                );
            }
            renderHome();
        };

        gamesActions.appendChild(
            button("New game", "custom-messages-add", () => {
                if (!ensureSaved()) return;
                this._promptGameName((name) => {
                    const added = PhonebotCharacters.addGame(characterId, name);
                    if (added) void editGame(added.slug);
                });
            })
        );
        gamesActions.appendChild(
            button("Upload game", "secondary", async () => {
                if (!ensureSaved()) return;
                const file = await this._pickFile(".json,application/json");
                const payload = file ? await this._readJson(file) : null;
                if (!file) return;
                const added = payload
                    ? await PhonebotCharacters.importGameFile(characterId, payload)
                    : null;
                if (!added) window.alert?.("That file is not a valid game.");
            })
        );

        const fill = (source) => {
            nameInput.value = source?.name || "";
            bioInput.value = source?.bio || "";
            const voice = String(source?.voice || "");
            if (voice && ![...voiceSelect.options].some((o) => o.value === voice)) {
                addOption(voiceSelect, voice, voice);
            }
            voiceSelect.value = voice;
            const builtIns = new Set(source?.builtInGames || []);
            for (const [id, check] of builtInChecks) check.checked = builtIns.has(id);
            otherBuiltIns = [...builtIns].filter((id) => !builtInIds.has(id));
            homeGame = String(source?.homeGame || "");
            renderGames();
            syncSave();
        };

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const saveBtn = button("Save", "custom-messages-submit", async () => {
            const saved = commit();
            if (!saved) return;
            saveBtn.disabled = true;
            saveBtn.textContent = "Saving…";
            try {
                await PhonebotCharacters.download(saved);
            } catch (err) {
                console.warn("Character download failed:", err);
                window.alert?.("Saved, but the character zip could not be made.");
            }
            this._closeEditor();
        });
        saveBtn.title = "Save and download as a zip";
        const syncSave = () => {
            saveBtn.disabled = !nameInput.value.trim();
        };
        nameInput.addEventListener("input", syncSave);

        actions.appendChild(saveBtn);
        actions.appendChild(button("Cancel", "secondary", () => this._closeEditor()));
        card.appendChild(actions);

        overlay.appendChild(card);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this._closeEditor();
        });
        document.body.appendChild(overlay);
        this._editorOverlay = overlay;

        const gameEvent = window.CustomMessagesGame?.GAME_CHANGE_EVENT;
        window.addEventListener(PhonebotCharacters.CHANGE_EVENT, renderGames);
        if (gameEvent) window.addEventListener(gameEvent, renderGames);
        this._editorCleanup = () => {
            window.removeEventListener(PhonebotCharacters.CHANGE_EVENT, renderGames);
            if (gameEvent) window.removeEventListener(gameEvent, renderGames);
        };

        fill(character);
        setTimeout(() => nameInput.focus(), 0);
    }
}

window.PhonebotCharacters = PhonebotCharacters;
window.CharactersPanel = CharactersPanel;
void PhonebotCharacters.loadBuiltins();
