// ETA & Mathematical Distance Engine for BU Smart Bus Tracker
// Follows strict project guidelines: Haversine distance is clearly distinguished from Road Network distance.

const BU_ETA_ENGINE = {
    // Earth's radius in kilometers
    EARTH_RADIUS_KM: 6371.0,

    // Urban road curvature factor for Barishal city streets (road length is ~1.25x to 1.35x straight-line)
    ROAD_WINDING_FACTOR: 1.28,

    // Default average urban bus speed in Barishal (in km/h, accounting for stops, passengers, and traffic)
    DEFAULT_URBAN_SPEED_KMH: 22.0,

    /**
     * Calculates straight-line Euclidean/Spherical distance using the Haversine formula.
     * @returns distance in kilometers
     */
    calculateHaversineDistanceKm: function (lat1, lon1, lat2, lon2) {
        if (!lat1 || !lon1 || !lat2 || !lon2) return null;

        const toRad = (angle) => (angle * Math.PI) / 180.0;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);

        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return this.EARTH_RADIUS_KM * c;
    },

    /**
     * Estimates road distance from straight-line using calibrated road network multiplier.
     * @returns estimated road distance in km
     */
    estimateRoadDistanceKm: function (haversineKm) {
        if (haversineKm === null || haversineKm === undefined) return null;
        return haversineKm * this.ROAD_WINDING_FACTOR;
    },

    /**
     * Calculates realistic arrival time (ETA) based on distance, speed, and stops remaining.
     * Never guarantees exact arrival; always provides honest approximate window.
     */
    calculateETA: function (busLocation, targetLocation, currentSpeedKmh, stopsRemainingCount = 0) {
        if (!busLocation || !targetLocation) {
            return {
                etaMinutes: null,
                formattedText: "ETA Unavailable",
                isApproximation: true,
                warning: "Missing coordinates"
            };
        }

        const straightLineKm = this.calculateHaversineDistanceKm(
            busLocation.lat,
            busLocation.lng,
            targetLocation.lat,
            targetLocation.lng
        );

        if (straightLineKm === null) {
            return {
                etaMinutes: null,
                formattedText: "ETA Unavailable",
                isApproximation: true,
                warning: "Invalid coordinates"
            };
        }

        const roadDistanceKm = this.estimateRoadDistanceKm(straightLineKm);

        // Effective speed: if GPS speed is between 8 km/h and 60 km/h use weighted average, else use urban default
        let effectiveSpeed = this.DEFAULT_URBAN_SPEED_KMH;
        if (currentSpeedKmh && currentSpeedKmh > 5 && currentSpeedKmh < 65) {
            effectiveSpeed = (currentSpeedKmh * 0.6) + (this.DEFAULT_URBAN_SPEED_KMH * 0.4);
        }

        // Travel time in hours + stop dwell time (approx 45 seconds per intermediate stop)
        const travelTimeHours = roadDistanceKm / effectiveSpeed;
        const dwellTimeMinutes = stopsRemainingCount * 0.75;
        const totalMinutes = Math.round((travelTimeHours * 60) + dwellTimeMinutes);

        const displayMinutes = Math.max(1, totalMinutes);

        let formattedText = "";
        if (displayMinutes <= 1) {
            formattedText = "Arriving now (< 2 mins)";
        } else if (displayMinutes < 60) {
            formattedText = `About ${displayMinutes} mins (${displayMinutes - 1}–${displayMinutes + 2} min window)`;
        } else {
            const hours = Math.floor(displayMinutes / 60);
            const mins = displayMinutes % 60;
            formattedText = `About ${hours}h ${mins}m`;
        }

        return {
            straightLineKm: Number(straightLineKm.toFixed(2)),
            roadDistanceKm: Number(roadDistanceKm.toFixed(2)),
            etaMinutes: displayMinutes,
            formattedText: formattedText,
            isApproximation: true,
            method: "Haversine + Urban Road Multiplier (1.28x) + Intermediate Stop Dwell",
            effectiveSpeedKmh: Math.round(effectiveSpeed)
        };
    },

    /**
     * Determines live tracking status (ACTIVE, STALE, OFFLINE) based on update timestamp.
     */
    evaluateStatus: function (timestampMs) {
        if (!timestampMs) return { code: "OFFLINE", label: "Offline / Inactive", class: "status-offline" };

        const ageMs = Date.now() - timestampMs;
        if (ageMs < 30000) {
            return { code: "ACTIVE", label: "Active (Live GPS)", class: "status-active", ageSec: Math.round(ageMs / 1000) };
        } else if (ageMs < 120000) {
            return { code: "STALE", label: "Stale Data (>30s)", class: "status-stale", ageSec: Math.round(ageMs / 1000) };
        } else {
            return { code: "OFFLINE", label: "Offline (>2 mins)", class: "status-offline", ageSec: Math.round(ageMs / 1000) };
        }
    }
};
