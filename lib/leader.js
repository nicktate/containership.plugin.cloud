'use strict';

const constants = require('./constants');
const middleware = require('./middleware');

const async = require('async');
const request = require('request');

module.exports = {

    initialize: function(core, config) {
        core.api.server.server.post('/:api_version/cluster/backup',
            middleware.version,
            core.api.server.middleware.get_handler('applications', 'get'),
            (req, res, next) => {
                const handler = req.handler;
                delete req.handler;

                handler.backup.volumes(core, req, res, next);
            },
            core.api.server.middleware.handle_response
        );

        function register_cluster(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            // defaults provider to open_source
            let provider = 'open_source';

            // overrides provider if cloud-hints plugin detected a hosting provider
            if (attributes.tags && attributes.tags.cloud) {
                provider = attributes.tags.cloud.provider;
            }

            const options = {
                url: `${constants.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}`,
                method: 'POST',
                timeout: 5000,
                headers: {
                    Authorization: `Bearer ${config.api_key}`
                },
                json: {
                    provider: provider,
                    ipaddress: attributes.address.public,
                    port: core.options['api-port'],
                    api_version: core.api.server.api_version || 'v1'
                }
            };

            if (attributes.praetor.leader) {
                core.loggers['containership-cloud'].log('debug', 'Registering cluster with ContainerShip Cloud');
                request(options, (err, response) => {
                    if (err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to register cluster with ContainerShip Cloud. ${err.message}`);
                    } else if (response.statusCode != 201) {
                        core.loggers['containership-cloud'].log('warn', `Unable to register cluster with ContainerShip Cloud. API returned ${response.statusCode}.`);
                    }

                    return callback();
                });
            } else {
                return callback();
            }
        }

        function sync_loadbalancers(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if (attributes.praetor.leader) {
                const options = {
                    url: `${constants.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}/loadbalancers`,
                    method: 'GET',
                    timeout: 5000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if (err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch loadbalancers from ContainerShip Cloud. ${err.message}`);
                        return callback();
                    } else if (response.statusCode != 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch loadbalancers from ContainerShip Cloud. API returned ${response.statusCode}.`);
                        return callback();
                    } else {
                        core.cluster.myriad.persistence.set('containership-cloud::loadbalancers', JSON.stringify(response.body), (err) => {
                            if (err) {
                                core.loggers['containership-cloud'].log('warn', `Error persisting loadbalancers to myriad-kv. ${err.message}`);
                            }

                            return callback();
                        });
                    }
                });
            } else {
                return callback();
            }
        }

        async.forever((callback) => {
            setTimeout(() => {
                async.parallel([ register_cluster, sync_loadbalancers ], callback);
            }, 15000);
        });
    }

};
