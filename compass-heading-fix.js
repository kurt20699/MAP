/* ============================================================
   compass-heading-fix.js  (v2)

   Fixes: the user-location cone pointing the wrong way, staying
   stuck pointing the wrong way, or not matching the route.

   ── Bug #1 (fixed in v1): event.alpha is only genuinely
   north-referenced when event.absolute === true. script.js's own
   attachCompassListener() ignores that check, so on many
   Android/Chrome combos it rotates the cone using a heading that's
   offset from true north by an arbitrary, unpredictable amount.

   ── Bug #2 (new in v2 — this is what was still broken): v1 only
   cleared state.lastKnownHeading = null when the data was
   untrustworthy. It never called setMarkerHeading() again, so the
   cone stayed visually stuck at whatever wrong angle script.js's
   own (untrustworthy) listener had already rotated it to. Clearing
   a variable does nothing if nothing re-reads it.

   ── Bug #3 (new in v2): the "route-direction fallback" mentioned
   in v1's comments never actually existed anywhere in script.js.
   There was nothing for the cone to fall back to, so even after
   fixing Bug #2 the cone would just go blank/frozen instead of
   pointing somewhere useful.

   Fix in this version:
   1. When device heading is trustworthy (iOS webkitCompassHeading,
      or Android alpha with absolute === true), use it — same as
      before.
   2. When it is NOT trustworthy, actively compute a bearing from
      the user's current location to the next point ahead on the
      active route (state.currentRoute.coordinates) and rotate the
      cone to THAT instead of leaving it stuck. This matches "cone
      should point the same direction as the route" when a real
      compass reading isn't available.
   3. If there's no active route either, default to north (0°)
      rather than leaving a stale wrong angle on screen.

   Load AFTER script.js:
     <script src="script.js?v=4"></script>
     <script src="compass-heading-fix.js"></script>

   Does not modify script.js.
   ============================================================ */

