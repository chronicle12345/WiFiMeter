// Coalesce backend bursts into one paint and stop visual work while the page is hidden.
export function createRenderScheduler({ render, hidden, requestFrame, cancelFrame }) {
    let frame = null, dirty = false;
    function flush() {
        frame = null;
        if (hidden() || !dirty) return;
        dirty = false;
        render();
    }
    function schedule() {
        dirty = true;
        if (!hidden() && frame === null) frame = requestFrame(flush);
    }
    function visibilityChanged() {
        if (hidden() && frame !== null) { cancelFrame(frame); frame = null; }
        else if (!hidden() && dirty) schedule();
    }
    function stop() { if (frame !== null) cancelFrame(frame); frame = null; dirty = false; }
    return { schedule, visibilityChanged, stop };
}
