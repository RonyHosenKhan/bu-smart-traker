// Student Live Map & Real-time Tracking Engine
// Renders vector map, route polyline, stop markers, live bus, student pin, and calculates real-time ETA

const BU_STUDENT = {
    map: null,
    selectedRouteId: "ROUTE_01",
    selectedBusId: "BUS_BRTC_04",
    selectedTargetStopId: null,

    // Markers and layers
    routePolylineLayer: null,
    stopMarkersLayer: null,
    busMarkers: {}, // Map of busId -> L.marker
    activeBuses: {}, // Map of busId -> locationData
    studentMarker: null,
    studentAccuracyCircle: null,
    cloudEventSource: null,
    pollIntervalId: null,

    // Current student coordinate (default near Rupatali Housing for realistic testing)
    studentLocation: {
        lat: 22.6865,
        lng: 90.3570,
        isLocated: false
    },

    // Latest bus location received for the currently selected bus
    latestBusLocation: null,

    init: function () {
        this.initMap();
        this.populateRoutesAndBuses();
        this.renderSelectedRoute();
        this.listenForBroadcasts();

        // Check for pre-existing active locations in storage for all buses
        if (typeof BU_ROUTES_DATA !== 'undefined' && BU_ROUTES_DATA.buses) {
            BU_ROUTES_DATA.buses.forEach(b => {
                const stored = localStorage.getItem(`BU_LIVE_LOCATION_${b.id}`);
                if (stored) {
                    try {
                        const parsed = JSON.parse(stored);
                        if (parsed && parsed.trackingStatus !== 'STOPPED' && !parsed.isStopped && (Date.now() - (parsed.timestamp || 0) < 60000)) {
                            this.onLiveLocationReceived(parsed);
                        }
                    } catch (e) { }
                }
            });
        }

        // Fetch immediately from local / cloud server API
        this.pollServerLocation();

        // Continuous server API polling every 1.5 seconds for multi-device updates
        this.pollIntervalId = setInterval(() => this.pollServerLocation(), 1500);

        // Start Cloud SSE stream for cross-internet mobile tracking
        this.initCloudSseStream();

        // Periodic ticker to check if bus location has become STALE or OFFLINE
        setInterval(() => this.updateStatusAndEta(), 1500);

        // Periodic ticker to clean up any bus that stopped or timed out (> 60s)
        setInterval(() => this.cleanupStaleBuses(), 3000);
    },

    initMap: function () {
        // Center on Barishal city & University of Barishal
        const buCenter = [22.6850, 90.3620];
        this.map = L.map('map', {
            center: buCenter,
            zoom: 14,
            zoomControl: false
        });

        // Add sleek zoom control at bottom right
        L.control.zoom({ position: 'bottomright' }).addTo(this.map);

        // OpenStreetMap Tile Layer
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors | University of Barishal'
        }).addTo(this.map);

        this.routePolylineLayer = L.layerGroup().addTo(this.map);
        this.stopMarkersLayer = L.layerGroup().addTo(this.map);
        this.manualPinLayer = L.layerGroup().addTo(this.map);

        // Allow student to click on the map to set their location & populate manual inputs
        this.map.on('click', (e) => {
            if (window.adminCoordinatePickerActive) return;
            const lat = e.latlng.lat;
            const lng = e.latlng.lng;
            const latInput = document.getElementById("input-manual-lat");
            const lngInput = document.getElementById("input-manual-lng");
            if (latInput) latInput.value = lat.toFixed(5);
            if (lngInput) lngInput.value = lng.toFixed(5);
            this.setStudentLocation(lat, lng, true);
            this.updateManualResultBox(lat, lng);
        });

        // Add initial draggable student marker
        this.addStudentMarker(this.studentLocation.lat, this.studentLocation.lng);
    },

    populateRoutesAndBuses: function () {
        const routeSelect = document.getElementById("student-route-select");
        if (!routeSelect) return;
        routeSelect.innerHTML = "";

        BU_ROUTES_DATA.routes.forEach(r => {
            const opt = document.createElement("option");
            opt.value = r.id;
            opt.textContent = `${r.nameEn} — ${r.nameBn}`;
            routeSelect.appendChild(opt);
        });
        routeSelect.value = this.selectedRouteId;

        this.updateBusDropdownForRoute();
    },

    updateBusDropdownForRoute: function () {
        const busSelect = document.getElementById("student-bus-select");
        if (!busSelect) return;
        busSelect.innerHTML = "";

        const matchingBuses = BU_ROUTES_DATA.buses.filter(b => b.routeId === this.selectedRouteId);
        matchingBuses.forEach(b => {
            const opt = document.createElement("option");
            opt.value = b.id;
            opt.textContent = `${b.name} (${b.status})`;
            busSelect.appendChild(opt);
        });

        if (matchingBuses.length > 0) {
            this.selectedBusId = matchingBuses[0].id;
            busSelect.value = this.selectedBusId;
        }

        this.updateCardInfo();
    },

    renderSelectedRoute: function () {
        const route = BU_ROUTES_DATA.routes.find(r => r.id === this.selectedRouteId);
        if (!route) return;

        this.routePolylineLayer.clearLayers();
        this.stopMarkersLayer.clearLayers();

        const latLngs = [];
        const stopsList = [];

        route.stopIds.forEach((stopId, index) => {
            const stop = BU_ROUTES_DATA.stops[stopId];
            if (stop && stop.lat && stop.lng) {
                const point = [stop.lat, stop.lng];
                latLngs.push(point);
                stopsList.push({ ...stop, sequence: index + 1 });

                // Custom stop marker matching Google Maps style
                const isBU = (stopId === "STOP_BU");
                const isStart = (index === 0);
                let pinClass = "stop-marker-icon";
                let label = `${index + 1}`;
                if (isBU) {
                    pinClass += " dest-pin";
                    label = "🏛️";
                } else if (isStart) {
                    pinClass += " start-pin";
                    label = "A";
                }

                const stopIcon = L.divIcon({
                    className: 'custom-stop-div',
                    html: `<div class="${pinClass}" style="border-color: ${route.color};">${label}</div>`,
                    iconSize: [28, 28],
                    iconAnchor: [14, 14]
                });

                const marker = L.marker(point, { icon: stopIcon });
                const statusBadge = stop.coordinatesReady
                    ? `<span class="coord-status-pill verified">✓ GPS Verified</span>`
                    : `<span class="coord-status-pill unverified">⚠ Coordinates Unverified</span>`;

                marker.bindPopup(`
                    <div style="font-family:'Outfit',sans-serif; min-width: 170px;">
                        <b style="font-family:'Hind Siliguri'; font-size: 1.05rem; color:#0F4C81;">${stop.nameBn}</b><br>
                        <span style="font-size:0.85rem; color:#475569;">${stop.nameEn}</span><br>
                        <span style="font-size:0.75rem; color:#64748B;">Stop #${index + 1} of ${route.stopIds.length}</span><br>
                        ${statusBadge}<br>
                        <button onclick="BU_STUDENT.setTargetStop('${stop.id}')" style="margin-top:8px; padding:4px 8px; font-size:0.75rem; background:#0F4C81; color:white; border:none; border-radius:4px; cursor:pointer;">
                            Calculate ETA to Here
                        </button>
                    </div>
                `);

                this.stopMarkersLayer.addLayer(marker);
            }
        });

        // Draw background subtle lines for other active university routes
        if (typeof BU_ROUTES_DATA !== 'undefined' && BU_ROUTES_DATA.routes) {
            BU_ROUTES_DATA.routes.forEach(r => {
                if (r.id !== this.selectedRouteId) {
                    const otherPoints = (r.roadPath && r.roadPath.length > 0)
                        ? r.roadPath
                        : r.stopIds.map(id => [BU_ROUTES_DATA.stops[id].lat, BU_ROUTES_DATA.stops[id].lng]);
                    if (otherPoints && otherPoints.length > 1) {
                        const bgLine = L.polyline(otherPoints, {
                            color: r.color || '#94a3b8',
                            weight: 3.5,
                            opacity: 0.35,
                            dashArray: '6, 6',
                            lineJoin: 'round',
                            lineCap: 'round'
                        });
                        this.routePolylineLayer.addLayer(bgLine);
                    }
                }
            });
        }

        // Draw Selected Route Polyline with sleek Google Maps dual-layer styling
        const pathPoints = (route.roadPath && route.roadPath.length > 0) ? route.roadPath : latLngs;
        if (pathPoints.length > 1) {
            const casing = L.polyline(pathPoints, {
                color: '#FFFFFF',
                weight: 9,
                opacity: 0.85,
                lineJoin: 'round',
                lineCap: 'round'
            });
            this.routePolylineLayer.addLayer(casing);

            const polyline = L.polyline(pathPoints, {
                color: route.color,
                weight: 5,
                opacity: 0.95,
                lineJoin: 'round',
                lineCap: 'round'
            });
            this.routePolylineLayer.addLayer(polyline);
        }

        // Auto-fit bounds so the full route is instantly visible on screen
        this.fitBounds();

        // Update Legend
        document.getElementById("legend-route-title").textContent = `${route.nameEn} (${route.nameBn})`;
        document.getElementById("legend-route-color").style.backgroundColor = route.color;
        document.getElementById("legend-stops-info").textContent = `${route.stopIds.length} Ordered Stops`;
        document.getElementById("legend-distance-info").textContent = `~${route.distanceKm || '7.5'} km (${route.estDurationMin || 20} min)`;

        const gmapsLink = document.getElementById("legend-gmaps-link");
        if (gmapsLink && route.googleMapsUrl) {
            gmapsLink.href = route.googleMapsUrl;
            gmapsLink.style.display = "inline-flex";
        }

        // Render Schedule Table
        this.renderRouteSchedule(route);

        // Render Sidebar Stops Accordion
        this.renderStopsTimeline(stopsList);
    },

    renderStopsTimeline: function (stops) {
        const container = document.getElementById("stops-timeline-list");
        const countSpan = document.getElementById("stops-count");
        if (!container) return;

        countSpan.textContent = stops.length;
        container.innerHTML = "";

        stops.forEach((s) => {
            const isTarget = (this.selectedTargetStopId === s.id);
            const item = document.createElement("div");
            item.className = `stop-item ${isTarget ? 'active-target' : ''}`;
            item.onclick = () => this.setTargetStop(s.id);

            item.innerHTML = `
                <div class="stop-badge">${s.sequence}</div>
                <div class="stop-details">
                    <span class="stop-name-bn">${s.nameBn}</span>
                    <span class="stop-name-en">${s.nameEn}</span>
                    <span class="coord-status-pill ${s.coordinatesReady ? 'verified' : 'unverified'}">
                        ${s.coordinatesReady ? 'Verified Coords' : 'Survey Pending'}
                    </span>
                </div>
            `;
            container.appendChild(item);
        });
    },

    setTargetStop: function (stopId) {
        this.selectedTargetStopId = stopId;
        const stop = BU_ROUTES_DATA.stops[stopId];
        if (stop) {
            document.getElementById("eta-target-name").textContent = `${stop.nameBn} (Stop #${stop.sequence || ''})`;
        }
        this.renderSelectedRoute();
        this.updateStatusAndEta();
    },

    addStudentMarker: function (lat, lng) {
        if (this.studentMarker) {
            this.studentMarker.setLatLng([lat, lng]);
            return;
        }

        const studentIcon = L.divIcon({
            className: 'custom-student-div',
            html: `<div class="student-marker-icon">👤</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });

        this.studentMarker = L.marker([lat, lng], {
            icon: studentIcon,
            draggable: true
        }).addTo(this.map);

        this.studentMarker.bindTooltip("You (Student) — Drag me anywhere!", {
            permanent: false,
            direction: 'top'
        });

        this.studentMarker.on('dragend', (e) => {
            const pos = e.target.getLatLng();
            this.setStudentLocation(pos.lat, pos.lng, true);
        });
    },

    setStudentLocation: function (lat, lng, isUserAction = false) {
        this.studentLocation.lat = lat;
        this.studentLocation.lng = lng;
        this.studentLocation.isLocated = true;
        this.addStudentMarker(lat, lng);

        const statusLabel = document.getElementById("student-loc-status");
        if (statusLabel) {
            statusLabel.textContent = `Location set: [${lat.toFixed(4)}, ${lng.toFixed(4)}]`;
        }

        if (isUserAction && !this.selectedTargetStopId) {
            document.getElementById("eta-target-name").textContent = "Your Live Location";
        }

        this.updateStatusAndEta();
    },

    locateStudentBrowser: function () {
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser.");
            return;
        }

        const statusLabel = document.getElementById("student-loc-status");
        if (statusLabel) {
            statusLabel.innerHTML = `🛰️ <i>Acquiring high-accuracy GPS... (জিপিএস লোকেশন খোঁজা হচ্ছে)</i>`;
        }

        // Tier 1: Try High-Accuracy Hardware GPS first (timeout: 5s)
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                this.onStudentGpsSuccess(pos);
            },
            (errHigh) => {
                console.warn("High-accuracy GPS timed out/failed, trying standard network location:", errHigh.message);
                if (statusLabel) {
                    statusLabel.innerHTML = `📡 <i>Retrying with standard network location...</i>`;
                }

                // Tier 2: Fallback to standard/network accuracy
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        this.onStudentGpsSuccess(pos);
                    },
                    (errLow) => {
                        console.warn("Standard accuracy GPS failed:", errLow.message);
                        if (statusLabel) {
                            statusLabel.innerHTML = `<span style="color:#DC2626; font-weight:600;">⚠️ GPS unavailable on this device. Click on map or choose a Preset!</span>`;
                        }

                        // Open manual GPS card to assist user immediately
                        const card = document.getElementById("manual-gps-box");
                        if (card) card.style.display = "block";

                        alert("⚠️ Could not detect GPS location on this device (common on desktop/laptops without GPS hardware).\n\nPlease click anywhere on the map or use the 'Manual GPS Locator' presets to set your location!\n\n(ডেস্কটপে জিপিএস না থাকলে ম্যাপে যেখানে ইচ্ছা ক্লিক করে বা প্রিসেট থেকে আপনার অবস্থান নির্বাচন করুন)");
                    },
                    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
                );
            },
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
        );
    },

    onStudentGpsSuccess: function (pos) {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const acc = Math.round(pos.coords.accuracy || 10);

        this.setStudentLocation(lat, lng, true);

        // Visual GPS accuracy circle
        if (this.studentAccuracyCircle) {
            this.studentAccuracyCircle.setLatLng([lat, lng]);
            this.studentAccuracyCircle.setRadius(acc);
        } else {
            this.studentAccuracyCircle = L.circle([lat, lng], {
                radius: acc,
                color: '#0B57D0',
                weight: 1.5,
                fillColor: '#3B82F6',
                fillOpacity: 0.15
            }).addTo(this.map);
        }

        // Update manual GPS inputs
        const latInput = document.getElementById("input-manual-lat");
        const lngInput = document.getElementById("input-manual-lng");
        if (latInput) latInput.value = lat.toFixed(5);
        if (lngInput) lngInput.value = lng.toFixed(5);

        this.map.flyTo([lat, lng], 16, { duration: 1.2 });

        const statusLabel = document.getElementById("student-loc-status");
        if (statusLabel) {
            statusLabel.innerHTML = `<span style="color:#16A34A; font-weight:600;">✓ Live GPS Acquired: [${lat.toFixed(5)}, ${lng.toFixed(5)}] (±${acc}m)</span>`;
        }

        this.updateManualResultBox(lat, lng);
    },

    listenForBroadcasts: function () {
        // 1. Multi-tab sync via BroadcastChannel (instant in same browser)
        if (typeof BroadcastChannel !== 'undefined') {
            const channel = new BroadcastChannel('BU_BUS_CHANNEL');
            channel.onmessage = (event) => {
                if (!event.data) return;
                if (event.data.type === "BUS_STOP_TRIP" && event.data.busId) {
                    this.removeBusMarker(event.data.busId);
                } else if (event.data.type === "BUS_LOCATION_UPDATE" && event.data.data) {
                    this.onLiveLocationReceived(event.data.data);
                }
            };
        }

        // 2. Storage event listener fallback (same origin tabs)
        window.addEventListener('storage', (e) => {
            if (e.key === "BU_BUS_STOPPED_EVENT" && e.newValue) {
                try {
                    const stopped = JSON.parse(e.newValue);
                    if (stopped && stopped.busId) {
                        this.removeBusMarker(stopped.busId);
                    }
                } catch (err) { }
            } else if (e.key === "BU_LATEST_LOCATION_UPDATE" && e.newValue) {
                try {
                    const loc = JSON.parse(e.newValue);
                    if (loc && loc.busId) {
                        if (loc.trackingStatus === "STOPPED" || loc.isStopped) {
                            this.removeBusMarker(loc.busId);
                        } else {
                            this.onLiveLocationReceived(loc);
                        }
                    }
                } catch (err) { }
            }
        });
    },

    pollServerLocation: function () {
        fetch(BU_API.url('/api/location'))
            .then(res => res.json())
            .then(data => {
                if (!data || typeof data !== 'object') return;

                const busesMap = data.busId ? { [data.busId]: data } : data;
                const activeServerIds = new Set();

                for (const [busId, loc] of Object.entries(busesMap)) {
                    if (loc && loc.lat && loc.lng) {
                        if (loc.trackingStatus === 'STOPPED' || loc.isStopped) {
                            this.removeBusMarker(busId);
                        } else {
                            activeServerIds.add(busId);
                            this.onLiveLocationReceived(loc);
                        }
                    }
                }

                // Any bus marker currently on map that is no longer returned as active by server should be erased
                // ONLY IF it hasn't received any local/pubsub update in > 45 seconds or was explicitly marked stopped
                for (const localBusId in this.busMarkers) {
                    if (!activeServerIds.has(localBusId)) {
                        const localBus = this.activeBuses[localBusId];
                        const lastTime = localBus ? (localBus.timestamp || 0) : 0;
                        if (Date.now() - lastTime > 45000) {
                            this.removeBusMarker(localBusId);
                        }
                    }
                }
            })
            .catch(() => { });
    },

    initCloudSseStream: function () {
        try {
            if (this.cloudEventSource) {
                this.cloudEventSource.close();
            }
            // Listen to global multi-bus SSE stream
            const sseUrl = `https://ntfy.sh/bu_bus_live_all/sse`;
            this.cloudEventSource = new EventSource(sseUrl);
            this.cloudEventSource.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    const payload = data.message ? JSON.parse(data.message) : data;
                    if (payload && payload.busId) {
                        if (payload.trackingStatus === "STOPPED" || payload.isStopped) {
                            this.removeBusMarker(payload.busId);
                        } else {
                            this.onLiveLocationReceived(payload);
                        }
                    }
                } catch (err) { }
            };
        } catch (e) { }
    },

    removeBusMarker: function (busId) {
        if (!busId) return;
        if (this.busMarkers[busId]) {
            this.map.removeLayer(this.busMarkers[busId]);
            delete this.busMarkers[busId];
        }
        delete this.activeBuses[busId];
        try {
            localStorage.removeItem(`BU_LIVE_LOCATION_${busId}`);
        } catch (e) { }

        if (this.selectedBusId === busId) {
            this.latestBusLocation = null;
            this.updateStatusAndEta();
            this.updateCardInfo();
        }
    },

    onBusStopped: function (busId) {
        this.removeBusMarker(busId);
    },

    cleanupStaleBuses: function () {
        const now = Date.now();
        for (const busId in this.activeBuses) {
            const loc = this.activeBuses[busId];
            if (!loc || loc.trackingStatus === 'STOPPED' || loc.isStopped || (now - (loc.timestamp || 0) > 60000)) {
                this.removeBusMarker(busId);
            }
        }
    },

    onLiveLocationReceived: function (loc) {
        if (!loc || !loc.busId) return;

        if (loc.trackingStatus === "STOPPED" || loc.isStopped) {
            this.removeBusMarker(loc.busId);
            return;
        }

        // Save into active buses map
        this.activeBuses[loc.busId] = loc;

        // Render or update car/bus marker on map
        this.updateBusMarkerOnMap(loc);

        // If this matches the selected bus, update telemetry card and live ETA
        if (loc.busId === this.selectedBusId) {
            this.latestBusLocation = loc;
            this.updateCardInfo();
            this.updateStatusAndEta();
        }
    },

    updateBusMarkerOnMap: function (loc) {
        if (!loc || !loc.lat || !loc.lng) return;
        const pos = [loc.lat, loc.lng];

        const bus = BU_ROUTES_DATA.buses.find(b => b.id === loc.busId);
        const route = BU_ROUTES_DATA.routes.find(r => r.id === (loc.routeId || (bus ? bus.routeId : "ROUTE_01")));

        const routeColor = (route && route.color) ? route.color : "#0B57D0";
        const busName = bus ? bus.name : (loc.busId || "BU Bus");
        const driverName = (bus && bus.driver) ? bus.driver : (loc.driverName || "Driver");
        const routeName = route ? route.nameBn : "BU Route";
        const shortName = busName.split(' ')[0] || "BUS";

        if (!this.busMarkers[loc.busId]) {
            const busIcon = L.divIcon({
                className: 'custom-bus-div',
                html: `
                    <div class="bus-pulse-ring" style="background:${routeColor}33;"></div>
                    <div class="bus-marker-icon" id="bus-icon-element-${loc.busId}" style="background:${routeColor}; border: 3px solid white;">
                        🚍
                        <div class="bus-badge-label" style="background:${routeColor};">${shortName}</div>
                    </div>
                `,
                iconSize: [44, 44],
                iconAnchor: [22, 22]
            });

            const marker = L.marker(pos, { icon: busIcon, zIndexOffset: 1000 }).addTo(this.map);

            const popupHtml = `
                <div style="font-family: inherit; font-size: 0.85rem; min-width: 170px; line-height: 1.4;">
                    <div style="font-weight: 700; font-size: 0.95rem; color: #0f172a; margin-bottom: 2px;">🚍 ${busName}</div>
                    <div style="color: #64748b; font-size: 0.75rem; margin-bottom: 6px;">👤 ${driverName}<br>🛣️ ${routeName}</div>
                    <div style="display: flex; justify-content: space-between; background: #f1f5f9; padding: 4px 8px; border-radius: 6px; font-weight: 600; font-size: 0.78rem; margin-bottom: 8px;">
                        <span>স্পিড:</span> <span style="color:#0B57D0;">${loc.speed || 0} km/h</span>
                    </div>
                    <button onclick="BU_STUDENT.selectBusById('${loc.busId}')" style="width: 100%; background: #0B57D0; color: white; border: none; padding: 6px 10px; border-radius: 6px; font-size: 0.78rem; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px;">
                        🎯 এই বাসটি ট্র্যাক করুন
                    </button>
                </div>
            `;
            marker.bindPopup(popupHtml);
            this.busMarkers[loc.busId] = marker;
        } else {
            // Smoothly move marker
            this.busMarkers[loc.busId].setLatLng(pos);
        }

        // Rotate heading if available
        const iconEl = document.getElementById(`bus-icon-element-${loc.busId}`);
        if (iconEl && loc.heading) {
            iconEl.style.transform = `rotate(${loc.heading}deg)`;
        }
    },

    selectBusById: function (busId) {
        const bus = BU_ROUTES_DATA.buses.find(b => b.id === busId);
        if (!bus) return;

        if (this.selectedRouteId !== bus.routeId) {
            this.selectedRouteId = bus.routeId;
            const routeSelect = document.getElementById("student-route-select");
            if (routeSelect) routeSelect.value = bus.routeId;
            this.updateBusDropdownForRoute();
            this.renderSelectedRoute();
        }

        this.selectedBusId = busId;
        const busSelect = document.getElementById("student-bus-select");
        if (busSelect) busSelect.value = busId;

        this.latestBusLocation = this.activeBuses[busId] || null;
        this.updateCardInfo();
        this.updateStatusAndEta();
        this.focusBus();
    },

    updateCardInfo: function () {
        const bus = BU_ROUTES_DATA.buses.find(b => b.id === this.selectedBusId);
        if (bus) {
            document.getElementById("card-bus-name").textContent = bus.name;
            document.getElementById("card-driver-name").textContent = `Driver: ${bus.driver}`;
            const mobBusName = document.getElementById("mobile-pill-bus-name");
            if (mobBusName) mobBusName.textContent = bus.name;
        }

        if (this.latestBusLocation) {
            document.getElementById("card-bus-speed").textContent = `${this.latestBusLocation.speed || 0} km/h`;
            document.getElementById("card-bus-accuracy").textContent = `± ${this.latestBusLocation.accuracy || 0} m`;
            document.getElementById("card-bus-heading").textContent = `${this.latestBusLocation.heading || 0}°`;
        }
    },

    updateStatusAndEta: function () {
        const badge = document.getElementById("bus-status-badge");
        const lastSeen = document.getElementById("bus-last-seen");
        const mobSub = document.getElementById("mobile-pill-sub");
        const mobEta = document.getElementById("mobile-pill-eta");
        const mobDot = document.getElementById("mobile-pill-status-dot");

        if (!this.latestBusLocation) {
            badge.textContent = "OFFLINE / NO SIGNAL";
            badge.className = "card-tag status-offline";
            lastSeen.textContent = "Driver has not started trip";
            document.getElementById("eta-display-text").textContent = "Bus Offline";
            if (mobSub) mobSub.textContent = "ড্রাইভার ট্রিপ শুরু করেনি (Offline)";
            if (mobEta) mobEta.textContent = "--";
            if (mobDot) mobDot.className = "pill-status-dot offline";
            return;
        }

        // Evaluate ACTIVE / STALE / OFFLINE
        const status = BU_ETA_ENGINE.evaluateStatus(this.latestBusLocation.timestamp);
        badge.textContent = status.label;
        badge.className = `card-tag ${status.class}`;

        if (status.ageSec !== undefined) {
            lastSeen.textContent = `Updated ${status.ageSec}s ago`;
        }

        // Determine destination target (Selected stop OR Student position)
        let targetPoint = null;
        if (this.selectedTargetStopId) {
            const stop = BU_ROUTES_DATA.stops[this.selectedTargetStopId];
            if (stop && stop.lat && stop.lng) {
                targetPoint = { lat: stop.lat, lng: stop.lng, name: stop.nameBn };
            }
        } else {
            targetPoint = { lat: this.studentLocation.lat, lng: this.studentLocation.lng, name: "Student Location" };
        }

        // Calculate ETA & Distances
        if (this.latestBusLocation && targetPoint) {
            const etaResult = BU_ETA_ENGINE.calculateETA(
                { lat: this.latestBusLocation.lat, lng: this.latestBusLocation.lng },
                targetPoint,
                this.latestBusLocation.speed,
                2
            );

            if (status.code === "OFFLINE") {
                document.getElementById("eta-display-text").textContent = "Bus Offline";
                document.getElementById("eta-road-dist").textContent = "-- km";
                document.getElementById("eta-straight-dist").textContent = "-- km";
                if (mobSub) mobSub.textContent = "অফলাইন (No Signal)";
                if (mobEta) mobEta.textContent = "--";
                if (mobDot) mobDot.className = "pill-status-dot offline";
            } else {
                document.getElementById("eta-display-text").textContent = etaResult.formattedText;
                document.getElementById("eta-road-dist").textContent = `${etaResult.roadDistanceKm} km`;
                document.getElementById("eta-straight-dist").textContent = `${etaResult.straightLineKm} km`;

                if (mobEta) mobEta.textContent = etaResult.formattedText;
                if (mobSub) {
                    const spd = this.latestBusLocation.speed || 0;
                    mobSub.textContent = status.code === "ACTIVE"
                        ? `🟢 লাইভ • ${spd} km/h • ${etaResult.roadDistanceKm} km`
                        : `🟡 বিলম্বিত • ${spd} km/h`;
                }
                if (mobDot) {
                    mobDot.className = "pill-status-dot " + (status.code === "ACTIVE" ? "active" : "stale");
                }
            }
        }
    },

    focusBus: function () {
        if (this.latestBusLocation) {
            this.map.flyTo([this.latestBusLocation.lat, this.latestBusLocation.lng], 16);
        } else if (this.busMarkers[this.selectedBusId]) {
            this.map.flyTo(this.busMarkers[this.selectedBusId].getLatLng(), 16);
        } else {
            alert("This bus has not started its trip yet (Currently Offline). Start the trip in Driver Cockpit!");
        }
    },

    focusBU: function () {
        this.map.flyTo([BU_ROUTES_DATA.university.lat, BU_ROUTES_DATA.university.lng], 16);
    },

    fitBounds: function () {
        const route = BU_ROUTES_DATA.routes.find(r => r.id === this.selectedRouteId);
        if (!route) return;
        const points = (route.roadPath && route.roadPath.length > 0)
            ? route.roadPath
            : route.stopIds.map(id => [BU_ROUTES_DATA.stops[id].lat, BU_ROUTES_DATA.stops[id].lng]);
        this.map.fitBounds(points, { padding: [50, 50] });
    },

    renderRouteSchedule: function (route) {
        const container = document.getElementById("schedule-container");
        if (!container) return;
        if (!route.scheduleSummary || route.scheduleSummary.length === 0) {
            container.innerHTML = `<div style="padding:10px; font-size:0.8rem; color:var(--text-muted);">No schedule data available.</div>`;
            return;
        }

        let html = `
            <table class="schedule-table">
                <thead>
                    <tr>
                        <th>Time (সময়)</th>
                        <th>Assigned Bus (বাস)</th>
                    </tr>
                </thead>
                <tbody>
        `;
        route.scheduleSummary.forEach(item => {
            html += `
                <tr>
                    <td><b>${item.time}</b></td>
                    <td>${item.bus}</td>
                </tr>
            `;
        });
        html += `</tbody></table>`;
        container.innerHTML = html;
    },

    locateCustomCoordinates: function (customLat, customLng) {
        let lat = customLat !== undefined ? customLat : parseFloat(document.getElementById("input-manual-lat").value);
        let lng = customLng !== undefined ? customLng : parseFloat(document.getElementById("input-manual-lng").value);

        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            alert("Please enter valid Latitude (-90 to 90) and Longitude (-180 to 180).");
            return;
        }

        document.getElementById("input-manual-lat").value = lat.toFixed(5);
        document.getElementById("input-manual-lng").value = lng.toFixed(5);

        this.manualPinLayer.clearLayers();

        const pinIcon = L.divIcon({
            className: 'manual-pin-div',
            html: `<div class="manual-pin-pulse"></div><div class="manual-pin-icon">📍</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 32]
        });

        const marker = L.marker([lat, lng], { icon: pinIcon }).addTo(this.manualPinLayer);

        const distBU = BU_ETA.haversineDistance(lat, lng, BU_ROUTES_DATA.university.lat, BU_ROUTES_DATA.university.lng);

        let nearestStop = null;
        let minStopDist = Infinity;
        Object.values(BU_ROUTES_DATA.stops).forEach(s => {
            const d = BU_ETA.haversineDistance(lat, lng, s.lat, s.lng);
            if (d < minStopDist) {
                minStopDist = d;
                nearestStop = s;
            }
        });

        const nearestDistM = Math.round(minStopDist * 1000);

        marker.bindPopup(`
            <div style="font-family:'Outfit',sans-serif; min-width: 190px;">
                <h4 style="margin:0 0 4px 0; color:#D97706; font-size:0.95rem;">📍 Custom GPS Location</h4>
                <div style="font-size:0.8rem; color:#475569; font-family:'JetBrains Mono',monospace;">
                    Lat: ${lat.toFixed(5)}<br>Lng: ${lng.toFixed(5)}
                </div>
                <hr style="margin:6px 0; border:0; border-top:1px solid #E2E8F0;">
                <div style="font-size:0.8rem; margin-bottom:4px;">
                    <b>🏛️ Distance to BU:</b> ${distBU.toFixed(2)} km
                </div>
                <div style="font-size:0.8rem; margin-bottom:8px;">
                    <b>🚏 Nearest Stop:</b> ${nearestStop ? nearestStop.nameBn : 'N/A'} (~${nearestDistM}m)
                </div>
                <button onclick="setManualAsStudentLocation(${lat}, ${lng})" style="width:100%; padding:5px 8px; background:#0B57D0; color:white; border:none; border-radius:4px; cursor:pointer; font-size:0.75rem; font-weight:600;">
                    🎓 Set as Student Location
                </button>
            </div>
        `).openPopup();

        this.map.flyTo([lat, lng], 16, { duration: 1.2 });
        this.updateManualResultBox(lat, lng);
    },

    updateManualResultBox: function (lat, lng) {
        const distBU = BU_ETA.haversineDistance(lat, lng, BU_ROUTES_DATA.university.lat, BU_ROUTES_DATA.university.lng);
        let nearestStop = null;
        let minStopDist = Infinity;
        Object.values(BU_ROUTES_DATA.stops).forEach(s => {
            const d = BU_ETA.haversineDistance(lat, lng, s.lat, s.lng);
            if (d < minStopDist) {
                minStopDist = d;
                nearestStop = s;
            }
        });

        const nearestDistM = Math.round(minStopDist * 1000);
        const resBox = document.getElementById("manual-gps-result");
        if (resBox) {
            resBox.style.display = "block";
            resBox.innerHTML = `
                <b>📍 Location:</b> ${lat.toFixed(5)}, ${lng.toFixed(5)}<br>
                <b>🏛️ To Campus:</b> ${distBU.toFixed(2)} km • <b>🚏 Nearest:</b> ${nearestStop ? nearestStop.nameBn : ''} (${nearestDistM}m)
            `;
        }
    },

    clearManualPin: function () {
        this.manualPinLayer.clearLayers();
        document.getElementById("input-manual-lat").value = "";
        document.getElementById("input-manual-lng").value = "";
        const resBox = document.getElementById("manual-gps-result");
        if (resBox) resBox.style.display = "none";
    }
};

// Global handlers
function onStudentRouteChange() {
    const sel = document.getElementById("student-route-select");
    BU_STUDENT.selectedRouteId = sel.value;
    BU_STUDENT.selectedTargetStopId = null;
    BU_STUDENT.updateBusDropdownForRoute();
    BU_STUDENT.renderSelectedRoute();
    BU_STUDENT.fitBounds();
}

function onStudentBusChange() {
    const sel = document.getElementById("student-bus-select");
    BU_STUDENT.selectedBusId = sel.value;
    BU_STUDENT.latestBusLocation = BU_STUDENT.activeBuses[sel.value] || null;
    BU_STUDENT.updateCardInfo();
    BU_STUDENT.updateStatusAndEta();
    if (BU_STUDENT.latestBusLocation) {
        BU_STUDENT.focusBus();
    }
}

function locateStudent() {
    BU_STUDENT.locateStudentBrowser();
}

function focusOnBus() {
    BU_STUDENT.focusBus();
}

function focusOnBU() {
    BU_STUDENT.focusBU();
}

function fitRouteBounds() {
    BU_STUDENT.fitBounds();
}

function locateCustomCoordinates(lat, lng) {
    BU_STUDENT.locateCustomCoordinates(lat, lng);
}

function setManualAsStudentLocation(lat, lng) {
    const latInput = document.getElementById("input-manual-lat");
    const lngInput = document.getElementById("input-manual-lng");
    if (lat === undefined || lng === undefined) {
        lat = latInput ? parseFloat(latInput.value || latInput.placeholder || "22.65987") : 22.65987;
        lng = lngInput ? parseFloat(lngInput.value || lngInput.placeholder || "90.36211") : 90.36211;
    }
    if (isNaN(lat) || isNaN(lng)) {
        alert("Please enter valid Latitude and Longitude.");
        return;
    }
    if (latInput) latInput.value = lat.toFixed(5);
    if (lngInput) lngInput.value = lng.toFixed(5);

    BU_STUDENT.setStudentLocation(lat, lng, true);
    BU_STUDENT.map.flyTo([lat, lng], 16, { duration: 1.0 });
    BU_STUDENT.updateManualResultBox(lat, lng);

    const statusLabel = document.getElementById("student-loc-status");
    if (statusLabel) {
        statusLabel.innerHTML = `<span style="color:#0B57D0; font-weight:600;">📍 Student Pin Set: [${lat.toFixed(5)}, ${lng.toFixed(5)}]</span>`;
    }
}

function clearManualPin() {
    BU_STUDENT.clearManualPin();
}

function applyPresetCoords(lat, lng, name) {
    const latInput = document.getElementById("input-manual-lat");
    const lngInput = document.getElementById("input-manual-lng");
    if (latInput) latInput.value = lat.toFixed(5);
    if (lngInput) lngInput.value = lng.toFixed(5);

    BU_STUDENT.setStudentLocation(lat, lng, true);
    BU_STUDENT.locateCustomCoordinates(lat, lng);
    BU_STUDENT.map.flyTo([lat, lng], 16, { duration: 1.0 });

    const statusLabel = document.getElementById("student-loc-status");
    if (statusLabel) {
        statusLabel.innerHTML = `<span style="color:#0B57D0; font-weight:600;">📍 Location set to ${name}: [${lat.toFixed(5)}, ${lng.toFixed(5)}]</span>`;
    }
}

function toggleManualGpsCard() {
    const card = document.getElementById("manual-gps-box");
    if (!card) return;
    if (card.style.display === "none") {
        card.style.display = "block";
    } else {
        card.style.display = "none";
    }
}

