import { DemoStore } from './mock.js';

// The current client is synchronous and demo-only. Backend transport is not implemented.
export function createDataClient(storage, clock) {
    return new DemoStore(storage, clock);
}
