const process = require('process/browser');
process.env = (window && window.__runtime_env) || __BUILD_ENV || {};
process.stdout = {
    isTTY: true
};

module.exports = process;