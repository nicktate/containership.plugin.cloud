'use strict';

const DEFAULT_AUTH_API_BASE_URL = process.env.CONTAINERSHIP_CLOUD_ENV === 'development' ? 'https://stage-auth.containership.io' : 'https://auth.containership.io';
const DEFAULT_BUILD_API_BASE_URL = process.env.CONTAINERSHIP_CLOUD_ENV === 'development' ? 'https://stage-build.containership.io' : 'https://build.containership.io';
const DEFAULT_CLOUD_API_BASE_URL = process.env.CONTAINERSHIP_CLOUD_ENV === 'development' ? 'https://stage-api.containership.io' : 'https://api.containership.io';

module.exports = {
    AUTH_API_BASE_URL: process.env.CS_AUTH_API_BASE_URL || DEFAULT_AUTH_API_BASE_URL,
    BUILD_API_BASE_URL: process.env.CS_BUILD_API_BASE_URL || DEFAULT_BUILD_API_BASE_URL,
    CLOUD_API_BASE_URL: process.env.CS_CLOUD_API_BASE_URL || DEFAULT_CLOUD_API_BASE_URL
};
