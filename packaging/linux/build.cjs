'use strict';

require('../tauri.cjs').buildDesktop('linux')
    .catch(error => require('../build-failure.cjs').reportBuildFailure(error));