(function () {
    'use strict';

    function getScreenAngle() {
        if (screen.orientation && typeof screen.orientation.angle === 'number') {
            return screen.orientation.angle;
        }
        return typeof window.orientation === 'number' ? window.orientation : 0;
    }

    // ------------------------------------------------------------------
    // Route-bearing fallback: bearing from the user's current position
    // to a point a little way ahead on the active route.
    // ------------------------------------------------------------------
    function toRad(deg) { return deg * Math.PI / 180; }
    function toDeg(rad) { return rad * 180 / Math.PI; }

    function bearingBetween(from, to) {
        // from/to: [lat, lng]
        const lat1 = toRad(from[0]);
        const lat2 = toRad(to[0]);
        const dLng = toRad(to[1] - from[1]);

        const y = Math.sin(dLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
                  Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

        let bearing = toDeg(Math.atan2(y, x));
        return (bearing + 360) % 360;
    }

    function distanceMeters(a, b) {
        const R = 6371000;
        const lat1 = toRad(a[0]);
        const lat2 = toRad(b[0]);
        const dLat = toRad(b[0] - a[0]);
        const dLng = toRad(b[1] - a[1]);
        const s = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    }

    // Looks ahead along the route polyline for a point roughly
    // LOOKAHEAD_M meters past the user's current position, and returns
    // the bearing from the user to that point. Falls back to the final
    // route point if the route is shorter than that.
    const LOOKAHEAD_M = 8;

    function getRouteBearingFallback() {
        const route = window.state && state.currentRoute;
        const userLoc = window.state && state.userLocation;
        if (!route || !Array.isArray(route.coordinates) || route.coordinates.length < 2) return null;
        if (!userLoc) return null;

        const userPos = [userLoc.lat, userLoc.lng];

        // route.coordinates are Leaflet LatLng objects: {lat, lng}
        const coords = route.coordinates.map(c => [c.lat, c.lng]);

        // Find the closest point on the route to the user, then walk
        // forward from there until we've covered LOOKAHEAD_M meters.
        let closestIdx = 0;
        let closestDist = Infinity;
        coords.forEach((pt, i) => {
            const d = distanceMeters(userPos, pt);
            if (d < closestDist) {
                closestDist = d;
                closestIdx = i;
            }
        });

        let travelled = 0;
        let targetPt = coords[coords.length - 1];
        for (let i = closestIdx; i < coords.length - 1; i++) {
            travelled += distanceMeters(coords[i], coords[i + 1]);
            if (travelled >= LOOKAHEAD_M) {
                targetPt = coords[i + 1];
                break;
            }
        }

        return bearingBetween(userPos, targetPt);
    }

    // ------------------------------------------------------------------
    // Optional debug overlay — shows raw sensor values + fallback state.
    // ------------------------------------------------------------------
    let debugEl = null;
    const debugEnabled =
        new URLSearchParams(window.location.search).get('debugHeading') === '1';

    function ensureDebugOverlay() {
        if (debugEl || !debugEnabled) return;
        debugEl = document.createElement('div');
        debugEl.id = 'headingDebugOverlay';
        debugEl.style.cssText = `
            position: fixed;
            top: 8px;
            left: 8px;
            z-index: 99999;
            background: rgba(0,0,0,0.75);
            color: #0f0;
            font-family: monospace;
            font-size: 11px;
            padding: 8px 10px;
            border-radius: 6px;
            line-height: 1.5;
            pointer-events: none;
            white-space: pre;
        `;
        document.body.appendChild(debugEl);
    }

    function updateDebugOverlay(data) {
        if (!debugEnabled) return;
        ensureDebugOverlay();
        if (!debugEl) return;
        debugEl.textContent =
            `alpha: ${data.alpha}\n` +
            `absolute: ${data.absolute}\n` +
            `webkitCompassHeading: ${data.webkit}\n` +
            `screenAngle: ${data.screenAngle}\n` +
            `computed heading: ${data.heading}\n` +
            `source: ${data.source}`;
    }

    // ------------------------------------------------------------------
    // Corrected handler.
    // ------------------------------------------------------------------
    function handler(event) {
        if (typeof state === 'undefined' || !state) return;

        let heading = null;
        let source = 'none (untrusted)';

        if (typeof event.webkitCompassHeading === 'number') {
            // iOS Safari — always genuinely north-referenced by design,
            // safe to trust directly regardless of `absolute`.
            heading = event.webkitCompassHeading;
            source = 'webkitCompassHeading (iOS)';
        } else if (event.absolute === true && typeof event.alpha === 'number') {
            // Only trust alpha as a real compass heading when the browser
            // explicitly confirms it's north-referenced.
            heading = 360 - event.alpha - getScreenAngle();
            heading = ((heading % 360) + 360) % 360;
            source = 'alpha (absolute=true)';
        }

        if (heading === null) {
            // Device heading isn't trustworthy. Actively fall back to the
            // route bearing instead of leaving the cone stuck at whatever
            // wrong angle script.js's own listener last set it to.
            const routeBearing = getRouteBearingFallback();
            if (routeBearing !== null) {
                heading = routeBearing;
                source = 'route bearing (fallback)';
            } else {
                heading = 0;
                source = 'default north (no route, no compass)';
            }
        }

        updateDebugOverlay({
            alpha: typeof event.alpha === 'number' ? event.alpha.toFixed(1) : 'n/a',
            absolute: String(event.absolute),
            webkit: typeof event.webkitCompassHeading === 'number' ? event.webkitCompassHeading.toFixed(1) : 'n/a',
            screenAngle: getScreenAngle(),
            heading: heading.toFixed(1),
            source
        });

        state.lastKnownHeading = heading;
        if (!state.gpsHeadingActive && typeof setMarkerHeading === 'function') {
            setMarkerHeading(heading);
        }
    }

    // Attach after script.js's own listener (this file loads after, so
    // our handler runs second per event and gets the final say).
    if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', handler);
    } else {
        window.addEventListener('deviceorientation', handler);
    }

    // Also recompute the fallback whenever the route changes or the user
    // location updates, in case no new orientation event fires for a
    // while (e.g. phone lying flat, or a browser that fires orientation
    // events rarely).
    setInterval(() => {
        if (typeof state === 'undefined' || !state || !state.currentRoute) return;
        if (state.gpsHeadingActive) return; // GPS-based heading takes priority

        // Periodic safety net: if orientation events are sparse or the
        // device never fires one at all, this keeps the cone following
        // the route even without any deviceorientation event firing.
        const routeBearing = getRouteBearingFallback();
        if (routeBearing !== null) {
            state.lastKnownHeading = routeBearing;
            if (typeof setMarkerHeading === 'function') {
                setMarkerHeading(routeBearing);
            }
        }
    }, 1500);

    if (debugEnabled) {
        console.info('[compass-heading-fix v2] Debug overlay enabled via ?debugHeading=1');
    }
})();