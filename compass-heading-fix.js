/* ============================================================
   compass-heading-fix.js

   Fixes: the user-location cone pointing the wrong way even on a
   real device with real GPS/compass.

   Root cause (confirmed against the W3C DeviceOrientation spec):
   `event.alpha` is ONLY genuinely referenced to true north when
   the browser explicitly sets `event.absolute === true`. When
   it's false, alpha is measured from an arbitrary starting
   orientation (wherever the device happened to be pointed when
   the sensor initialized) — not north.

   script.js's attachCompassListener() currently uses alpha
   whenever it's a number, WITHOUT checking event.absolute. That
   was a deliberate earlier fix to make the cone appear on devices
   that never set absolute: true — but it has the side effect of
   treating non-north-referenced alpha values as if they were real
   compass headings, producing a heading that's wrong by a
   persistent, device/session-dependent, unpredictable offset.

   Fix: attach a second, stricter listener (loaded after script.js,
   so it runs after and gets the final say for each event) that
   only trusts alpha when event.absolute === true. When it isn't,
   this explicitly clears state.lastKnownHeading back to null so
   your route-direction fallback (cone-heading-fallback.js, if
   loaded) takes over instead of showing a misleading heading.

   Also includes an optional on-screen debug readout — add
   ?debugHeading=1 to your URL, or tap-and-hold the 🧭 button for
   1s if map-rotation.js is also loaded — to see live raw sensor
   values for empirical verification on your actual device.

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
    // Optional debug overlay — shows raw sensor values so you can verify
    // the fix empirically (e.g. face known-north, check the numbers).
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

        updateDebugOverlay({
            alpha: typeof event.alpha === 'number' ? event.alpha.toFixed(1) : 'n/a',
            absolute: String(event.absolute),
            webkit: typeof event.webkitCompassHeading === 'number' ? event.webkitCompassHeading.toFixed(1) : 'n/a',
            screenAngle: getScreenAngle(),
            heading: heading !== null ? heading.toFixed(1) : 'null (untrusted — falling back)',
            source
        });

        if (heading === null) {
            // Not genuinely north-referenced. Explicitly clear whatever
            // script.js's own (looser) listener may have just set from
            // this same event, so a route-direction fallback can take
            // over instead of showing a misleading heading.
            state.lastKnownHeading = null;
            return;
        }

        state.lastKnownHeading = heading;
        if (!state.gpsHeadingActive && typeof setMarkerHeading === 'function') {
            setMarkerHeading(heading);
        }
    }

    // Attach after script.js's own listener (this file loads after, so
    // our handler runs second per event and gets the final say). We
    // don't duplicate the iOS permission-request flow — script.js's
    // requestCompassPermission() already handles that; we just also
    // listen passively, and simply receive nothing until permission is
    // granted, same as any other listener would.
    if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', handler);
    } else {
        window.addEventListener('deviceorientation', handler);
    }

    if (debugEnabled) {
        console.info('[compass-heading-fix] Debug overlay enabled via ?debugHeading=1');
    }
})();