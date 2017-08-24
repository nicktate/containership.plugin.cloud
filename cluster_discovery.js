'use strict';

const constants = require('./lib/constants');

const request = require('request');

module.exports = {

    discover: function(cluster_id, config, callback) {
        const options = {
            baseUrl: constants.environment.CLOUD_API_BASE_URL,
            url: `/v2/organizations/${config.organization}/clusters/${cluster_id}/instances/ips`,
            method: 'GET',
            timeout: 15000,
            headers: {
                Authorization: `Bearer ${config.api_key}`
            },
            json: true
        };

        request(options, function(err, response) {
            if(err) {
                return callback(err);
            } else if(response.statusCode !== 200) {
                return callback(new Error(`ContainerShip Cloud API returned status code: ${response.statusCode}`));
            } else {
                return callback(null, response.body);
            }
        });
    }

};
