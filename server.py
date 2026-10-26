#!/usr/bin/env python3
"""
MotionIQ — Local Development Server
Serves the PWA over HTTP on port 8080.

Usage:
    python3 server.py

Then open http://localhost:8080 in Chrome on your computer,
or find your LAN IP (e.g. 192.168.1.x) and open
http://192.168.1.x:8080 on your phone (must be same WiFi).

Note: GPS/sensors require a secure context (HTTPS or localhost).
  • localhost works directly (Chrome allows sensors on localhost).
  • For phone testing over LAN, Chrome also allows sensors on
    local IPs starting with 192.168.x.x in Chrome 94+.
    If sensors don't work, deploy to GitHub Pages (free HTTPS).
"""

import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DIR  = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self):
        # Required headers for PWA / sensors
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} — {fmt % args}')

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'\n  MotionIQ server running at http://localhost:{PORT}')
    print(f'  Serving files from: {DIR}')
    print(f'  Press Ctrl+C to stop.\n')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')
