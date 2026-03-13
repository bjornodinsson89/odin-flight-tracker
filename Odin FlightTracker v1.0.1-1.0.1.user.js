// ==UserScript==
// @name         Odin FlightTracker v1.0.3
// @version      1.0.3
// @description  Flight Tracking
// @author       BjornOdinsson89
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        apiKey: GM_getValue('odin_ft_apikey', ''),
        trackFaction: GM_getValue('odin_ft_trackfaction', true),
        trackEnemies: GM_getValue('odin_ft_trackenemies', true),
        factionPollInterval: GM_getValue('odin_ft_pollinterval_faction', 30000),
        enemyPollInterval: GM_getValue('odin_ft_pollinterval_enemy', 30000),
        manualPollInterval: GM_getValue('odin_ft_pollinterval_manual', 30000),
        trackedState: GM_getValue('odin_ft_trackedstate', {}),
        trackingMode: GM_getValue('odin_ft_trackingmode', 'auto'),
        manualTarget: GM_getValue('odin_ft_manualtarget', {
            type: 'faction',
            id: null
        }),
        alertSettings: GM_getValue('odin_ft_alertsettings', {
            enabled: true,
            tiers: { 600: true, 300: true, 60: true },
            sound: true,
            vibration: true,
            debug: false,
            historyLimit: 50
        }),
        quickViewTab: 'enemies'
    };

    (function() {
        let toNum = v => {
            let n = Number(v);
            return (Number.isFinite(n) && n > 0) ? n : null;
        };
        CONFIG.factionPollInterval = Math.max(15000, toNum(CONFIG.factionPollInterval) || 30000);
        CONFIG.manualPollInterval = Math.max(15000, toNum(CONFIG.manualPollInterval) || 30000);
        CONFIG.enemyPollInterval = Math.max(15000, toNum(CONFIG.enemyPollInterval) || 30000);
    })();


    (function normalizeLoadedConfig() {
        let at = CONFIG.alertSettings;
        if (!at || typeof at !== 'object') at = {};
        let tiers = at.tiers;
        if (!tiers || typeof tiers !== 'object') tiers = {};
        CONFIG.alertSettings = {
            enabled: at.enabled !== false,
            tiers: {
                600: tiers[600] !== false,
                300: tiers[300] !== false,
                60: tiers[60] !== false
            },
            sound: at.sound !== false,
            vibration: at.vibration !== false,
            debug: !!at.debug,
            historyLimit: Math.max(10, Number(at.historyLimit) || 50)
        };

        let mt = CONFIG.manualTarget;
        if (!mt || typeof mt !== 'object') mt = { type: 'faction', id: null };
        CONFIG.manualTarget = {
            type: mt.type === 'user' ? 'user' : 'faction',
            id: sanitizeId(mt.id)
        };

        CONFIG.trackingMode = CONFIG.trackingMode === 'manual' ? 'manual' : 'auto';
        CONFIG.trackFaction = CONFIG.trackFaction !== false;
        CONFIG.trackEnemies = CONFIG.trackEnemies !== false;
    })();

    function saveConfig() {
        GM_setValue('odin_ft_apikey', CONFIG.apiKey);
        GM_setValue('odin_ft_trackfaction', CONFIG.trackFaction);
        GM_setValue('odin_ft_trackenemies', CONFIG.trackEnemies);
        GM_setValue('odin_ft_pollinterval_faction', CONFIG.factionPollInterval);
        GM_setValue('odin_ft_pollinterval_enemy', CONFIG.enemyPollInterval);
        GM_setValue('odin_ft_pollinterval_manual', CONFIG.manualPollInterval);
        GM_setValue('odin_ft_trackedstate', CONFIG.trackedState);
        GM_setValue('odin_ft_trackingmode', CONFIG.trackingMode);
        GM_setValue('odin_ft_manualtarget', CONFIG.manualTarget);
        GM_setValue('odin_ft_alertsettings', CONFIG.alertSettings);
    }

    const TRAVEL_TABLE = {
        'mexico': { 'airstrip': 18, 'private': 13, 'business': 8 },
        'cayman': { 'airstrip': 25, 'private': 18, 'business': 11 },
        'canada': { 'airstrip': 29, 'private': 21, 'business': 12 },
        'hawaii': { 'airstrip': 94, 'private': 67, 'business': 40 },
        'uk': { 'airstrip': 111, 'private': 80, 'business': 48 },
        'argentina': { 'airstrip': 117, 'private': 84, 'business': 50 },
        'switzerland': { 'airstrip': 123, 'private': 88, 'business': 53 },
        'japan': { 'airstrip': 158, 'private': 113, 'business': 68 },
        'china': { 'airstrip': 169, 'private': 121, 'business': 73 },
        'uae': { 'airstrip': 190, 'private': 136, 'business': 81 },
        'south_africa': { 'airstrip': 208, 'private': 149, 'business': 89 }
    };

    function normalizeDestination(dest) {
        let raw = String(dest || '').toLowerCase().trim();
        if (!raw) return null;
        let clean = raw.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!clean) return null;

        const aliases = {
            'mexico city': 'mexico', 'juarez': 'mexico', 'ciudad juarez': 'mexico',
            'george town': 'cayman', 'cayman islands': 'cayman',
            'toronto': 'canada',
            'honolulu': 'hawaii',
            'london': 'uk', 'united kingdom': 'uk',
            'buenos aires': 'argentina',
            'zurich': 'switzerland',
            'tokyo': 'japan',
            'beijing': 'china',
            'dubai': 'uae',
            'cape town': 'south_africa', 'johannesburg': 'south_africa',
            'pretoria': 'south_africa', 'south africa': 'south_africa'
        };

        if (clean === 'torn' || clean.includes('torn city')) return 'torn';
        if (aliases[clean]) return aliases[clean];

        for (let [k, v] of Object.entries(aliases)) {
            if (clean.includes(k)) return v;
        }

        if (clean.includes('mexico')) return 'mexico';
        if (clean.includes('cayman')) return 'cayman';
        if (clean.includes('canada')) return 'canada';
        if (clean.includes('hawaii')) return 'hawaii';
        if (clean.includes('kingdom') || clean === 'uk') return 'uk';
        if (clean.includes('argentina')) return 'argentina';
        if (clean.includes('switzerland') || clean.includes('swiss')) return 'switzerland';
        if (clean.includes('japan')) return 'japan';
        if (clean.includes('china')) return 'china';
        if (clean.includes('emirates') || clean.includes('arab')) return 'uae';
        if (clean.includes('africa')) return 'south_africa';

        return null;
    }

    function extractAbroadLocation(description) {
        if (!description) return null;
        let desc = String(description);
        let inMatch = desc.match(/^In\s+(.+)$/i);
        if (inMatch) return normalizeDestination(inMatch[1]);
        return normalizeDestination(desc);
    }

    function getTravelDuration(destKey, planeType) {
        if (!destKey || !planeType) return null;
        let destData = TRAVEL_TABLE[destKey];
        if (!destData) return null;
        let minutes = destData[planeType];
        return minutes ? minutes * 60 : null;
    }

    const TORN_TIME = { baseServerMs: null, basePerfMs: null, baseDateMs: null };

    function setTornServerTime(serverMs) {
        if (!Number.isFinite(serverMs) || serverMs <= 0) return;
        let perf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : null;

        if (perf == null) {
            TORN_TIME.baseServerMs = serverMs;
            TORN_TIME.basePerfMs = null;
            TORN_TIME.baseDateMs = Date.now();
            return;
        }

        if (TORN_TIME.baseServerMs != null && TORN_TIME.basePerfMs != null) {
            let current = tornNowMs();
            if (Math.abs(serverMs - current) < 500) return;
        }

        TORN_TIME.baseServerMs = serverMs;
        TORN_TIME.basePerfMs = perf;
        TORN_TIME.baseDateMs = Date.now();
    }

    function tornNowMs() {
        let perf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : null;
        if (TORN_TIME.baseServerMs == null) return Date.now();
        if (TORN_TIME.basePerfMs == null || perf == null) return TORN_TIME.baseServerMs;

        let perfElapsed = perf - TORN_TIME.basePerfMs;
        let dateElapsed = Date.now() - (TORN_TIME.baseDateMs || Date.now());

        let elapsed = Math.abs(perfElapsed - dateElapsed) > 3000 ? dateElapsed : perfElapsed;

        return TORN_TIME.baseServerMs + elapsed;
    }

    function syncTornTimeFromResponse(response) {
        try {
            if (!response || !response.headers) return;
            let dateStr = response.headers.get('Date');
            if (!dateStr) return;
            let serverMs = Date.parse(dateStr);
            if (Number.isFinite(serverMs)) setTornServerTime(serverMs);
        } catch (_) {}
    }

    const PLANE_NAMES = {
        'airstrip': 'Airstrip',
        'private': 'Private Jet',
        'business': 'Business Class'
    };

    function normalizePlaneType(raw) {
        if (!raw) return null;
        let r = String(raw).toLowerCase().trim();

        if (r === 'standard' || r === 'airstrip' || r.includes('light')) return 'airstrip';
        if (r === 'private' || r.includes('private')) return 'private';
        if (r === 'business' || r.includes('airliner') || r.includes('business')) return 'business';

        return null;
    }

    const trackedPersons = new Map();
    let MY_LOCATION = null;
    let MY_STATUS = null;
    let myLocationTimer = null;
    let uiDirty = false;
    const alertHistory = [];

    function markUIDirty() { uiDirty = true; }

    let audioCtx = null;

    document.addEventListener('click', function() {
        if (!audioCtx) {
            try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
            catch (_) {}
        }
    }, { once: true });

    function playAlertBeep() {
        if (!CONFIG.alertSettings.sound) return;
        try {
            let Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            if (!audioCtx) audioCtx = new Ctx();

            let osc = audioCtx.createOscillator();
            let gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 880;
            gain.gain.value = 0.04;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.15);
        } catch (_) {}
    }

    class TrackedPerson {
        constructor(id, name) {
            this.id = id;
            this.name = name;
            this.traveling = false;
            this.takeoffAt = null;
            this.landingAt = null;
            this.destination = null;
            this.origin = null;
            this.planeType = null;
            this.alertedTiers = {};
            this.abroadLocation = null;
            this.isEnemy = false;
            this.isFactionMember = false;
            this.isManual = false;
            this.lastState = undefined;
            this.timer_valid = false;
        }

        updateFromStatus(statusObj) {
            if (!statusObj) return;

            let wasTraveling = this.lastState;
            let isTraveling = !!statusObj.traveling;
            this.traveling = isTraveling;

            if (isTraveling) {
                let desc = statusObj.description || '';

                let destMatch = desc.match(/Returning to\s+([A-Za-z .'-]+?)(?:\s+from\b|$)/i) ||
                    desc.match(/Traveling to\s+([A-Za-z .'-]+?)(?:\s+from\b|$)/i) ||
                    desc.match(/Flying to\s+([A-Za-z .'-]+?)(?:\s+from\b|$)/i) ||
                    desc.match(/\bto\s+([A-Za-z .'-]+?)(?:\s+from\b|$)/i);

                let fromMatch = desc.match(/from\s+([A-Za-z .'-]+)/i);

                if (destMatch) {
                    this.destination = normalizeDestination(destMatch[1].trim());
                }
                if (fromMatch) {
                    this.origin = normalizeDestination(fromMatch[1].trim());
                }

                if (statusObj.planeType) {
                    this.planeType = normalizePlaneType(statusObj.planeType);
                }

                if (!wasTraveling && wasTraveling !== undefined && this.planeType) {
                    this.takeoffAt = tornNowMs();
                    this.alertedTiers = {};
                    this.timer_valid = true;

                    let destKey = this.destination === 'torn' ? this.origin : this.destination;
                    let duration = getTravelDuration(destKey, this.planeType);

                    if (duration) {
                        this.landingAt = this.takeoffAt + (duration * 1000);
                    } else {
                        this.landingAt = null;
                        this.timer_valid = false;
                    }
                } else if (wasTraveling === undefined) {
                    this.timer_valid = false;
                    this.landingAt = null;
                    this.takeoffAt = null;
                }

                this.abroadLocation = null;

            } else {
                if (wasTraveling) {
                    this.takeoffAt = null;
                    this.landingAt = null;
                    this.destination = null;
                    this.origin = null;
                    this.planeType = null;
                    this.alertedTiers = {};
                    this.timer_valid = false;
                }

                if (statusObj.abroad && statusObj.locationKey) {
                    this.abroadLocation = statusObj.locationKey;
                } else {
                    this.abroadLocation = null;
                }
            }

            if (this.traveling && this.landingAt && tornNowMs() >= this.landingAt + 30000) {
                this.traveling = false;
                this.takeoffAt = null;
                this.landingAt = null;
                this.alertedTiers = {};
                this.timer_valid = false;
            }

            this.lastState = isTraveling;
        }

        getRemainingSeconds() {
            if (!this.traveling || !this.landingAt || !this.timer_valid) return 0;
            let now = tornNowMs();
            if (now >= this.landingAt) return 0;
            return Math.max(0, Math.floor((this.landingAt - now) / 1000));
        }

        hasValidTimer() {
            return this.traveling && this.landingAt && this.timer_valid;
        }

        getDisplayStatus() {
            if (!this.traveling) return '';
            if (!this.hasValidTimer()) return '??:??:??';
            let remaining = this.getRemainingSeconds();
            if (remaining <= 0) return '00:00:00';
            return formatHMS(remaining);
        }

        serialize() {
            return {
                id: this.id,
                name: this.name,
                traveling: this.traveling,
                takeoffAt: this.takeoffAt,
                landingAt: this.landingAt,
                destination: this.destination,
                origin: this.origin,
                planeType: this.planeType,
                alertedTiers: this.alertedTiers,
                abroadLocation: this.abroadLocation,
                isEnemy: this.isEnemy,
                isFactionMember: this.isFactionMember,
                isManual: this.isManual,
                _prevTraveling: this.lastState,
                _timerValid: this.timer_valid
            };
        }

        static deserialize(data) {
            let person = new TrackedPerson(data.id, data.name);
            person.traveling = data.traveling || false;
            person.takeoffAt = data.takeoffAt || null;
            person.landingAt = data.landingAt || null;
            person.destination = data.destination || null;
            person.origin = data.origin || null;
            person.planeType = data.planeType || null;
            person.alertedTiers = data.alertedTiers || {};
            person.abroadLocation = data.abroadLocation || null;
            person.isEnemy = !!data.isEnemy;
            person.isFactionMember = !!data.isFactionMember;
            person.isManual = !!data.isManual;
            person.lastState = ('_prevTraveling' in data) ? !!data._prevTraveling : undefined;
            person.timer_valid = !!data._timerValid;
            return person;
        }
    }

    function formatHMS(seconds) {
        let s = Math.max(0, Math.floor(Number(seconds) || 0));
        let hours = Math.floor(s / 3600);
        let mins = Math.floor((s % 3600) / 60);
        let secs = s % 60;
        return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function escapeHtml(str) {
        let s = String(str || '');
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function prettyCountry(key) {
        let k = String(key || '').trim().toLowerCase();
        if (!k) return '';
        const map = { uae: 'UAE', uk: 'UK', south_africa: 'South Africa', torn: 'Torn City' };
        if (map[k]) return escapeHtml(map[k]);
        return escapeHtml(k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    }

    function sanitizeId(id) {
        let n = parseInt(id, 10);
        return (Number.isFinite(n) && n > 0) ? n : null;
    }

    function profileUrl(id) {
        let safe = sanitizeId(id);
        if (!safe) return '#';
        return `https://www.torn.com/profiles.php?XID=${encodeURIComponent(safe)}`;
    }

    function persistTrackedState() {
        let state = {};
        trackedPersons.forEach((person, id) => {
            state[id] = person.serialize();
        });
        CONFIG.trackedState = state;
        saveConfig();
    }

    function restoreTrackedState() {
        let state = CONFIG.trackedState || {};
        Object.entries(state).forEach(([id, data]) => {
            let person = TrackedPerson.deserialize(data);
            if (person.landingAt && tornNowMs() >= person.landingAt + 60000) {
                person.timer_valid = false;
                person.landingAt = null;
                person.takeoffAt = null;
            }
            trackedPersons.set(parseInt(id), person);
        });
    }

    const apiRateLimiter = {
        timestamps: [],
        maxCalls: 75,
        windowMs: 60000,

        canCall() {
            let now = Date.now();
            this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
            return this.timestamps.length < this.maxCalls;
        },

        record() {
            this.timestamps.push(Date.now());
        },

        async waitForSlot() {
            while (!this.canCall()) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    };

    function normalizeStatus(statusObj) {
        if (!statusObj || typeof statusObj !== 'object') return null;

        let state = String(statusObj.state || statusObj.type || '').trim();
        let stateLower = state.toLowerCase();
        let desc = String(statusObj.description || statusObj.details || '');
        let traveling = stateLower === 'traveling' || stateLower === 'travelling';
        let abroad = stateLower === 'abroad';

        let planeType = normalizePlaneType(statusObj.plane_image_type || statusObj.planeType);

        let locationKey = null;
        if (abroad) {
            locationKey = extractAbroadLocation(desc);
        } else if (traveling) {
            let destMatch = desc.match(/to\s+([A-Za-z .'-]+?)(?:\s+from\b|$)/i);
            if (destMatch) locationKey = normalizeDestination(destMatch[1]);
        }

        let stateDisplay = stateLower ? (stateLower[0].toUpperCase() + stateLower.slice(1)) : state;
        return { state: stateDisplay, description: desc, traveling, abroad, planeType, locationKey, raw: statusObj };
    }

    async function apiRequest(endpoint, key) {
        if (!CONFIG.apiKey) return null;

        await apiRateLimiter.waitForSlot();
        apiRateLimiter.record();

        let apiKey = key || CONFIG.apiKey;
        let url = new URL(`https://api.torn.com/v2/${endpoint}`);
        if (!url.searchParams.has('comment')) {
            url.searchParams.set('comment', 'OdinFlightTracker');
        }

        // Keep auth to the single documented header only.
        // The added X-API-Key header in newer builds forces a stricter CORS preflight
        // that Torn does not always allow, which causes every request to fail.
        let headers = {
            'Authorization': `ApiKey ${apiKey}`
        };

        try {
            let response = await fetch(url, { headers });
            syncTornTimeFromResponse(response);
            if (!response.ok) return null;
            let data = await response.json();
            if (data && data.error) {
                let err = data.error;
                let code = (err && typeof err === 'object') ? err.code : data.code;
                let msg = (err && typeof err === 'object') ? err.error : data.error;
                console.error(`API Error ${code || 'unknown'}: ${msg || 'Unknown error'}`);
                return null;
            }
            return data;
        } catch (e) {
            return null;
        }
    }

    async function fetchFactionMembers(factionId) {
        let candidates = factionId
            ? [`faction/${factionId}/members`, `faction/${factionId}?selections=members`]
            : ['faction/members', 'faction?selections=members'];

        let membersRaw = null;
        for (let endpoint of candidates) {
            let data = await apiRequest(endpoint, CONFIG.apiKey);
            if (!data) continue;
            membersRaw = data.members || data.faction?.members || null;
            if (membersRaw) break;
        }
        if (!membersRaw) return [];

        let memberList = Array.isArray(membersRaw) ? membersRaw : Object.values(membersRaw);
        let out = [];

        memberList.forEach(mm => {
            if (!mm || typeof mm !== 'object') return;
            let id = sanitizeId(mm.id || mm.player_id || mm.user_id);
            if (!id) return;
            out.push({
                id,
                name: mm.name || mm.player_name || '',
                status: normalizeStatus(mm.status || mm.state || null),
                raw: mm
            });
        });

        return out;
    }

    async function fetchUserStatus(userId) {
        let safeId = sanitizeId(userId);
        let candidates = safeId
            ? [`user/${safeId}`, `user/${safeId}?selections=profile,basic`]
            : ['user', 'user?selections=profile,basic'];

        let data = null;
        for (let endpoint of candidates) {
            data = await apiRequest(endpoint);
            if (data) break;
        }
        if (!data) return null;

        let profile = data.profile || data.player || data;
        let statusObj = profile.status || profile.basic?.status || data.status || data.basic?.status || null;

        return {
            id: safeId || sanitizeId(profile.player_id || profile.id),
            name: profile.name || profile.player_name || 'Unknown',
            status: normalizeStatus(statusObj)
        };
    }

    async function updateMyLocation() {
        let me = await fetchUserStatus(null);
        if (!me || !me.status) return;

        let status = me.status;
        MY_STATUS = status.abroad ? 'Abroad' : (status.traveling ? 'Traveling' : status.state || 'Unknown');

        if (status.traveling) {
            MY_LOCATION = 'traveling';
        } else if (status.abroad) {
            MY_LOCATION = status.locationKey || extractAbroadLocation(status.description);
        } else {
            MY_LOCATION = 'torn';
        }

        markUIDirty();
    }

    let factionPollTimer = null;
    let manualPollTimer = null;
    let enemyPollTimer = null;
    let isPolling = false;

    async function pollFaction() {
        if (isPolling) return;
        isPolling = true;
        try {
            let members = await fetchFactionMembers(null);
            let activeFactionIds = new Set();

            for (let member of members) {
                activeFactionIds.add(member.id);
                let tracked = trackedPersons.get(member.id);
                if (!tracked) {
                    tracked = new TrackedPerson(member.id, member.name);
                    trackedPersons.set(member.id, tracked);
                }
                tracked.isFactionMember = true;
                tracked.isManual = false;
                tracked.name = member.name || tracked.name;
                tracked.updateFromStatus(member.status);
            }

            trackedPersons.forEach((person, id) => {
                if (person.isFactionMember && !activeFactionIds.has(id) && !person.traveling) {
                    trackedPersons.delete(id);
                }
            });

            persistTrackedState();
        } catch (e) {
            console.error('Odin FlightTracker: faction poll failed', e);
        } finally {
            isPolling = false;
        }
    }

    async function pollEnemies() {
        if (!CONFIG.trackEnemies) return;

        let enemyIds = extractEnemyIds();
        if (enemyIds.length === 0) return;

        let activeEnemyIds = new Set(enemyIds);

        for (let id of enemyIds) {
            let userData = await fetchUserStatus(id);
            if (!userData) continue;

            let tracked = trackedPersons.get(id);
            let wasTraveling = tracked ? tracked.lastState : undefined;

            if (!tracked) {
                tracked = new TrackedPerson(id, userData.name);
                trackedPersons.set(id, tracked);
            }
            tracked.isEnemy = true;
            tracked.name = userData.name || tracked.name;
            tracked.updateFromStatus(userData.status);

            if (wasTraveling === false && tracked.traveling) {
                fireTravelStartToast(tracked);
            }
        }

        if (activeEnemyIds.size > 0) {
            trackedPersons.forEach((person, id) => {
                if (person.isEnemy && !person.isFactionMember && !activeEnemyIds.has(id) && !person.traveling) {
                    trackedPersons.delete(id);
                }
            });
        }

        persistTrackedState();
    }

    async function pollManualTarget() {
        if (!CONFIG.manualTarget.id) return;

        try {
            if (CONFIG.manualTarget.type === 'faction') {
                let members = await fetchFactionMembers(CONFIG.manualTarget.id);
                for (let member of members) {
                    let tracked = trackedPersons.get(member.id);
                    let wasTraveling = tracked ? tracked.lastState : undefined;

                    if (!tracked) {
                        tracked = new TrackedPerson(member.id, member.name);
                        trackedPersons.set(member.id, tracked);
                    }
                    tracked.isManual = true;
                    tracked.isEnemy = true;
                    tracked.isFactionMember = false;
                    tracked.name = member.name || tracked.name;
                    tracked.updateFromStatus(member.status);

                    if (wasTraveling === false && tracked.traveling && tracked.isEnemy) {
                        fireTravelStartToast(tracked);
                    }
                }

                if (CONFIG.trackingMode === 'manual' && CONFIG.manualTarget.type === 'faction') {
                    let activeIds = new Set(members.map(m => m.id));
                    trackedPersons.forEach((person, id) => {
                        if (person.isManual && !activeIds.has(id) && !person.traveling) {
                            trackedPersons.delete(id);
                        }
                    });
                }
            } else if (CONFIG.manualTarget.type === 'user') {
                let userData = await fetchUserStatus(CONFIG.manualTarget.id);
                if (!userData) return;

                let tracked = trackedPersons.get(CONFIG.manualTarget.id);
                let wasTraveling = tracked ? tracked.lastState : undefined;

                if (!tracked) {
                    tracked = new TrackedPerson(CONFIG.manualTarget.id, userData.name);
                    trackedPersons.set(CONFIG.manualTarget.id, tracked);
                }
                tracked.isManual = true;
                tracked.isEnemy = true;
                tracked.isFactionMember = false;
                tracked.name = userData.name || tracked.name;
                tracked.updateFromStatus(userData.status);

                if (wasTraveling === false && tracked.traveling && tracked.isEnemy) {
                    fireTravelStartToast(tracked);
                }
            }
        } catch (e) {}

        persistTrackedState();
    }

    function extractEnemyIds() {
        let ids = new Set();
        document.querySelectorAll('li.enemy a[href*="profiles.php?XID="]').forEach(link => {
            let match = link.href.match(/XID=(\d+)/);
            if (match) ids.add(parseInt(match[1]));
        });
        return Array.from(ids);
    }

    function startPolling() {
        if (factionPollTimer) clearInterval(factionPollTimer);
        if (manualPollTimer) clearInterval(manualPollTimer);
        if (enemyPollTimer) clearInterval(enemyPollTimer);

        if (CONFIG.trackFaction) {
            let runFactionPoll = async () => {
                try {
                    await pollFaction();
                } catch (e) {
                    console.error('Odin FlightTracker: faction poll loop failed', e);
                }
                markUIDirty();
            };
            runFactionPoll();
            factionPollTimer = setInterval(runFactionPoll, CONFIG.factionPollInterval);
        }

        if (CONFIG.trackingMode === 'manual') {
            let runManualPoll = async () => {
                try {
                    await pollManualTarget();
                } catch (e) {
                    console.error('Odin FlightTracker: manual poll loop failed', e);
                }
                markUIDirty();
            };
            runManualPoll();
            manualPollTimer = setInterval(runManualPoll, CONFIG.manualPollInterval);
        }

        if (CONFIG.trackingMode === 'auto' && CONFIG.trackEnemies) {
            pollEnemies();
            enemyPollTimer = setInterval(pollEnemies, CONFIG.enemyPollInterval);
        }
    }

    function getEnemyDestinations() {
        let destinations = new Map();
        trackedPersons.forEach(p => {
            if (!p.isEnemy) return;
            let loc = p.traveling ? p.destination : p.abroadLocation;
            if (loc && loc !== 'torn') {
                if (!destinations.has(loc)) destinations.set(loc, []);
                destinations.get(loc).push(p);
            }
        });
        return destinations;
    }

    function evaluateArrivalAlerts() {
        if (!CONFIG.alertSettings.enabled) return;
        if (MY_STATUS !== 'Abroad') return;
        if (!MY_LOCATION || MY_LOCATION === 'traveling' || MY_LOCATION === 'torn') return;

        trackedPersons.forEach(person => {
            if (!person.isEnemy) return;
            if (!person.traveling || !person.destination) return;
            if (!person.hasValidTimer()) return;
            if (person.destination !== MY_LOCATION) return;

            let remaining = person.getRemainingSeconds();
            if (remaining <= 0) return;

            Object.keys(CONFIG.alertSettings.tiers).forEach(tier => {
                let tierSec = parseInt(tier);
                if (!CONFIG.alertSettings.tiers[tierSec]) return;
                if (remaining > tierSec) return;
                if (person.alertedTiers[tierSec]) return;

                fireArrivalAlert(person, remaining, tierSec);
                person.alertedTiers[tierSec] = true;
            });
        });
    }

    function fireArrivalAlert(person, seconds, tier) {
        alertHistory.unshift({
            time: tornNowMs(),
            person: person.name,
            destination: person.destination,
            remaining: seconds,
            tier
        });

        if (alertHistory.length > CONFIG.alertSettings.historyLimit) {
            alertHistory.pop();
        }

        if (CONFIG.alertSettings.sound) {
            try {
                if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                let osc = audioCtx.createOscillator();
                let gain = audioCtx.createGain();
                osc.type = 'square';
                osc.frequency.value = 880;
                gain.gain.value = 0.15;
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start();
                osc.stop(audioCtx.currentTime + 0.3);
            } catch (_) {}
        }

        if (CONFIG.alertSettings.vibration && navigator.vibrate) {
            navigator.vibrate([200, 100, 200, 100, 200]);
        }

        let el = document.createElement('div');
        el.className = 'odin-arrival-alert';
        el.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: linear-gradient(135deg, #c0392b, #e74c3c);
            color: #fff;
            padding: 16px 20px;
            border-radius: 8px;
            z-index: 100000;
            font-weight: bold;
            font-size: 14px;
            box-shadow: 0 4px 20px rgba(192,57,43,0.6);
            border: 2px solid #fff;
            animation: odin-pulse 0.5s ease-in-out 3;
        `;

        el.innerHTML = `
            <div style="font-size:16px;margin-bottom:4px;">⚠️ INCOMING ENEMY ⚠️</div>
            <div><strong>${escapeHtml(person.name)}</strong> arriving in <strong>${formatHMS(seconds)}</strong></div>
            <div style="font-size:12px;opacity:0.9;margin-top:4px;">Destination: ${prettyCountry(person.destination)}</div>
        `;

        if (!document.getElementById('odin-alert-styles')) {
            let style = document.createElement('style');
            style.id = 'odin-alert-styles';
            style.textContent = `
                @keyframes odin-pulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(el);
        setTimeout(() => el.remove(), 15000);
    }

    function fireTravelStartToast(person) {
        try {
            if (!CONFIG.alertSettings.enabled) return;

            let dest = prettyCountry(person.destination || 'Unknown');
            let hasTimer = person.hasValidTimer();
            let eta = hasTimer ? formatHMS(person.getRemainingSeconds()) : '??:??:??';

            let toast = document.createElement('div');
            toast.className = 'odin-flighttoast';
            toast.style.cssText = `
                position: fixed;
                bottom: 80px;
                right: 20px;
                background: rgba(30, 30, 30, 0.95);
                color: #fff;
                padding: 14px 18px;
                border-radius: 8px;
                z-index: 100000;
                box-shadow: 0 4px 16px rgba(0,0,0,0.5);
                border-left: 4px solid #ff6600;
                max-width: 300px;
            `;

            toast.innerHTML = `
                <div style="font-weight:700;margin-bottom:6px;color:#ff6600;">✈️ Enemy Traveling</div>
                <a href="${profileUrl(person.id)}" target="_blank" rel="noopener noreferrer"
                   style="color:#8fd3ff;text-decoration:none;font-weight:600;">${escapeHtml(person.name || 'Enemy')}</a>
                <span style="color:#ccc;"> → ${dest}</span>
                <div style="margin-top:6px;font-size:13px;">ETA: <strong>${eta}</strong>${!hasTimer ? ' <span style="color:#ff9900;">(no timer)</span>' : ''}</div>
            `;

            document.body.appendChild(toast);

            try { playAlertBeep(); } catch (_) {}
            try {
                if (CONFIG.alertSettings.vibration && navigator.vibrate) {
                    navigator.vibrate([120, 60, 120]);
                }
            } catch (_) {}

            setTimeout(() => { try { toast.remove(); } catch (_) {} }, 8000);
        } catch (e) {}
    }

    function renderDebugOverlay() {
        if (!CONFIG.alertSettings.debug) {
            let existing = document.getElementById('odin-debug');
            if (existing) existing.remove();
            return;
        }

        let box = document.getElementById('odin-debug');
        if (!box) {
            box = document.createElement('div');
            box.id = 'odin-debug';
            box.style.cssText = `
                position: fixed;
                top: 120px;
                right: 20px;
                background: #111;
                color: #0f0;
                padding: 10px;
                font-size: 11px;
                z-index: 99999;
                font-family: monospace;
                border: 1px solid #0f0;
                max-width: 320px;
                max-height: 400px;
                overflow-y: auto;
            `;
            document.body.appendChild(box);
        }

        let traveling = Array.from(trackedPersons.values()).filter(p => p.traveling);
        let withTimer = traveling.filter(p => p.hasValidTimer());
        let enemies = Array.from(trackedPersons.values()).filter(p => p.isEnemy);
        let faction = Array.from(trackedPersons.values()).filter(p => p.isFactionMember);

        box.innerHTML = `
            <div style="color:#ff6600;font-weight:bold;margin-bottom:5px;">Odin Debug v1.0.1</div>
            My Status: <span style="color:#fff;">${MY_STATUS || 'unknown'}</span><br>
            My Location: <span style="color:#fff;">${MY_LOCATION || 'unknown'}</span><br>
            Alerts Active: <span style="color:${MY_STATUS === 'Abroad' ? '#0f0' : '#f00'};">${MY_STATUS === 'Abroad' ? 'YES' : 'NO'}</span><br>
            <hr style="border-color:#333;margin:5px 0;">
            Tracked: ${trackedPersons.size}<br>
            Faction: ${faction.length}<br>
            Enemies: ${enemies.length}<br>
            Traveling: ${traveling.length} (${withTimer.length} w/ timer)<br>
            <hr style="border-color:#333;margin:5px 0;">
            <div style="color:#ff6600;">Travelers:</div>
            ${traveling.slice(0, 8).map(p => {
            let timer = p.hasValidTimer() ? formatHMS(p.getRemainingSeconds()) : '??:??:??';
            let valid = p.hasValidTimer() ? '✓' : '✗';
            let type = p.isEnemy ? 'E' : 'F';
            return `${valid}[${type}] ${escapeHtml(p.name)}: ${p.destination} [${timer}]`;
        }).join('<br>') || 'None'}
        `;
    }

    let countdownTimer = null;

    function startCountdown() {
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = setInterval(() => {
            evaluateArrivalAlerts();
            markUIDirty();
        }, 1000);
    }

    function getPageContext() {
        let url = location.href;
        return {
            faction: url.includes('factions.php'),
            war: url.includes('rankedwar'),
            profile: url.includes('profiles.php'),
            enemy: document.querySelector('li.enemy') !== null
        };
    }

    function updateAllUI() {
        let ctx = getPageContext();

        let stray = document.getElementById('odin-profile-badge');
        if (stray) stray.remove();

        if (ctx.faction || ctx.war) updateFactionRoster();
        if (ctx.enemy) updateEnemyRoster();
        if (ctx.profile) updateProfileFlightBannerOverlay();

        updateHeaderButton();

        if (CONFIG.alertSettings.debug) renderDebugOverlay();
    }

    function updateFactionRoster() {
        if (trackedPersons.size === 0) return;

        let selectors = [
            '#react-root ul.table-body li.table-row',
            '.faction-info-wrap .table-body .table-row',
            '.members-list .table-row',
            '[class*="memberList"] [class*="row"]',
            '.f-war-list .table-row'
        ];

        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(row => {
                let link = row.querySelector('a[href*="profiles.php?XID="], a[href*="XID="]');
                if (!link) return;

                let match = link.href.match(/XID=(\d+)/);
                if (!match) return;

                let id = parseInt(match[1]);
                let tracked = trackedPersons.get(id);
                if (!tracked || !tracked.traveling) return;

                let displayStatus = tracked.getDisplayStatus();

                let statusSelectors = [
                    'div.table-cell.status span',
                    '.status span',
                    '[class*="status"] span',
                    '.member-status',
                    '[class*="memberStatus"]'
                ];

                for (let statusSel of statusSelectors) {
                    let statusCell = row.querySelector(statusSel);
                    if (statusCell && (statusCell.textContent.toLowerCase().includes('travel') ||
                                       statusCell.textContent.toLowerCase().includes('abroad') ||
                                       statusCell.textContent.toLowerCase().includes('returning'))) {
                        statusCell.textContent = displayStatus;
                        statusCell.style.color = tracked.hasValidTimer() ? '#ff6600' : '#ff9900';
                        statusCell.style.fontWeight = 'bold';
                        statusCell.title = `Flying to ${prettyCountry(tracked.destination)}`;
                        break;
                    }
                }

                let allSpans = row.querySelectorAll('span');
                for (let span of allSpans) {
                    let text = span.textContent.toLowerCase();
                    if (text.includes('traveling') || text.includes('returning to')) {
                        span.textContent = displayStatus;
                        span.style.color = tracked.hasValidTimer() ? '#ff6600' : '#ff9900';
                        span.style.fontWeight = 'bold';
                        span.title = `Flying to ${prettyCountry(tracked.destination)}`;
                        break;
                    }
                }
            });
        });
    }

    function updateEnemyRoster() {
        if (!CONFIG.trackEnemies) return;

        document.querySelectorAll('li.enemy').forEach(enemy => {
            let link = enemy.querySelector('a[href*="profiles.php?XID="]');
            if (!link) return;

            let match = link.href.match(/XID=(\d+)/);
            if (!match) return;

            let id = parseInt(match[1]);
            let tracked = trackedPersons.get(id);
            if (!tracked || !tracked.traveling) return;

            let displayStatus = tracked.getDisplayStatus();

            let statusCell = enemy.querySelector('div.status.left, .status, [class*="status"]');
            if (statusCell) {
                statusCell.textContent = displayStatus;
                statusCell.style.color = tracked.hasValidTimer() ? '#ff6600' : '#ff9900';
                statusCell.style.fontWeight = 'bold';
            }
        });
    }

    function getCurrentProfileId() {
        try {
            let u = new URL(location.href);
            let xid = u.searchParams.get('XID');
            if (xid) return parseInt(xid);
        } catch {}
        return null;
    }

    function findProfileBannerContainer() {
        let root = document.getElementById('profileroot') || document;

        let desc = Array.from(root.querySelectorAll('.main-desc, [class*="mainDesc"]')).find(s => {
            let t = (s.textContent || '').toLowerCase();
            return t.includes('travel') || t.includes('returning');
        });
        if (desc) return desc.closest('.profile-container') || desc.closest('.cont') || desc.closest('div');
        return null;
    }

    function updateProfileFlightBannerOverlay() {
        let id = getCurrentProfileId();
        let overlayId = 'odin-flight-banner-overlay';
        let container = findProfileBannerContainer();

        let existing = document.getElementById(overlayId);
        if (!id || !container) {
            if (existing) existing.remove();
            return;
        }

        let tracked = trackedPersons.get(id);
        if (!tracked || !tracked.traveling) {
            if (existing) existing.remove();
            return;
        }

        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        let el = existing;
        if (!el) {
            el = document.createElement('div');
            el.id = overlayId;
            el.style.cssText = `
                position: absolute;
                left: 10px;
                top: 10px;
                background: rgba(0,0,0,0.75);
                color: #fff;
                padding: 8px 12px;
                border-radius: 6px;
                font-weight: 800;
                font-size: 14px;
                line-height: 1.2;
                z-index: 50;
                pointer-events: none;
                text-shadow: 0 1px 2px rgba(0,0,0,0.8);
                border: 1px solid rgba(255,102,0,0.5);
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            `;
            container.appendChild(el);
        }

        let displayStatus = tracked.getDisplayStatus();
        let hasTimer = tracked.hasValidTimer();

        el.innerHTML = `
            <div style="color:#ff6600;margin-bottom:2px;">✈️ ${hasTimer ? 'Landing in' : 'Flying to'}</div>
            <div style="font-size:18px;">${displayStatus}</div>
            <div style="font-size:11px;opacity:0.8;margin-top:2px;">→ ${prettyCountry(tracked.destination)}</div>
        `;
    }

    function injectHeaderButton() {
        let header = document.querySelector('#header-root, #topHeaderBanner, header');
        if (!header || document.getElementById('odin-header-button')) return;

        let button = document.createElement('div');
        button.id = 'odin-header-button';
        button.style.cssText = `
            display: inline-flex;
            align-items: center;
            padding: 6px 12px;
            cursor: pointer;
            background: linear-gradient(135deg, #2d2d2d, #1a1a1a);
            color: white;
            border-radius: 4px;
            margin-left: 10px;
            font-size: 13px;
            font-weight: 600;
            border: 1px solid #444;
            transition: all 0.2s;
        `;
        button.textContent = '✈ 0';
        button.title = 'Odin FlightTracker';

        button.addEventListener('mouseenter', () => {
            button.style.background = 'linear-gradient(135deg, #ff6600, #cc5500)';
        });
        button.addEventListener('mouseleave', () => {
            updateHeaderButton();
        });
        button.addEventListener('click', () => {
            showQuickView();
        });

        let searchIcon = header.querySelector('[class*="search"]');
        if (searchIcon && searchIcon.parentElement) {
            searchIcon.parentElement.insertAdjacentElement('afterend', button);
        } else {
            header.appendChild(button);
        }
    }

    function updateHeaderButton() {
        let button = document.querySelector('#odin-header-button');
        if (!button) return;

        let enemies = Array.from(trackedPersons.values()).filter(p => p.isEnemy);
        let travelingCount = enemies.filter(p => p.traveling && p.destination).length;
        let abroadCount = enemies.filter(p => !p.traveling && p.abroadLocation).length;
        let total = travelingCount + abroadCount;

        let inbound = (MY_STATUS === 'Abroad' && MY_LOCATION && MY_LOCATION !== 'torn')
        ? enemies.filter(p => p.traveling && p.destination === MY_LOCATION).length
        : 0;

        if (inbound > 0) {
            button.style.background = 'linear-gradient(135deg, #c0392b, #e74c3c)';
            button.style.borderColor = '#fff';
            button.textContent = `⚠️ ${inbound}`;
        } else {
            button.style.background = 'linear-gradient(135deg, #2d2d2d, #1a1a1a)';
            button.style.borderColor = '#444';
            button.textContent = `✈ ${total}`;
        }
    }

    function showQuickView() {
        let existing = document.getElementById('odin-quickview');
        if (existing) {
            if (existing._odinIntervalId) clearInterval(existing._odinIntervalId);
            if (existing._odinCloseHandler) {
                document.removeEventListener('click', existing._odinCloseHandler);
            }
            existing.remove();
            return;
        }

        let modal = document.createElement('div');
        modal.id = 'odin-quickview';
        modal.style.cssText = `
            position: fixed;
            top: 62px;
            right: 10px;
            z-index: 999999;
            background: rgba(20, 20, 20, 0.98);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 8px;
            padding: 12px;
            min-width: 300px;
            max-width: 400px;
            font-size: 12px;
            color: #f0f0f0;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        `;

        function renderEnemiesView() {
            let enemies = Array.from(trackedPersons.values()).filter(p => p && p.isEnemy);
            let dangerCounts = new Map();

            enemies.forEach(p => {
                let k = p.traveling ? p.destination : p.abroadLocation;
                if (!k) return;
                dangerCounts.set(k, (dangerCounts.get(k) || 0) + 1);
            });

            let allCountries = Object.keys(TRAVEL_TABLE);
            let dangerKeys = Array.from(dangerCounts.keys()).sort();
            let safeKeys = allCountries.filter(k => !dangerCounts.has(k)).sort();

            let withTimer = enemies.filter(p => p.traveling && p.destination && p.hasValidTimer())
            .sort((a, b) => (a.landingAt || 0) - (b.landingAt || 0));

            let withoutTimer = enemies.filter(p =>
                                              (p.traveling && p.destination && !p.hasValidTimer()) ||
                                              (!p.traveling && p.abroadLocation)
                                             ).sort((a, b) => {
                let aKey = a.traveling ? 0 : 1;
                let bKey = b.traveling ? 0 : 1;
                if (aKey !== bKey) return aKey - bKey;
                return (a.name || '').localeCompare(b.name || '');
            });

            let timerRows = withTimer.length
            ? withTimer.map(p => {
                let dest = prettyCountry(p.destination);
                let name = escapeHtml(p.name || `#${p.id}`);
                let remainTxt = formatHMS(p.getRemainingSeconds());
                let isInbound = MY_STATUS === 'Abroad' && p.destination === MY_LOCATION;
                let style = isInbound ? 'color:#ff4444;font-weight:bold;' : '';
                return `<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:2px 0;${style}">
                        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                            ${isInbound ? '⚠️ ' : ''}<a href="${profileUrl(p.id)}" target="_blank" rel="noopener" style="color:${isInbound ? '#ff6666' : '#9fd1ff'};text-decoration:none;">${name}</a>
                            <span style="opacity:0.9;"> → ${dest}</span>
                        </div>
                        <div style="font-variant-numeric:tabular-nums;white-space:nowrap;">${remainTxt}</div>
                    </div>`;
                }).join('')
            : '<div style="opacity:0.7;padding:4px 0;">None</div>';

            let noTimerRows = withoutTimer.length
            ? withoutTimer.map(p => {
                let where = p.traveling
                ? `${prettyCountry(p.destination)} (Flying)`
                        : `${prettyCountry(p.abroadLocation)} (Abroad)`;
                    let name = escapeHtml(p.name || `#${p.id}`);
                    return `<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:2px 0;">
                        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                            <a href="${profileUrl(p.id)}" target="_blank" rel="noopener" style="color:#9fd1ff;text-decoration:none;">${name}</a>
                            <span style="opacity:0.9;"> → ${where}</span>
                        </div>
                    </div>`;
                }).join('')
            : '<div style="opacity:0.7;">None</div>';

            let dangerList = dangerKeys.length
            ? dangerKeys.map(k => {
                let isMyLoc = MY_STATUS === 'Abroad' && k === MY_LOCATION;
                return `<span style="${isMyLoc ? 'color:#ff6666;font-weight:bold;' : ''}">${prettyCountry(k)} (${dangerCounts.get(k)})</span>`;
            }).join(', ')
            : 'None';

            let safeList = safeKeys.length
            ? safeKeys.map(k => prettyCountry(k)).join(', ')
            : 'None';

            let statusInfo = MY_STATUS === 'Abroad'
            ? `<span style="color:#4ade80;">Abroad</span> in <strong>${prettyCountry(MY_LOCATION)}</strong>`
                : `<span style="color:#888;">${MY_STATUS || 'Unknown'}</span>`;

            return `
                <div style="font-weight:700;margin-bottom:4px;font-size:11px;color:#4ade80;">WITH TIMER</div>
                <div id="odin-timer-list" style="margin-bottom:8px;max-height:120px;overflow-y:auto;">${timerRows}</div>

                <div style="font-weight:700;margin:8px 0 4px;font-size:11px;color:#999;">WITHOUT TIMER</div>
                <div id="odin-notimer-list" style="margin-bottom:8px;max-height:120px;overflow-y:auto;">${noTimerRows}</div>

                <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);">
                    <div style="font-weight:700;margin-bottom:4px;font-size:11px;color:#999;">DANGER ZONES</div>
                    <div style="line-height:1.4;">${dangerList}</div>
                </div>

                <div style="margin-top:8px;">
                    <div style="font-weight:700;margin-bottom:4px;font-size:11px;color:#999;">SAFE ZONES</div>
                    <div style="line-height:1.4;color:#4ade80;">${safeList}</div>
                </div>

                <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);font-size:11px;">
                    Your status: ${statusInfo}
                </div>
            `;
        }

        function renderFactionView() {
            let factionMembers = Array.from(trackedPersons.values()).filter(p => p && p.isFactionMember);
            let enemyDestinations = getEnemyDestinations();

            let countryCounts = new Map();
            factionMembers.forEach(p => {
                let loc = p.traveling ? p.destination : p.abroadLocation;
                if (loc && loc !== 'torn') {
                    if (!countryCounts.has(loc)) countryCounts.set(loc, []);
                    countryCounts.get(loc).push(p);
                }
            });

            let abroad = factionMembers.filter(p => !p.traveling && p.abroadLocation);
            let flying = factionMembers.filter(p => p.traveling && p.destination);

            let countryList = Array.from(countryCounts.entries())
            .sort((a, b) => b[1].length - a[1].length)
            .map(([country, members]) => {
                let hasInbound = enemyDestinations.has(country);
                return `<span style="${hasInbound ? 'color:#ff6666;font-weight:bold;' : ''}">${prettyCountry(country)} (${members.length})${hasInbound ? ' ⚠️' : ''}</span>`;
            }).join(', ') || 'None';

            let abroadRows = abroad.length
            ? abroad.map(p => {
                let loc = prettyCountry(p.abroadLocation);
                let name = escapeHtml(p.name || `#${p.id}`);
                let hasInbound = enemyDestinations.has(p.abroadLocation);
                let style = hasInbound ? 'color:#ff6666;' : '';
                return `<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:2px 0;">
                        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${style}">
                            ${hasInbound ? '⚠️ ' : ''}<a href="${profileUrl(p.id)}" target="_blank" rel="noopener" style="color:${hasInbound ? '#ff6666' : '#9fd1ff'};text-decoration:none;">${name}</a>
                            <span style="opacity:0.9;"> - ${loc}</span>
                        </div>
                    </div>`;
                }).join('')
            : '<div style="opacity:0.7;">None</div>';

            let flyingRows = flying.length
            ? flying.map(p => {
                let dest = prettyCountry(p.destination);
                let name = escapeHtml(p.name || `#${p.id}`);
                let hasInbound = enemyDestinations.has(p.destination);
                let timer = p.hasValidTimer() ? formatHMS(p.getRemainingSeconds()) : '??:??:??';
                let style = hasInbound ? 'color:#ff6666;' : '';
                return `<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:2px 0;">
                        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${style}">
                            ${hasInbound ? '⚠️ ' : ''}<a href="${profileUrl(p.id)}" target="_blank" rel="noopener" style="color:${hasInbound ? '#ff6666' : '#9fd1ff'};text-decoration:none;">${name}</a>
                            <span style="opacity:0.9;"> → ${dest}</span>
                        </div>
                        <div style="font-variant-numeric:tabular-nums;white-space:nowrap;">${timer}</div>
                    </div>`;
                }).join('')
            : '<div style="opacity:0.7;">None</div>';

            return `
                <div style="margin-bottom:10px;">
                    <div style="font-weight:700;margin-bottom:4px;font-size:11px;color:#999;">OCCUPIED COUNTRIES</div>
                    <div style="line-height:1.4;">${countryList}</div>
                </div>

                <div style="font-weight:700;margin:8px 0 4px;font-size:11px;color:#4ade80;">ABROAD (${abroad.length})</div>
                <div id="odin-abroad-list" style="margin-bottom:8px;max-height:120px;overflow-y:auto;">${abroadRows}</div>

                <div style="font-weight:700;margin:8px 0 4px;font-size:11px;color:#ff6600;">FLYING (${flying.length})</div>
                <div id="odin-flying-list" style="max-height:120px;overflow-y:auto;">${flyingRows}</div>
            `;
        }

        function renderQuickView() {
            let enemiesActive = CONFIG.quickViewTab === 'enemies';
            let factionActive = CONFIG.quickViewTab === 'faction';

            let tabStyle = (active) => `
                padding: 6px 16px;
                cursor: pointer;
                font-weight: 700;
                font-size: 13px;
                border: none;
                background: ${active ? '#ff6600' : 'transparent'};
                color: ${active ? '#fff' : '#888'};
                border-radius: 4px;
                transition: all 0.2s;
            `;

            let content = enemiesActive ? renderEnemiesView() : renderFactionView();

            modal.innerHTML = `
                <div style="display:flex;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.1);">
                    <button id="odin-tab-enemies" style="${tabStyle(enemiesActive)}">Enemies</button>
                    <button id="odin-tab-faction" style="${tabStyle(factionActive)}">Faction</button>
                </div>
                ${content}
            `;

            modal.querySelector('#odin-tab-enemies').addEventListener('click', (e) => {
                e.stopPropagation();
                CONFIG.quickViewTab = 'enemies';
                renderQuickView();
            });

            modal.querySelector('#odin-tab-faction').addEventListener('click', (e) => {
                e.stopPropagation();
                CONFIG.quickViewTab = 'faction';
                renderQuickView();
            });
        }

        renderQuickView();
        document.body.appendChild(modal);

        let intervalId = setInterval(() => {
            if (!document.body.contains(modal)) {
                clearInterval(intervalId);
                return;
            }
            let scrollPositions = {};
            ['odin-timer-list', 'odin-notimer-list', 'odin-abroad-list', 'odin-flying-list'].forEach(id => {
                let el = modal.querySelector('#' + id);
                if (el) scrollPositions[id] = el.scrollTop;
            });

            renderQuickView();

            Object.entries(scrollPositions).forEach(([id, pos]) => {
                let el = modal.querySelector('#' + id);
                if (el) el.scrollTop = pos;
            });
        }, 1000);
        modal._odinIntervalId = intervalId;

        let closeQuickView = (e) => {
            if (modal.contains(e.target) || e.target.id === 'odin-header-button') return;
            clearInterval(intervalId);
            modal.remove();
            document.removeEventListener('click', closeQuickView);
        };
        modal._odinCloseHandler = closeQuickView;

        setTimeout(() => document.addEventListener('click', closeQuickView), 0);
    }

    let settingsClickHandler = null;

    function createSettingsUI() {
        if (document.getElementById('odin-settings-modal')) return;

        let modal = document.createElement('div');
        modal.id = 'odin-settings-modal';
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #1b1e22;
            color: #e6e6e6;
            border: 1px solid #3a3f46;
            border-radius: 8px;
            padding: 20px;
            z-index: 99999;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            width: 360px;
            max-width: 90vw;
            max-height: 80vh;
            overflow-y: auto;
            font-family: system-ui, -apple-system, sans-serif;
        `;

        let isManual = CONFIG.trackingMode === 'manual';
        let targetType = CONFIG.manualTarget.type || 'faction';
        let targetId = CONFIG.manualTarget.id || '';
        let maskedKey = CONFIG.apiKey ? '••••••••••••••••' : '';

        modal.innerHTML = `
            <h3 style="margin:0 0 16px 0; color:#ff6600; font-size:16px">Odin FlightTracker Settings</h3>

            <div style="margin-bottom:16px">
                <label style="display:block; margin-bottom:4px; font-size:12px; color:#999">API Key</label>
                <input type="password" id="odin-apikey" value="${maskedKey}" placeholder="Enter API key" style="width:100%; padding:8px; background:#2a2f36; color:#fff; border:1px solid #3a3f46; border-radius:4px; box-sizing:border-box">
            </div>

            <div style="margin-bottom:16px">
                <label style="display:block; margin-bottom:4px; font-size:12px; color:#999">Faction Poll Interval (ms)</label>
                <input type="number" id="odin-pollinterval-faction" value="${CONFIG.factionPollInterval}" min="15000" style="width:100%; padding:8px; background:#2a2f36; color:#fff; border:1px solid #3a3f46; border-radius:4px; box-sizing:border-box">
            </div>

            <div style="margin-bottom:16px">
                <label style="display:block; margin-bottom:4px; font-size:12px; color:#999">Enemy Poll Interval (ms)</label>
                <input type="number" id="odin-pollinterval-enemy" value="${CONFIG.enemyPollInterval}" min="15000" style="width:100%; padding:8px; background:#2a2f36; color:#fff; border:1px solid #3a3f46; border-radius:4px; box-sizing:border-box">
            </div>

            <div style="margin-bottom:16px">
                <label style="display:block; margin-bottom:4px; font-size:12px; color:#999">Manual Target Poll Interval (ms)</label>
                <input type="number" id="odin-pollinterval-manual" value="${CONFIG.manualPollInterval}" min="15000" style="width:100%; padding:8px; background:#2a2f36; color:#fff; border:1px solid #3a3f46; border-radius:4px; box-sizing:border-box">
            </div>

            <h4 style="color:#ff6600; font-size:13px; margin:16px 0 8px">Tracking Mode</h4>
            <div style="margin-bottom:8px">
                <label style="display:flex; align-items:center; gap:8px; margin:4px 0; cursor:pointer">
                    <input type="radio" name="tracking-mode" value="auto" ${!isManual ? 'checked' : ''}>
                    <span>🟢 Automatic (faction + enemies on page)</span>
                </label>
                <label style="display:flex; align-items:center; gap:8px; margin:4px 0; cursor:pointer">
                    <input type="radio" name="tracking-mode" value="manual" ${isManual ? 'checked' : ''}>
                    <span>🟠 Manual target</span>
                </label>
            </div>

            <div id="manual-options" style="margin-left:20px; ${!isManual ? 'display:none' : ''}">
                <select id="manual-type" style="width:100%; padding:6px; margin-bottom:8px; background:#2a2f36; color:#fff; border:1px solid #3a3f46; border-radius:4px">
                    <option value="faction" ${targetType === 'faction' ? 'selected' : ''}>Faction ID</option>
                    <option value="user" ${targetType === 'user' ? 'selected' : ''}>Single User ID</option>
                </select>
                <input type="number" id="manual-id" value="${targetId}" placeholder="Enter ID" style="width:100%; padding:8px; background:#2a2f36; color:#fff; border:1px solid #3a3f46; border-radius:4px; box-sizing:border-box">
            </div>

            <h4 style="color:#ff6600; font-size:13px; margin:16px 0 8px">Alerts</h4>
            <p style="font-size:11px; color:#888; margin:0 0 8px;">Inbound alerts only when you're Abroad.</p>
            <label style="display:flex; align-items:center; gap:8px; margin:5px 0; cursor:pointer">
                <input type="checkbox" id="alert-enabled" ${CONFIG.alertSettings.enabled ? 'checked' : ''}>
                <span>Enable Alerts</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; margin:5px 0; cursor:pointer">
                <input type="checkbox" id="alert-sound" ${CONFIG.alertSettings.sound ? 'checked' : ''}>
                <span>Sound</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; margin:5px 0; cursor:pointer">
                <input type="checkbox" id="alert-vibrate" ${CONFIG.alertSettings.vibration ? 'checked' : ''}>
                <span>Vibration</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; margin:5px 0; cursor:pointer">
                <input type="checkbox" id="alert-debug" ${CONFIG.alertSettings.debug ? 'checked' : ''}>
                <span>Debug Overlay</span>
            </label>
            <div style="margin-left:20px; margin-top:4px">
                <label style="display:flex; align-items:center; gap:8px; margin:3px 0; font-size:12px; cursor:pointer">
                    <input type="checkbox" id="tier-600" ${CONFIG.alertSettings.tiers[600] ? 'checked' : ''}>
                    <span>10 minutes warning</span>
                </label>
                <label style="display:flex; align-items:center; gap:8px; margin:3px 0; font-size:12px; cursor:pointer">
                    <input type="checkbox" id="tier-300" ${CONFIG.alertSettings.tiers[300] ? 'checked' : ''}>
                    <span>5 minutes warning</span>
                </label>
                <label style="display:flex; align-items:center; gap:8px; margin:3px 0; font-size:12px; cursor:pointer">
                    <input type="checkbox" id="tier-60" ${CONFIG.alertSettings.tiers[60] ? 'checked' : ''}>
                    <span>1 minute warning</span>
                </label>
            </div>

            <div style="margin-top:20px; display:flex; gap:10px">
                <button id="odin-save" style="flex:1; padding:10px; background:#ff6600; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:600; min-height:40px">Save</button>
                <button id="odin-cancel" style="flex:1; padding:10px; background:#2a2f36; color:#e6e6e6; border:1px solid #3a3f46; border-radius:4px; cursor:pointer; min-height:40px">Cancel</button>
            </div>
            <div style="margin-top:12px; border-top:1px solid #3a3f46; padding-top:12px;">
                <button id="odin-reset" style="width:100%; padding:8px; background:#8b0000; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:12px;">Reset All Data</button>
            </div>
        `;

        document.body.appendChild(modal);

        let radioHandler = () => {
            let manualOpts = modal.querySelector('#manual-options');
            manualOpts.style.display = modal.querySelector('input[value="manual"]').checked ? 'block' : 'none';
        };

        modal.querySelectorAll('input[name="tracking-mode"]').forEach(radio => {
            radio.addEventListener('change', radioHandler);
        });

        let saveHandler = () => {
            let prevTrackingMode = CONFIG.trackingMode;
            let prevManualTargetId = CONFIG.manualTarget.id;

            let apiKeyInput = modal.querySelector('#odin-apikey').value;
            if (apiKeyInput && apiKeyInput !== '••••••••••••••••') {
                CONFIG.apiKey = apiKeyInput;
            }

            CONFIG.factionPollInterval = Math.max(15000, parseInt(modal.querySelector('#odin-pollinterval-faction').value) || 30000);
            CONFIG.enemyPollInterval = Math.max(15000, parseInt(modal.querySelector('#odin-pollinterval-enemy').value) || 30000);
            CONFIG.manualPollInterval = Math.max(15000, parseInt(modal.querySelector('#odin-pollinterval-manual').value) || 30000);
            CONFIG.trackingMode = modal.querySelector('input[name="tracking-mode"]:checked').value;
            CONFIG.manualTarget.type = modal.querySelector('#manual-type').value;
            CONFIG.manualTarget.id = parseInt(modal.querySelector('#manual-id').value) || null;

            CONFIG.alertSettings.enabled = modal.querySelector('#alert-enabled').checked;
            CONFIG.alertSettings.sound = modal.querySelector('#alert-sound').checked;
            CONFIG.alertSettings.vibration = modal.querySelector('#alert-vibrate').checked;
            CONFIG.alertSettings.debug = modal.querySelector('#alert-debug').checked;
            CONFIG.alertSettings.tiers[600] = modal.querySelector('#tier-600').checked;
            CONFIG.alertSettings.tiers[300] = modal.querySelector('#tier-300').checked;
            CONFIG.alertSettings.tiers[60] = modal.querySelector('#tier-60').checked;

            if (!CONFIG.alertSettings.debug) {
                let dbg = document.getElementById('odin-debug');
                if (dbg) dbg.remove();
            }

            if (prevTrackingMode !== CONFIG.trackingMode ||
                (CONFIG.trackingMode === 'manual' && prevManualTargetId !== CONFIG.manualTarget.id)) {
                trackedPersons.clear();
            }

            saveConfig();
            modal.remove();
            startPolling();
        };

        modal.querySelector('#odin-save').addEventListener('click', saveHandler);

        let cancelHandler = () => {
            modal.querySelectorAll('input[name="tracking-mode"]').forEach(radio => {
                radio.removeEventListener('change', radioHandler);
            });
            modal.remove();
        };

        modal.querySelector('#odin-cancel').addEventListener('click', cancelHandler);

        let resetHandler = () => {
            if (confirm('Are you sure you want to reset all FlightTracker data? This will clear your API key and all settings.')) {
                modal.remove();
                resetAllData();
            }
        };

        modal.querySelector('#odin-reset').addEventListener('click', resetHandler);
    }

    function injectSettingsMenuEntry() {
        let logoutLink = document.querySelector('li.link > a[href*="logout.php"]');
        if (!logoutLink || document.getElementById('odin-settings-entry')) return;

        let settingsEntry = document.createElement('li');
        settingsEntry.id = 'odin-settings-entry';
        settingsEntry.className = 'link';
        settingsEntry.innerHTML = '<a href="#" style="cursor:pointer">⚙️FlightTracker</a>';

        if (settingsClickHandler) {
            settingsEntry.removeEventListener('click', settingsClickHandler);
        }
        settingsClickHandler = (e) => {
            e.preventDefault();
            createSettingsUI();
        };
        settingsEntry.addEventListener('click', settingsClickHandler);

        logoutLink.parentElement.parentElement.insertBefore(settingsEntry, logoutLink.parentElement);
    }

    function showApiOnboardingModal() {
        let backdrop = document.createElement('div');
        backdrop.id = 'odin-onboard-backdrop';
        backdrop.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.6);
            z-index: 99999;
        `;
        document.body.appendChild(backdrop);

        let modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #1b1e22;
            color: #e6e6e6;
            border: 1px solid #3a3f46;
            border-radius: 8px;
            padding: 24px;
            z-index: 100000;
            box-shadow: 0 4px 16px rgba(0,0,0,0.7);
            width: 420px;
            max-width: 90vw;
            max-height: 90vh;
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            flex-direction: column;
        `;

        modal.innerHTML = `
            <h3 style="margin:0 0 16px 0; color:#ff6600; font-size:18px">Odin FlightTracker – Setup</h3>

            <div style="flex:1; min-height:0; margin-bottom:16px;">
                <div style="background:#2a2f36; border:1px solid #3a3f46; border-radius:6px; padding:12px; height:280px; overflow-y:auto; font-size:13px; line-height:1.5;">
                    <div style="color:#ff6600; font-weight:700; font-size:14px; margin-bottom:12px;">Torn API Usage Disclaimer</div>

                    <p style="margin:0 0 12px;">This tool uses your personal Torn API key to read limited, read-only game data from Torn's official API.</p>

                    <div style="color:#4ade80; font-weight:600; margin:12px 0 8px;">What data is accessed:</div>
                    <ul style="margin:0 0 12px; padding-left:20px;">
                        <li>Your current status and location (e.g. Traveling / Abroad / In Torn)</li>
                        <li>Faction member lists and their public status</li>
                        <li>Public enemy player profile status when visible in-game</li>
                    </ul>

                    <div style="color:#ff6666; font-weight:600; margin:12px 0 8px;">What this tool does NOT do:</div>
                    <div style="margin:0 0 12px; padding-left:8px;">
                        <div>❌ It does not perform any actions on your account</div>
                        <div>❌ It does not make purchases, attacks, trades, or edits</div>
                        <div>❌ It does not modify Torn data in any way</div>
                        <div>❌ It does not send your API key to Torn staff, third parties, or other players</div>
                    </div>

                    <div style="color:#9fd1ff; font-weight:600; margin:12px 0 8px;">API Key Handling:</div>
                    <ul style="margin:0 0 12px; padding-left:20px;">
                        <li>Your API key is stored locally in your browser via Tampermonkey/Greasemonkey storage</li>
                        <li>The key is used only to make requests directly to api.torn.com</li>
                        <li>You may revoke or regenerate your API key at any time in Torn's account settings</li>
                    </ul>

                    <div style="color:#ffaa00; font-weight:600; margin:12px 0 8px;">Important:</div>
                    <ul style="margin:0 0 12px; padding-left:20px;">
                        <li>Use of this script is at your own risk</li>
                        <li>You are responsible for keeping your API key secure</li>
                        <li>This script is not affiliated with or endorsed by Torn Ltd.</li>
                    </ul>

                    <p style="margin:12px 0 0; padding-top:12px; border-top:1px solid #3a3f46; font-style:italic; color:#999;">
                        By continuing, you acknowledge that you understand how your API key is used and consent to its use as described above.
                    </p>
                </div>
            </div>

            <div style="margin-bottom:12px;">
                <label style="display:block; margin-bottom:4px; font-size:12px; color:#999">Torn API Key</label>
                <input type="text" id="onboard-apikey" placeholder="Enter your API key" style="width:100%; padding:10px; background:#2a2f36; color:#fff; border:1px solid #3a3f46; border-radius:4px; box-sizing:border-box; font-size:14px">
            </div>

            <label style="display:flex; align-items:center; margin-bottom:16px; cursor:pointer">
                <input type="checkbox" id="onboard-agree" style="margin-right:8px">
                <span style="font-size:13px">I have read and agree to the above disclaimer</span>
            </label>

            <div style="display:flex; gap:10px">
                <button id="onboard-save" disabled style="flex:1; padding:10px; background:#ff6600; color:#fff; border:none; border-radius:4px; cursor:not-allowed; font-weight:600; min-height:40px; opacity:0.5">Continue</button>
                <button id="onboard-cancel" style="flex:1; padding:10px; background:#2a2f36; color:#e6e6e6; border:1px solid #3a3f46; border-radius:4px; cursor:pointer; min-height:40px">Cancel</button>
            </div>
        `;

        document.body.appendChild(modal);

        let saveBtn = modal.querySelector('#onboard-save');
        let keyInput = modal.querySelector('#onboard-apikey');
        let agreeCheck = modal.querySelector('#onboard-agree');

        function validateForm() {
            let keyValid = keyInput.value.length >= 16;
            let agreeValid = agreeCheck.checked;
            let valid = keyValid && agreeValid;
            saveBtn.disabled = !valid;
            saveBtn.style.cursor = valid ? 'pointer' : 'not-allowed';
            saveBtn.style.opacity = valid ? '1' : '0.5';
        }

        keyInput.addEventListener('input', validateForm);
        agreeCheck.addEventListener('change', validateForm);

        saveBtn.addEventListener('click', () => {
            if (saveBtn.disabled) return;
            CONFIG.apiKey = keyInput.value;
            saveConfig();
            backdrop.remove();
            modal.remove();
            document.removeEventListener('keydown', escHandler);
            init();
        });

        function closeOnboard() {
            backdrop.remove();
            modal.remove();
            document.removeEventListener('keydown', escHandler);
        }

        let escHandler = (e) => {
            if (e.key === 'Escape') closeOnboard();
        };
        document.addEventListener('keydown', escHandler);

        modal.querySelector('#onboard-cancel').addEventListener('click', closeOnboard);
    }

    function resetAllData() {
        if (factionPollTimer) clearInterval(factionPollTimer);
        if (manualPollTimer) clearInterval(manualPollTimer);
        if (enemyPollTimer) clearInterval(enemyPollTimer);
        if (countdownTimer) clearInterval(countdownTimer);
        if (myLocationTimer) clearInterval(myLocationTimer);

        GM_setValue('odin_ft_apikey', '');
        GM_setValue('odin_ft_trackfaction', true);
        GM_setValue('odin_ft_trackenemies', true);
        GM_setValue('odin_ft_pollinterval_faction', 30000);
        GM_setValue('odin_ft_pollinterval_enemy', 30000);
        GM_setValue('odin_ft_pollinterval_manual', 30000);
        GM_setValue('odin_ft_trackedstate', {});
        GM_setValue('odin_ft_trackingmode', 'auto');
        GM_setValue('odin_ft_manualtarget', { type: 'faction', id: null });
        GM_setValue('odin_ft_alertsettings', {
            enabled: true,
            tiers: { 600: true, 300: true, 60: true },
            sound: true,
            vibration: true,
            debug: false,
            historyLimit: 50
        });
        trackedPersons.clear();
        location.reload();
    }

    function setupObservers() {
        let debounceTimer = null;

        let observer = new MutationObserver(() => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                injectSettingsMenuEntry();
                injectHeaderButton();
                markUIDirty();
            }, 100);
        });

        let root = document.getElementById('react-root') || document.body;
        observer.observe(root, { childList: true, subtree: true });
    }

    function init() {
        if (!CONFIG.apiKey) {
            showApiOnboardingModal();
            return;
        }

        restoreTrackedState();
        injectSettingsMenuEntry();
        injectHeaderButton();
        setupObservers();

        setInterval(() => {
            if (!uiDirty) return;
            uiDirty = false;
            updateAllUI();
        }, 1000);

        updateMyLocation();
        myLocationTimer = setInterval(updateMyLocation, 15000);
        startPolling();
        startCountdown();
    }

    init();

})();
