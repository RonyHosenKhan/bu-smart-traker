// Driver GPS Cockpit & Real-time Location Broadcaster
// Supports multiple concurrent driver trips across all routes (Simulation & Real Device GPS)
// Broadcasts in real-time across same-device tabs, local/cloud REST API, and cloud pub/sub

const BU_DRIVER = {
    activeBusId: "BUS_BRTC_04",
    activeRouteId: "ROUTE_01",
    isSimMode: false, // Default to REAL DEVICE GPS
    simSpeedKmh: 35,
    activeTrips: {}, // Map of busId -> TripState

    // Multi-tab / multi-device communication channel
    channel: (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('BU_BUS_CHANNEL') : null,

    init: function () {
        this.populateDriverBuses();
        this.syncRouteFromBus();
        this.fetchServerInfo();
        this.syncPublicUrl();
        this.updateTripButtonsUI();
        this.renderActiveTripsList();
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
        fetch('/api/info')
            .then(res => res.json())
            .then(info => {
                if (info && info.mobileUrl) {
                    const el = document.getElementById("mobile-server-url");
                    if (el) el.textContent = info.mobileUrl;
                }
            })
            .catch(() => {});
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
        }
        this.updateTripButtonsUI();
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
    },

    startTrip: function () {
        this.startTripForBus(this.activeBusId, this.isSimMode);
    },

    stopTrip: function () {
        this.stopTripForBus(this.activeBusId);
    },

    startTripForBus: function (busId, isSim) {
        if (!busId) busId = this.activeBusId;
        if (typeof isSim === 'undefined') isSim = this.isSimMode;

        // If this bus is already running, do nothing
        if (this.activeTrips[busId]) return;

        const bus = BU_ROUTES_DATA.buses.find(b => b.id === busId);
        const routeId = bus ? bus.routeId : "ROUTE_01";
        const route = BU_ROUTES_DATA.routes.find(r => r.id === routeId);

        // Build route waypoints for simulation
        let waypoints = [];
        if (route && route.roadPath && route.roadPath.length > 0) {
            for (let i = 0; i < route.roadPath.length; i += 4) {
                waypoints.push({ lat: route.roadPath[i][0], lng: route.roadPath[i][1] });
            }
            const last = route.roadPath[route.roadPath.length - 1];
            waypoints.push({ lat: last[0], lng: last[1] });
        } else if (route) {
            waypoints = route.stopIds.map(id => {
                const stop = BU_ROUTES_DATA.stops[id];
                return { lat: stop.lat, lng: stop.lng, name: stop.nameEn };
            });
        }

        const startLat = (waypoints.length > 0) ? waypoints[0].lat : 22.6850;
        const startLng = (waypoints.length > 0) ? waypoints[0].lng : 90.3620;

        const trip = {
            busId: busId,
            routeId: routeId,
            driverName: bus ? bus.driver : "Driver",
            busName: bus ? bus.name : busId,
            isSim: isSim,
            simIntervalId: null,
            watchId: null,
            lastGpsPoint: null,
            updateCount: 0,
            simState: {
                waypointIndex: 0,
                progressT: 0.0,
                waypoints: waypoints
            },
            currentLocation: {
                busId: busId,
                routeId: routeId,
                driverName: bus ? bus.driver : "Driver",
                lat: startLat,
                lng: startLng,
                speed: isSim ? this.simSpeedKmh : 0,
                accuracy: 6,
                heading: 0,
                timestamp: Date.now(),
                trackingStatus: "ACTIVE",
                source: isSim ? "SIMULATION" : "HARDWARE_GPS"
            }
        };

        this.activeTrips[busId] = trip;

        if (isSim) {
            this.startSimulationForTrip(trip);
        } else {
            this.startHardwareGpsForTrip(trip);
        }

        // Broadcast initial position
        this.broadcastLocationForTrip(trip);
        this.updateTripButtonsUI();
        this.renderActiveTripsList();
    },

    stopTripForBus: function (busId) {
        if (!busId) busId = this.activeBusId;
        const trip = this.activeTrips[busId];
        if (!trip) return;

        if (trip.simIntervalId) clearInterval(trip.simIntervalId);
        if (trip.watchId) navigator.geolocation.clearWatch(trip.watchId);

        delete this.activeTrips[busId];

        const stopPayload = {
            busId: busId,
            routeId: trip.routeId,
            trackingStatus: "STOPPED",
            isStopped: true,
            timestamp: Date.now(),
            speed: 0
        };

        this.broadcastStop(stopPayload);
        this.updateTripButtonsUI();
        this.renderActiveTripsList();
    },

    startAllRoutesSim: function () {
        // Launch 1 bus on each of the 3 University routes simultaneously
        this.startTripForBus("BUS_BRTC_04", true);   // Route 1 (Barishal Club)
        this.startTripForBus("BUS_SUGANDHA", true);  // Route 2 (Natun Bazar)
        this.startTripForBus("BUS_BRTC_07", true);   // Route 3 (Nathullabad)
        this.updateTripButtonsUI();
        this.renderActiveTripsList();
    },

    stopAllTrips: function () {
        const ids = Object.keys(this.activeTrips);
        ids.forEach(id => this.stopTripForBus(id));
        this.updateTripButtonsUI();
        this.renderActiveTripsList();
    },

    startSimulationForTrip: function (trip) {
        trip.simIntervalId = setInterval(() => {
            if (!this.activeTrips[trip.busId]) {
                clearInterval(trip.simIntervalId);
                return;
            }
            this.stepSimulationForTrip(trip);
        }, 2000);
    },

    stepSimulationForTrip: function (trip) {
        const wps = trip.simState.waypoints;
        if (wps.length < 2) return;

        let curIdx = trip.simState.waypointIndex;
        let nextIdx = (curIdx + 1) % wps.length;

        const p1 = wps[curIdx];
        const p2 = wps[nextIdx];

        const stepSize = (this.simSpeedKmh / 35.0) * 0.12;
        trip.simState.progressT += stepSize;

        if (trip.simState.progressT >= 1.0) {
            trip.simState.progressT = 0.0;
            trip.simState.waypointIndex = nextIdx;
            if (nextIdx === wps.length - 1) {
                trip.currentLocation.speed = 0;
            }
        }

        const t = trip.simState.progressT;
        const lat = p1.lat + (p2.lat - p1.lat) * t;
        const lng = p1.lng + (p2.lng - p1.lng) * t;

        const y = Math.sin((p2.lng - p1.lng) * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180);
        const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180) -
                  Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos((p2.lng - p1.lng) * Math.PI / 180);
        let heading = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

        trip.currentLocation = {
            busId: trip.busId,
            routeId: trip.routeId,
            driverName: trip.driverName,
            lat: lat,
            lng: lng,
            speed: Math.max(5, Math.round(this.simSpeedKmh + (Math.random() * 6 - 3))),
            accuracy: Math.round(5 + Math.random() * 4),
            heading: Math.round(heading),
            timestamp: Date.now(),
            trackingStatus: "ACTIVE",
            source: "SIMULATION"
        };

        trip.updateCount++;
        this.broadcastLocationForTrip(trip);

        if (this.activeBusId === trip.busId) {
            this.updateTelemetryUI(trip.currentLocation);
        }
    },

    startHardwareGpsForTrip: function (trip) {
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser. Falling back to simulation mode.");
            trip.isSim = true;
            this.startSimulationForTrip(trip);
            return;
        }

        const options = {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 1000
        };

        trip.watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const curLat = pos.coords.latitude;
                const curLng = pos.coords.longitude;
                const curTime = Date.now();

                let speedKmh = 0;
                if (pos.coords.speed !== null && !isNaN(pos.coords.speed) && pos.coords.speed > 0) {
                    speedKmh = Math.round(pos.coords.speed * 3.6);
                } else if (trip.lastGpsPoint) {
                    const distKm = BU_ETA.haversineDistance(trip.lastGpsPoint.lat, trip.lastGpsPoint.lng, curLat, curLng);
                    const timeDeltaHr = (curTime - trip.lastGpsPoint.time) / 3600000;
                    if (timeDeltaHr > 0.0001) {
                        const calculatedSpeed = Math.round(distKm / timeDeltaHr);
                        if (calculatedSpeed < 120) {
                            speedKmh = calculatedSpeed;
                        }
                    }
                }

                let headingDeg = 0;
                if (pos.coords.heading !== null && !isNaN(pos.coords.heading) && pos.coords.heading > 0) {
                    headingDeg = Math.round(pos.coords.heading);
                } else if (trip.lastGpsPoint) {
                    const p1 = trip.lastGpsPoint;
                    const p2 = { lat: curLat, lng: curLng };
                    const distM = BU_ETA.haversineDistance(p1.lat, p1.lng, p2.lat, p2.lng) * 1000;
                    if (distM > 2.5) {
                        const y = Math.sin((p2.lng - p1.lng) * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180);
                        const x = Math.cos(p1.lat * Math.PI / 180) * Math.sin(p2.lat * Math.PI / 180) -
                                  Math.sin(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.cos((p2.lng - p1.lng) * Math.PI / 180);
                        headingDeg = Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
                    } else {
                        headingDeg = trip.currentLocation.heading || 0;
                    }
                }

                trip.lastGpsPoint = { lat: curLat, lng: curLng, time: curTime };

                trip.currentLocation = {
                    busId: trip.busId,
                    routeId: trip.routeId,
                    driverName: trip.driverName,
                    lat: curLat,
                    lng: curLng,
                    speed: speedKmh,
                    accuracy: Math.round(pos.coords.accuracy || 6),
                    heading: headingDeg,
                    timestamp: curTime,
                    trackingStatus: "ACTIVE",
                    source: "HARDWARE_GPS"
                };

                trip.updateCount++;
                this.broadcastLocationForTrip(trip);

                if (this.activeBusId === trip.busId) {
                    this.updateTelemetryUI(trip.currentLocation);
                }
            },
            (err) => {
                console.warn("Hardware GPS Warning:", err.message);
            },
            options
        );
    },

    broadcastLocationForTrip: function (trip) {
        const payload = JSON.stringify(trip.currentLocation);

        // 1. Same-device multi-tab BroadcastChannel
        try {
            if (this.channel) {
                this.channel.postMessage({
                    type: "BUS_LOCATION_UPDATE",
                    busId: trip.busId,
                    data: trip.currentLocation
                });
            }
        } catch (e) {}

        // 2. Storage event
        try {
            localStorage.setItem(`BU_LIVE_LOCATION_${trip.busId}`, payload);
            localStorage.setItem("BU_LATEST_LOCATION_UPDATE", payload);
        } catch (e) {}

        // 3. Local/Cloud Python Server REST API
        try {
            fetch('/api/location', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).catch(() => {});
        } catch (e) {}

        // 4. Free Cloud Pub/Sub relay (ntfy.sh)
        try {
            fetch(`https://ntfy.sh/bu_bus_live_all`, {
                method: 'POST',
                body: payload
            }).catch(() => {});
            fetch(`https://ntfy.sh/bu_bus_live_${trip.busId}`, {
                method: 'POST',
                body: payload
            }).catch(() => {});
        } catch (e) {}

        // 5. Update local student engine immediately
        if (window.BU_STUDENT && typeof window.BU_STUDENT.onLiveLocationReceived === 'function') {
            window.BU_STUDENT.onLiveLocationReceived(trip.currentLocation);
        }
    },

    broadcastStop: function (stopPayload) {
        const payload = JSON.stringify(stopPayload);

        // 1. Multi-tab BroadcastChannel
        try {
            if (this.channel) {
                this.channel.postMessage({
                    type: "BUS_STOP_TRIP",
                    busId: stopPayload.busId,
                    data: stopPayload
                });
            }
        } catch (e) {}

        // 2. Storage event
        try {
            localStorage.removeItem(`BU_LIVE_LOCATION_${stopPayload.busId}`);
            localStorage.setItem("BU_BUS_STOPPED_EVENT", payload);
        } catch (e) {}

        // 3. Local & Cloud Server REST API
        try {
            fetch('/api/location', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).catch(() => {});

            fetch(`/api/location?busId=${stopPayload.busId}`, {
                method: 'DELETE'
            }).catch(() => {});
        } catch (e) {}

        // 4. Cloud Pub/Sub relay
        try {
            fetch(`https://ntfy.sh/bu_bus_live_all`, {
                method: 'POST',
                body: payload
            }).catch(() => {});
            fetch(`https://ntfy.sh/bu_bus_live_${stopPayload.busId}`, {
                method: 'POST',
                body: payload
            }).catch(() => {});
        } catch (e) {}

        // 5. Update local student engine immediately
        if (window.BU_STUDENT && typeof window.BU_STUDENT.onBusStopped === 'function') {
            window.BU_STUDENT.onBusStopped(stopPayload.busId);
        }
    },

    updateTripButtonsUI: function () {
        const isRunning = !!this.activeTrips[this.activeBusId];
        const btnStart = document.getElementById("btn-start-trip");
        const btnStop = document.getElementById("btn-stop-trip");
        const badge = document.getElementById("driver-trip-badge");
        const livePill = document.getElementById("driver-live-indicator");
        const mobBadge = document.getElementById("mob-driver-live-badge");

        if (btnStart) btnStart.disabled = isRunning;
        if (btnStop) btnStop.disabled = !isRunning;

        if (badge) {
            if (isRunning) {
                const trip = this.activeTrips[this.activeBusId];
                badge.textContent = trip.isSim ? "SIMULATING LIVE" : "LIVE GPS ACTIVE";
                badge.className = "badge status-active";
            } else {
                badge.textContent = "IDLE / STOPPED";
                badge.className = "badge status-offline";
            }
        }

        const activeCount = Object.keys(this.activeTrips).length;
        if (livePill) livePill.style.display = activeCount > 0 ? "inline-block" : "none";
        if (mobBadge) mobBadge.style.display = activeCount > 0 ? "inline-block" : "none";

        if (isRunning && this.activeTrips[this.activeBusId]) {
            this.updateTelemetryUI(this.activeTrips[this.activeBusId].currentLocation);
        }
    },

    renderActiveTripsList: function () {
        const countBadge = document.getElementById("active-trips-count-badge");
        const container = document.getElementById("active-trips-list");
        const trips = Object.values(this.activeTrips);

        if (countBadge) {
            countBadge.textContent = `${trips.length} Active Bus${trips.length === 1 ? '' : 'es'}`;
            countBadge.className = trips.length > 0 ? "badge status-active" : "badge status-offline";
        }

        if (!container) return;

        if (trips.length === 0) {
            container.innerHTML = `<span style="color:#64748b; font-style:italic;">কোনো বাস বর্তমানে রানিং নেই (No buses running)</span>`;
            return;
        }

        let html = '';
        trips.forEach(t => {
            const bus = BU_ROUTES_DATA.buses.find(b => b.id === t.busId);
            const route = BU_ROUTES_DATA.routes.find(r => r.id === t.routeId);
            const routeColor = route ? route.color : "#0B57D0";
            const busName = bus ? bus.name : t.busId;

            html += `
                <div style="display:flex; justify-content:space-between; align-items:center; background:#F8FAFC; padding:4px 8px; border-radius:6px; border-left:3px solid ${routeColor}; margin-bottom:4px;">
                    <div>
                        <b style="color:#0F172A; font-size:0.78rem;">🚍 ${busName}</b>
                        <span style="font-size:0.7rem; color:#64748B;">(${t.isSim ? 'Sim' : 'GPS'} • ${t.currentLocation.speed || 0} km/h)</span>
                    </div>
                    <button class="btn btn-xs btn-danger" style="padding:2px 6px; font-size:0.7rem;" onclick="BU_DRIVER.stopTripForBus('${t.busId}')">
                        🛑 Stop
                    </button>
                </div>
            `;
        });
        container.innerHTML = html;
    },

    updateTelemetryUI: function (loc) {
        if (!loc) loc = this.activeTrips[this.activeBusId]?.currentLocation || { speed: 0, accuracy: 0, heading: 0, lat: 0, lng: 0 };
        const trip = this.activeTrips[this.activeBusId];

        const speedEl = document.getElementById("driver-tele-speed");
        const accEl = document.getElementById("driver-tele-accuracy");
        const headEl = document.getElementById("driver-tele-heading");
        const countEl = document.getElementById("driver-tele-count");
        const latEl = document.getElementById("driver-tele-lat");
        const lngEl = document.getElementById("driver-tele-lng");

        if (speedEl) speedEl.innerHTML = `${loc.speed || 0} <small>km/h</small>`;
        if (accEl) accEl.innerHTML = `± ${loc.accuracy || 0} <small>m</small>`;
        if (headEl) headEl.textContent = `${loc.heading || 0}°`;
        if (countEl) countEl.textContent = trip ? trip.updateCount : 0;
        if (latEl && loc.lat) latEl.textContent = loc.lat.toFixed(5);
        if (lngEl && loc.lng) lngEl.textContent = loc.lng.toFixed(5);
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
