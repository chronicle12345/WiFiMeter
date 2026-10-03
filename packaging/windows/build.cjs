'use strict';

require('../tauri.cjs').buildDesktop('win32')
    .catch(error => require('../build-failure.cjs').reportBuildFailure(error));
