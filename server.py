#!/usr/bin/env python3
"""
BU Smart Bus Live Real-time GPS Server
Serves static dashboard files and provides REST API + broadcast storage for Driver Live GPS tracking.
"""

import http.server
import socketserver
import json
import os
import sys
import time
import socket
import functools
from urllib.parse import urlparse, parse_qs

# Ensure UTF-8 output on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

PORT = int(os.environ.get("PORT", 5500))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# In-memory store for active bus locations
LIVE_BUS_LOCATIONS = {}
CACHE_FILE = os.path.join(DIRECTORY, "latest_locations.json")

# Load existing cache if available
if os.path.exists(CACHE_FILE):
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            LIVE_BUS_LOCATIONS = json.load(f)
    except Exception as e:
        print(f"Notice: Starting fresh location store: {e}")

def get_local_ip():
    """Detect LAN IP address so phone can easily connect to this server."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"

class BUSmartBusHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS for cross-device access
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # Prevent browser & proxy caching for all assets so mobile updates apply instantly
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        
        # 1. API: Get Latest Location(s) for All Active Buses
        if parsed.path == '/api/location':
            query = parse_qs(parsed.query)
            bus_id = query.get('busId', [None])[0]

            now_ms = int(time.time() * 1000)
            # Prune buses that stopped or haven't sent updates in > 60 seconds
            stale_buses = [
                bid for bid, loc in LIVE_BUS_LOCATIONS.items()
                if (loc.get('trackingStatus') == 'STOPPED' or 
                    loc.get('isStopped') or 
                    (now_ms - loc.get('serverTimestamp', now_ms) > 60000))
            ]
            for bid in stale_buses:
                LIVE_BUS_LOCATIONS.pop(bid, None)

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()

            if bus_id:
                loc = LIVE_BUS_LOCATIONS.get(bus_id)
                self.wfile.write(json.dumps(loc if loc else {}).encode('utf-8'))
            else:
                self.wfile.write(json.dumps(LIVE_BUS_LOCATIONS).encode('utf-8'))
            return

        # 2. API: Server & Network Information (for connecting from mobile phone)
        if parsed.path == '/api/info':
            local_ip = get_local_ip()
            host_header = self.headers.get('Host', '')
            proto = self.headers.get('X-Forwarded-Proto', 'https' if 'onrender.com' in host_header or 'railway' in host_header else 'http')
            mobile_url = f"{proto}://{host_header}" if host_header and not host_header.startswith('localhost') and not host_header.startswith('127.0.0.1') else f"http://{local_ip}:{PORT}"
            info = {
                "serverTime": int(time.time() * 1000),
                "localIp": local_ip,
                "port": PORT,
                "mobileUrl": mobile_url,
                "activeBusesCount": len(LIVE_BUS_LOCATIONS)
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(info).encode('utf-8'))
            return

        # 3. Download Android APK endpoint
        if parsed.path in ('/download-apk', '/bu-smart-bus.apk', '/download'):
            apk_candidates = [
                os.path.join(DIRECTORY, "bu-smart-bus.apk"),
                os.path.join(DIRECTORY, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
                os.path.join(DIRECTORY, "downloads", "bu-smart-bus.apk")
            ]
            for apk_path in apk_candidates:
                if os.path.exists(apk_path):
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.android.package-archive')
                    self.send_header('Content-Disposition', 'attachment; filename="bu-smart-bus.apk"')
                    self.send_header('Content-Length', str(os.path.getsize(apk_path)))
                    self.end_headers()
                    with open(apk_path, 'rb') as f:
                        self.wfile.write(f.read())
                    return

            # If not yet compiled locally, redirect to verified GitHub Release APK
            self.send_response(302)
            self.send_header('Location', 'https://github.com/RonyHosenKhan/bu-smart-traker/releases/download/v1.0.3/app-debug.apk')
            self.end_headers()
            return

        # Fallback to standard static file server
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        # 1. API: Driver Live GPS Broadcast Upload or Stop
        if parsed.path == '/api/location':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body)

                bus_id = data.get('busId')
                if not bus_id:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(b'{"error":"Missing busId"}')
                    return

                # If Driver stopped trip, instantly remove from active cache & disk
                if data.get('trackingStatus') == 'STOPPED' or data.get('isStopped'):
                    LIVE_BUS_LOCATIONS.pop(bus_id, None)
                    try:
                        with open(CACHE_FILE, "w", encoding="utf-8") as f:
                            json.dump(LIVE_BUS_LOCATIONS, f)
                    except Exception:
                        pass

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": "stopped", "busId": bus_id}).encode('utf-8'))
                    return

                # Record server timestamp and update active cache
                data['serverTimestamp'] = int(time.time() * 1000)
                LIVE_BUS_LOCATIONS[bus_id] = data

                # Persist to disk
                try:
                    with open(CACHE_FILE, "w", encoding="utf-8") as f:
                        json.dump(LIVE_BUS_LOCATIONS, f)
                except Exception:
                    pass

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                resp = {
                    "status": "success",
                    "busId": bus_id,
                    "updateCount": data.get("updateCount", 0),
                    "receivedAt": data['serverTimestamp']
                }
                self.wfile.write(json.dumps(resp).encode('utf-8'))
                return

            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
                return

        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/location':
            query = parse_qs(parsed.query)
            bus_id = query.get('busId', [None])[0]
            if bus_id and bus_id in LIVE_BUS_LOCATIONS:
                LIVE_BUS_LOCATIONS.pop(bus_id, None)
                try:
                    with open(CACHE_FILE, "w", encoding="utf-8") as f:
                        json.dump(LIVE_BUS_LOCATIONS, f)
                except Exception:
                    pass
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "removed", "busId": bus_id}).encode('utf-8'))
            return
        self.send_response(404)
        self.end_headers()

def run_server():
    local_ip = get_local_ip()
    print("=" * 60)
    print(f">> BU Smart Bus Live GPS Server Running!")
    print(f">> Local Web Dashboard: http://localhost:{PORT}")
    print(f">> Mobile Driver Phone: http://{local_ip}:{PORT}")
    print(f">> Real-Time GPS API:  http://localhost:{PORT}/api/location")
    print("=" * 60)
    sys.stdout.flush()

    handler_factory = functools.partial(BUSmartBusHandler, directory=DIRECTORY)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), handler_factory) as httpd:
        httpd.daemon_threads = True
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown()

if __name__ == "__main__":
    run_server()
