export const MIN_SAMPLE_INTERVAL = 0.25;
export const MAX_SAMPLE_INTERVAL = 3600;

export function validSampleInterval(seconds) {
    return typeof seconds === 'number' && Number.isFinite(seconds)
        && seconds >= MIN_SAMPLE_INTERVAL && seconds <= MAX_SAMPLE_INTERVAL
        && Math.abs(seconds * 1000 - Math.round(seconds * 1000)) < 0.000001;
}
