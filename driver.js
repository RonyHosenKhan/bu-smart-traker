// Driver GPS Cockpit & Real-time Location Broadcaster
// Utilizes real device navigator.geolocation (hardware GPS) or virtual simulation
// Broadcasts in real-time across same-device tabs, local server REST API, and cloud pub/sub

const BU_DRIVER = {
    activeBusId: "BUS_BRTC_04",
    activeRouteId: "ROUTE_01",
    isTracking: false,
    isSimMode: false, // Default to REAL DEVICE GPS as requested
    simSpeedKmh: 35,
    updateCount: 0,
    watchId: null,
    simIntervalId: null,
    lastGpsPoint: null,

    // Current bus telemetry
    currentLocation: {
        lat: 22.69749,
        lng: 90.36998,
        speed: 0,
        accuracy: 8,
        heading: 195,
        timestamp: Date.now(),
        trackingStatus: "ACTIVE"
    },

    // Simulation route progression state
    simState: {
        waypointIndex: 0,
        progressT: 0.0,
        waypoints: []
    },

    // Multi-tab / multi-device communication channel
    channel: (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('BU_BUS_CHANNEL') : null,

    init: function () {
        this.populateDriverBuses();
        this.syncRouteFromBus();
        this.fetchServerInfo();
        this.syncPublicUrl();
    },

    syncPublicUrl: function () {
        if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
            const liveEl = document.getElementById("mobile-live-url");
            if (liveEl) {
                liveEl.textContent = window.location.origin;
            }
        }
    },

    fetchServerInfo: function () {
        fetch(BU_API.url('/api/info'))
            .then(res => res.json())
            .then(info => {
                if (info && info.mobileUrl) {
                    const el = document.getElementById("mobile-server-url");
                    if (el) el.textContent = info.mobileUrl;
                }
            })
            .catch(() => { });
    },

    populateDriverBuses: function () {
        const select = document.getElementById("driver-bus-select");
        if (!select) return;
        select.innerHTML = "";
        BU_ROUTES_DATA.buses.forEach(b => {
            const opt = document.createElement("option");
            opt.value = b.id;
            opt.textContent = `${b.name} (${b.id}) — ${b.driver}`;
            select.appendChild(opt);
        });
        select.value = this.activeBusId;
    },

    syncRouteFromBus: function () {
        const bus = BU_ROUTES_DATA.buses.find(b => b.id === this.activeBusId) || BU_ROUTES_DATA.buses[0];
        if (bus) {
            this.activeBusId = bus.id;
            this.activeRouteId = bus.routeId;
            const routeSelect = document.getElementById("driver-route-select");
            const route = BU_ROUTES_DATA.routes.find(r => r.id === bus.routeId);
            if (routeSelect && route) {
                routeSelect.innerHTML = `<option>${route.nameEn} (${route.nameBn})</option>`;
            }
            this.buildSimulationWaypoints();
        }
    },

    buildSimulationWaypoints: function () {
        const route = BU_ROUTES_DATA.routes.find(r => r.id === this.activeRouteId);
        if (!route) return;

        if (route.roadPath && route.roadPath.length > 0) {
            const sampled = [];
            for (let i = 0; i < route.roadPath.length; i += 4) {
                sampled.push({ lat: route.roadPath[i][0], lng: route.roadPath[i][1] });
            }
            const last = route.roadPath[route.roadPath.length - 1];
            sampled.push({ lat: last[0], lng: last[1] });
            this.simState.waypoints = sampled;
        } else {
            this.simState.waypoints = route.stopIds.map(id => {
                const stop = BU_ROUTES_DATA.stops[id];
                return { lat: stop.lat, lng: stop.lng, name: stop.nameEn };
            });
        }
        this.simState.waypointIndex = 0;
        this.simState.progressT = 0;

        if (this.simState.waypoints.length > 0) {
            this.currentLocation.lat = this.simState.waypoints[0].lat;
            this.currentLocation.lng = this.simState.waypoints[0].lng;
        }
    },

    setMode: function (isSim) {
        this.isSimMode = isSim;
        const realTab = document.getElementById("tab-mode-real");
        const simTab = document.getElementById("tab-mode-sim");
        const simControls = document.getElementById("sim-controls");

        if (realTab && simTab) {
            if (isSim) {
                realTab.classList.remove("active");
                simTab.classList.add("active");
                if (simControls) simControls.style.display = "flex";
            } else {
                realTab.classList.add("active");
                simTab.classList.remove("active");
                if (simControls) simControls.style.display = "none";
            }
        }

        if (this.isTracking) {
            this.stopTrip();
            this.startTrip();
        }
    },

    startTrip: function () {
        this.isTracking = true;
        this.updateCount = 0;
        this.lastGpsPoint = null;

        document.getElementById("btn-start-trip").disabled = true;
        document.getElementById("btn-stop-trip").disabled = false;
        document.getElementById("driver-bus-select").disabled = true;

        const badge = document.getElementById("driver-trip-badge");
        badge.textContent = this.isSimMode ? "SIMULATING ROUTE" : "CONNECTING TO GPS...";
        badge.className = "badge status-active";

        const livePill = document.getElementById("driver-live-indicator");
        if (livePill) livePill.style.display = "inline-block";
        const mobBadge = document.getElementById("mob-driver-live-badge");
        if (mobBadge) mobBadge.style.display = "inline-block";

        if (this.isSimMode) {
            this.startSimulation();
        } else {
            this.startHardwareGps();
        }
    },

    stopTrip: function () {
        this.isTracking = false;

        if (this.simIntervalId) clearInterval(this.simIntervalId);
        if (this.watchId) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }

        document.getElementById("btn-start-trip").disabled = false;
        document.getElementById("btn-stop-trip").disabled = true;
        document.getElementById("driver-bus-select").disabled = false;

        const badge = document.getElementById("driver-trip-badge");
        if (badge) {
            badge.textContent = "STOPPED";
            badge.className = "badge status-offline";
        }

        const livePill = document.getElementById("driver-live-indicator");
        if (livePill) livePill.style.display = "none";
        const mobBadge = document.getElementById("mob-driver-live-badge");
        if (mobBadge) mobBadge.style.display = "none";

        const stopPayload = {
            busId: this.activeBusId,
            routeId: this.activeRouteId,
            trackingStatus: "STOPPED",
            isStopped: true,
            timestamp: Date.now(),
            speed: 0
        };

        this.broadcastStop(stopPayload);
        this.updateTelemetryUI();
    },

    broadcastStop: function (stopPayload) {
        const payload = JSON.stringify(stopPayload);

        // 1. Same-device multi-tab BroadcastChannel
        try {
            if (this.channel) {
                this.channel.postMessage({
                    type: "BUS_STOP_TRIP",
                    busId: this.activeBusId,
                    data: stopPayload
                });
            }
        } catch (e) { }

        // 2. Storage event
        try {
            localStorage.removeItem(`BU_LIVE_LOCATION_${this.activeBusId}`);
            localStorage.setItem("BU_BUS_STOPPED_EVENT", payload);
        } catch (e) { }

        // 3. Local & Cloud Server REST API (POST STOPPED + DELETE)
        try {
            fetch(BU_API.url('/api/location'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).catch(() => { });

            fetch(BU_API.url(`/api/location?busId=${this.activeBusId}`), {
                method: 'DELETE'
            }).catch(() => { });
        } catch (e) { }

        // 4. Free Cloud Pub/Sub relay (ntfy.sh)
        try {
            fetch(`https://ntfy.sh/bu_bus_live_all`, {
                method: 'POST',
                body: payload
            }).catch(() => { });
            fetch(`https://ntfy.sh/bu_bus_live_${this.activeBusId}`, {
                method: 'POST',
                body: payload
            }).catch(() => { });
        } catch (e) { }

        // 5. Update local student engine immediately
        if (window.BU_STUDENT && typeof window.BU_STUDENT.onBusStopped === 'function') {
            window.BU_STUDENT.onBusStopped(this.activeBusId);
        }
    },

    startSimulation: function () {
        this.simIntervalId = setInterval(() => {
            if (!this.isTracking) return;
            this.stepSimulation();
        }, 2200);
    },

    stepSimulation: function () {
        const wps = this.simState.waypoints;
        if (wps.length < 2) return;

        let curIdx = this.simState.waypointIndex;
        let nextIdx = (curIdx + 1) % wps.length;

        const p1 = wps[curIdx];
        const p2 = wps[nextIdx];

        const stepSize = (this.simSpeedKmh / 35.0) * 0.12;
        this.simState.progressT += stepSize;

        if (this.simState.progressT >= 1.0) {
            this.simState.progressT = 0.0;
            this.simState.waypointIndex = nextIdx;
            if (nextIdx === wps.length - 1) {
                this.currentLocation.speed = 0;
            }
        }

        const t = this.simState.progressT;
        const lat = p1.lat + (p2.lat - p1.lat) * t;
        const lng = p1.lng + (p2.lng - p1.lng) * t;

        const y = Math.sin((p2.lng - p1.lng) * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180);
        const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180) -
            Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos((p2.lng - p1.lng) * Math.PI / 180);
        let heading = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

        const bus = BU_ROUTES_DATA.buses.find(b => b.id === this.activeBusId);

        this.currentLocation = {
            busId: this.activeBusId,
            routeId: this.activeRouteId,
            driverName: bus ? bus.driver : "Driver",
            lat: lat,
            lng: lng,
            speed: Math.max(5, Math.round(this.simSpeedKmh + (Math.random() * 6 - 3))),
            accuracy: Math.round(5 + Math.random() * 4),
            heading: Math.round(heading),
            timestamp: Date.now(),
            trackingStatus: "ACTIVE",
            source: "SIMULATION"
        };

        this.updateCount++;
        this.broadcastLocation();
        this.updateTelemetryUI();
    },

    startHardwareGps: function () {
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser. Falling back to simulation mode.");
            this.setMode(true);
            return;
        }

        const options = {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 1000
        };

        this.watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const curLat = pos.coords.latitude;
                const curLng = pos.coords.longitude;
                const curTime = Date.now();

                // Dynamic speed calculation (handles devices where pos.coords.speed is null/0)
                let speedKmh = 0;
                if (pos.coords.speed !== null && !isNaN(pos.coords.speed) && pos.coords.speed > 0) {
                    speedKmh = Math.round(pos.coords.speed * 3.6);
                } else if (this.lastGpsPoint) {
                    const distKm = BU_ETA.haversineDistance(this.lastGpsPoint.lat, this.lastGpsPoint.lng, curLat, curLng);
                    const timeDeltaHr = (curTime - this.lastGpsPoint.time) / 3600000;
                    if (timeDeltaHr > 0.0001) {
                        const calculatedSpeed = Math.round(distKm / timeDeltaHr);
                        if (calculatedSpeed < 120) {
                            speedKmh = calculatedSpeed;
                        }
                    }
                }

                // Dynamic compass heading calculation
                let headingDeg = 0;
                if (pos.coords.heading !== null && !isNaN(pos.coords.heading) && pos.coords.heading > 0) {
                    headingDeg = Math.round(pos.coords.heading);
                } else if (this.lastGpsPoint) {
                    const p1 = this.lastGpsPoint;
                    const p2 = { lat: curLat, lng: curLng };
                    const distM = BU_ETA.haversineDistance(p1.lat, p1.lng, p2.lat, p2.lng) * 1000;
                    if (distM > 2.5) {
                        const y = Math.sin((p2.lng - p1.lng) * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180);
                        const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180) -
                            Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos((p2.lng - p1.lng) * Math.PI / 180);
                        headingDeg = Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
                    } else {
                        headingDeg = this.currentLocation.heading || 0;
                    }
                }

                this.lastGpsPoint = { lat: curLat, lng: curLng, time: curTime };

                const bus = BU_ROUTES_DATA.buses.find(b => b.id === this.activeBusId);

                this.currentLocation = {
                    busId: this.activeBusId,
                    routeId: this.activeRouteId,
                    driverName: bus ? bus.driver : "Driver",
                    lat: curLat,
                    lng: curLng,
                    speed: speedKmh,
                    accuracy: Math.round(pos.coords.accuracy || 6),
                    heading: headingDeg,
                    timestamp: curTime,
                    trackingStatus: "ACTIVE",
                    source: "HARDWARE_GPS"
                };

                this.updateCount++;

                const badge = document.getElementById("driver-trip-badge");
                if (badge) {
                    badge.textContent = `LIVE GPS ACTIVE (#${this.updateCount})`;
                    badge.className = "badge status-active";
                }

                this.broadcastLocation();
                this.updateTelemetryUI();
            },
            (err) => {
                console.warn("Driver Hardware GPS Error:", err.message);
                const badge = document.getElementById("driver-trip-badge");
                if (badge) {
                    badge.textContent = `GPS WARNING: ${err.message}`;
                }
            },
            options
        );
    },

    broadcastLocation: function () {
        const payload = JSON.stringify(this.currentLocation);

        // 1. Same-device multi-tab BroadcastChannel
        try {
            if (this.channel) {
                this.channel.postMessage({
                    type: "BUS_LOCATION_UPDATE",
                    data: this.currentLocation
                });
            }
        } catch (e) { }

        // 2. Local storage for same-origin tabs
        try {
            localStorage.setItem(`BU_LIVE_LOCATION_${this.activeBusId}`, payload);
            localStorage.setItem("BU_LATEST_LOCATION_UPDATE", payload);
        } catch (e) { }

        // 3. Local Python Server REST API (multi-device on Wi-Fi / LAN / Server)
        try {
            fetch(BU_API.url('/api/location'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).catch(() => { });
        } catch (e) { }

        // 4. Free Cloud Pub/Sub relay (ntfy.sh) for cellular/internet cross-device sync
        try {
            fetch(`https://ntfy.sh/bu_bus_live_all`, {
                method: 'POST',
                body: payload
            }).catch(() => { });
            fetch(`https://ntfy.sh/bu_bus_live_${this.activeBusId}`, {
                method: 'POST',
                body: payload
            }).catch(() => { });
        } catch (e) { }

        // 5. Update local student listener directly if in same window
        if (window.BU_STUDENT && typeof window.BU_STUDENT.onLiveLocationReceived === 'function') {
            window.BU_STUDENT.onLiveLocationReceived(this.currentLocation);
        }
    },

    updateTelemetryUI: function () {
        const speedEl = document.getElementById("driver-tele-speed");
        const accEl = document.getElementById("driver-tele-accuracy");
        const headEl = document.getElementById("driver-tele-heading");
        const countEl = document.getElementById("driver-tele-count");
        const latEl = document.getElementById("driver-tele-lat");
        const lngEl = document.getElementById("driver-tele-lng");

        if (speedEl) speedEl.innerHTML = `${this.currentLocation.speed} <small>km/h</small>`;
        if (accEl) accEl.innerHTML = `± ${this.currentLocation.accuracy} <small>m</small>`;
        if (headEl) headEl.textContent = `${this.currentLocation.heading}°`;
        if (countEl) countEl.textContent = this.updateCount;
        if (latEl) latEl.textContent = this.currentLocation.lat.toFixed(5);
        if (lngEl) lngEl.textContent = this.currentLocation.lng.toFixed(5);
    }
};

