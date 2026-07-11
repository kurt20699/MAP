/* ============================================================
   cone-heading-fallback.js

   Fixes: the user-location cone pointing the "wrong way" (often
   looking roughly opposite the route) whenever no real compass
   or GPS-movement heading is available.

   Root cause: script.js falls back to a hardcoded 0° (due north)
   whenever state.lastKnownHeading is null — e.g. on devices/
   emulators without a working magnetometer, or when using a
   mock-location testing tool. If your route doesn't happen to
   head north, the cone looks backwards relative to it.

   Fix: when no real heading exists, point the cone toward the
   upcoming direction of the active route instead of a fixed
   compass direction — falling back to the destination itself if
   no route is loaded yet. The moment real compass/GPS heading
   data becomes available again, this defers to it immediately.

   Load AFTER script.js (order relative to map-rotation.js doesn't
   matter), e.g.:
     <script src="script.js?v=4"></script>
     <script src="cone-heading-fallback.js"></script>

   Does not modify script.js. Relies only on globals it already
   exposes: state, setMarkerHeading, calculateDistance,
   normalizeCoords.
   ============================================================ */

(function () {
    'use strict';

    const POLL_MS = 1000;         // how often to re-check/update the fallback heading
    const LOOKAHEAD_POINTS = 8;   // how many route-coordinate steps ahead to aim at

    function toRad(deg) { return (deg * Math.PI) / 180; }
    function toDeg(rad) { return (rad * 180) / Math.PI; }

    // Standard forward-azimuth (initial bearing) calculation between two
    // lat/lng points, in degrees clockwise from true north — same
    // convention used everywhere else in this app (compass heading,
    // GPS position.coords.heading, setMarkerHeading()).
    function calculateBearing(lat1, lng1, lat2, lng2) {
        const dLng = toRad(lng2 - lng1);
        const y = Math.sin(dLng) * Math.cos(toRad(lat2));
        const x =
            Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
        const bearing = toDeg(Math.atan2(y, x));
        return (bearing + 360) % 360;
    }

    // Finds a point a little further ahead along the active route than
    // the closest point to the user, so the fallback heading reflects
    // the upcoming direction of travel rather than the immediate next
    // (sometimes noisy/near-identical) route vertex.
    function getLookaheadPoint() {
        if (
            typeof state === 'undefined' || !state ||
            !state.currentRoute ||
            !Array.isArray(state.currentRoute.coordinates) ||
            !state.currentRoute.coordinates.length ||
            !state.userLocation
        ) {
            return null;
        }

        const coords = state.currentRoute.coordinates; // array of {lat, lng}
        const userLat = state.userLocation.lat;
        const userLng = state.userLocation.lng;

        let nearestIdx = 0;
        let nearestDist = Infinity;

        for (let i = 0; i < coords.length; i++) {
            const c = coords[i];
            if (typeof c.lat !== 'number' || typeof c.lng !== 'number') continue;
            const d = (typeof calculateDistance === 'function')
                ? calculateDistance([userLat, userLng], [c.lat, c.lng])
                : Math.hypot(c.lat - userLat, c.lng - userLng);
            if (d < nearestDist) {
                nearestDist = d;
                nearestIdx = i;
            }
        }

        const lookaheadIdx = Math.min(nearestIdx + LOOKAHEAD_POINTS, coords.length - 1);
        return coords[lookaheadIdx];
    }

    // Falls back to the selected destination itself if there's no active
    // route yet (e.g. before routesfound fires, or route calculation
    // failed) — still far better than a fixed north default.
    function getDestinationPoint() {
        if (
            typeof state === 'undefined' || !state ||
            !state.selectedLocation || !state.selectedLocation.coords ||
            typeof normalizeCoords !== 'function'
        ) {
            return null;
        }
        const coords = normalizeCoords(state.selectedLocation.coords);
        if (!coords) return null;
        return { lat: coords[0], lng: coords[1] };
    }

    function hasRealHeading() {
        return (
            typeof state !== 'undefined' && state &&
            (
                state.gpsHeadingActive ||
                (state.lastKnownHeading !== null && state.lastKnownHeading !== undefined && !isNaN(state.lastKnownHeading))
            )
        );
    }

    setInterval(() => {
        if (typeof state === 'undefined' || !state) return;
        if (!state.userMarker || !state.userLocation) return;

        // Real compass or GPS-movement heading exists — script.js's own
        // logic already handles this correctly. Don't interfere.
        if (hasRealHeading()) return;

        const target = getLookaheadPoint() || getDestinationPoint();
        if (!target) return; // no route or destination yet — leave as-is

        const bearing = calculateBearing(
            state.userLocation.lat,
            state.userLocation.lng,
            target.lat,
            target.lng
        );

        if (typeof setMarkerHeading === 'function') {
            setMarkerHeading(bearing);
        }
    }, POLL_MS);
})();   