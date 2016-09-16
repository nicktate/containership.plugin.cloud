'use strict';

const constants = require('./constants');

const _ = require('lodash');
const async = require('async');
const tar = require('tar');
const tarfs = require('tar-fs');
const request = require('request');

module.exports = {

    initialize: function(core, config) {
        core.cluster.legiond.join('containership-cloud.backup');

        // enables registry authentication
        core.scheduler.follower.container.add_pre_pull_middleware('docker', 'authentication', function(options, fn) {
            options.auth = [];

            let request_options = {
                url: `${constants.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/registries`,
                method: 'GET',
                headers: {
                    Authorization: ['Bearer', config.api_key].join(' ')
                },
                json: true
            };

            request(request_options, function(err, response) {
                let registries;
                if(err || response.statusCode != 200) {
                    registries = {};
                } else {
                    registries = _.groupBy(response.body, 'serveraddress');
                }

                registries['registry.containership.io'] = [
                    {
                        username: config.organization,
                        password: config.api_key,
                        serveraddress: 'registry.containership.io',
                        auth: ''
                    }
                ];

                let registry;
                if(options.image.split('/').length > 2) {
                    registry = options.image.split('/').slice(0, options.image.split('/').length - 2);
                } else {
                    registry = 'docker.io';
                }

                if(_.has(registries, registry)) {
                    _.each(registries[registry], function(registry) {
                        options.auth.push({
                            authconfig: {
                                email: registry.email,
                                username: registry.username,
                                password: registry.password,
                                serveraddress: registry.serveraddress,
                                auth: ''
                            }
                        });
                    });
                } else {
                    options.auth.push({});
                }

                return fn();
            });
        });

        // set ContainerShip Cloud specific environment variables
        core.scheduler.follower.container.add_pre_start_middleware('docker', 'csc_env', function(container_options, fn) {
            let application_name = container_options.application_name;
            let container = _.omit(container_options, ['application_name', 'start_args']);

            let options = {
                url: `${constants.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}`,
                method: 'GET',
                headers: {
                    Authorization: ['Bearer', config.api_key].join(' ')
                },
                json: true,
                timeout: 5000
            };

            request(options, function(err, response) {
                if(!err && response.statusCode == 200 && _.has(response.body, 'environment')) {
                    container.env_vars.CSC_ENV = response.body.environment;
                }

                core.cluster.myriad.persistence.set([core.constants.myriad.CONTAINERS_PREFIX, application_name, container.id].join(core.constants.myriad.DELIMITER), JSON.stringify(container), function() {
                    return fn();
                });
            });
        });

        // download snapshot from ContainerShip Cloud
        core.scheduler.follower.container.add_pre_start_middleware('docker', 'containership-cloud', function(container_options, fn) {
            if(_.has(container_options.env_vars, 'CSC_BACKUP_ID') && !_.isEmpty(container_options.volumes)) {

                let on_error = function() {
                    core.loggers['containership-cloud'].log('warn', 'Error downloading container snapshot');
                };

                if(!container_options.tags || !container_options.tags.metadata || !container_options.tags.metadata.codexd || !container_options.tags.metadata.codexd.volumes) {
                    return fn();
                }

                async.each(_.keys(container_options.tags.metadata.codexd.volumes), (volume_id, fn) => {
                    let options = {
                        url: `${constants.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/backups/${container_options.env_vars.CSC_BACKUP_ID}/containers/${container_options.id}/volumes/${volume_id}`,
                        method: 'GET',
                        headers: {
                            Authorization: ['Bearer', config.api_key].join(' ')
                        }
                    };

                    let extract_tar = tar.Extract({path: `${core.cluster.codexd.options.base_path}/${volume_id}`}).on('error', on_error).on('end', function() {
                        return fn();
                    });

                    request(options).pipe(extract_tar);
                }, fn);

            } else {
                return fn();
            }
        });

        // upload snapshot to ContainerShip Cloud
        core.cluster.legiond.on('containership-cloud.backup', function(message) {
            let options = {
                url: `${constants.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/backups/${message.data.backup_id}/containers/${message.data.container_id}/volumes/${message.data.volume_id}`,
                method: 'POST',
                headers: {
                    Authorization: ['Bearer', config.api_key].join(' ')
                }
            };

            tarfs.pack(message.data.path).pipe(request(options));
        });
    }

};