// Global helper wrappers
function onDriverBusSelect() {
    const sel = document.getElementById("driver-bus-select");
    BU_DRIVER.activeBusId = sel.value;
    BU_DRIVER.syncRouteFromBus();
}

function startDriverTrip() {
    BU_DRIVER.startTrip();
}

function stopDriverTrip() {
    BU_DRIVER.stopTrip();
}

function setDriverMode(isSim) {
    BU_DRIVER.setMode(isSim);
}

function toggleDriverMode() {
    const isSim = document.getElementById("driver-sim-toggle")?.checked || false;
    BU_DRIVER.setMode(isSim);
}

function updateSimSpeed(val) {
    BU_DRIVER.simSpeedKmh = parseInt(val);
    const label = document.getElementById("sim-speed-label");
    if (label) label.textContent = `${val} km/h`;
}

function copyMobileUrl() {
    const urlEl = document.getElementById("mobile-server-url");
    const btn = document.getElementById("btn-copy-url");
    if (!urlEl) return;
    const text = urlEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
        if (btn) {
            const old = btn.textContent;
            btn.textContent = "✓ Copied!";
            btn.style.color = "#16A34A";
            setTimeout(() => {
                btn.textContent = old;
                btn.style.color = "";
            }, 2000);
        }
    }).catch(() => {
        prompt("Copy mobile URL to use on phone:", text);
    });
}

function copyLiveUrl() {
    const urlEl = document.getElementById("mobile-live-url");
    const btn = document.getElementById("btn-copy-live-url");
    if (!urlEl) return;
    const text = urlEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
        if (btn) {
            const old = btn.textContent;
            btn.textContent = "✓ Copied!";
            btn.style.color = "#16A34A";
            setTimeout(() => {
                btn.textContent = old;
                btn.style.color = "";
            }, 2000);
        }
    }).catch(() => {
        prompt("Copy Live HTTPS URL to open on your phone:", text);
    });
}

