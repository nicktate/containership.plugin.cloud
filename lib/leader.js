'use strict';

const auto_termination = require('./auto_termination');
const cluster_snapshot = require('./cluster_snapshot');
const constants = require('./constants');
const Firewall = require('./firewall');
const middleware = require('./middleware');
const SSH_Keys = require('./ssh_keys');

const _ = require('lodash');
const async = require('async');
const request = require('request');

let cache = {};

let sync_timeout = null;

let process_running = true;

module.exports = {

    stop: function() {
        process_running = false;
        clearTimeout(sync_timeout);
    },

    initialize: function(core, config) {
        process_running = true;

        const firewall = new Firewall(core);
        firewall.enable();

        // enable SSH key management
        new SSH_Keys(core);

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
            if(attributes.tags && attributes.tags.cloud) {
                provider = attributes.tags.cloud.provider;
            }

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to register cluster with ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            const options = {
                url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}`,
                method: 'POST',
                timeout: 10000,
                headers: {
                    Authorization: `Bearer ${config.api_key}`
                },
                json: {
                    provider: provider,
                    ipaddress: attributes.address.public,
                    port: core.options['api-port'],
                    configuration: {
                        general: {
                            containership: {
                                version: core.options && core.options.version
                            }
                        }
                    },
                    api_version: core.api.server.api_version || 'v1'
                }
            };

            if(attributes.praetor.leader) {
                // get applications and hosts
                const my_req = { core: core, params: { api_version: core.api.server.api_version || 'v1' } };
                const my_res = { stash: {} };
                core.api.server.middleware.get_handler('cluster', 'state')(my_req, my_res, (err) => {
                    if(!err && my_res.stash.code === 200) {
                        options.json = _.defaults(options.json, my_res.stash.body);
                    }
                    core.loggers['containership-cloud'].log('debug', 'Registering cluster with ContainerShip Cloud');
                    request(options, (err, response) => {
                        if(err) {
                            core.loggers['containership-cloud'].log('warn', `Unable to register cluster with ContainerShip Cloud: ${err.message}`);
                        } else if(response.statusCode !== 201) {
                            core.loggers['containership-cloud'].log('warn', `Unable to register cluster with ContainerShip Cloud: API returned ${response.statusCode}.`);
                        }

                        return callback();
                    });
                });
            } else {
                return callback();
            }
        }

        function sync_cluster_details(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to sync cluster details from ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch cluster details from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch cluster details from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else {
                        async.parallel({
                            set_cluster_details: (callback) => {
                                const cluster_details = {
                                    environment: response.body.environment
                                };

                                if(!cache.cluster_details || !_.isEqual(cache.cluster_details, cluster_details)) {
                                    core.cluster.myriad.persistence.set(constants.myriad.CLUSTER_DETAILS, JSON.stringify(cluster_details), (err) => {
                                        if(err) {
                                            core.loggers['containership-cloud'].log('warn', `Error persisting cluster details to myriad-kv: ${err.message}`);
                                        } else {
                                            cache.cluster_details = cluster_details;
                                        }

                                        return callback();
                                    });
                                } else {
                                    return callback();
                                }
                            },

                            set_snapshotting_configuration: (callback) => {
                                const snapshotting_configuration = response.body.snapshotting_configuration;

                                if(!cache.snapshotting_configuration || !_.isEqual(cache.snapshotting_configuration, snapshotting_configuration)) {
                                    core.cluster.myriad.persistence.set(constants.myriad.SNAPSHOTTING_CONFIGURATION, JSON.stringify(snapshotting_configuration), (err) => {
                                        if(err) {
                                            core.loggers['containership-cloud'].log('warn', `Error persisting snapshotting configuration to myriad-kv: ${err.message}`);
                                        } else {
                                            cache.snapshotting_configuration = snapshotting_configuration;
                                            cluster_snapshot.setup(core, cache, config);
                                        }

                                        return callback();
                                    });
                                } else {
                                    return callback();
                                }
                            },

                            set_auto_termination_configuration: (callback) => {
                                const auto_termination_configuration = response.body.auto_termination_configuration;

                                if(!cache.auto_termination_configuration || !_.isEqual(cache.auto_termination_configuration, auto_termination_configuration)) {
                                    core.cluster.myriad.persistence.set(constants.myriad.AUTO_TERMINATION_CONFIGURATION, JSON.stringify(auto_termination_configuration), (err) => {
                                        if(err) {
                                            core.loggers['containership-cloud'].log('warn', `Error persisting auto termination configuration to myriad-kv: ${err.message}`);
                                        } else {
                                            cache.auto_termination_configuration = auto_termination_configuration;
                                            auto_termination.schedule(core, cache, config);
                                        }

                                        return callback();
                                    });
                                } else {
                                    return callback();
                                }
                            }
                        }, callback);
                    }
                });
            } else {
                cluster_snapshot.cancel();
                auto_termination.cancel();
                return callback();
            }
        }

        function sync_firewalls(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to fetch firewalls from ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}/firewalls`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch firewalls from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch firewalls from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else if(!cache.firewalls || !_.isEqual(cache.firewalls, response.body)) {
                        core.cluster.myriad.persistence.set(constants.myriad.FIREWALLS, JSON.stringify(response.body), (err) => {
                            if(err) {
                                core.loggers['containership-cloud'].log('warn', `Error persisting firewalls to myriad-kv: ${err.message}`);
                            } else {
                                cache.firewalls = response.body;
                            }

                            return callback();
                        });
                    } else {
                        return callback();
                    }
                });
            } else {
                return callback();
            }
        }

        function sync_loadbalancers(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to fetch loadbalancers from ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}/loadbalancers`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch loadbalancers from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch loadbalancers from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else if(!cache.loadbalancers || !_.isEqual(cache.loadbalancers, response.body)) {
                        core.cluster.myriad.persistence.set(constants.myriad.LOADBALANCERS, JSON.stringify(response.body), (err) => {
                            if(err) {
                                core.loggers['containership-cloud'].log('warn', `Error persisting loadbalancers to myriad-kv: ${err.message}`);
                            } else {
                                cache.loadbalancers = response.body;
                            }

                            return callback();
                        });
                    } else {
                        return callback();
                    }
                });
            } else {
                return callback();
            }
        }

        function sync_registries(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/registries`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch registries from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch registries from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else if(!cache.registries || !_.isEqual(cache.registries, response.body)) {
                        core.cluster.myriad.persistence.set(constants.myriad.REGISTRIES, JSON.stringify(response.body), (err) => {
                            if(err) {
                                core.loggers['containership-cloud'].log('warn', `Error persisting registries to myriad-kv: ${err.message}`);
                            } else {
                                cache.registries = response.body;
                            }

                            return callback();
                        });
                    } else {
                        return callback();
                    }
                });
            } else {
                return callback();
            }
        }

        function sync_ssh_keys(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to fetch ssh keys from ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}/ssh_keys`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch ssh keys from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch ssh keys from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else if(!cache.ssh_keys || !_.isEqual(cache.ssh_keys, response.body)) {
                        core.cluster.myriad.persistence.set(constants.myriad.SSH_KEYS, JSON.stringify(response.body), (err) => {
                            if(err) {
                                core.loggers['containership-cloud'].log('warn', `Error persisting ssh keys to myriad-kv: ${err.message}`);
                            } else {
                                cache.ssh_keys = response.body;
                            }

                            return callback();
                        });
                    } else {
                        return callback();
                    }
                });
            } else {
                return callback();
            }
        }

        async.forever((callback) => {
            if(!process_running) {
                return callback(new Error('ContainerShip process has stopped'));
            }

            sync_timeout = setTimeout(() => {
                async.parallel([
                    register_cluster,
                    sync_cluster_details,
                    sync_firewalls,
                    sync_loadbalancers,
                    sync_registries,
                    sync_ssh_keys
                ], callback);
            }, 15000);
        });
    }
};
