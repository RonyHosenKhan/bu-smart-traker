// Admin & Bus Stop Coordinate Management Engine
// Enables verifying stops by clicking on the map or inputting verified GPS surveys

window.adminCoordinatePickerActive = false;

const BU_ADMIN = {
    selectedStopId: "STOP_BARISHAL_CLUB",

    init: function () {
        this.populateStopDropdown();
        this.loadSelectedStop();
        this.renderFleetTable();
    },

    populateStopDropdown: function () {
        const select = document.getElementById("admin-stop-select");
        if (!select) return;
        select.innerHTML = "";

        const seen = new Set();
        Object.values(BU_ROUTES_DATA.stops).forEach(stop => {
            if (seen.has(stop.id)) return;
            seen.add(stop.id);
            const opt = document.createElement("option");
            opt.value = stop.id;
            opt.textContent = `${stop.nameBn} (${stop.nameEn}) [${stop.coordinatesReady ? '✓ Verified' : '⚠ Unverified'}]`;
            select.appendChild(opt);
        });
        select.value = this.selectedStopId;
    },

    loadSelectedStop: function () {
        const stop = BU_ROUTES_DATA.stops[this.selectedStopId];
        if (!stop) return;

        document.getElementById("admin-stop-lat").value = stop.lat || "";
        document.getElementById("admin-stop-lng").value = stop.lng || "";
        document.getElementById("admin-coords-ready").checked = !!stop.coordinatesReady;
    },

    enablePicker: function () {
        window.adminCoordinatePickerActive = true;
        alert("📍 MAP PICKER ACTIVE:\nClick anywhere on the map to set the exact latitude & longitude for " + BU_ROUTES_DATA.stops[this.selectedStopId].nameEn);

        const onMapClickForAdmin = (e) => {
            document.getElementById("admin-stop-lat").value = e.latlng.lat.toFixed(6);
            document.getElementById("admin-stop-lng").value = e.latlng.lng.toFixed(6);
            document.getElementById("admin-coords-ready").checked = true;

            window.adminCoordinatePickerActive = false;
            BU_STUDENT.map.off('click', onMapClickForAdmin);
            alert(`Coordinates captured: ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}. Click 'Save Stop Config' to apply.`);
        };

        BU_STUDENT.map.once('click', onMapClickForAdmin);
    },

    saveStop: function () {
        const stop = BU_ROUTES_DATA.stops[this.selectedStopId];
        if (!stop) return;

        const newLat = parseFloat(document.getElementById("admin-stop-lat").value);
        const newLng = parseFloat(document.getElementById("admin-stop-lng").value);
        const isReady = document.getElementById("admin-coords-ready").checked;

        if (isNaN(newLat) || isNaN(newLng)) {
            alert("Please enter valid numeric latitude and longitude coordinates.");
            return;
        }

        stop.lat = newLat;
        stop.lng = newLng;
        stop.coordinatesReady = isReady;

        // Persist to local storage
        localStorage.setItem("BU_UPDATED_STOPS_V2", JSON.stringify(BU_ROUTES_DATA.stops));

        // Re-render UI and markers
        this.populateStopDropdown();
        BU_STUDENT.renderSelectedRoute();

        alert(`✅ Successfully updated ${stop.nameEn}!\nCoordinates verified: ${isReady ? 'YES' : 'NO'}`);
    },

    renderFleetTable: function () {
        const container = document.getElementById("admin-fleet-table");
        if (!container) return;

        let html = `
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem; text-align:left;">
                <thead>
                    <tr style="border-bottom:2px solid #CBD5E1; color:#475569;">
                        <th style="padding:6px;">Bus</th>
                        <th style="padding:6px;">Route</th>
                        <th style="padding:6px;">Assigned Driver</th>
                        <th style="padding:6px;">Status</th>
                    </tr>
                </thead>
                <tbody>
        `;

        BU_ROUTES_DATA.buses.forEach(b => {
            const route = BU_ROUTES_DATA.routes.find(r => r.id === b.routeId);
            html += `
                <tr style="border-bottom:1px solid #E2E8F0;">
                    <td style="padding:6px; font-weight:600;">${b.name}</td>
                    <td style="padding:6px; color:#0F4C81;">${route ? route.nameEn : b.routeId}</td>
                    <td style="padding:6px;">${b.driver}</td>
                    <td style="padding:6px;"><span class="coord-status-pill verified">${b.status}</span></td>
                </tr>
            `;
        });

        html += `</tbody></table>`;
        container.innerHTML = html;
    }
};

function loadStopForAdminEdit() {
    const sel = document.getElementById("admin-stop-select");
    BU_ADMIN.selectedStopId = sel.value;
    BU_ADMIN.loadSelectedStop();
}

function enableMapCoordinatePicker() {
    BU_ADMIN.enablePicker();
}

function saveAdminStopCoordinates() {
    BU_ADMIN.saveStop();
}
