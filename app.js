// Main Application Initializer & Role Orchestrator

document.addEventListener("DOMContentLoaded", () => {
    // 1. Clear any legacy cached stops to prevent stale data
    localStorage.removeItem("BU_UPDATED_STOPS");
    const savedStops = localStorage.getItem("BU_UPDATED_STOPS_V2");
    if (savedStops) {
        try {
            const parsed = JSON.parse(savedStops);
            Object.assign(BU_ROUTES_DATA.stops, parsed);
        } catch (e) {
            console.error("Could not load stored stops", e);
        }
    }

    // 2. Initialize subsystems
    BU_STUDENT.init();
    BU_DRIVER.init();
    BU_ADMIN.init();

    // 3. Start live clock & network monitor
    startClock();
    initNetworkMonitor();

    // 4. Initialize mobile responsive view
    initResponsiveView();

    console.log("BU Smart Bus Tracker Web Application Loaded Successfully.");
});

let currentMobileView = 'map'; // 'map' or 'panel'

function initResponsiveView() {
    if (window.innerWidth < 992) {
        setMobileView('map');
    }

    window.addEventListener('resize', () => {
        if (window.innerWidth >= 992) {
            document.body.classList.remove('mobile-show-panel', 'mobile-show-map');
            if (BU_STUDENT.map) {
                BU_STUDENT.map.invalidateSize();
            }
        } else {
            if (!document.body.classList.contains('mobile-show-panel') && !document.body.classList.contains('mobile-show-map')) {
                setMobileView(currentMobileView);
            }
        }
    });
}

function setMobileView(view, role) {
    currentMobileView = view;
    const isMobile = window.innerWidth < 992;

    // Reset all bottom nav active states
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => btn.classList.remove('active'));

    if (view === 'map') {
        document.body.classList.remove('mobile-show-panel');
        document.body.classList.add('mobile-show-map');

        const mapBtn = document.getElementById('mob-nav-map');
        if (mapBtn) mapBtn.classList.add('active');

        // Close manual GPS if open or keep it tidy
        if (BU_STUDENT && BU_STUDENT.map) {
            setTimeout(() => {
                BU_STUDENT.map.invalidateSize();
            }, 80);
            setTimeout(() => {
                BU_STUDENT.map.invalidateSize();
            }, 250);
        }
    } else {
        // Show panel
        document.body.classList.remove('mobile-show-map');
        document.body.classList.add('mobile-show-panel');

        if (role) {
            switchRole(role, false);
        }

        // Highlight corresponding mobile bottom nav button
        if (role === 'student') {
            const btn = document.getElementById('mob-nav-student');
            if (btn) btn.classList.add('active');
        } else if (role === 'driver') {
            const btn = document.getElementById('mob-nav-driver');
            if (btn) btn.classList.add('active');
        } else if (role === 'admin' || role === 'docs') {
            const btn = document.getElementById('mob-nav-admin');
            if (btn) btn.classList.add('active');
        }

        // Scroll sidebar to top
        const sidebar = document.getElementById('sidebar-panel');
        if (sidebar) sidebar.scrollTop = 0;
    }
}

function switchRole(role, autoSwitchMobileView = true) {
    const roles = ['student', 'driver', 'admin', 'docs'];
    roles.forEach(r => {
        const panel = document.getElementById(`panel-${r}`);
        const btn = document.getElementById(`btn-role-${r}`);
        if (panel) panel.classList.toggle('active', r === role);
        if (btn) btn.classList.toggle('active', r === role);
    });

    // Sync mobile bottom nav buttons
    if (role === 'student') {
        const btn = document.getElementById('mob-nav-student');
        if (btn) btn.classList.add('active');
    } else if (role === 'driver') {
        const btn = document.getElementById('mob-nav-driver');
        if (btn) btn.classList.add('active');
    } else if (role === 'admin' || role === 'docs') {
        const btn = document.getElementById('mob-nav-admin');
        if (btn) btn.classList.add('active');
    }

    if (autoSwitchMobileView && window.innerWidth < 992) {
        setMobileView('panel', role);
    }

    // Invalidate map size when switching back to student view to ensure proper leaflet render
    if (BU_STUDENT && BU_STUDENT.map) {
        setTimeout(() => BU_STUDENT.map.invalidateSize(), 150);
    }
}

function startClock() {
    const timeEl = document.getElementById("header-time");
    function update() {
        const now = new Date();
        if (timeEl) {
            timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
    }
    update();
    setInterval(update, 1000);
}

function initNetworkMonitor() {
    const netEl = document.getElementById("connection-status");
    function updateNet() {
        if (!netEl) return;
        if (navigator.onLine) {
            netEl.className = "network-badge online";
            netEl.innerHTML = `<span class="dot"></span> Online`;
        } else {
            netEl.className = "network-badge offline";
            netEl.innerHTML = `<span class="dot" style="background:#EF4444;"></span> Offline`;
        }
    }
    window.addEventListener('online', updateNet);
    window.addEventListener('offline', updateNet);
    updateNet();
}
